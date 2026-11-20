# syntax=docker/dockerfile:1
# The API image. Railway builds it (railway.json); nothing here is host-specific.

FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS build
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# The deploy workflow writes the commit to release-sha.txt before uploading, and
# the build bakes it in so /health can say which commit is live (ADR 0024).
COPY release-sha.tx[t] ./
RUN npm run build

FROM base AS prod-deps
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrate, then serve (src/start.ts). Exec'd directly so SIGTERM reaches node.
CMD ["node", "dist/start.js"]
