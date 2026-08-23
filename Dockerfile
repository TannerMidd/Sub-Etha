# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

# The patch script must exist before `npm ci` so its postinstall hook can run.
COPY package.json package-lock.json ./
COPY scripts/apply-security-patches.mjs ./scripts/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build


# Production-only dependencies (pg for the migration and wait helpers,
# web-push for VAPID key generation) kept out of the final image size math.
FROM node:22-alpine AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/apply-security-patches.mjs ./scripts/
RUN npm ci --omit=dev --no-audit --no-fund


FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

RUN mkdir -p /app/state && chown node:node /app/state

COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node scripts/wait-for-db.mjs scripts/migrate.mjs scripts/generate-vapid-keys.mjs ./scripts/
COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh

RUN chmod +x ./docker/entrypoint.sh

USER node

EXPOSE 3000

VOLUME ["/app/state"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

ENTRYPOINT ["./docker/entrypoint.sh"]
