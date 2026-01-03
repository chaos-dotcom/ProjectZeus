import express, { Request, Response } from 'express';
import path from 'path';
import { exec } from 'child_process';
import cron, { ScheduledTask } from 'node-cron';
import fs from 'fs';
import os from 'os';

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve static files from the 'public' directory and project root for images
app.use(express.static(path.join(__dirname, '..'))); // Serve files from project root (for projectzeus.gif)

// --- Task Management ---
interface PathPair {
  source: string;
  destination: string;
}

interface Task {
  id: string;
  name: string;
  sourceHost: string;
  destinationHost: string;
  paths: PathPair[];
  flags: string[]; // Store flags as an array of strings
  scheduleEnabled: boolean;
  scheduleDetails?: string; // e.g., cron string or simple description
  // Fields for linking to automation
  automationConfigId?: string; // ID of the AutomationConfig that created this task
  triggerFilePath?: string;    // The specific .livework or .turbosort file that triggered this task
  // Add other fields like lastRun, status, etc. later
}

export let tasks: Task[] = []; // Will be populated by loadData

// --- Type definitions for Express route handlers ---

// Parameter types are now defined inline in each route handler

// Request Body types
interface ScanDirectoryRequestBody { directoryPath: string; }
interface ListDirectoryContentsRequestBody { directoryPath: string; }
interface ReadFileRequestBody { filePath: string; }

interface AutomationConfigRequestBody {
  name: string;
  type: 'livework' | 'turbosort';
  scanHostId: string;
  scanDirectoryPath: string;
  destinationHostIds: string[];
  destinationBasePath: string;
  scanSchedule?: string;
  generatedTaskSchedule?: string;
  label?: string;
}

interface HostRequestBody {
  alias: string;
  user: string;
  hostname: string;
  port?: string | number; // Accepts string from form, parsed to number
}
interface UpdateHostRequestBody { // For PUT /api/hosts/:id
  alias?: string;
  user?: string;
  hostname?: string;
  port?: string | number;
}

interface SshCopyIdRequestBody { password?: string; } // Logic checks for presence

interface TaskRequestBody {
  name: string;
  sourceHost: string;
  destinationHost: string;
  paths: PathPair[];
  flags?: string[];
  scheduleEnabled?: boolean;
  scheduleDetails?: string;
  automationConfigId?: string;
  triggerFilePath?: string;
}
interface StrictUpdateTaskRequestBody { // For PUT /api/tasks/:taskId
  name: string;
  sourceHost: string;
  destinationHost: string;
  paths: PathPair[];
  flags?: string[];
  scheduleEnabled?: boolean;
  scheduleDetails?: string;
  // automationConfigId and triggerFilePath are not typically part of user update payload
}

interface SuggestPathRequestBody { currentInputPath: string; }

// --- Automation Configuration ---
interface AutomationConfig {
  id: string;
  name: string;
  label?: string;
  type: 'livework' | 'turbosort'; // The type of file that triggers this automation
  scanHostId: string;             // The host where scanning for trigger files occurs
  scanDirectoryPath: string;      // The base directory on scanHostId to scan recursively
  destinationHostIds: string[];   // Array of host IDs to copy the project folder to
  destinationBasePath: string;    // Base path on each destination host
  processedLogFile?: string;      // For .turbosort: filename on source host listing processed project folders
  scanSchedule?: string; // e.g., "manual", "hourly", "daily_3am"
  generatedTaskSchedule?: string; // e.g., "manual_once", "hourly", "daily_4am"
  // templateTaskId?: string; // For future use: ID of a Task to use as a template
}

export let automationConfigs: AutomationConfig[] = []; // Will be populated by loadData

// Define a global array to keep track of cron jobs for automation scans
let automationScanCronJobs: ScheduledTask[] = [];
let taskExecutionCronJobs: ScheduledTask[] = []; // For individual task schedules

// Helper function to translate schedule strings to cron patterns
function translateScheduleToCron(scheduleString?: string): string | null {
    if (!scheduleString) return null;
    switch (scheduleString) {
        case 'every_5_min':
            return '*/5 * * * *'; // Every 5 Minutes
        case 'every_15_min':
            return '*/15 * * * *'; // Every 15 Minutes
        case 'every_30_min':
            return '*/30 * * * *'; // Every 30 Minutes
        case 'hourly':
            return '0 * * * *'; // Every hour at minute 0
        case 'every_2_hours':
            return '0 */2 * * *'; // Every 2 Hours at minute 0
        case 'every_6_hours':
            return '0 */6 * * *'; // Every 6 Hours at minute 0
        case 'every_12_hours':
            return '0 */12 * * *'; // Every 12 Hours at minute 0
        case 'daily_3am':
            return '0 3 * * *'; // Every day at 3:00 AM
        case 'weekly_sun_3am':
            return '0 3 * * 0'; // Every Sunday at 3:00 AM
        case 'manual':
        default:
            return null;
    }
}

// --- Job Run Logging ---
interface JobRunLog {
  id: string; // Unique ID for this log entry
  taskId: string;
  taskName: string;
  startTime: string;
  endTime: string;
  status: 'success' | 'warning' | 'error'; // success = all paths ok, warning = some paths failed, error = task not found or major issue
  results: RsyncExecutionResult[]; // Detailed results from each path pair
}

export let jobRunLogs: JobRunLog[] = []; // Will be populated by loadData

// --- Automation Run Logging ---
interface AutomationRunLog {
  id: string;
  automationConfigId: string;
  automationConfigName: string;
  startTime: string;
  endTime: string;
  status: 'success' | 'error' | 'completed_with_errors';
  triggerFilesFound: number;
  tasksCreatedCount: number;
  tasksDeletedCount: number;
  messages: string[];
}

export let automationRunLogs: AutomationRunLog[] = []; // Will be populated by loadData


 // --- Data Persistence ---
 // Persist under /app/data by default (Docker). Allow override via DATA_DIR env var.
 const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : '/app/data';
 if (!fs.existsSync(DATA_DIR)) {
   fs.mkdirSync(DATA_DIR, { recursive: true });
 }
 export const DATA_FILE_PATH = path.join(DATA_DIR, 'websync-data.json');
 export const JOB_HISTORY_FILE_PATH = path.join(DATA_DIR, 'job_history.json');

 // Atomic write helpers with backup to reduce risk of blank overwrites
 async function backupIfExists(filePath: string): Promise<void> {
   try {
     const stat = await fs.promises.stat(filePath);
     if (stat.size > 0) {
       await fs.promises.copyFile(filePath, filePath + '.bak');
     }
   } catch {
     // ignore if file doesn't exist
   }
 }
 
 async function writeJsonAtomic(filePath: string, data: any): Promise<void> {
   const tmp = filePath + '.tmp';
   await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
   await fs.promises.rename(tmp, filePath);
 }
 
 async function readJsonWithBackup(filePath: string): Promise<any | null> {
   try {
     if (!fs.existsSync(filePath)) return null;
     const text = await fs.promises.readFile(filePath, 'utf-8');
     if (!text.trim()) throw new Error('Empty file');
     return JSON.parse(text);
   } catch {
     const backup = filePath + '.bak';
     try {
       if (!fs.existsSync(backup)) return null;
       const text2 = await fs.promises.readFile(backup, 'utf-8');
       if (!text2.trim()) return null;
       return JSON.parse(text2);
     } catch {
       return null;
     }
   }
 }
 
 export async function saveData(): Promise<void> {
  try {
    // Save main configuration data (hosts, tasks, automationConfigs, jobRunLogs)
    const mainDataToSave = { hosts, tasks, automationConfigs, jobRunLogs }; // automationRunLogs removed
    await backupIfExists(DATA_FILE_PATH);
    await writeJsonAtomic(DATA_FILE_PATH, mainDataToSave);
    // console.log('Main data saved to file.'); // Optional: for debugging
  } catch (error) {
    console.error('Error saving main data to file:', error);
  }

  try {
    // Save automation run logs to a separate file
    await backupIfExists(JOB_HISTORY_FILE_PATH);
    await writeJsonAtomic(JOB_HISTORY_FILE_PATH, automationRunLogs);
    // console.log('Automation run logs saved to job_history.json.'); // Optional: for debugging
  } catch (error) {
    console.error('Error saving automation run logs to file:', error);
  }
}

export async function loadData(): Promise<void> {
  const dataFileExistedAtStart = fs.existsSync(DATA_FILE_PATH);
  const jobHistoryExistedAtStart = fs.existsSync(JOB_HISTORY_FILE_PATH);
  let loadedHosts: Host[] = [];
  let loadedTasks: Task[] = [];
  let loadedAutomationConfigs: AutomationConfig[] = [];
  let loadedJobRunLogs: JobRunLog[] = [];
  // let loadedAutomationRunLogs: AutomationRunLog[] = []; // Removed: will be loaded separately

  try {
    const parsedData = await readJsonWithBackup(DATA_FILE_PATH);
    if (parsedData) {
      loadedHosts = parsedData.hosts || [];
      loadedTasks = parsedData.tasks || [];
      loadedAutomationConfigs = parsedData.automationConfigs || [];
      loadedJobRunLogs = parsedData.jobRunLogs || [];
    } else if (dataFileExistedAtStart) {
      console.error('Data file exists but could not be parsed, and no valid backup was found. Using in-memory defaults without overwriting on disk.');
    }
  } catch (error) {
    console.error('Unexpected error reading main data file.', error);
  }

  // Ensure 'localhost' is always present and at the beginning.
  // Its alias can be persisted, but core properties are fixed.
  const defaultLocalhostAlias = 'Localhost';
  const localhostFromFile = loadedHosts.find(h => h.id === 'localhost');
  const currentLocalhostAlias = localhostFromFile ? localhostFromFile.alias : defaultLocalhostAlias;

  const localhostEntry: Host = { id: 'localhost', alias: currentLocalhostAlias, user: '', hostname: 'localhost' };
  
  // Filter out any existing localhost entries from loadedHosts to avoid duplicates, then prepend our controlled one.
  hosts = [localhostEntry, ...loadedHosts.filter(h => h.id !== 'localhost')];
  tasks = loadedTasks;
  automationConfigs = loadedAutomationConfigs;
  jobRunLogs = loadedJobRunLogs;
  // automationRunLogs = loadedAutomationRunLogs; // Removed: will be loaded separately

  // New: Load automation run logs from their separate file
  let loadedAutomationRunLogsFromFile: AutomationRunLog[] = [];
  try {
    const parsedJobHistory = await readJsonWithBackup(JOB_HISTORY_FILE_PATH);
    loadedAutomationRunLogsFromFile = Array.isArray(parsedJobHistory) ? parsedJobHistory : [];
  } catch (error) {
    console.error('Unexpected error reading job_history.json.', error);
    loadedAutomationRunLogsFromFile = [];
  }
  automationRunLogs = loadedAutomationRunLogsFromFile;


  // If the file didn't exist initially or was unparsable and resulted in empty data structures, save initial state.
  if (!dataFileExistedAtStart) {
    await saveData(); // create initial files on first run only
  }
  if (!jobHistoryExistedAtStart) {
    try {
      await writeJsonAtomic(JOB_HISTORY_FILE_PATH, automationRunLogs);
    } catch (e) {
      console.error('Error creating job_history.json:', e);
    }
  }
}

