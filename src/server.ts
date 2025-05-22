import express from 'express';
import path from 'path';
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve projectzeus.gif from the project root
app.get('/projectzeus.gif', (req, res) => {
  const gifPath = path.join(__dirname, '..', 'projectzeus.gif'); // Resolves to PROJECT_ROOT/projectzeus.gif
  res.sendFile(gifPath, (err) => {
    if (err) {
      console.error('Error sending projectzeus.gif:', err);
      // Avoid sending HTML error page for a missing image, just end the response.
      if (!res.headersSent) {
        // Check if err has a status property, otherwise default to 404
        const statusCode = (err as any).status || (err as any).statusCode || 404;
        res.status(statusCode).end();
      }
    }
  });
});

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

let tasks: Task[] = []; // Will be populated by loadData

// --- Automation Configuration ---
interface AutomationConfig {
  id: string;
  name: string;
  type: 'livework' | 'turbosort'; // The type of file that triggers this automation
  scanHostId: string;             // The host where scanning for trigger files occurs
  scanDirectoryPath: string;      // The base directory on scanHostId to scan recursively
  destinationHostIds: string[];   // Array of host IDs to copy the project folder to
  destinationBasePath: string;    // Base path on each destination host
  processedLogFile?: string;      // For .turbosort: filename on source host listing processed project folders
  // templateTaskId?: string; // For future use: ID of a Task to use as a template
}

let automationConfigs: AutomationConfig[] = []; // Will be populated by loadData

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

let jobRunLogs: JobRunLog[] = []; // Will be populated by loadData


// --- Data Persistence ---
const DATA_FILE_PATH = path.join(__dirname, '..', 'websync-data.json');

async function saveData(): Promise<void> {
  try {
    const dataToSave = { hosts, tasks, automationConfigs, jobRunLogs };
    await fs.promises.writeFile(DATA_FILE_PATH, JSON.stringify(dataToSave, null, 2), 'utf-8');
    // console.log('Data saved to file.'); // Optional: for debugging
  } catch (error) {
    console.error('Error saving data to file:', error);
  }
}

