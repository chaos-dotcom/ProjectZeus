FROM node:18-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build TypeScript code
RUN npm run build

# Create .ssh directory for SSH keys
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

# Install sshpass for SSH key setup
RUN apk add --no-cache openssh-client sshpass

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["npm", "start"]
