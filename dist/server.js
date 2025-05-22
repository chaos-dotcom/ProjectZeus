"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const app = (0, express_1.default)();
const port = process.env.PORT || 3000;
// Middleware to parse JSON bodies
app.use(express_1.default.json());
// Serve static files from the 'public' directory
app.use(express_1.default.static(path_1.default.join(__dirname, '..', 'public')));
let tasks = []; // Will be populated by loadData
let automationConfigs = []; // Will be populated by loadData
// --- Data Persistence ---
const DATA_FILE_PATH = path_1.default.join(__dirname, '..', 'websync-data.json');
async function saveData() {
    try {
        const dataToSave = { hosts, tasks, automationConfigs };
        await fs_1.default.promises.writeFile(DATA_FILE_PATH, JSON.stringify(dataToSave, null, 2), 'utf-8');
        // console.log('Data saved to file.'); // Optional: for debugging
    }
    catch (error) {
        console.error('Error saving data to file:', error);
    }
}
async function loadData() {
    let loadedHosts = [];
    let loadedTasks = [];
    let loadedAutomationConfigs = [];
    try {
        if (fs_1.default.existsSync(DATA_FILE_PATH)) {
            const fileContent = await fs_1.default.promises.readFile(DATA_FILE_PATH, 'utf-8');
            const parsedData = JSON.parse(fileContent);
            loadedHosts = parsedData.hosts || [];
            loadedTasks = parsedData.tasks || [];
            loadedAutomationConfigs = parsedData.automationConfigs || [];
        }
    }
    catch (error) {
        console.error('Error reading or parsing data file. Initializing with empty/default data.', error);
    }
    // Ensure 'localhost' is always present and at the beginning.
    // Its alias can be persisted, but core properties are fixed.
    const defaultLocalhostAlias = 'Localhost';
    const localhostFromFile = loadedHosts.find(h => h.id === 'localhost');
    const currentLocalhostAlias = localhostFromFile ? localhostFromFile.alias : defaultLocalhostAlias;
    const localhostEntry = { id: 'localhost', alias: currentLocalhostAlias, user: '', hostname: 'localhost' };
    // Filter out any existing localhost entries from loadedHosts to avoid duplicates, then prepend our controlled one.
    hosts = [localhostEntry, ...loadedHosts.filter(h => h.id !== 'localhost')];
    tasks = loadedTasks;
    automationConfigs = loadedAutomationConfigs;
    // If the file didn't exist initially or was unparsable and resulted in empty data structures, save initial state.
    if (!fs_1.default.existsSync(DATA_FILE_PATH) ||
        ((loadedHosts.length === 0 && !localhostFromFile) && loadedTasks.length === 0 && loadedAutomationConfigs.length === 0)) {
        await saveData();
    }
}
// --- Scanner Functionality ---
// Helper function for recursive local directory scanning
async function getFilesInDirectoryLocalRecursive(dirPath, fileExtensions) {
    let files = [];
    try {
        const entries = await fs_1.default.promises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path_1.default.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                files = files.concat(await getFilesInDirectoryLocalRecursive(fullPath, fileExtensions));
            }
            else if (entry.isFile() && fileExtensions.some(ext => entry.name.endsWith(ext))) {
                files.push(fullPath);
            }
        }
    }
    catch (error) {
        // Log errors for specific subdirectories but continue scanning others if possible
        console.warn(`Warning: Could not read directory ${dirPath}: ${error.message}`);
    }
    return files;
}
async function scanDirectoryOnHost(host, directoryPath) {
    const privateKeyPath = path_1.default.join(os_1.default.homedir(), '.ssh', 'websync_id_rsa');
    if (!fs_1.default.existsSync(privateKeyPath)) {
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
        }
        catch (error) {
            // This top-level catch is for errors that prevent starting the scan at all (e.g., root path doesn't exist)
            console.error(`Error starting local recursive scan for directory ${directoryPath}:`, error);
            throw new Error(`Failed to scan local directory ${directoryPath} recursively: ${error.message}`);
        }
    }
    else {
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
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)(sshCommand, (error, stdout, stderr) => {
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
    }
    catch (error) {
        console.error(`Error in scan-directory endpoint for host ${hostId}, path ${directoryPath}:`, error);
        res.status(500).json({ message: error.message || 'An unexpected error occurred during directory scan.' });
    }
});
async function listDirectoryContents(host, directoryPath) {
    const privateKeyPath = path_1.default.join(os_1.default.homedir(), '.ssh', 'websync_id_rsa');
    // No need to check for key existence here again, as scanDirectoryOnHost and ssh-copy-id handle it.
    // Assume if we reach here for a remote host, key setup is expected.
    if (host.id === 'localhost') {
        try {
            const entries = await fs_1.default.promises.readdir(directoryPath, { withFileTypes: true });
            return entries.map(entry => {
                let type = 'other';
                if (entry.isFile())
                    type = 'file';
                else if (entry.isDirectory())
                    type = 'directory';
                return { name: entry.name, type, path: path_1.default.join(directoryPath, entry.name) };
            });
        }
        catch (error) {
            console.error(`Error listing local directory ${directoryPath}:`, error);
            throw new Error(`Failed to list local directory ${directoryPath}: ${error.message}`);
        }
    }
    else {
        // Remote host: Use SSH to execute 'ls -Ap1 -- "<directoryPath>"'
        // The '--' ensures that if directoryPath starts with a '-', it's not treated as an option.
        const escapedDirectoryPath = directoryPath.replace(/'/g, "'\\''"); // Basic escaping for single quotes
        const listCommand = `ls -Ap1 -- '${escapedDirectoryPath}'`;
        const portOption = host.port ? `-p ${host.port}` : '';
        const sshCommand = `ssh -i "${privateKeyPath}" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${portOption} ${host.user}@${host.hostname} "${listCommand}"`;
        console.log(`Executing remote directory list: ${sshCommand.split(' ')[0]} ...`); // Log only ssh part for brevity
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)(sshCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Remote directory list exec error for ${host.alias} on path ${directoryPath}: ${stderr || error.message}`);
                    return reject(new Error(`Failed to list directory on ${host.alias}. SSH command failed. ${stderr || error.message}`));
                }
                const lines = stdout.trim().split('\n').filter(line => line.length > 0);
                const directoryEntries = lines.map(line => {
                    const isDir = line.endsWith('/');
                    const name = isDir ? line.slice(0, -1) : line;
                    // Construct full path. Note: path.join might not be correct for remote paths if they use different separators.
                    // For simplicity, assuming Unix-like remote paths.
                    const entryPath = (directoryPath.endsWith('/') ? directoryPath : directoryPath + '/') + name;
                    return {
                        name,
                        type: isDir ? 'directory' : 'file',
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
    }
    catch (error) {
        console.error(`Error in list-directory-contents endpoint for host ${hostId}, path ${directoryPath}:`, error);
        res.status(500).json({ message: error.message || 'An unexpected error occurred during directory listing.' });
    }
});
// --- File Content Reading Functionality ---
async function readFileContent(host, filePath) {
    const privateKeyPath = path_1.default.join(os_1.default.homedir(), '.ssh', 'websync_id_rsa');
    if (host.id === 'localhost') {
        try {
            return await fs_1.default.promises.readFile(filePath, 'utf-8');
        }
        catch (error) {
            console.error(`Error reading local file ${filePath}:`, error);
            throw new Error(`Failed to read local file ${filePath}: ${error.message}`);
        }
    }
    else {
        // Remote host: Use SSH to execute 'cat <filePath>'
        const escapedFilePath = filePath.replace(/'/g, "'\\''"); // Basic escaping for single quotes
        const catCommand = `cat '${escapedFilePath}'`;
        const portOption = host.port ? `-p ${host.port}` : '';
        const sshCommand = `ssh -i "${privateKeyPath}" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${portOption} ${host.user}@${host.hostname} "${catCommand}"`;
        // console.log(`Executing remote file read: ${sshCommand}`); // For debugging
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)(sshCommand, (error, stdout, stderr) => {
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
    }
    catch (error) {
        console.error(`Error in read-file endpoint for host ${hostId}, path ${filePath}:`, error);
        res.status(500).json({ message: error.message || 'An unexpected error occurred during file read.' });
    }
});
// --- Automation Config API Endpoints ---
app.get('/api/automation-configs', (req, res) => {
    res.json(automationConfigs);
});
app.post('/api/automation-configs', async (req, res) => {
    const { name, type, scanHostId, scanDirectoryPath, destinationHostIds, destinationBasePath } = req.body;
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
        return res.status(400).json({ message: 'destinationHostIds must be a non-empty array.' });
    }
    for (const destHostId of destinationHostIds) {
        if (!hosts.find(h => h.id === destHostId)) {
            return res.status(400).json({ message: `Invalid hostId "${destHostId}" in destinationHostIds.` });
        }
    }
    const newConfig = {
        id: Date.now().toString(),
        name,
        type,
        scanHostId,
        scanDirectoryPath,
        destinationHostIds,
        destinationBasePath,
    };
    automationConfigs.push(newConfig);
    await saveData();
    res.status(201).json(newConfig);
});
app.put('/api/automation-configs/:id', async (req, res) => {
    const { id } = req.params;
    const { name, type, scanHostId, scanDirectoryPath, destinationHostIds, destinationBasePath } = req.body;
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
        return res.status(400).json({ message: 'destinationHostIds must be a non-empty array.' });
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
        ...automationConfigs[configIndex],
        name,
        type,
        scanHostId,
        scanDirectoryPath,
        destinationHostIds,
        destinationBasePath,
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
let hosts = []; // Will be populated by loadData
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
    const newHost = {
        id: Date.now().toString(),
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
    }
    else { // For localhost, only update alias if provided
        if (alias)
            hosts[hostIndex].alias = alias;
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
    const privateKeyPath = path_1.default.join(os_1.default.homedir(), '.ssh', 'websync_id_rsa');
    const publicKeyPath = `${privateKeyPath}.pub`;
    try {
        // Step 1: Ensure SSH key pair exists for the application
        if (!fs_1.default.existsSync(publicKeyPath)) {
            await new Promise((resolve, reject) => {
                // Generate a new key pair without a passphrase
                // Note: -b 2048 for quicker generation in dev; consider 4096 for production.
                (0, child_process_1.exec)(`ssh-keygen -t rsa -b 2048 -f "${privateKeyPath}" -N ""`, (error, stdout, stderr) => {
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
        await new Promise((resolve, reject) => {
            (0, child_process_1.exec)(sshCopyIdCommand, (error, stdout, stderr) => {
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
    }
    catch (error) {
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
    const { name, sourceHost, destinationHost, paths, flags, scheduleEnabled, scheduleDetails, 
    // New optional fields for automation linking
    automationConfigId, triggerFilePath, } = req.body;
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
    const newTask = {
        id: Date.now().toString(),
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
// --- Rsync Task Execution ---
async function executeRsyncCommand(task, pathPair, hostsList) {
    const sourceHostObj = hostsList.find(h => h.id === task.sourceHost);
    const destinationHostObj = hostsList.find(h => h.id === task.destinationHost);
    if (!sourceHostObj || !destinationHostObj) {
        return { pathPair, success: false, stdout: '', stderr: 'Source or destination host not found.', command: '' };
    }
    const privateKeyPath = path_1.default.join(os_1.default.homedir(), '.ssh', 'websync_id_rsa');
    if (!fs_1.default.existsSync(privateKeyPath)) {
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
    let sshPortForRsync;
    if (destinationHostObj.id !== 'localhost' && destinationHostObj.port) {
        sshPortForRsync = destinationHostObj.port;
    }
    else if (sourceHostObj.id !== 'localhost' && sourceHostObj.port) {
        sshPortForRsync = sourceHostObj.port;
    }
    const rsyncSshCommand = `ssh -i "${privateKeyPath}" ${sshPortForRsync ? `-p ${sshPortForRsync}` : ''} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    const flagsString = task.flags.join(' ');
    // Add -e option only if at least one host is remote
    const rsyncCommand = (sourceHostObj.id !== 'localhost' || destinationHostObj.id !== 'localhost')
        ? `rsync ${flagsString} -e "${rsyncSshCommand}" "${sourceArg}" "${destinationArg}"`
        : `rsync ${flagsString} "${sourceArg}" "${destinationArg}"`;
    console.log(`Executing rsync: ${rsyncCommand}`); // Log the command for debugging
    return new Promise((resolve) => {
        (0, child_process_1.exec)(rsyncCommand, (error, stdout, stderr) => {
            if (error) {
                console.error(`Rsync execution error for task ${task.name} (${pathPair.source} -> ${pathPair.destination}): ${stderr || error.message}`);
                resolve({ pathPair, success: false, stdout, stderr: stderr || error.message, command: rsyncCommand });
            }
            else {
                resolve({ pathPair, success: true, stdout, stderr, command: rsyncCommand });
            }
        });
    });
}
app.post('/api/tasks/:taskId/run', async (req, res) => {
    const { taskId } = req.params;
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
        return res.status(404).json({ message: 'Task not found.' });
    }
    const executionResults = [];
    for (const pathPair of task.paths) {
        const result = await executeRsyncCommand(task, pathPair, hosts);
        executionResults.push(result);
        // If a path pair fails, we could decide to stop or continue with other pairs.
        // For now, let's continue and report all results.
    }
    // Check if all pathPairs were successful
    const overallSuccess = executionResults.every(r => r.success);
    if (overallSuccess) {
        res.json({ message: `Task "${task.name}" executed.`, results: executionResults });
    }
    else {
        // Send 500 if any part failed, but still send results
        res.status(500).json({ message: `Task "${task.name}" executed with some errors.`, results: executionResults });
    }
});
app.post('/api/tasks/run-all', async (req, res) => {
    if (tasks.length === 0) {
        return res.json({ message: 'No tasks to run.' });
    }
    console.log('Starting to run all tasks...');
    const allTasksResults = [];
    for (const task of tasks) {
        const executionResults = [];
        for (const pathPair of task.paths) {
            const result = await executeRsyncCommand(task, pathPair, hosts);
            executionResults.push(result);
        }
        allTasksResults.push({ taskId: task.id, taskName: task.name, results: executionResults });
    }
    console.log('Finished running all tasks.');
    // This response could be very large if there are many tasks/paths or lots of output.
    // Consider how to handle this for many tasks (e.g., background execution and status polling).
    res.json({ message: 'All tasks execution attempted.', summary: allTasksResults });
});
// A simple API endpoint example
app.get('/api/hello', (req, res) => {
    res.json({ message: 'Hello from WebSync TS API!' });
});
// All other GET requests not handled before will return the main index.html
app.get('*', (req, res) => {
    res.sendFile(path_1.default.join(__dirname, '..', 'public', 'index.html'));
});
async function startServer() {
    await loadData();
    app.listen(port, () => {
        console.log(`WebSync TS server listening at http://localhost:${port}`);
    });
}
startServer();