// --- Scanner Functionality ---

// Helper function for recursive local directory scanning
async function getFilesInDirectoryLocalRecursive(dirPath: string, fileExtensions: string[]): Promise<string[]> {
  let files: string[] = [];
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(await getFilesInDirectoryLocalRecursive(fullPath, fileExtensions));
      } else if (entry.isFile() && fileExtensions.some(ext => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  } catch (error: any) {
    // Log errors for specific subdirectories but continue scanning others if possible
    console.warn(`Warning: Could not read directory ${dirPath}: ${error.message}`);
  }
  return files;
}

async function scanDirectoryOnHost(host: Host, directoryPath: string): Promise<string[]> {
  const privateKeyPath = path.join(os.homedir(), '.ssh', 'websync_id_rsa');
  if (!fs.existsSync(privateKeyPath)) {
    // Attempt to generate keys if websync_id_rsa doesn't exist.
    // This is primarily for the ssh-copy-id feature, but good to check here too.
    // If this fails, SSH operations will likely fail.
    console.warn(`SSH private key ${privateKeyPath} not found. SSH operations might fail if keys are not set up.`);
    // Optionally, trigger key generation here if desired, similar to ssh-copy-id,
    // but for scanning, we might assume keys should already be functional.
  }


  if (host.id === 'localhost') {
    try {
      return await getFilesInDirectoryLocalRecursive(directoryPath, ['.livework', '.turbosort']);
    } catch (error: any) {
      // This top-level catch is for errors that prevent starting the scan at all (e.g., root path doesn't exist)
      console.error(`Error starting local recursive scan for directory ${directoryPath}:`, error);
      throw new Error(`Failed to scan local directory ${directoryPath} recursively: ${error.message}`);
    }
  } else {
    // Remote host: Use SSH to execute 'find' (recursively by default)
    // Ensure directoryPath is properly escaped for the remote shell.
    // Using single quotes around directoryPath for the remote find command.
    const escapedDirectoryPath = directoryPath.replace(/'/g, "'\\''"); // Basic escaping for single quotes

    // Removed -maxdepth 1 to make the find command recursive
    const findCommand = `find '${escapedDirectoryPath}' -type f \\( -name '*.livework' -o -name '*.turbosort' \\)`;
    const portOption = host.port ? `-p ${host.port}` : '';
    // BatchMode=yes ensures ssh doesn't hang asking for a password if key auth fails
    const sshCommand = `ssh -i "${privateKeyPath}" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${portOption} ${host.user}@${host.hostname} "${findCommand}"`;

    console.log(`Executing remote scan: ${sshCommand}`); // For debugging

    return new Promise<string[]>((resolve, reject) => {
      exec(sshCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`Remote scan exec error for ${host.alias} on path ${directoryPath}: ${stderr || error.message}`);
          return reject(new Error(`Failed to scan directory on ${host.alias}. SSH command failed. ${stderr || error.message}`));
        }
        const foundFiles = stdout.trim().split('\n').filter(line => line.length > 0);
        resolve(foundFiles);
      });
    });
  }
}

app.post('/api/hosts/:hostId/scan-directory', async (req: Request<{hostId: string}, any, ScanDirectoryRequestBody>, res: Response): Promise<void> => {
  const { hostId } = req.params;
  const { directoryPath } = req.body;

  if (!directoryPath) {
    res.status(400).json({ message: 'directoryPath is required in the request body.' });
    return;
  }

  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    res.status(404).json({ message: 'Host not found.' });
    return;
  }

  try {
    const files = await scanDirectoryOnHost(host, directoryPath);
    res.json(files);
  } catch (error: any) {
    console.error(`Error in scan-directory endpoint for host ${hostId}, path ${directoryPath}:`, error);
    res.status(500).json({ message: error.message || 'An unexpected error occurred during directory scan.' });
  }
});

// --- Directory Listing Functionality ---
interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
  path: string; // Full path to the entry
}

async function listDirectoryContents(host: Host, directoryPath: string): Promise<DirectoryEntry[]> {
  const privateKeyPath = path.join(os.homedir(), '.ssh', 'websync_id_rsa');
  // No need to check for key existence here again, as scanDirectoryOnHost and ssh-copy-id handle it.
  // Assume if we reach here for a remote host, key setup is expected.

  if (host.id === 'localhost') {
    try {
      const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
      return entries.map(entry => {
        let type: DirectoryEntry['type'] = 'other';
        if (entry.isFile()) type = 'file';
        else if (entry.isDirectory()) type = 'directory';
        return { name: entry.name, type, path: path.join(directoryPath, entry.name) };
      });
    } catch (error: any) {
      console.error(`Error listing local directory ${directoryPath}:`, error);
      throw new Error(`Failed to list local directory ${directoryPath}: ${error.message}`);
    }
  } else {
    // Remote host: Use SSH to execute 'ls -Ap1 -- "<directoryPath>"'
    // The '--' ensures that if directoryPath starts with a '-', it's not treated as an option.
    const escapedDirectoryPath = directoryPath.replace(/'/g, "'\\''"); // Basic escaping for single quotes
    const listCommand = `ls -Ap1 -- '${escapedDirectoryPath}'`;
    const portOption = host.port ? `-p ${host.port}` : '';
    const sshCommand = `ssh -i "${privateKeyPath}" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${portOption} ${host.user}@${host.hostname} "${listCommand}"`;

    console.log(`Executing remote directory list: ${sshCommand.split(' ')[0]} ...`); // Log only ssh part for brevity

    return new Promise<DirectoryEntry[]>((resolve, reject) => {
      exec(sshCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`Remote directory list exec error for ${host.alias} on path ${directoryPath}: ${stderr || error.message}`);
          return reject(new Error(`Failed to list directory on ${host.alias}. SSH command failed. ${stderr || error.message}`));
        }
        const lines = stdout.trim().split('\n').filter(line => line.length > 0);
        const directoryEntries: DirectoryEntry[] = lines.map(line => {
          const isDir = line.endsWith('/');
          const name = isDir ? line.slice(0, -1) : line;
          // Construct full path. Note: path.join might not be correct for remote paths if they use different separators.
          // For simplicity, assuming Unix-like remote paths.
          const entryPath = (directoryPath.endsWith('/') ? directoryPath : directoryPath + '/') + name;
          return {
            name,
            type: isDir ? 'directory' : 'file', // ls -p appends / to dirs
            path: entryPath
          };
        });
        resolve(directoryEntries);
      });
    });
  }
}

app.post('/api/hosts/:hostId/list-directory-contents', async (req: Request<{hostId: string}, any, ListDirectoryContentsRequestBody>, res: Response): Promise<void> => {
  const { hostId } = req.params;
  const { directoryPath } = req.body;

  if (!directoryPath) {
    res.status(400).json({ message: 'directoryPath is required in the request body.' });
    return;
  }

  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    res.status(404).json({ message: 'Host not found.' });
    return;
  }

  try {
    const entries = await listDirectoryContents(host, directoryPath);
    res.json(entries);
  } catch (error: any) {
    console.error(`Error in list-directory-contents endpoint for host ${hostId}, path ${directoryPath}:`, error);
    res.status(500).json({ message: error.message || 'An unexpected error occurred during directory listing.' });
  }
});

// --- File Content Reading Functionality ---
async function readFileContent(host: Host, filePath: string): Promise<string> {
  const privateKeyPath = path.join(os.homedir(), '.ssh', 'websync_id_rsa');

  if (host.id === 'localhost') {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (error: any) {
      console.error(`Error reading local file ${filePath}:`, error);
      throw new Error(`Failed to read local file ${filePath}: ${error.message}`);
    }
  } else {
    // Remote host: Use SSH to execute 'cat <filePath>'
    const escapedFilePath = filePath.replace(/'/g, "'\\''"); // Basic escaping for single quotes
    const catCommand = `cat '${escapedFilePath}'`;
    const portOption = host.port ? `-p ${host.port}` : '';
    const sshCommand = `ssh -i "${privateKeyPath}" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${portOption} ${host.user}@${host.hostname} "${catCommand}"`;

    // console.log(`Executing remote file read: ${sshCommand}`); // For debugging

    return new Promise<string>((resolve, reject) => {
      exec(sshCommand, (error, stdout, stderr) => {
        if (error) {
          // stderr might contain useful info from `cat` if the file doesn't exist or isn't readable
          console.error(`Remote file read exec error for ${host.alias} on path ${filePath}: ${stderr || error.message}`);
          return reject(new Error(`Failed to read file on ${host.alias}. SSH command failed. ${stderr || error.message}`));
        }
        resolve(stdout); // stdout is the file content
      });
    });
  }
}

app.post('/api/hosts/:hostId/read-file', async (req: Request<{hostId: string}, any, ReadFileRequestBody>, res: Response): Promise<void> => {
  const { hostId } = req.params;
  const { filePath } = req.body;

  if (!filePath) {
    res.status(400).json({ message: 'filePath is required in the request body.' });
    return;
  }

  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    res.status(404).json({ message: 'Host not found.' });
    return;
  }

  try {
    const content = await readFileContent(host, filePath);
    res.type('text/plain').send(content); // Send as plain text
  } catch (error: any) {
    console.error(`Error in read-file endpoint for host ${hostId}, path ${filePath}:`, error);
    res.status(500).json({ message: error.message || 'An unexpected error occurred during file read.' });
  }
});

// --- Automation Config API Endpoints ---
app.get('/api/automation-configs', (req, res) => {
  res.json(automationConfigs);
});

