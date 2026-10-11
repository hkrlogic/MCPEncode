# MCPEncode publisher image. Host-neutral: runs on any container host.
# Postgres is not included. Point POSTGRES_* (or DATABASE_URL) at your database.
#
#   docker build -t mcpencode .
#   docker run --init -p 127.0.0.1:3000:3000 --env-file .env \
#     -e BIND_HOST=0.0.0.0 -e POSTGRES_HOST=<db host> mcpencode
#
# Every public deploy must set SETUP_TOKEN, SESSION_SECRET and PUBLIC_BASE_URL.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The app runs TypeScript through tsx (as `npm start` does), so dev dependencies stay.
RUN npm ci --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    BIND_HOST=0.0.0.0
WORKDIR /app
# Files stay owned by root and read-only to the app user. Uploads live in Postgres.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "src/index.ts"]
