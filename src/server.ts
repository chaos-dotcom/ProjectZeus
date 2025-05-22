import express from 'express';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// A simple API endpoint example
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from WebSync TS API!' });
});

// All other GET requests not handled before will return the React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`WebSync TS server listening at http://localhost:${port}`);
});
