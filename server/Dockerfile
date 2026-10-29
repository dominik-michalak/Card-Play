# Build from the repository root: docker build -f server/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
# the lock file and every workspace manifest first, so the install layer is cached
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
RUN npm run build -w server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
# production dependencies of the server only; the shared package is bundled into dist
RUN npm ci --omit=dev --workspace=server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY server/drizzle server/drizzle
WORKDIR /app/server
USER node
EXPOSE 3000
# migrations first, then the server; a failed migration stops the container
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
