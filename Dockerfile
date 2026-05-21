# Charon - Solana pump token screening bot
FROM node:20-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('fs').accessSync('/app/data/charon.db')" || exit 1

# Run as non-root user
RUN addgroup -g 1001 -S charon && \
    adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G charon -g charon charon && \
    chown -R charon:charon /app

USER charon

# Default command
CMD ["npm", "start"]
