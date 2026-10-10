# The AI gateway image (services/gateway). Build context: the repository root.
#
# Node 24 runs the gateway's TypeScript directly (type stripping), so nothing is compiled.
# One stage installs the production dependencies with the pnpm version the repository
# pins; the runtime stage is a distroless Node image with no shell and no package manager,
# running as its non-root user. Base images are pinned by digest: `just pin-images`
# refreshes them.

FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS deps
WORKDIR /repo
# corepack reads `packageManager` from package.json, so the image installs with the same
# pnpm as CI and local runs.
RUN corepack enable
# Manifests first, so this layer is reused until a dependency changes. The lockfile also
# lists the other workspace packages; a filtered install ignores them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/gateway/package.json services/gateway/
RUN pnpm install --frozen-lockfile --prod --filter @lb/gateway

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS runtime
LABEL org.opencontainers.image.title="lb-gateway" \
      org.opencontainers.image.description="LB-00 AI gateway: routing, fallback, budgets, quotas and run spans." \
      org.opencontainers.image.source="https://github.com/Landry12-BAS/Portfolio"
# The repository's own layout, so pnpm's relative links from services/gateway/node_modules
# into the shared node_modules/.pnpm keep working.
WORKDIR /app/services/gateway
COPY --from=deps /repo/node_modules /app/node_modules
COPY --from=deps /repo/services/gateway/node_modules ./node_modules
COPY services/gateway/package.json services/gateway/routing.yaml ./
COPY services/gateway/src ./src
ENV NODE_ENV=production
# The distroless "nonroot" user, written as a number so orchestrators can verify it.
USER 65532:65532
EXPOSE 8080
# The image's entrypoint is `node`; this is the script it runs.
CMD ["src/main.ts"]
