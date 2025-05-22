import express from 'express';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  // Add other fields like lastRun, status, etc. later
}

let tasks: Task[] = []; // In-memory store for tasks

// --- Host Management ---
interface Host {
  id: string;
  alias: string;
  user: string;
  hostname: string;
  port?: number; // Optional port
}

let hosts: Host[] = [
  // Add a default localhost entry for convenience in tasks
  { id: 'localhost', alias: 'Localhost', user: '', hostname: 'localhost' }
]; // In-memory store for hosts

// GET all hosts
app.get('/api/hosts', (req, res) => {
  res.json(hosts);
});

// POST a new host
app.post('/api/hosts', (req, res) => {
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
  res.status(201).json(newHost);
});

// DELETE a host
app.delete('/api/hosts/:id', (req, res) => {
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
  res.status(204).send(); // No content
});


// --- Task Management --- (Existing code continues)
// GET all tasks
app.get('/api/tasks', (req, res) => {
  res.json(tasks);
});

// POST a new task
app.post('/api/tasks', (req, res) => {
  const {
    name,
    sourceHost,
    destinationHost,
    paths,
    flags,
    scheduleEnabled,
    scheduleDetails,
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
  };
  tasks.push(newTask);
  res.status(201).json(newTask);
});

// A simple API endpoint example
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from WebSync TS API!' });
});

// All other GET requests not handled before will return the main index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`WebSync TS server listening at http://localhost:${port}`);
});
