import express from 'express';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Task Management ---
interface Task {
  id: string;
  name: string;
  // We will add more properties like source, destination, schedule, flags later
}

let tasks: Task[] = []; // In-memory store for tasks

// GET all tasks
app.get('/api/tasks', (req, res) => {
  res.json(tasks);
});

// POST a new task
app.post('/api/tasks', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Task name is required' });
  }
  const newTask: Task = {
    id: Date.now().toString(), // Simple ID generation
    name,
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
