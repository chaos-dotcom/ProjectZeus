# Project Zeus

Project Zeus is a web-based task manager for rsync, designed to help you add, schedule, and maintain rsync tasks in a modern and user-friendly interface. This project is built with TypeScript, Node.js, and Express.

It is not a fork but heavily inspired by [websync](https://github.com/furier/websync) which having been archived by it's owner in 2019 now means has a number of security vulnerabilities which meant it was easier to write a entirely new program from the ground up in typescript, it is worth mention this is not a fork of the code no code was copied or transferred,  I love the ideas that websync created with and honor it with a reference to it in the SSH key that zeus uses to connect to the first system for rsyncing. 

Many of the functions are the same with some additional functions that are niche but are designed for my own workflow. if you find these useful then that is wonderful. 


## Features

*   **Web-Based UI:** Intuitive interface for managing rsync operations.
*   **Host Management:** Add, edit, and delete remote hosts for rsync tasks. Includes SSH key setup assistance.
*   **Task Management (Default View):**
    *   Define rsync tasks with multiple source/destination path pairs.
    *   Select rsync flags from a predefined list or add custom ones.
    *   Manually run individual tasks or all tasks.
*   **Automation:**
    *   Configure automated scanning of directories on hosts for specific trigger files (`.livework`, `.turbosort`).
    *   Automatically propose and create rsync tasks based on found trigger files and configurable destination settings.
    *   Handles cleanup of tasks if trigger files are removed.
*   **Client-Side Logging:** View console messages (logs, warnings, errors) directly in the "Logs" tab.
*   **Data Persistence:** Host configurations, tasks, and automation configurations are saved to a local `websync-data.json` file.
*   **Real-time Feedback:** In-page message banners for operations, with detailed console logging for task execution.

## Project Structure

```
project-zeus/
├── dist/                 # Compiled JavaScript output
├── node_modules/         # Project dependencies
├── public/               # Static frontend assets (HTML, CSS, client-side JS)
│   └── index.html        # Main application page
├── src/                  # TypeScript source files
│   └── server.ts         # Backend server logic
├── package.json          # Project metadata and dependencies
├── tsconfig.json         # TypeScript compiler configuration
├── websync-data.json     # Persisted application data (hosts, tasks, automations)
└── README.md             # This file
```

## Prerequisites

*   Node.js (v23.x or later recommended)
*   npm (usually comes with Node.js)
*   `rsync` installed on the server running Project Zeus TS and on any remote hosts.
*   `sshpass` installed on the server running Project Zeus TS (for the "SSH Setup" feature to copy SSH keys).
    *   Debian/Ubuntu: `sudo apt-get install sshpass`
    *   macOS (Homebrew): `brew install hudochenkov/sshpass/sshpass` or `brew install sshpass`
*   SSH access configured for any remote hosts you intend to use (passwordless key-based authentication is recommended for automated tasks).

## Setup and Running

1.  **Clone the repository (if applicable):**
    ```bash
    git clone <repository-url>
    cd project-zeus
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Build the TypeScript code:**
    ```bash
    npm run build
    ```
    This compiles the TypeScript files from `src/` into JavaScript in `dist/`.

4.  **Run the server:**
    *   For production/manual start:
        ```bash
        npm start
        ```
    *   For development (automatically rebuilds on changes in `src/` and restarts):
        ```bash
        npm run dev
        ```
        Note: The `dev` script runs `npm run build && npm start`. Ensure `tsc` (TypeScript compiler) completes without errors for the latest changes to be active.

5.  **Access the application:**
    Open your web browser and navigate to `http://localhost:3000` (or the configured port).

## Using the Application

### Hosts Tab
*   Add new hosts by providing an Alias, Username, Hostname/IP, and an optional Port.
*   The "SSH Setup" button attempts to copy the Project Zeus server's `~/.ssh/websync_id_rsa.pub` key to the target host using the provided password (via `sshpass`). This key is then used for subsequent SSH operations like scanning and rsync. If the `websync_id_rsa` key pair doesn't exist on the Project Zeus server, it will be generated.
*   Edit or delete existing host configurations.

### Tasks Tab
*   Create new rsync tasks:
    *   Specify a task name.
    *   Select source and destination hosts (can be "Localhost" or any configured remote host).
    *   Define one or more source/destination path pairs.
    *   Select rsync flags from the provided buttons or manually type them.
    *   (Schedule functionality is present in UI but not fully implemented for automated execution yet).
*   Run individual tasks using the "Run" button next to each task.
*   Run all defined tasks using the "Run All Tasks" button.
*   Delete tasks.

### Automation Tab
*   **Automation Configurations:**
    *   Define configurations that specify:
        *   A name for the automation.
        *   The type of trigger file (`.livework` or `.turbosort`).
        *   A "Scan Host" where trigger files will be searched.
        *   A "Scan Directory Path" on the scan host (recursive scan).
        *   One or more "Destination Hosts".
        *   A "Destination Base Path" on the destination hosts.
    *   Save these configurations. They are persisted in `websync-data.json`.
*   **Running Automations:**
    *   Click "Scan for Files" for a saved automation configuration.
    *   The system scans the specified path on the scan host.
    *   If `.turbosort` files are found, their content is read to determine an additional subdirectory for the destination path.
    *   The system identifies project folders (parent directories of found trigger files).
    *   It proposes rsync tasks to copy these project folders to the configured destination hosts and paths.
    *   It checks for existing tasks created by the same automation for the same trigger files and destinations, and will skip proposing duplicates.
    *   If trigger files are no longer found, associated tasks previously created by this automation are deleted.
    *   A "Create Proposed Tasks" button appears if new tasks are proposed. Clicking this will create the actual rsync tasks.

## API Documentation

The server exposes the following API endpoints:

### Host Management

*   **`GET /api/hosts`**
    *   Description: Retrieves all configured hosts.
    *   Response: `200 OK` - JSON array of host objects.
        ```json
        [
          { "id": "localhost", "alias": "Localhost", "user": "", "hostname": "localhost" },
          { "id": "162...", "alias": "MyServer", "user": "user", "hostname": "server.example.com", "port": 22 }
        ]
        ```

*   **`POST /api/hosts`**
    *   Description: Adds a new host.
    *   Request Body: JSON object
        ```json
        {
          "alias": "New Host",
          "user": "remoteuser",
          "hostname": "remote.example.com",
          "port": 2222 // Optional
        }
        ```
    *   Response: `201 Created` - JSON object of the newly created host.

*   **`PUT /api/hosts/:id`**
    *   Description: Updates an existing host.
    *   Request Body: JSON object with fields to update (similar to POST).
    *   Response: `200 OK` - JSON object of the updated host.

*   **`DELETE /api/hosts/:id`**
    *   Description: Deletes a host.
    *   Response: `204 No Content`.

*   **`POST /api/hosts/:id/ssh-copy-id`**
    *   Description: Attempts to copy the Project Zeus server's public SSH key (`~/.ssh/websync_id_rsa.pub`) to the specified host. Generates the key pair if it doesn't exist on the server.
    *   Request Body:
        ```json
        { "password": "remote_host_password" }
        ```
    *   Response: `200 OK` with success message or `4xx/5xx` with error message.

### Task Management

*   **`GET /api/tasks`**
    *   Description: Retrieves all configured tasks.
    *   Response: `200 OK` - JSON array of task objects.
        ```json
        [
          {
            "id": "162...",
            "name": "Backup Project X",
            "sourceHost": "localhost",
            "destinationHost": "remoteHostId",
            "paths": [{ "source": "/path/to/projectx", "destination": "/backup/projectx" }],
            "flags": ["-a", "-v"],
            "scheduleEnabled": false,
            "automationConfigId": "optional_automation_id", // If created by automation
            "triggerFilePath": "/path/to/.triggerfile"    // If created by automation
          }
        ]
        ```

*   **`POST /api/tasks`**
    *   Description: Creates a new task.
    *   Request Body: JSON object representing the task (see GET response for structure).
    *   Response: `201 Created` - JSON object of the newly created task.

*   **`DELETE /api/tasks/:taskId`**
    *   Description: Deletes a specific task.
    *   Response: `204 No Content`.

*   **`DELETE /api/tasks/delete-all`**
    *   Description: Deletes all configured tasks.
    *   Response: `200 OK` with success message, or `204 No Content`.

*   **`POST /api/tasks/:taskId/run`**
    *   Description: Executes a specific task.
    *   Response: `200 OK` (or `500` if errors occurred) - JSON object with execution results.
        ```json
        {
          "message": "Task 'Task Name' executed.",
          "results": [
            {
              "pathPair": { "source": "...", "destination": "..." },
              "success": true,
              "stdout": "rsync output...",
              "stderr": "",
              "command": "executed rsync command..."
            }
          ]
        }
        ```

*   **`POST /api/tasks/run-all`**
    *   Description: Attempts to run all configured tasks.
    *   Response: `200 OK` - JSON object with a summary of all task executions.

### Automation Configuration Management

*   **`GET /api/automation-configs`**
    *   Description: Retrieves all saved automation configurations.
    *   Response: `200 OK` - JSON array of automation configuration objects.
        ```json
        [
          {
            "id": "163...",
            "name": "Livework Scan Project A",
            "type": "livework",
            "scanHostId": "localhost",
            "scanDirectoryPath": "/projects/livework_scans",
            "destinationHostIds": ["remoteId1", "remoteId2"],
            "destinationBasePath": "/mnt/backups/livework"
          }
        ]
        ```

*   **`POST /api/automation-configs`**
    *   Description: Creates a new automation configuration.
    *   Request Body: JSON object (see GET response for structure).
    *   Response: `201 Created` - JSON object of the newly created configuration.

*   **`PUT /api/automation-configs/:id`**
    *   Description: Updates an existing automation configuration.
    *   Request Body: JSON object with fields to update.
    *   Response: `200 OK` - JSON object of the updated configuration.

*   **`DELETE /api/automation-configs/:id`**
    *   Description: Deletes an automation configuration.
    *   Response: `204 No Content`.

### Utility Endpoints

*   **`POST /api/hosts/:hostId/scan-directory`**
    *   Description: Scans a directory on the specified host (recursively) for `.livework` and `.turbosort` files.
    *   Request Body:
        ```json
        { "directoryPath": "/path/to/scan" }
        ```
    *   Response: `200 OK` - JSON array of full file paths found.
        ```json
        ["/path/to/scan/projectA/.livework", "/path/to/scan/sub/projectB/.turbosort"]
        ```

*   **`POST /api/hosts/:hostId/list-directory-contents`**
    *   Description: Lists files and directories within a specified path on a host.
    *   Request Body:
        ```json
        { "directoryPath": "/path/to/list" }
        ```
    *   Response: `200 OK` - JSON array of directory entry objects.
        ```json
        [
          { "name": "file.txt", "type": "file", "path": "/path/to/list/file.txt" },
          { "name": "subdir", "type": "directory", "path": "/path/to/list/subdir" }
        ]
        ```

*   **`POST /api/hosts/:hostId/read-file`**
    *   Description: Reads the content of a specified file on a host.
    *   Request Body:
        ```json
        { "filePath": "/path/to/file.txt" }
        ```
    *   Response: `200 OK` - Plain text content of the file.