app.post('/api/automation-configs', async (req: Request<{}, any, AutomationConfigRequestBody>, res: Response): Promise<void> => {
  const { 
    name, 
    type, 
    scanHostId, 
    scanDirectoryPath, 
    destinationHostIds, 
    destinationBasePath,
    scanSchedule,         // New field
    generatedTaskSchedule, // New field
    label
  } = req.body;

  if (!name || !type || !scanHostId || !scanDirectoryPath || !destinationHostIds || !destinationBasePath) {
    res.status(400).json({ message: 'Name, type, scanHostId, scanDirectoryPath, destinationHostIds, and destinationBasePath are required.' });
    return;
  }
  if (type !== 'livework' && type !== 'turbosort') {
    res.status(400).json({ message: 'Invalid type. Must be "livework" or "turbosort".' });
    return;
  }
  if (!hosts.find(h => h.id === scanHostId)) {
    res.status(400).json({ message: 'scanHostId does not refer to a valid host.' });
    return;
  }
  if (!Array.isArray(destinationHostIds) || destinationHostIds.length === 0) {
    res.status(400).json({ message: 'destinationHostIds must be a non-empty array.'});
    return;
  }
  for (const destHostId of destinationHostIds) {
    if (!hosts.find(h => h.id === destHostId)) {
      res.status(400).json({ message: `Invalid hostId "${destHostId}" in destinationHostIds.` });
      return;
    }
  }

  const newConfig: AutomationConfig = {
    id: Date.now().toString(),
    name,
    label,
    type,
    scanHostId,
    scanDirectoryPath,
    destinationHostIds,
    destinationBasePath,
    scanSchedule: scanSchedule || 'manual', // Default to manual
    generatedTaskSchedule: generatedTaskSchedule || 'manual_once' // Default to manual_once
  };

  if (type === 'turbosort') {
    // Base filename for the processed log file - we'll create project-specific ones at runtime
    newConfig.processedLogFile = `.projectzeus_processed_${newConfig.id}`;
  }

  automationConfigs.push(newConfig);
  await saveData();
  scheduleAutomationScans(); // Reschedule after adding
  res.status(201).json(newConfig);
});

app.put('/api/automation-configs/:id', async (req: Request<{id: string}, any, AutomationConfigRequestBody>, res: Response): Promise<void> => {
  const { id } = req.params;
  const { 
    name, 
    type, 
    scanHostId, 
    scanDirectoryPath, 
    destinationHostIds, 
    destinationBasePath,
    scanSchedule,         // New field
    generatedTaskSchedule, // New field
    label
  } = req.body;

  if (!name || !type || !scanHostId || !scanDirectoryPath || !destinationHostIds || !destinationBasePath) {
    res.status(400).json({ message: 'Name, type, scanHostId, scanDirectoryPath, destinationHostIds, and destinationBasePath are required.' });
    return;
  }
  if (type !== 'livework' && type !== 'turbosort') {
    res.status(400).json({ message: 'Invalid type. Must be "livework" or "turbosort".' });
    return;
  }
  if (!hosts.find(h => h.id === scanHostId)) {
    res.status(400).json({ message: 'scanHostId does not refer to a valid host.' });
    return;
  }
  if (!Array.isArray(destinationHostIds) || destinationHostIds.length === 0) {
    res.status(400).json({ message: 'destinationHostIds must be a non-empty array.'});
    return;
  }
  for (const destHostId of destinationHostIds) {
    if (!hosts.find(h => h.id === destHostId)) {
      res.status(400).json({ message: `Invalid hostId "${destHostId}" in destinationHostIds.` });
      return;
    }
  }

  const configIndex = automationConfigs.findIndex(ac => ac.id === id);
  if (configIndex === -1) {
    res.status(404).json({ message: 'Automation configuration not found.' });
    return;
  }

  automationConfigs[configIndex] = {
    ...automationConfigs[configIndex], // Keep original ID and any other non-updated fields
    name,
    label,
    type,
    scanHostId,
    scanDirectoryPath,
    destinationHostIds,
    destinationBasePath,
    scanSchedule: scanSchedule || automationConfigs[configIndex].scanSchedule || 'manual',
    generatedTaskSchedule: generatedTaskSchedule || automationConfigs[configIndex].generatedTaskSchedule || 'manual_once',
    // Ensure processedLogFile is handled correctly on update
    processedLogFile: type === 'turbosort' 
                      ? (automationConfigs[configIndex].processedLogFile || `.projectzeus_processed_${id}.txt`) 
                      : undefined,
  };

  await saveData();
  scheduleAutomationScans(); // Reschedule after updating
  res.json(automationConfigs[configIndex]);
});

app.delete('/api/automation-configs/:id', async (req: Request<{id: string}, any, any>, res: Response): Promise<void> => {
  const { id } = req.params;
  const configIndex = automationConfigs.findIndex(ac => ac.id === id);

  if (configIndex === -1) {
    res.status(404).json({ message: 'Automation configuration not found.' });
    return;
  }

  automationConfigs.splice(configIndex, 1);
  await saveData();
  scheduleAutomationScans(); // Reschedule after deleting
  res.status(204).send();
});

// --- Discovered Projects API Endpoint ---
interface Project {
  name: string;
  path: string;
  label?: string;
  type: 'livework' | 'turbosort';
  automationConfigId: string;
  automationConfigName: string;
  scanHostId: string;
  scanHostAlias: string;
}

app.get('/api/projects', (req, res) => {
  const projectsMap = new Map<string, Project>();

  for (const task of tasks) {
    if (task.automationConfigId && task.paths.length > 0) {
      const projectPath = task.paths[0].source;

      if (!projectsMap.has(projectPath)) {
        const automationConfig = automationConfigs.find(ac => ac.id === task.automationConfigId);
        if (automationConfig) {
          const scanHost = hosts.find(h => h.id === automationConfig.scanHostId);
          const project: Project = {
            name: path.basename(projectPath.endsWith('/') ? projectPath.slice(0, -1) : projectPath),
            path: projectPath,
            label: automationConfig.label,
            type: automationConfig.type,
            automationConfigId: automationConfig.id,
            automationConfigName: automationConfig.name,
            scanHostId: automationConfig.scanHostId,
            scanHostAlias: scanHost ? scanHost.alias : 'Unknown Host',
          };
          projectsMap.set(projectPath, project);
        }
      }
    }
  }

  const projects = Array.from(projectsMap.values());
  res.json(projects);
});


// --- Host Management ---
interface Host {
  id: string;
  alias: string;
  user: string;
  hostname: string;
  port?: number; // Optional port
}

export let hosts: Host[] = []; // Will be populated by loadData

// GET all hosts
app.get('/api/hosts', (req, res) => {
  res.json(hosts);
});

// POST a new host
app.post('/api/hosts', async (req: Request<{}, any, HostRequestBody>, res: Response): Promise<void> => {
  const { alias, user, hostname, port } = req.body;

  if (!alias || !user || !hostname) {
    res.status(400).json({ message: 'Alias, User, and Hostname are required' });
    return;
  }
  if (port && (isNaN(parseInt(String(port), 10)) || parseInt(String(port), 10) <= 0 || parseInt(String(port), 10) > 65535)) {
    res.status(400).json({ message: 'Port must be a valid number between 1 and 65535' });
    return;
  }

  const newHost: Host = {
    id: Date.now().toString(), // Simple ID generation
    alias,
    user,
    hostname,
    port: port ? parseInt(String(port), 10) : undefined,
  };
  hosts.push(newHost);
  await saveData();
  res.status(201).json(newHost);
});

// PUT (update) an existing host
app.put('/api/hosts/:id', async (req: Request<{id: string}, any, UpdateHostRequestBody>, res: Response): Promise<void> => {
  const { id } = req.params;
  const { alias, user, hostname, port } = req.body;

  if (id === 'localhost' && (req.body.user || req.body.hostname || req.body.port)) {
    // Allow changing alias of localhost, but not other critical fields.
    if (Object.keys(req.body).some(key => !['alias'].includes(key))) {
         res.status(400).json({ message: 'Only the alias of Localhost can be modified.' });
         return;
    }
  }

  if (!alias) { // User and hostname might not be sent if only alias is changing for localhost
    if (id !== 'localhost' || !req.body.alias) { // if not localhost, or if localhost and no alias sent
        res.status(400).json({ message: 'Alias is required' });
        return;
    }
  }
  if (id !== 'localhost' && (!user || !hostname)) {
      res.status(400).json({ message: 'User and Hostname are required for non-localhost entries' });
      return;
  }

  if (port && (isNaN(parseInt(String(port), 10)) || parseInt(String(port), 10) <= 0 || parseInt(String(port), 10) > 65535)) {
    res.status(400).json({ message: 'Port must be a valid number between 1 and 65535' });
    return;
  }

  const hostIndex = hosts.findIndex(h => h.id === id);
  if (hostIndex === -1) {
    res.status(404).json({ message: 'Host not found' });
    return;
  }

  // Update fields
  hosts[hostIndex].alias = alias || hosts[hostIndex].alias; // Keep old alias if new one not provided (e.g. for localhost)
  if (id !== 'localhost') {
    hosts[hostIndex].user = user!;
    hosts[hostIndex].hostname = hostname!;
    hosts[hostIndex].port = port ? parseInt(String(port), 10) : undefined;
  } else { // For localhost, only update alias if provided
      if (alias) hosts[hostIndex].alias = alias;
  }

  await saveData();
  res.json(hosts[hostIndex]);
});

// DELETE a host
app.delete('/api/hosts/:id', async (req: Request<{id: string}, any, any>, res: Response): Promise<void> => {
  const { id } = req.params;
  // Prevent deleting the default 'localhost' entry if it's special
  if (id === 'localhost') {
      res.status(400).json({ message: 'Cannot delete the default Localhost entry.' });
      return;
  }
  const hostIndex = hosts.findIndex(h => h.id === id);
  if (hostIndex === -1) {
    res.status(404).json({ message: 'Host not found' });
    return;
  }
  hosts.splice(hostIndex, 1);
  await saveData();
  res.status(204).send(); // No content
});