async function loadData(): Promise<void> {
  let loadedHosts: Host[] = [];
  let loadedTasks: Task[] = [];
  let loadedAutomationConfigs: AutomationConfig[] = [];
  let loadedJobRunLogs: JobRunLog[] = [];

  try {
    if (fs.existsSync(DATA_FILE_PATH)) {
      const fileContent = await fs.promises.readFile(DATA_FILE_PATH, 'utf-8');
      const parsedData = JSON.parse(fileContent);
      loadedHosts = parsedData.hosts || [];
      loadedTasks = parsedData.tasks || [];
      loadedAutomationConfigs = parsedData.automationConfigs || [];
      loadedJobRunLogs = parsedData.jobRunLogs || [];
    }
  } catch (error) {
    console.error('Error reading or parsing data file. Initializing with empty/default data.', error);
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

  // If the file didn't exist initially or was unparsable and resulted in empty data structures, save initial state.
  if (!fs.existsSync(DATA_FILE_PATH) || 
      ((loadedHosts.length === 0 && !localhostFromFile) && 
       loadedTasks.length === 0 && 
       loadedAutomationConfigs.length === 0 &&
       loadedJobRunLogs.length === 0)
     ) {
    await saveData(); 
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

app.post('/api/hosts/:hostId/scan-directory', async (req, res) => {
  const { hostId } = req.params;
  const { directoryPath } = req.body;

  if (!directoryPath) {
    return res.status(400).json({ message: 'directoryPath is required in the request body.' });
  }

  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    return res.status(404).json({ message: 'Host not found.' });
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

app.post('/api/hosts/:hostId/list-directory-contents', async (req, res) => {
  const { hostId } = req.params;
  const { directoryPath } = req.body;

  if (!directoryPath) {
    return res.status(400).json({ message: 'directoryPath is required in the request body.' });
  }

  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    return res.status(404).json({ message: 'Host not found.' });
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

app.post('/api/hosts/:hostId/read-file', async (req, res) => {
  const { hostId } = req.params;
  const { filePath } = req.body;

  if (!filePath) {
    return res.status(400).json({ message: 'filePath is required in the request body.' });
  }

  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    return res.status(404).json({ message: 'Host not found.' });
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

app.post('/api/automation-configs', async (req, res) => {
  const { 
    name, 
    type, 
    scanHostId, 
    scanDirectoryPath, 
    destinationHostIds, 
    destinationBasePath 
  } = req.body;

  if (!name || !type || !scanHostId || !scanDirectoryPath || !destinationHostIds || !destinationBasePath) {
    return res.status(400).json({ message: 'Name, type, scanHostId, scanDirectoryPath, destinationHostIds, and destinationBasePath are required.' });
  }
  if (type !== 'livework' && type !== 'turbosort') {
    return res.status(400).json({ message: 'Invalid type. Must be "livework" or "turbosort".' });
  }
  if (!hosts.find(h => h.id === scanHostId)) {
    return res.status(400).json({ message: 'scanHostId does not refer to a valid host.' });
  }
  if (!Array.isArray(destinationHostIds) || destinationHostIds.length === 0) {
    return res.status(400).json({ message: 'destinationHostIds must be a non-empty array.'});
  }
  for (const destHostId of destinationHostIds) {
    if (!hosts.find(h => h.id === destHostId)) {
      return res.status(400).json({ message: `Invalid hostId "${destHostId}" in destinationHostIds.` });
    }
  }

  const newConfig: AutomationConfig = {
    id: Date.now().toString(),
    name,
    type,
    scanHostId,
    scanDirectoryPath,
    destinationHostIds,
    destinationBasePath,
  };

  if (type === 'turbosort') {
    // Base filename for the processed log file - we'll create project-specific ones at runtime
    newConfig.processedLogFile = `.projectzeus_processed_${newConfig.id}`;
  }

  automationConfigs.push(newConfig);
  await saveData();
  res.status(201).json(newConfig);
});

app.put('/api/automation-configs/:id', async (req, res) => {
  const { id } = req.params;
  const { 
    name, 
    type, 
    scanHostId, 
    scanDirectoryPath, 
    destinationHostIds, 
    destinationBasePath 
  } = req.body;

  if (!name || !type || !scanHostId || !scanDirectoryPath || !destinationHostIds || !destinationBasePath) {
    return res.status(400).json({ message: 'Name, type, scanHostId, scanDirectoryPath, destinationHostIds, and destinationBasePath are required.' });
  }
  if (type !== 'livework' && type !== 'turbosort') {
    return res.status(400).json({ message: 'Invalid type. Must be "livework" or "turbosort".' });
  }
  if (!hosts.find(h => h.id === scanHostId)) {
    return res.status(400).json({ message: 'scanHostId does not refer to a valid host.' });
  }
  if (!Array.isArray(destinationHostIds) || destinationHostIds.length === 0) {
    return res.status(400).json({ message: 'destinationHostIds must be a non-empty array.'});
  }
  for (const destHostId of destinationHostIds) {
    if (!hosts.find(h => h.id === destHostId)) {
      return res.status(400).json({ message: `Invalid hostId "${destHostId}" in destinationHostIds.` });
    }
  }

  const configIndex = automationConfigs.findIndex(ac => ac.id === id);
  if (configIndex === -1) {
    return res.status(404).json({ message: 'Automation configuration not found.' });
  }

  automationConfigs[configIndex] = {
    ...automationConfigs[configIndex], // Keep original ID and any other non-updated fields
    name,
    type,
    scanHostId,
    scanDirectoryPath,
    destinationHostIds,
    destinationBasePath,
    // Ensure processedLogFile is handled correctly on update
    processedLogFile: type === 'turbosort' 
                      ? (automationConfigs[configIndex].processedLogFile || `.projectzeus_processed_${id}.txt`) 
                      : undefined,
  };

  await saveData();
  res.json(automationConfigs[configIndex]);
});

app.delete('/api/automation-configs/:id', async (req, res) => {
  const { id } = req.params;
  const configIndex = automationConfigs.findIndex(ac => ac.id === id);

  if (configIndex === -1) {
    return res.status(404).json({ message: 'Automation configuration not found.' });
  }

  automationConfigs.splice(configIndex, 1);
  await saveData();
  res.status(204).send();
});


// --- Host Management ---
interface Host {
  id: string;
  alias: string;
  user: string;
  hostname: string;
  port?: number; // Optional port
}

let hosts: Host[] = []; // Will be populated by loadData

// GET all hosts
app.get('/api/hosts', (req, res) => {
  res.json(hosts);
});

// POST a new host
app.post('/api/hosts', async (req, res) => {
  const { alias, user, hostname, port } = req.body;

  if (!alias || !user || !hostname) {
    return res.status(400).json({ message: 'Alias, User, and Hostname are required' });
  }
  if (port && (isNaN(parseInt(port, 10)) || parseInt(port, 10) <= 0 || parseInt(port, 10) > 65535)) {
    return res.status(400).json({ message: 'Port must be a valid number between 1 and 65535' });
  }

  const newHost: Host = {
    id: Date.now().toString(), // Simple ID generation
    alias,
    user,
    hostname,
    port: port ? parseInt(port, 10) : undefined,
  };
  hosts.push(newHost);
  await saveData();
  res.status(201).json(newHost);
});

// PUT (update) an existing host
app.put('/api/hosts/:id', async (req, res) => {
  const { id } = req.params;
  const { alias, user, hostname, port } = req.body;

  if (id === 'localhost' && (req.body.user || req.body.hostname || req.body.port)) {
    // Allow changing alias of localhost, but not other critical fields.
    if (Object.keys(req.body).some(key => !['alias'].includes(key))) {
         return res.status(400).json({ message: 'Only the alias of Localhost can be modified.' });
    }
  }

  if (!alias) { // User and hostname might not be sent if only alias is changing for localhost
    if (id !== 'localhost' || !req.body.alias) { // if not localhost, or if localhost and no alias sent
        return res.status(400).json({ message: 'Alias is required' });
    }
  }
  if (id !== 'localhost' && (!user || !hostname)) {
      return res.status(400).json({ message: 'User and Hostname are required for non-localhost entries' });
  }

  if (port && (isNaN(parseInt(port, 10)) || parseInt(port, 10) <= 0 || parseInt(port, 10) > 65535)) {
    return res.status(400).json({ message: 'Port must be a valid number between 1 and 65535' });
  }

  const hostIndex = hosts.findIndex(h => h.id === id);
  if (hostIndex === -1) {
    return res.status(404).json({ message: 'Host not found' });
  }

  // Update fields
  hosts[hostIndex].alias = alias || hosts[hostIndex].alias; // Keep old alias if new one not provided (e.g. for localhost)
  if (id !== 'localhost') {
    hosts[hostIndex].user = user;
    hosts[hostIndex].hostname = hostname;
    hosts[hostIndex].port = port ? parseInt(port, 10) : undefined;
  } else { // For localhost, only update alias if provided
      if (alias) hosts[hostIndex].alias = alias;
  }

  await saveData();
  res.json(hosts[hostIndex]);
});

// DELETE a host
app.delete('/api/hosts/:id', async (req, res) => {
  const { id } = req.params;
  // Prevent deleting the default 'localhost' entry if it's special
  if (id === 'localhost') {
      return res.status(400).json({ message: 'Cannot delete the default Localhost entry.' });
  }
  const hostIndex = hosts.findIndex(h => h.id === id);
  if (hostIndex === -1) {
    return res.status(404).json({ message: 'Host not found' });
  }
  hosts.splice(hostIndex, 1);
  await saveData();
  res.status(204).send(); // No content
});


// SSH Key Copy ID
app.post('/api/hosts/:id/ssh-copy-id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: 'Password is required.' });
  }

  const host = hosts.find(h => h.id === id);
  if (!host || host.id === 'localhost') {
    return res.status(404).json({ message: 'Host not found or operation not applicable to Localhost.' });
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
          resolve();
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
        if (error) {
          console.error(`ssh-copy-id error: ${stderr}`);
          // Try to provide a more user-friendly error from stderr
          if (stderr.toLowerCase().includes('permission denied')) {
            return reject(new Error('Permission denied. Please check the password and user permissions.'));
          }
          return reject(new Error(`Failed to copy SSH ID: ${stderr || error.message}`));
        }
        console.log(`ssh-copy-id output: ${stdout}`);
        resolve();
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
app.post('/api/tasks', async (req, res) => {
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
    return res.status(400).json({ message: 'Task name is required' });
  }
  if (!sourceHost || !destinationHost) {
    return res.status(400).json({ message: 'Source and Destination hosts are required' });
  }
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ message: 'At least one source/destination path pair is required' });
  }
  // Basic validation for paths
  for (const p of paths) {
    if (typeof p.source !== 'string' || typeof p.destination !== 'string') {
      return res.status(400).json({ message: 'Each path pair must have a source and a destination string.' });
    }
  }

  const newTask: Task = {
    id: Date.now().toString(), // Simple ID generation
    name,
    sourceHost,
    destinationHost,
    paths,
    flags: flags || [],
    scheduleEnabled: !!scheduleEnabled,
    scheduleDetails: scheduleEnabled ? scheduleDetails : undefined,
    automationConfigId: automationConfigId || undefined,
    triggerFilePath: triggerFilePath || undefined,
  };
  tasks.push(newTask);
  await saveData();
  res.status(201).json(newTask);
});

app.delete('/api/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const taskIndex = tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    return res.status(404).json({ message: 'Task not found.' });
  }

  tasks.splice(taskIndex, 1);
  await saveData(); // Persist the change
  res.status(204).send(); // No content, successful deletion
});

app.put('/api/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const {
    name,
    sourceHost,
    destinationHost,
    paths,
    flags,
    scheduleEnabled,
    scheduleDetails,
    // automationConfigId and triggerFilePath are typically set on creation by automation
    // and usually not directly editable by the user in the main task form.
    // If they need to be editable, they should be included here.
  } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Task name is required' });
  }
  if (!sourceHost || !destinationHost) {
    return res.status(400).json({ message: 'Source and Destination hosts are required' });
  }
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ message: 'At least one source/destination path pair is required' });
  }
  for (const p of paths) {
    if (typeof p.source !== 'string' || typeof p.destination !== 'string') {
      return res.status(400).json({ message: 'Each path pair must have a source and a destination string.' });
    }
  }

  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    return res.status(404).json({ message: 'Task not found.' });
  }

  // Preserve automation-related fields if they exist and are not part of the update payload
  const existingTask = tasks[taskIndex];
  tasks[taskIndex] = {
    ...existingTask, // Keeps original ID, automationConfigId, triggerFilePath
    name,
    sourceHost,
    destinationHost,
    paths,
    flags: flags || [],
    scheduleEnabled: !!scheduleEnabled,
    scheduleDetails: scheduleEnabled ? scheduleDetails : undefined,
  };

  await saveData();
  res.json(tasks[taskIndex]);
});


