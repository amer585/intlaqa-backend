FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy dependency files first (for Docker layer caching)
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Back4App exposes port 3000
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
