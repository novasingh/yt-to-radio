# Use Node 20 Debian-slim image for max compatibility with native binaries and custom runtimes
FROM node:20-slim

# Install system dependencies:
# 1. python3: Strictly required by yt-dlp to run YouTube extraction scripts
# 2. ffmpeg: Required for streaming/transcoding audio segments 
# 3. ca-certificates: Required for secure SSL/HTTPS calls to external YouTube APIs
# 4. build-essential: Required to compile sqlite3 from source for perfect GLIBC compatibility
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    ffmpeg \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set working directory inside the container
WORKDIR /app

# Copy package manifests first to leverage Docker layer caching
COPY package*.json ./

# Install production dependencies only (compiling sqlite3 from source quietly)
RUN npm install --force --omit=dev --build-from-source --loglevel=error --no-audit --no-fund

# Copy the rest of the application source code
COPY . .

# Create a dedicated directory for persistent data and ensure ownership by the node user
RUN mkdir -p /app/data && chown -R node:node /app

# Run the app as a secure, non-root user
USER node

# Expose default application port
EXPOSE 80

# Set standard environment variables for production execution
ENV NODE_ENV=development
ENV PORT=80
ENV DATABASE_PATH=/app/data/database.sqlite
ENV COOKIES_PATH=/app/data/cookies.txt
ENV WEB_MIN_WORKERS=2
ENV WEB_MAX_WORKERS=4

# Start the Node.js application
CMD ["node", "server.js"]