// --- Rsync Task Execution ---
interface RsyncExecutionResult {
  pathPair: PathPair;
  success: boolean;
  stdout: string;
  stderr: string;
  command: string; // For debugging
}

async function executeRsyncCommand(task: Task, pathPair: PathPair, hostsList: Host[]): Promise<RsyncExecutionResult> {
  const sourceHostObj = hostsList.find(h => h.id === task.sourceHost);
  const destinationHostObj = hostsList.find(h => h.id === task.destinationHost);

  if (!sourceHostObj || !destinationHostObj) {
    return { pathPair, success: false, stdout: '', stderr: 'Source or destination host not found.', command: '' };
  }

  const privateKeyPath = path.join(os.homedir(), '.ssh', 'websync_id_rsa');
  if (!fs.existsSync(privateKeyPath)) {
    // This key is essential for remote operations.
    // The ssh-copy-id feature should have created it. If not, remote rsync will fail.
    console.warn(`SSH private key ${privateKeyPath} not found. Remote rsync operations will likely fail.`);
    // For localhost-to-localhost, this key isn't strictly needed by rsync itself, but good to be aware.
  }

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
  
  const flagsString = task.flags.join(' ');
  let rsyncCommand: string;
  let finalFlags = [...task.flags]; // Start with task's flags

  // Check if this task is from a .turbosort automation and needs an exclude file
  if (task.automationConfigId) {
    const automationConfig = automationConfigs.find(ac => ac.id === task.automationConfigId);
    
    // --- SERVER-SIDE DEBUGGING for --exclude-from ---
    console.log(`[Rsync Exec] Task ID: ${task.id}, AutomationConfigID: ${task.automationConfigId}`);
    if (automationConfig) {
      console.log(`[Rsync Exec] Found AutomationConfig: ID=${automationConfig.id}, Type=${automationConfig.type}, ProcessedLogFile=${automationConfig.processedLogFile}, ScanPath=${automationConfig.scanDirectoryPath}`);
    } else {
      console.log(`[Rsync Exec] No AutomationConfig found for ID: ${task.automationConfigId}`);
    }
    // --- END SERVER-SIDE DEBUGGING ---

    if (automationConfig && automationConfig.type === 'turbosort') {
      // Extract project name from the source path
      const projectName = path.basename(pathPair.source.endsWith('/') ? pathPair.source.slice(0, -1) : pathPair.source);
      
      // Place the exclude file inside the project folder itself
      // The path is constructed using sourcePath (pathPair.source) and projectFolderName (projectName)
      let excludeFilePathOnSource = path.join(pathPair.source, `.${projectName}_processed.txt`);
      
      // For debugging
      console.log(`[Rsync Exec] Using project-specific exclude file: ${excludeFilePathOnSource} for project: ${projectName}`);
      
      // --- Ensure the exclude file exists on the source host BEFORE rsync ---
      const touchCommand = `touch '${excludeFilePathOnSource.replace(/'/g, "'\\''")}'`;
      let commandToTouchFile = touchCommand;
      const sourceHostForTouch = hosts.find(h => h.id === task.sourceHost); // Get source host object

      if (sourceHostForTouch && sourceHostForTouch.id !== 'localhost') {
        const sshPortOption = sourceHostForTouch.port ? `-p ${sourceHostForTouch.port}` : '';
        commandToTouchFile = `ssh -i "${privateKeyPath}" ${sshPortOption} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes ${sourceHostForTouch.user}@${sourceHostForTouch.hostname} "${touchCommand.replace(/"/g, '\\"')}"`;
      }
      
      console.log(`[Rsync Exec] Ensuring exclude file exists on ${sourceHostForTouch?.alias || 'localhost'}: ${commandToTouchFile.split(' ')[0]} ...`);
      try {
        await new Promise<void>((resolveTouch, rejectTouch) => {
          exec(commandToTouchFile, (touchError, touchStdout, touchStderr) => {
            if (touchError) {
              // Log the error but proceed; rsync will fail if it can't read it, but at least we tried.
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
      // --- End ensure exclude file exists ---

      // Add the exclude-from flag
      finalFlags.push(`--exclude-from='${excludeFilePathOnSource.replace(/'/g, "'\\''")}'`);
      
      // Add itemize-changes flag if not already present - this provides structured output of changed files
      if (!finalFlags.includes('--itemize-changes')) {
        finalFlags.push('--itemize-changes');
      }
      console.log(`[Rsync Exec] ADDED --exclude-from and --itemize-changes (if needed) for turbosort task ${task.id}`); // DEBUG
    } else {
      // Updated log message to reflect that the main condition for not adding is not being a turbosort task,
      // or automationConfig not being found.
      console.log(`[Rsync Exec] DID NOT add --exclude-from for task ${task.id}. Conditions: automationConfig found=${!!automationConfig}, type=${automationConfig?.type}`); // DEBUG
    }
  }
  const effectiveFlagsString = finalFlags.join(' ');


  if (sourceHostObj.id !== 'localhost' && destinationHostObj.id !== 'localhost') {
    if (sourceHostObj.id === destinationHostObj.id) {
      // Remote-to-SAME-Remote: SSH into the host and perform a local rsync there.
      const remoteLocalRsyncCommand = `rsync ${effectiveFlagsString} '${pathPair.source.replace(/'/g, "'\\''")}' '${pathPair.destination.replace(/'/g, "'\\''")}'`;
      const sshPortOption = sourceHostObj.port ? `-p ${sourceHostObj.port}` : '';
      rsyncCommand = `ssh -i "${privateKeyPath}" ${sshPortOption} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes ${sourceHostObj.user}@${sourceHostObj.hostname} "${remoteLocalRsyncCommand.replace(/"/g, '\\"')}"`;
      console.log(`Executing remote-to-same-remote rsync (on ${sourceHostObj.alias}): ${rsyncCommand.split(' ')[0]} ... details in task log`);
    } else {
      // Remote-to-DIFFERENT-Remote: SSH into sourceHostObj (RHA) and execute rsync from there to destinationHostObj (RHB).
      const rhaToRhbSshCommandForRsync = `ssh${destinationHostObj.port ? ` -p ${destinationHostObj.port}` : ''}`;
      const remoteRsyncCommand = `rsync ${effectiveFlagsString} -e '${rhaToRhbSshCommandForRsync.replace(/'/g, "'\\''")}' '${pathPair.source.replace(/'/g, "'\\''")}' '${destinationHostObj.user}@${destinationHostObj.hostname}:${pathPair.destination.replace(/'/g, "'\\''")}'`;
      const outerSshPortOption = sourceHostObj.port ? `-p ${sourceHostObj.port}` : '';
      rsyncCommand = `ssh -i "${privateKeyPath}" ${outerSshPortOption} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes ${sourceHostObj.user}@${sourceHostObj.hostname} "${remoteRsyncCommand.replace(/"/g, '\\"')}"`;
      console.log(`Executing remote-to-different-remote rsync (WSS -> ${sourceHostObj.alias} -> ${destinationHostObj.alias}): ${rsyncCommand.split(' ')[0]} ... details in task log`);
    }
  } else if (sourceHostObj.id !== 'localhost' || destinationHostObj.id !== 'localhost') {
    // Local-to-Remote or Remote-to-Local
    rsyncCommand = `rsync ${effectiveFlagsString} -e 'ssh ${rsyncSshCommand.substring(4)}' "${sourceArg}" "${destinationArg}"`;
    console.log(`Executing rsync (local involved): ${rsyncCommand}`);
  } else {
    // Local-to-Local
    rsyncCommand = `rsync ${effectiveFlagsString} "${sourceArg}" "${destinationArg}"`;
    console.log(`Executing rsync (local-to-local): ${rsyncCommand}`);
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
                  return; // Skip the rest of the function
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
                    // Skip empty paths
                    if (!relativePath.trim()) continue;
                    
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
                  return; // Skip if no files to append
                }
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

app.post('/api/tasks/:taskId/run', async (req, res) => {
  const { taskId } = req.params;
  const task = tasks.find(t => t.id === taskId);
  const startTime = new Date().toISOString();

  if (!task) {
    const errorMsg = 'Task not found.';
    jobRunLogs.push({
      id: Date.now().toString(),
      taskId: taskId,
      taskName: 'Unknown Task',
      startTime,
      endTime: new Date().toISOString(),
      status: 'error',
      results: [{ pathPair: {source: 'N/A', destination: 'N/A'}, success: false, stdout: '', stderr: errorMsg, command: 'N/A' }]
    });
    await saveData();
    return res.status(404).json({ message: errorMsg });
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
    id: Date.now().toString(),
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

app.post('/api/tasks/run-all', async (req, res) => {
  if (tasks.length === 0) {
    return res.json({ message: 'No tasks to run.' });
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


// A simple API endpoint example
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from WebSync TS API!' });
});

// All other GET requests not handled before will return the main index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function startServer() {
  await loadData();
  app.listen(port, () => {
    console.log(`Project Zeus server listening at http://localhost:${port}`);
  });
}

startServer();
