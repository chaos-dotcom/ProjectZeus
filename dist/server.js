"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const app = (0, express_1.default)();
const port = process.env.PORT || 3000;
// Serve static files from the 'public' directory
app.use(express_1.default.static(path_1.default.join(__dirname, '..', 'public')));
// A simple API endpoint example
app.get('/api/hello', (req, res) => {
    res.json({ message: 'Hello from WebSync TS API!' });
});
// All other GET requests not handled before will return the React app
app.get('*', (req, res) => {
    res.sendFile(path_1.default.join(__dirname, '..', 'public', 'index.html'));
});
app.listen(port, () => {
    console.log(`WebSync TS server listening at http://localhost:${port}`);
});