// SSH Key Copy ID
app.post('/api/hosts/:id/ssh-copy-id', async (req: Request<{id: string}, any, SshCopyIdRequestBody>, res: Response): Promise<void> => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password) {
    res.status(400).json({ message: 'Password is required.' });
    return;
  }

  const host = hosts.find(h => h.id === id);
  if (!host || host.id === 'localhost') {
    res.status(404).json({ message: 'Host not found or operation not applicable to Localhost.' });
    return;
  }

  const privateKeyPath = path.join(os.homedir(), '.ssh', 'websync_id_rsa');
  const publicKeyPath = `${privateKeyPath}.pub`;

  try {
    // Step 1: Ensure SSH key pair exists for the application
    if (!fs.existsSync(publicKeyPath)) {
      await new Promise<void>((resolve, reject) => {
        // Generate a new key pair without a passphrase
        // Note: -b 2048 for quicker generation in dev; consider 4096 for production.
        exec(`ssh-keygen -t rsa -b 2048 -f "${privateKeyPath}" -N ""`, (error, stdout, stderr) => {
          if (error) {
            console.error(`ssh-keygen error: ${stderr}`);
            return reject(new Error(`Failed to generate SSH key pair: ${stderr}`));
          }
          console.log(`ssh-keygen output: ${stdout}`);
          
          // Attempt to add the generated key to ssh-agent
          exec(`ssh-add "${privateKeyPath}"`, (addError, addStdout, addStderr) => {
            if (addError) {
              // Log a warning if ssh-add fails, but don't make ssh-copy-id fail.
              // Agent forwarding is primarily for remote-to-remote rsync.
              console.warn(`ssh-add failed for ${privateKeyPath}: ${addStderr || addError.message}. SSH agent forwarding for remote-to-remote transfers might not work if agent is not running or key is not added.`);
            } else {
              console.log(`ssh-add successful for ${privateKeyPath}: ${addStdout}`);
            }
            resolve(); // Resolve the promise for ssh-keygen completion
          });
        });
      });
    }

    // Step 2: Copy the public key using sshpass and ssh-copy-id
    // WARNING: Using sshpass with a password directly in a command is a security risk.
    // The -o StrictHostKeyChecking=no and UserKnownHostsFile=/dev/null are used to bypass host key prompts.
    // This also has security implications and should be handled carefully in production.
    const portOption = host.port ? `-p ${host.port}` : '';
    const sshCopyIdCommand = `sshpass -p '${password}' ssh-copy-id -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "${publicKeyPath}" ${portOption} ${host.user}@${host.hostname}`;
    
    console.log(`Executing: ${sshCopyIdCommand.replace(password, '********')}`); // Log command without password

    await new Promise<void>((resolve, reject) => {
      exec(sshCopyIdCommand, (error, stdout, stderr) => {
        // Primary failure condition: command exited non-zero
        if (error) {
          console.error(`ssh-copy-id command execution failed. Stderr: ${stderr || 'N/A'}. Stdout: ${stdout || 'N/A'}. Error: ${error.message}`);
          if (stderr && stderr.toLowerCase().includes('permission denied')) {
            return reject(new Error('Permission denied. Please check the password and user permissions.'));
          }
          let errMsg = `Failed to copy SSH ID.`;
          if (error.message) errMsg += ` Message: ${error.message}.`;
          if (stderr) errMsg += ` Details: ${stderr}.`;
          return reject(new Error(errMsg));
        }

        // Command exited zero. Now, verify from stdout that keys were actually managed.
        // ssh-copy-id prints "Number of key(s) added: X" on success (X can be 0 if already present).
        // It also prints "All keys were already present" or "All keys were skipped because they already exist" if X=0.
        const successInStdout = stdout && 
                              (stdout.includes("Number of key(s) added:") || 
                               stdout.includes("All keys were already present on the remote host") ||
                               stdout.includes("All keys were skipped because they already exist on the remote system"));

        if (successInStdout) {
          console.log(`ssh-copy-id successful. stdout: ${stdout}`);
          resolve();
        } else {
          // Exit code 0, but stdout lacks confirmation. This is suspicious.
          // stderr might contain the actual error reason (e.g., permission denied if ssh-copy-id is misbehaving).
          console.warn(`ssh-copy-id command exited 0 but stdout lacked success confirmation. Stdout: "${stdout || 'N/A'}". Stderr: "${stderr || 'N/A'}"`);
          if (stderr && stderr.toLowerCase().includes('permission denied')) {
            // This is the scenario where exit code was 0 but stderr indicates auth failure.
            return reject(new Error('Permission denied (reported in stderr). Please check the password and user permissions.'));
          }
          // Generic failure if stdout is not confirming and stderr doesn't give a clear "permission denied".
          let failureMsg = 'SSH key copy operation may have failed. Output did not confirm key installation.';
          if (stderr) failureMsg += ` Details: ${stderr}.`;
          else if (stdout) failureMsg += ` Output: ${stdout}.`; 
          else failureMsg += ' No informative output received.';
          return reject(new Error(failureMsg));
        }
      });
    });

    res.json({ message: `SSH ID successfully copied to ${host.alias} (${host.user}@${host.hostname}).` });

  } catch (error: any) {
    console.error('Error in ssh-copy-id process:', error);
    res.status(500).json({ message: error.message || 'An unexpected error occurred during SSH key copy.' });
  }
});


// --- Task Management --- (Existing code continues)
// GET all tasks
app.get('/api/tasks', (req, res) => {
  res.json(tasks);
});

// POST a new task
app.post('/api/tasks', async (req: Request<{}, any, TaskRequestBody>, res: Response): Promise<void> => {
  const {
    name,
    sourceHost,
    destinationHost,
    paths,
    flags,
    scheduleEnabled,
    scheduleDetails,
    // New optional fields for automation linking
    automationConfigId,
    triggerFilePath,
  } = req.body;

  if (!name) {
    res.status(400).json({ message: 'Task name is required' });
    return;
  }
  if (!sourceHost || !destinationHost) {
    res.status(400).json({ message: 'Source and Destination hosts are required' });
    return;
  }
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    res.status(400).json({ message: 'At least one source/destination path pair is required' });
    return;
  }
  // Basic validation for paths
  for (const p of paths) {
    if (typeof p.source !== 'string' || typeof p.destination !== 'string') {
      res.status(400).json({ message: 'Each path pair must have a source and a destination string.' });
      return;
    }
  }

  let effectiveFlags = flags || []; // Start with provided flags

  if (automationConfigId) {
    const linkedAutomationConfig = automationConfigs.find(ac => ac.id === automationConfigId);
    if (linkedAutomationConfig && linkedAutomationConfig.type === 'turbosort') {
      if (!effectiveFlags.includes('--itemize-changes')) {
        effectiveFlags.push('--itemize-changes');
      }
    }
  }

  const newTask: Task = {
    id: Date.now().toString(), // Simple ID generation
    name,
    sourceHost,
    destinationHost,
    paths,
    flags: effectiveFlags, // Use the potentially modified flags
    scheduleEnabled: !!scheduleEnabled,
    scheduleDetails: scheduleEnabled ? scheduleDetails : undefined,
    automationConfigId: automationConfigId || undefined,
    triggerFilePath: triggerFilePath || undefined,
  };
  tasks.push(newTask);
  await saveData();
  scheduleTaskExecutions(); // Reschedule tasks
  res.status(201).json(newTask);
});

// DELETE all tasks
app.delete('/api/tasks/delete-all', async (req: Request<{}, any, any>, res: Response): Promise<void> => {
  tasks = []; // Clear the tasks array
  await saveData(); // Persist the change
  scheduleTaskExecutions(); // Reschedule tasks
  res.status(200).json({ message: 'All tasks deleted successfully.' }); // Or 204 No Content
});

app.delete('/api/tasks/:taskId', async (req: Request<{taskId: string}, any, any>, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const taskIndex = tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    res.status(404).json({ message: 'Task not found.' });
    return;
  }

  tasks.splice(taskIndex, 1);
  await saveData(); // Persist the change
  scheduleTaskExecutions(); // Reschedule tasks
  res.status(204).send(); // No content, successful deletion
});

app.put('/api/tasks/:taskId', async (req: Request<{taskId: string}, any, StrictUpdateTaskRequestBody>, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const {
    name,
    sourceHost,
    destinationHost,
    paths,
    // flags, // flags are handled specially below
    scheduleEnabled,
    scheduleDetails,
    // automationConfigId and triggerFilePath are typically set on creation by automation
    // and usually not directly editable by the user in the main task form.
    // If they need to be editable, they should be included here.
  } = req.body;

  if (!name) {
    res.status(400).json({ message: 'Task name is required' });
    return;
  }
  if (!sourceHost || !destinationHost) {
    res.status(400).json({ message: 'Source and Destination hosts are required' });
    return;
  }
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    res.status(400).json({ message: 'At least one source/destination path pair is required' });
    return;
  }
  for (const p of paths) {
    if (typeof p.source !== 'string' || typeof p.destination !== 'string') {
      res.status(400).json({ message: 'Each path pair must have a source and a destination string.' });
      return;
    }
  }

  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    res.status(404).json({ message: 'Task not found.' });
    return;
  }

  // Preserve automation-related fields if they exist and are not part of the update payload
  const existingTask = tasks[taskIndex];
  
  // Start with new flags if provided in the request body, else use existing flags.
  // Ensure req.body.flags is explicitly checked for undefined to distinguish from an empty array.
  let updatedFlags = req.body.flags !== undefined ? (req.body.flags || []) : [...existingTask.flags];

  // If the task is linked to a turbosort automation, ensure --itemize-changes is present.
  if (existingTask.automationConfigId) {
    const linkedAutomationConfig = automationConfigs.find(ac => ac.id === existingTask.automationConfigId);
    if (linkedAutomationConfig && linkedAutomationConfig.type === 'turbosort') {
      if (!updatedFlags.includes('--itemize-changes')) {
        updatedFlags.push('--itemize-changes');
      }
    }
  }

  tasks[taskIndex] = {
    ...existingTask, // Keeps original ID, automationConfigId, triggerFilePath
    name,
    sourceHost,
    destinationHost,
    paths,
    flags: updatedFlags, // Use the processed flags
    scheduleEnabled: !!scheduleEnabled,
    scheduleDetails: scheduleEnabled ? scheduleDetails : undefined,
  };

  await saveData();
  scheduleTaskExecutions(); // Reschedule tasks
  res.json(tasks[taskIndex]);
});


// --- Rsync Task Execution ---

