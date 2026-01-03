FROM node:18-alpine

# Install system dependencies first
RUN apk add --no-cache openssh-client sshpass rsync

# Create app user and group
# -S creates a system user (no password, no shell by default unless specified)
# -G adds user to group
# -h sets home directory
RUN addgroup -g 3000 -S appgroup && \
    adduser -u 3000 -S appuser -G appgroup -h /app

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build TypeScript code
RUN npm run build

# Change ownership of all app files to appuser
RUN chown -R appuser:appgroup /app

# The .ssh directory (/app/.ssh) will be created by the application (src/server.ts)
# if it doesn't exist, using the volume mount from docker-compose.yml.
# The application runs as appuser (UID 3000) due to docker-compose.yml,
# so it will have permission to create /app/.ssh because /app is owned by appuser.

# Expose the port the app runs on
VOLUME ["/app/data"]

EXPOSE 80

# Command to run the application
CMD ["npm", "start"]
