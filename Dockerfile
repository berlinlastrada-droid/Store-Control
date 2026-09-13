FROM node:20-bookworm-slim

WORKDIR /app

# Copy package manifests
COPY package*.json ./

# Install dependencies (prebuilt binaries for Debian glibc)
RUN npm install --omit=dev

# Copy application files
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server/index.js"]