// New helper function to construct the rsync command
async function constructRsyncCommandForPathPair(
    task: Task,
    pathPair: PathPair,
    hostsList: Host[],
    forDisplayOnly: boolean // If true, skip side-effects like touching files
): Promise<string> {
    const sourceHostObj = hostsList.find(h => h.id === task.sourceHost);
    const destinationHostObj = hostsList.find(h => h.id === task.destinationHost);

    if (!sourceHostObj || !destinationHostObj) {
        // This case should ideally be caught before calling, but as a safeguard:
        throw new Error('Source or destination host not found during command construction.');
    }

    const privateKeyPath = path.join(os.homedir(), '.ssh', 'websync_id_rsa');
    // No fs.existsSync check here for forDisplayOnly, as we're just constructing the command.
    // The actual execution will depend on the key.

    let sourceArg = pathPair.source;
    if (sourceHostObj.id !== 'localhost') {
        sourceArg = `${sourceHostObj.user}@${sourceHostObj.hostname}:${pathPair.source}`;
    }

    let destinationArg = pathPair.destination;
    if (destinationHostObj.id !== 'localhost') {
        destinationArg = `${destinationHostObj.user}@${destinationHostObj.hostname}:${pathPair.destination}`;
    }

    let sshPortForRsync: number | undefined;
    if (destinationHostObj.id !== 'localhost' && destinationHostObj.port) {
        sshPortForRsync = destinationHostObj.port;
    } else if (sourceHostObj.id !== 'localhost' && sourceHostObj.port) {
        sshPortForRsync = sourceHostObj.port;
    }

    const rsyncSshCommand = `ssh -i "${privateKeyPath}" ${sshPortForRsync ? `-p ${sshPortForRsync}` : ''} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes`;
    
    let finalFlags = [...task.flags]; // Start with task's flags

    if (task.automationConfigId) {
        const automationConfig = automationConfigs.find(ac => ac.id === task.automationConfigId);
        
        if (automationConfig && automationConfig.type === 'livework') {
            // Ensure .livework files are excluded for livework automations
            if (!finalFlags.includes("--exclude='*.livework'")) {
                finalFlags.push("--exclude='*.livework'");
            }
        } else if (automationConfig && automationConfig.type === 'turbosort') {
            const projectName = path.basename(pathPair.source.endsWith('/') ? pathPair.source.slice(0, -1) : pathPair.source);
            const excludeFilePathOnSource = path.join(pathPair.source, `.${projectName}_processed.txt`);
            
            if (!forDisplayOnly) { // Only attempt to touch if actually executing
                const touchCommand = `touch '${excludeFilePathOnSource.replace(/'/g, "'\\''")}'`;
                let commandToTouchFile = touchCommand;
                const sourceHostForTouch = hostsList.find(h => h.id === task.sourceHost);

                if (sourceHostForTouch && sourceHostForTouch.id !== 'localhost') {
                    const sshPortOption = sourceHostForTouch.port ? `-p ${sourceHostForTouch.port}` : '';
                    commandToTouchFile = `ssh -i "${privateKeyPath}" ${sshPortOption} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes ${sourceHostForTouch.user}@${sourceHostForTouch.hostname} "${touchCommand.replace(/"/g, '\\"')}"`;
                }
                
                console.log(`[Rsync Exec] Ensuring exclude file exists on ${sourceHostForTouch?.alias || 'localhost'}: ${commandToTouchFile.split(' ')[0]} ...`);
                try {
                    await new Promise<void>((resolveTouch, rejectTouch) => {
                        exec(commandToTouchFile, (touchError, touchStdout, touchStderr) => {
                            if (touchError) {
                                console.error(`[Rsync Exec] Failed to touch exclude file ${excludeFilePathOnSource} on ${sourceHostForTouch?.alias || 'localhost'}: ${touchStderr || touchError.message}`);
                            } else {
                                console.log(`[Rsync Exec] Successfully ensured exclude file ${excludeFilePathOnSource} exists on ${sourceHostForTouch?.alias || 'localhost'}`);
                            }
                            resolveTouch(); 
                        });
                    });
                } catch (e) {
                    console.error(`[Rsync Exec] Error during pre-rsync touch of exclude file for task ${task.name}:`, e);
                }
            }
            const excludeFromFlag = `--exclude-from='${excludeFilePathOnSource.replace(/'/g, "'\\''")}'`;
            if (!finalFlags.includes(excludeFromFlag)) {
                finalFlags.push(excludeFromFlag);
            }
            if (!finalFlags.includes('--itemize-changes')) {
                finalFlags.push('--itemize-changes');
            }
        }
    }
    const effectiveFlagsString = finalFlags.join(' ');
    let rsyncCommand: string;

    if (sourceHostObj.id !== 'localhost' && destinationHostObj.id !== 'localhost') {
        if (sourceHostObj.id === destinationHostObj.id) {
            const remoteLocalRsyncCommand = `rsync ${effectiveFlagsString} '${pathPair.source.replace(/'/g, "'\\''")}' '${pathPair.destination.replace(/'/g, "'\\''")}'`;
            const sshPortOption = sourceHostObj.port ? `-p ${sourceHostObj.port}` : '';
            // For remote-to-same-remote, no agent forwarding (-A) is needed as rsync is local on the remote machine.
            rsyncCommand = `ssh -i "${privateKeyPath}" ${sshPortOption} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes ${sourceHostObj.user}@${sourceHostObj.hostname} "${remoteLocalRsyncCommand.replace(/"/g, '\\"')}"`;
        } else {
            // Inner SSH command (from source host to destination host) needs host key checking options.
            const rhaToRhbSshCommandForRsync = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null${destinationHostObj.port ? ` -p ${destinationHostObj.port}` : ''}`;
            const remoteRsyncCommand = `rsync ${effectiveFlagsString} -e '${rhaToRhbSshCommandForRsync.replace(/'/g, "'\\''")}' '${pathPair.source.replace(/'/g, "'\\''")}' '${destinationHostObj.user}@${destinationHostObj.hostname}:${pathPair.destination.replace(/'/g, "'\\''")}'`;
            const outerSshPortOption = sourceHostObj.port ? `-p ${sourceHostObj.port}` : '';
            // Outer SSH command (from app container to source host) needs agent forwarding (-A) for the inner SSH to use the key.
            rsyncCommand = `ssh -A -i "${privateKeyPath}" ${outerSshPortOption} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes ${sourceHostObj.user}@${sourceHostObj.hostname} "${remoteRsyncCommand.replace(/"/g, '\\"')}"`;
        }
    } else if (sourceHostObj.id !== 'localhost' || destinationHostObj.id !== 'localhost') {
        // rsyncSshCommand already includes -i, StrictHostKeyChecking, UserKnownHostsFile, BatchMode
        rsyncCommand = `rsync ${effectiveFlagsString} -e 'ssh ${rsyncSshCommand.substring(4)}' "${sourceArg}" "${destinationArg}"`;
    } else {
        rsyncCommand = `rsync ${effectiveFlagsString} "${sourceArg}" "${destinationArg}"`;
    }
    return rsyncCommand;
}

interface RsyncExecutionResult {
  pathPair: PathPair;
  success: boolean;
  stdout: string;
  stderr: string;
  command: string; // For debugging
}

