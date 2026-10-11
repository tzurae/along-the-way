FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun apps/api ./apps/api
COPY --chown=bun:bun packages/contracts ./packages/contracts

USER bun
EXPOSE 3000

CMD ["bun", "apps/api/src/server.ts"]
