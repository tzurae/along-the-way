FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN bun install --frozen-lockfile
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
RUN bun run build:web

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=bun:bun /app/apps/web/dist ./apps/web/dist
COPY --chown=bun:bun apps/web/server.ts ./apps/web/server.ts
COPY --chown=bun:bun apps/web/server ./apps/web/server

USER bun
EXPOSE 4173

CMD ["bun", "apps/web/server.ts"]