async function executeRsyncCommand(task: Task, pathPair: PathPair, hostsList: Host[]): Promise<RsyncExecutionResult> {
  const privateKeyPath = path.join(os.homedir(), '.ssh', 'websync_id_rsa');
  let rsyncCommand: string;
  try {
    rsyncCommand = await constructRsyncCommandForPathPair(task, pathPair, hostsList, false); // forDisplayOnly = false
    if (task.sourceHost && task.destinationHost) { // Check if hosts are defined before logging
        const sourceHostObj = hostsList.find(h => h.id === task.sourceHost);
        const destinationHostObj = hostsList.find(h => h.id === task.destinationHost);
        if (sourceHostObj && destinationHostObj) {
            if (sourceHostObj.id !== 'localhost' && destinationHostObj.id !== 'localhost') {
                if (sourceHostObj.id === destinationHostObj.id) {
                    console.log(`Executing remote-to-same-remote rsync (on ${sourceHostObj.alias}): ${rsyncCommand.split(' ')[0]} ... details in task log`);
                } else {
                    console.log(`Executing remote-to-different-remote rsync (WSS -> ${sourceHostObj.alias} -> ${destinationHostObj.alias}): ${rsyncCommand.split(' ')[0]} ... details in task log`);
                }
            } else if (sourceHostObj.id !== 'localhost' || destinationHostObj.id !== 'localhost') {
                console.log(`Executing rsync (local involved): ${rsyncCommand.split(' ')[0]} ... details in task log`);
            } else {
                console.log(`Executing rsync (local-to-local): ${rsyncCommand.split(' ')[0]} ... details in task log`);
            }
        }
    }
  } catch (constructionError: any) {
    console.error(`Error constructing rsync command for task ${task.name}: ${constructionError.message}`);
    return { pathPair, success: false, stdout: '', stderr: `Command construction failed: ${constructionError.message}`, command: 'N/A' };
  }
  
  return new Promise<RsyncExecutionResult>((resolve) => {
    exec(rsyncCommand, async (error, stdout, stderr) => { // Make callback async
        if (error) {
          console.error(`Rsync execution error for task ${task.name} (${pathPair.source} -> ${pathPair.destination}): ${stderr || error.message}`);
          resolve({ pathPair, success: false, stdout, stderr: stderr || error.message, command: rsyncCommand });
        } else {
          // If successful and part of a .turbosort automation, update the processedLogFile
          if (task.automationConfigId) {
            const automationConfig = automationConfigs.find(ac => ac.id === task.automationConfigId);
            // Ensure sourceHostObj is available in this scope. It's a parameter to executeRsyncCommand.
            const sourceHostObj = hosts.find(h => h.id === task.sourceHost); // Re-fetch or ensure it's passed if not in scope

            if (automationConfig && sourceHostObj && automationConfig.type === 'turbosort' && automationConfig.processedLogFile && task.triggerFilePath) {
              try {
                // Extract project name from the source path
                const projectName = path.basename(pathPair.source.endsWith('/') ? pathPair.source.slice(0, -1) : pathPair.source);
                
                // Place the exclude file inside the project folder itself
                const excludeFilePathOnSource = path.join(pathPair.source, `.${projectName}_processed.txt`);
                // Get the list of files that were transferred in this rsync operation
                // We'll parse the stdout to get the list of files
                const transferredFiles: string[] = [];
                
                // Parse rsync output to extract transferred files using the itemize-changes format
                // Format is: YXcstpoguax PATH
                // Where the first 11 characters are flags and the rest is the path
                const lines = stdout.split('\n');
                
                for (const line of lines) {
                  // Skip empty lines and summary lines
                  if (!line.trim() || line.includes('sent ') || line.includes('total size')) continue;
                  
                  // With --itemize-changes, each line starts with flags like ">f++++++"
                  // We're looking for lines that indicate a file was transferred
                  const itemizeMatch = line.trim().match(/^([<>].*?) (.+)$/);
                  
                  if (itemizeMatch && itemizeMatch[2]) {
                    // First character is '>' for sending, '<' for receiving
                    // Second character is file type (f=file, d=directory, etc)
                    // We only want to track actual files/dirs that were transferred
                    const flags = itemizeMatch[1];
                    const path = itemizeMatch[2];
                    
                    // Check if this was an actual transfer (not just a check)
                    // For files that were actually transferred, there will be a '+' in the update flags
                    if (flags.includes('+') || flags.includes('*') || flags.includes('c')) {
                      transferredFiles.push(path);
                    }
                  }
                }
                
                // If we couldn't parse any files from stdout, log a warning but don't fail
                if (transferredFiles.length === 0) {
                  console.log(`[Rsync Exec] Warning: Could not parse transferred files from rsync output for task ${task.name}`);
                  console.log(`[Rsync Exec] Rsync stdout: ${stdout}`);
                  
                  // DO NOT fall back to using the entire source path
                  // Instead, we'll skip updating the exclude file for this run
                  console.log(`[Rsync Exec] No files were transferred or could be parsed from output. Skipping exclude file update.`);
                  // Removed premature return; The function should continue to resolve the promise.
                }
                
                // Use the same exclude file path that was defined earlier
                // (We're using the file inside the project folder)
                
                // Create a command to append each transferred file to the exclude file
                let appendEntries = '';
                for (const file of transferredFiles) {
                  // Handle the case where we're using the entire source path
                  // (which happens in remote-to-remote transfers)
                  if (file === pathPair.source) {
                    // Extract just the last part of the path (the project folder name)
                    const projectFolderName = path.basename(file.endsWith('/') ? file.slice(0, -1) : file);
                    appendEntries += `${projectFolderName}/\n`; // Add trailing slash to indicate directory
                    console.log(`[Rsync Exec] Adding project folder to exclude list: ${projectFolderName}/`);
                  } else {
                    // Normal case - get the relative path from the source directory
                    let relativePath = file;
                    if (file.startsWith(pathPair.source)) {
                      relativePath = file.substring(pathPair.source.length);
                    }
                    // Skip empty paths AND the top-level directory placeholder "./"
                    // as adding "./" to the exclude file would exclude everything in subsequent runs.
                    if (!relativePath.trim() || relativePath === './') continue;
                    
                    // Add the file to our append string
                    appendEntries += `${relativePath}\n`;
                  }
                }
                
                // If we have files to append, create the command
                let appendCommand = '';
                if (appendEntries) {
                  appendCommand = `echo '${appendEntries.replace(/'/g, "'\\''")}' >> '${excludeFilePathOnSource.replace(/'/g, "'\\''")}'`;
                } else {
                  console.log(`[Rsync Exec] No files to append to exclude list for task ${task.name}`);
                  // Removed return; // Skip if no files to append -- This was preventing promise resolution
                }
                // Only attempt to append if there's a command to run
                if (appendCommand) {
                    let commandToRunOnSourceHost = appendCommand;
                    // privateKeyPath is already defined in the outer scope of executeRsyncCommand

                    if (sourceHostObj.id !== 'localhost') {
                      const sshPortOption = sourceHostObj.port ? `-p ${sourceHostObj.port}` : '';
                      commandToRunOnSourceHost = `ssh -i "${privateKeyPath}" ${sshPortOption} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes ${sourceHostObj.user}@${sourceHostObj.hostname} "${appendCommand.replace(/"/g, '\\"')}"`;
                    }
                    
                    console.log(`Appending to processed log on ${sourceHostObj.alias}: ${commandToRunOnSourceHost.split(' ')[0]} ...`);
                    await new Promise<void>((resolveAppend, rejectAppend) => {
                      exec(commandToRunOnSourceHost, (appendError, appendStdout, appendStderr) => {
                        if (appendError) {
                          console.error(`Failed to append to processed log file ${excludeFilePathOnSource} on ${sourceHostObj.alias}: ${appendStderr || appendError.message}`);
                          // Don't mark rsync as failed, but log this issue.
                        } else {
                          console.log(`Successfully appended transferred files to ${excludeFilePathOnSource} on ${sourceHostObj.alias}`);
                        }
                        resolveAppend(); 
                      });
                    });
                } // End if (appendCommand)
              } catch (e) {
                console.error(`Error during processed log update for task ${task.name}:`, e);
              }
            }
          }
          resolve({ pathPair, success: true, stdout, stderr, command: rsyncCommand });
        }
      });
  });
}

app.post('/api/tasks/:taskId/run', async (req: Request<{taskId: string}, any, any>, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const task = tasks.find(t => t.id === taskId);
  const startTime = new Date().toISOString();

  if (!task) {
    const errorMsg = 'Task not found.';
    jobRunLogs.push({
      id: Date.now().toString() + Math.random().toString(36).substring(2, 7), // More unique ID
      taskId: taskId,
      taskName: 'Unknown Task',
      startTime,
      endTime: new Date().toISOString(),
      status: 'error',
      results: [{ pathPair: {source: 'N/A', destination: 'N/A'}, success: false, stdout: '', stderr: errorMsg, command: 'N/A' }]
    });
    await saveData();
    res.status(404).json({ message: errorMsg });
    return;
  }

  const executionResults: RsyncExecutionResult[] = [];
  for (const pathPair of task.paths) {
    const result = await executeRsyncCommand(task, pathPair, hosts);
    executionResults.push(result);
  }
  
  const endTime = new Date().toISOString();
  const overallSuccess = executionResults.every(r => r.success);
  const someSuccess = executionResults.some(r => r.success);
  let jobStatus: JobRunLog['status'] = 'error';
  if (overallSuccess) {
    jobStatus = 'success';
  } else if (someSuccess) {
    jobStatus = 'warning'; // Some paths succeeded, some failed
  }

  jobRunLogs.push({
    id: Date.now().toString() + Math.random().toString(36).substring(2, 7), // More unique ID
    taskId: task.id,
    taskName: task.name,
    startTime,
    endTime,
    status: jobStatus,
    results: executionResults
  });
  await saveData();

  if (jobStatus === 'success') {
    res.json({ message: `Task "${task.name}" executed successfully.`, results: executionResults });
  } else {
    res.status(500).json({ message: `Task "${task.name}" executed with ${jobStatus === 'warning' ? 'some errors' : 'errors'}.`, results: executionResults });
  }
});

app.post('/api/tasks/run-all', async (req: Request<{}, any, any>, res: Response): Promise<void> => {
  if (tasks.length === 0) {
    res.json({ message: 'No tasks to run.' });
    return;
  }

  console.log('Starting to run all tasks...');
  const allTasksRunSummaries = [];
  for (const task of tasks) {
    const startTime = new Date().toISOString();
    const executionResults: RsyncExecutionResult[] = [];
    for (const pathPair of task.paths) {
      const result = await executeRsyncCommand(task, pathPair, hosts);
      executionResults.push(result);
    }
    const endTime = new Date().toISOString();
    const overallSuccess = executionResults.every(r => r.success);
    const someSuccess = executionResults.some(r => r.success);
    let jobStatus: JobRunLog['status'] = 'error';
    if (overallSuccess) jobStatus = 'success';
    else if (someSuccess) jobStatus = 'warning';

    jobRunLogs.push({
      id: Date.now().toString(),
      taskId: task.id,
      taskName: task.name,
      startTime,
      endTime,
      status: jobStatus,
      results: executionResults
    });
    allTasksRunSummaries.push({ taskId: task.id, taskName: task.name, status: jobStatus, resultsCount: executionResults.length });
  }
  await saveData();
  console.log('Finished running all tasks.');
  res.json({ message: 'All tasks execution attempted.', summary: allTasksRunSummaries });
});

// --- Job Run Log API Endpoint ---
app.get('/api/job-run-logs', (req, res) => {
  // Return logs sorted by start time, newest first
  const sortedLogs = [...jobRunLogs].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  res.json(sortedLogs);
});

// DELETE all job run logs
app.delete('/api/job-run-logs', async (req, res) => {
  jobRunLogs = [];
  await saveData();
  res.status(200).json({ message: 'All job run logs cleared successfully.' });
});

// --- Automation Run Log API Endpoint ---
app.get('/api/automation-run-logs', (req, res) => {
  // Return logs sorted by start time, newest first
  const sortedLogs = [...automationRunLogs].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  res.json(sortedLogs);
});

// DELETE all automation run logs
app.delete('/api/automation-run-logs', async (req, res) => {
  automationRunLogs = [];
  await saveData(); // This will save the empty automationRunLogs to job_history.json
  res.status(200).json({ message: 'All automation run logs cleared successfully.' });
});

// New API endpoint to get the command string for a task
app.get('/api/tasks/:taskId/command', async (req: Request<{taskId: string}, any, any>, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    res.status(404).json({ message: 'Task not found.' });
    return;
  }

  try {
    const commandDetails = [];
    for (const pathPair of task.paths) {
      // Call constructRsyncCommandForPathPair with forDisplayOnly = true
      const commandStr = await constructRsyncCommandForPathPair(task, pathPair, hosts, true);
      commandDetails.push({ pathPair, command: commandStr });
    }
    res.json({ taskName: task.name, commands: commandDetails });
  } catch (error: any) {
    console.error(`Error constructing command for display for task ${taskId}:`, error);
    res.status(500).json({ message: `Failed to construct command for display: ${error.message}` });
  }
});

// A simple API endpoint example
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from WebSync TS API!' });
});

