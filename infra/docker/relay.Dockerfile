FROM node:20-bookworm-slim AS deps

WORKDIR /app

# better-sqlite3 is a native dependency. Debian slim gives npm a glibc target
# and the builder stage has the tools needed if a local rebuild is required.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# The relay needs the relay app and the shared protocol package.
COPY apps ./apps
COPY packages ./packages
COPY scripts/relay-backup.js ./scripts/relay-backup.js
COPY scripts/directory-server.js ./scripts/directory-server.js

CMD ["node", "apps/relay/index.js"]
