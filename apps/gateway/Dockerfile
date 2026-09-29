# Kestrel gateway image. Build from the repository root:
#   docker build -f apps/gateway/Dockerfile -t kestrel-gateway .
# syntax=docker/dockerfile:1.7

FROM node:26-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
# Install only what the gateway and the panel app need (not Next.js, Prisma, ...).
RUN pnpm install --frozen-lockfile --filter "@kestrel/gateway..." --filter "@kestrel/panel-app..."
RUN pnpm --filter @kestrel/panel-app build

FROM node:26-slim AS runtime
ENV NODE_ENV=production \
    KESTREL_DATA_DIR=/data \
    KESTREL_PANEL_DIR=/app/panel \
    KESTREL_PANEL_PORT=8080
WORKDIR /repo
# pnpm's node_modules use relative symlinks, so copying the tree keeps them intact.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/gateway ./apps/gateway
COPY --from=build /repo/apps/panel/dist /app/panel
RUN mkdir -p /data && chown -R node:node /data
USER node
WORKDIR /repo/apps/gateway
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/main.ts"]