// All other GET requests not handled before will return the main index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Serve index.html for any other routes to support SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Path Autocompletion API Endpoint ---
app.post('/api/hosts/:hostId/suggest-path', async (req: Request<{hostId: string}, any, SuggestPathRequestBody>, res: Response): Promise<void> => {
  const { hostId } = req.params;
  const { currentInputPath } = req.body;

  if (typeof currentInputPath !== 'string') {
    res.status(400).json({ message: 'currentInputPath (string) is required in the request body.' });
    return;
  }

  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    res.status(404).json({ message: 'Host not found.' });
    return;
  }

  try {
    let dirToList: string;
    let prefix: string;

    if (currentInputPath === '' || currentInputPath === '/') {
      dirToList = '/';
      prefix = '';
    } else if (currentInputPath.endsWith('/')) {
      dirToList = currentInputPath;
      prefix = '';
    } else {
      // path.dirname will return '.' if currentInputPath is like 'filename' (no slashes)
      // and '/' if currentInputPath is like '/filename'
      let tempDirName = path.dirname(currentInputPath);
      if (tempDirName === '.' && !currentInputPath.includes('/')) { // e.g. "myf"
          // Assume current directory or root based on context.
          // For simplicity, let's assume root if no slash.
          // Or, if you want to list from where the user is, you might need more context.
          // For now, let's treat "myf" as trying to list from root.
          dirToList = '/'; // Or some default like user's home if known and applicable
          prefix = currentInputPath;
      } else if (tempDirName === '.' && currentInputPath.startsWith('./')) { // e.g. "./myf"
          dirToList = '.'; // Or resolve to an actual path
          prefix = path.basename(currentInputPath);
      }
      else {
        dirToList = tempDirName;
        prefix = path.basename(currentInputPath);
      }
    }
    
    // Ensure dirToList is absolute if it's not explicitly relative like '.'
    if (dirToList !== '.' && !path.isAbsolute(dirToList) && host.id === 'localhost') {
        // This logic might be too simplistic for remote hosts or complex local setups.
        // For now, if it's not clearly absolute for localhost, default to root.
        // This might need refinement based on expected user input patterns.
        // dirToList = '/'; // Reconsidering this, path.dirname usually handles it well.
    }
    if (dirToList === '') dirToList = '/'; // Ensure dirname of "file" doesn't become empty string

    const entries = await listDirectoryContents(host, dirToList);
    
    const suggestions = entries
      .filter(entry => entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(entry => {
        // Construct the full path for the suggestion
        // Ensure no double slashes if dirToList is '/'
        let suggestedPath = (dirToList === '/' ? '/' : dirToList + '/') + entry.name;
        suggestedPath = suggestedPath.replace(/\/\//g, '/'); // Normalize double slashes

        if (entry.type === 'directory') {
          return suggestedPath + '/';
        }
        return suggestedPath;
      })
      .slice(0, 15); // Limit to 15 suggestions

    res.json(suggestions);

  } catch (error: any) {
    // If listDirectoryContents throws an error (e.g., path doesn't exist),
    // it's often not a server error but an invalid user path.
    // Return empty suggestions or a specific error message.
    if (error.message && (error.message.includes('No such file or directory') || error.message.includes('Failed to list'))) {
        // console.warn(`Path suggestion error (likely invalid base path "${dirToList}"): ${error.message}`);
        res.json([]); // Send empty array if base path is invalid
    } else {
        console.error(`Error in suggest-path endpoint for host ${hostId}, path "${currentInputPath}":`, error);
        res.status(500).json({ message: error.message || 'An unexpected error occurred during path suggestion.' });
    }
  }
});


// Helper function to execute a scheduled task
async function runScheduledTask(taskId: string): Promise<void> {
  const task = tasks.find(t => t.id === taskId);
  const startTime = new Date().toISOString();

  if (!task) {
    const errorMsg = `[CronTaskRun] Scheduled task ${taskId} not found during execution.`;
    console.error(errorMsg);
    // Optionally, log this to a system log or a specific part of jobRunLogs if persistent tracking of such errors is needed.
    // For now, console error is the primary notification.
    return;
  }

  console.log(`[CronTaskRun] Automatically running scheduled task: ${task.name} (ID: ${task.id})`);

  const executionResults: RsyncExecutionResult[] = [];
  for (const pathPair of task.paths) {
    const result = await executeRsyncCommand(task, pathPair, hosts);
    executionResults.push(result);
  }

  const endTime = new Date().toISOString();
  const overallSuccess = executionResults.every(r => r.success);
  const someSuccess = executionResults.some(r => r.success);
  let jobStatus: JobRunLog['status'] = 'error';
  if (overallSuccess) {
    jobStatus = 'success';
  } else if (someSuccess) {
    jobStatus = 'warning';
  }

  jobRunLogs.push({
    id: Date.now().toString() + Math.random().toString(36).substring(2, 7), // Unique ID
    taskId: task.id,
    taskName: task.name,
    startTime,
    endTime,
    status: jobStatus,
    results: executionResults
  });
  await saveData(); // Persist the log after task execution
  console.log(`[CronTaskRun] Finished running scheduled task: ${task.name}. Status: ${jobStatus}`);
}

// Function to schedule individual task executions based on their cron strings
function scheduleTaskExecutions() {
    // Stop and clear existing task cron jobs
    taskExecutionCronJobs.forEach(job => job.stop());
    taskExecutionCronJobs = [];

    tasks.forEach(task => {
        if (task.scheduleEnabled && task.scheduleDetails) {
            if (cron.validate(task.scheduleDetails)) {
                try {
                    const job = cron.schedule(task.scheduleDetails, () => {
                        console.log(`[CronTask] Triggering task execution: ${task.name} (ID: ${task.id}) as per schedule: ${task.scheduleDetails}`);
                        runScheduledTask(task.id);
                    }, {
                        // timezone: "Your/Timezone" // Optional: specify timezone if tasks are timezone-sensitive
                    });
                    taskExecutionCronJobs.push(job);
                    console.log(`[Scheduler] Scheduled task execution for "${task.name}" with pattern "${task.scheduleDetails}".`);
                } catch (e) {
                    console.error(`[Scheduler] Failed to schedule task execution for "${task.name}" with pattern "${task.scheduleDetails}". Error: ${e}`);
                }
            } else {
                console.warn(`[Scheduler] Invalid cron pattern "${task.scheduleDetails}" for task "${task.name}". Task will not be scheduled.`);
            }
        }
    });
}

/**
 * Year parsing helpers for .livework automations
 */
function extractYearFromProjectFolderName(folderName: string): number | null {
  // Prefer a leading 4-digit year (e.g., 20250520_Project -> 2025)
  const leadingYear = folderName.match(/^([12]\d{3})/);
  if (leadingYear) {
    const y = parseInt(leadingYear[1], 10);
    if (y >= 1900 && y <= 2099) return y;
  }
  // Fallback: any standalone 19xx/20xx
  const anywhere = folderName.match(/\b(19|20)\d{2}\b/);
  return anywhere ? parseInt(anywhere[0], 10) : null;
}

function liveworkYearBucket(year: number): string {
  const currentDecadeStart = Math.floor(new Date().getFullYear() / 10) * 10;
  const yearDecadeStart = Math.floor(year / 10) * 10;
  return yearDecadeStart < currentDecadeStart ? `${yearDecadeStart}s` : String(year);
}

// In src/server.ts, add this new async function:
async function runAutomationScanServerSide(configId: string) {
    const startTimeForLog = new Date().toISOString();
    const logEntry: Partial<AutomationRunLog> = {
        automationConfigId: '', // Will be set once config is fetched
        automationConfigName: '', // Will be set once config is fetched
        startTime: startTimeForLog,
        messages: [],
        tasksCreatedCount: 0,
        tasksDeletedCount: 0,
        triggerFilesFound: 0,
        status: 'success', // Default, will be changed on error
    };

    const config = automationConfigs.find(ac => ac.id === configId);
    if (!config) {
        const errorMsg = `[CronScan] Automation config ${configId} not found.`;
        console.error(errorMsg);
        logEntry.messages!.push(errorMsg);
        logEntry.status = 'error';
        logEntry.endTime = new Date().toISOString();
        logEntry.id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
        automationRunLogs.push(logEntry as AutomationRunLog);
        await saveData();
        return;
    }

    logEntry.automationConfigId = config.id;
    logEntry.automationConfigName = config.name;
    logEntry.messages!.push(`Starting scan for automation: ${config.name} (ID: ${configId})`);

    if (!config.scanHostId) {
        const errorMsg = `[CronScan] Scan host ID is missing for automation config ${config.name} (${configId}).`;
        console.error(errorMsg);
        logEntry.messages!.push(errorMsg);
        logEntry.status = 'error';
        logEntry.endTime = new Date().toISOString();
        logEntry.id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
        automationRunLogs.push(logEntry as AutomationRunLog);
        await saveData();
        return;
    }

    const scanHost = hosts.find(h => h.id === config.scanHostId);
    if (!scanHost) {
        const errorMsg = `[CronScan] Scan host ${config.scanHostId} not found for automation ${config.name}.`;
        console.error(errorMsg);
        logEntry.messages!.push(errorMsg);
        logEntry.status = 'error';
        logEntry.endTime = new Date().toISOString();
        logEntry.id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
        automationRunLogs.push(logEntry as AutomationRunLog);
        await saveData();
        return;
    }

    // console.log(`[CronScan] Running server-side scan for automation: ${config.name} (ID: ${configId})`); // Covered by logEntry message

    try {
        // 1. Scan for trigger files
        const allFoundFiles = await scanDirectoryOnHost(scanHost, config.scanDirectoryPath);
        const triggerFiles = allFoundFiles.filter(file => file.endsWith(`.${config.type}`));

        logEntry.triggerFilesFound = triggerFiles.length;
        logEntry.messages!.push(`Found ${triggerFiles.length} trigger files.`);
        // console.log(`[CronScan] Found ${triggerFiles.length} trigger files for ${config.name}.`); // Covered by logEntry message

        // 2. Fetch all tasks to compare against
        // (tasks array is already available globally in server.ts)

        // 3. Task Cleanup: Identify and delete tasks whose trigger files are gone
        const tasksForThisAutomation = tasks.filter(task => task.automationConfigId === config.id);
        let tasksDeletedCount = 0;
        for (const task of tasksForThisAutomation) {
            if (task.triggerFilePath && !triggerFiles.includes(task.triggerFilePath)) {
                const taskIndex = tasks.findIndex(t => t.id === task.id);
                if (taskIndex > -1) {
                    tasks.splice(taskIndex, 1);
                    // tasksDeletedCount++; // This local var is removed, using logEntry.tasksDeletedCount
                    logEntry.tasksDeletedCount!++;
                    const deleteMsg = `Deleted task "${task.name}" (trigger file ${task.triggerFilePath} no longer found).`;
                    logEntry.messages!.push(deleteMsg);
                    // console.log(`[CronScan] Deleted task "${task.name}" (trigger file ${task.triggerFilePath} no longer found).`); // Covered by logEntry
                }
            }
        }
        // if (tasksDeletedCount > 0) { // Covered by logEntry summary
        //     console.log(`[CronScan] ${tasksDeletedCount} tasks deleted for ${config.name}.`);
        // }

        // 4. Propose and Create New Jobs
        // let tasksCreatedCount = 0; // This local var is removed, using logEntry.tasksCreatedCount
        for (const triggerFile of triggerFiles) {
            const parentDir = triggerFile.substring(0, triggerFile.lastIndexOf('/'));
            const projectFolderName = parentDir.substring(parentDir.lastIndexOf('/') + 1);
            let specificDestSubDir = "";

            if (config.type === 'turbosort') {
                try {
                    specificDestSubDir = (await readFileContent(scanHost, triggerFile)).trim();
                } catch (e: any) {
                    const errorMsg = `Error reading .turbosort file ${triggerFile}: ${e.message}`;
                    console.error(`[CronScan] ${errorMsg} for ${config.name}`);
                    logEntry.messages!.push(errorMsg);
                    logEntry.status = 'completed_with_errors';
                    continue; // Skip this trigger file
                }
            }

            for (const destHostId of config.destinationHostIds) {
                const destHost = hosts.find(h => h.id === destHostId);
                if (!destHost) {
                    const warnMsg = `Warning: Destination host ${destHostId} not found. Skipping related task creation.`;
                    console.warn(`[CronScan] ${warnMsg} for ${config.name}.`);
                    logEntry.messages!.push(warnMsg);
                    if (logEntry.status !== 'error') logEntry.status = 'completed_with_errors';
                    continue;
                }

                let finalDestinationPath = config.destinationBasePath;
                if (config.type === 'turbosort' && specificDestSubDir) {
                    finalDestinationPath = `${config.destinationBasePath}/${specificDestSubDir}/1_DRIVE`;
                } else {
                    const year = extractYearFromProjectFolderName(projectFolderName);
                    const bucket = year ? liveworkYearBucket(year) : null;
                    finalDestinationPath = `${config.destinationBasePath}/${bucket ? bucket + '/' : ''}${projectFolderName}`;
                }
                finalDestinationPath = finalDestinationPath.replace(/\/\//g, '/');
                const rsyncSourcePath = parentDir.endsWith('/') ? parentDir : parentDir + '/';

                const taskName = `Auto: ${config.name} - ${projectFolderName} to ${destHost.alias}`;

                // Check if a similar task already exists
                const existingTask = tasks.find(t =>
                    t.automationConfigId === config.id &&
                    t.triggerFilePath === triggerFile &&
                    t.sourceHost === config.scanHostId &&
                    t.destinationHost === destHostId &&
                    t.paths.length === 1 &&
                    t.paths[0].source === rsyncSourcePath &&
                    t.paths[0].destination === finalDestinationPath
                );

                if (existingTask) {
                    // console.log(`[CronScan] Task "${taskName}" already exists. Skipping creation.`);
                    continue;
                }

                // Determine schedule for the auto-generated task
                let taskScheduleEnabled = false;
                let taskScheduleDetailsCron: string | undefined = undefined;
                const genSchedule = config.generatedTaskSchedule || 'manual_once';
                if (genSchedule === 'every_5_min') {
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '*/5 * * * *'; // Every 5 Minutes
                } else if (genSchedule === 'every_15_min') {
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '*/15 * * * *'; // Every 15 Minutes
                } else if (genSchedule === 'every_30_min') {
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '*/30 * * * *'; // Every 30 Minutes
                } else if (genSchedule === 'hourly') {
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '0 * * * *'; // Every hour
                } else if (genSchedule === 'every_2_hours') {
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '0 */2 * * *'; // Every 2 Hours
                } else if (genSchedule === 'every_6_hours') {
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '0 */6 * * *'; // Every 6 Hours
                } else if (genSchedule === 'every_12_hours') {
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '0 */12 * * *'; // Every 12 Hours
                } else if (genSchedule === 'daily_3am') { // Changed from daily_4am
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '0 3 * * *'; // Every day at 3 AM
                } else if (genSchedule === 'weekly_sun_3am') { // Changed from weekly_mon_4am
                    taskScheduleEnabled = true;
                    taskScheduleDetailsCron = '0 3 * * 0'; // Every Sunday at 3 AM
                }

                let baseFlags: string[];
                if (config.type === 'livework') {
                    baseFlags = ['-a', '-v', '--delete', '-u', "--exclude='*.livework'"];
                } else { // For turbosort
                    baseFlags = ['-a', '-v', '-u'];
                    if (!baseFlags.includes('--itemize-changes')) { // Should already be handled by POST /api/tasks
                        baseFlags.push('--itemize-changes');
                    }
                    // Note: --exclude-from is handled dynamically in executeRsyncCommand
                }

                const newTask: Task = {
                    id: Date.now().toString() + Math.random().toString(36).substring(2, 7), // More unique ID
                    name: taskName,
                    sourceHost: config.scanHostId,
                    destinationHost: destHostId,
                    paths: [{ source: rsyncSourcePath, destination: finalDestinationPath }],
                    flags: baseFlags,
                    scheduleEnabled: taskScheduleEnabled,
                    scheduleDetails: taskScheduleDetailsCron,
                    automationConfigId: config.id,
                    triggerFilePath: triggerFile,
                };
                tasks.push(newTask);
                // tasksCreatedCount++; // This local var is removed, using logEntry.tasksCreatedCount
                logEntry.tasksCreatedCount!++;
                const createMsg = `Created new task "${newTask.name}".`;
                logEntry.messages!.push(createMsg);
                // console.log(`[CronScan] Created new task "${newTask.name}" for ${config.name}.`); // Covered by logEntry
            }
        }
        // if (tasksCreatedCount > 0) { // Covered by logEntry summary
        //      console.log(`[CronScan] ${tasksCreatedCount} new tasks created for ${config.name}.`);
        // }

        logEntry.messages!.push(`Scan finished for automation: ${config.name}.`);
        // console.log(`[CronScan] Finished server-side scan for automation: ${config.name}`); // Covered by logEntry

    } catch (error: any) {
        const errorMsg = `Critical error during scan: ${error.message}`;
        console.error(`[CronScan] ${errorMsg} for ${config.name} (ID: ${configId})`);
        logEntry.messages!.push(errorMsg);
        logEntry.status = 'error';
    } finally {
        logEntry.endTime = new Date().toISOString();
        logEntry.id = Date.now().toString() + Math.random().toString(36).substring(2, 7); // Ensure ID is unique
        automationRunLogs.push(logEntry as AutomationRunLog);

        const tasksWereModified = logEntry.tasksDeletedCount! > 0 || logEntry.tasksCreatedCount! > 0;

        // Save data if tasks were modified OR if the scan itself had issues/results worth logging permanently
        if (tasksWereModified || logEntry.status === 'error' || logEntry.status === 'completed_with_errors') {
            await saveData();
        } else if (logEntry.triggerFilesFound! > 0 && logEntry.tasksCreatedCount === 0 && logEntry.tasksDeletedCount === 0) { // All existed, still save automation log
            await saveData();
        } else if (logEntry.triggerFilesFound === 0 && logEntry.tasksDeletedCount === 0) { // No triggers, no deletions (a "no-op" scan but still logged)
            await saveData();
        }
            
        if (tasksWereModified) {
            scheduleTaskExecutions(); // Reschedule individual tasks if automation scan changed them
        }
    }
}

// In src/server.ts, add this new function:
function scheduleAutomationScans() {
    // Stop and clear existing cron jobs
    automationScanCronJobs.forEach(job => job.stop());
    automationScanCronJobs = [];

    // Sort automationConfigs to prioritize 'livework' types.
    // This means if multiple automations are scheduled for the exact same cron time,
    // the .livework ones will have had their cron jobs registered first.
    // Note: This does not guarantee sequential execution if they run asynchronously.
    const sortedConfigs = [...automationConfigs].sort((a, b) => {
        if (a.type === 'livework' && b.type !== 'livework') {
            return -1; // a (livework) comes before b
        }
        if (a.type !== 'livework' && b.type === 'livework') {
            return 1;  // b (livework) comes before a
        }
        return 0; // Maintain original order for same types or other types
    });

    sortedConfigs.forEach(config => {
        if (config.scanSchedule && config.scanSchedule !== 'manual') {
            const cronPattern = translateScheduleToCron(config.scanSchedule);
            if (cronPattern && cron.validate(cronPattern)) {
                try {
                    const job = cron.schedule(cronPattern, () => {
                        console.log(`[Cron] Triggering scan for automation: ${config.name} (ID: ${config.id}) as per schedule: ${config.scanSchedule}`);
                        runAutomationScanServerSide(config.id);
                    });
                    automationScanCronJobs.push(job);
                    console.log(`[Scheduler] Scheduled automation scan for "${config.name}" with pattern "${cronPattern}".`);
                } catch (e) {
                    console.error(`[Scheduler] Failed to schedule automation scan for "${config.name}" with pattern "${cronPattern}". Error: ${e}`);
                }
            } else if (cronPattern) {
                 console.warn(`[Scheduler] Invalid cron pattern "${cronPattern}" generated for schedule "${config.scanSchedule}" for config "${config.name}". Scan will not be scheduled.`);
            }
        }
    });
}

// This function is intended for use in tests to reset module-level state.
export function _resetInternalStateForTests() {
  tasks = [];
  automationConfigs = [];
  automationScanCronJobs.forEach(job => job.stop());
  automationScanCronJobs = [];
  taskExecutionCronJobs.forEach(job => job.stop());
  taskExecutionCronJobs = [];
  jobRunLogs = [];
  automationRunLogs = [];
  hosts = [];
}

async function startServer() {
  await loadData();
  app.listen(port, () => {
    console.log(`Project Zeus server listening at http://localhost:${port}`);
  });
  scheduleAutomationScans(); // Initialize automation scan schedules
  scheduleTaskExecutions(); // Initialize individual task execution schedules
}

// Only run startServer if not in a test environment
if (process.env.NODE_ENV !== 'test') {
  startServer();
}
