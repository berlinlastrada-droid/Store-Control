# 🏪 StoreControl Pro 2.0 - Production Dockerfile
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package descriptors
COPY package*.json ./

# Install dependencies (production)
RUN npm ci --only=production

# Copy application code
COPY . .

# Ensure data directory exists with appropriate permissions
RUN mkdir -p /app/data && chmod 777 /app/data

# Declare persistent volume for SQLite database
VOLUME ["/app/data"]

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose server port
EXPOSE 3000

# Start server
CMD ["node", "server/index.js"]
