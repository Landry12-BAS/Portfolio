# The Node systems image (services/node-systems): the API and the BullMQ worker of LB-08, LB-04,
# LB-06 and LB-07, and the one-shot migration and seed (infra/docker-compose.yml). One image, four
# commands, each a script of the service. Build context: the repository root. LB-07's browser runs
# in an image of its own (lb07-sandbox.Dockerfile); this one only drives it.
#
# Node 24 runs the TypeScript directly (type stripping), so nothing is compiled. One stage
# installs the production dependencies of the service and of the two workspace packages it
# uses, with the pnpm version the repository pins; the runtime stage is a distroless Node
# image with no shell and no package manager, running as its non-root user. Base images are
# pinned by digest: `just pin-images` refreshes them.

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS deps
WORKDIR /repo
# corepack reads `packageManager` from package.json, so the image installs with the same
# pnpm as CI and local runs.
RUN corepack enable
# Manifests first, so this layer is reused until a dependency changes. The lockfile also
# lists the other workspace packages; a filtered install ignores them. `...` takes the
# workspace packages the service depends on along with it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/common/package.json packages/common/
COPY packages/contracts/package.json packages/contracts/
COPY services/node-systems/package.json services/node-systems/
RUN pnpm install --frozen-lockfile --prod --filter "@lb/node-systems..."

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS runtime
LABEL org.opencontainers.image.title="lb-node-systems" \
      org.opencontainers.image.description="The Node systems (LB-08 Automation Studio, LB-04 Contract Radar, LB-06 Incident Commander, LB-07 QA Engineer): API, BullMQ worker, migration and seed." \
      org.opencontainers.image.source="https://github.com/Landry12-BAS/Portfolio"
# The repository's own layout, so pnpm's relative links from each package's node_modules
# into the shared node_modules/.pnpm keep working, and so the two workspace packages are
# reached by their real paths (Node refuses to strip types from a file under node_modules).
WORKDIR /app
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages/common/node_modules ./packages/common/node_modules
COPY --from=deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /repo/services/node-systems/node_modules ./services/node-systems/node_modules
COPY packages/common/package.json ./packages/common/
COPY packages/common/src ./packages/common/src
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY services/node-systems/package.json ./services/node-systems/
COPY services/node-systems/src ./services/node-systems/src
# LB-08's synthetic data: the samples the demo opens on and the stock list.
COPY data/seed/lb08 ./data/seed/lb08
# LB-04's: the playbook its reviews are read against and the sample contracts (PDFs) with the
# list that says what each file must be. The generator that makes them (pdf-lib) stays out.
COPY data/seed/lb04 ./data/seed/lb04
# LB-06's: its golden set, which is where its curated samples come from (a fault and a seed each).
COPY evals/lb06 ./evals/lb06
# LB-07's: the bug catalogue and the golden set its curated samples come from. The module reads
# both when it starts and the seed job checks them, so an image without them starts nothing.
COPY data/seed/lb07 ./data/seed/lb07
COPY evals/lb07 ./evals/lb07
COPY infra/docker/node-entrypoint.mjs /usr/local/lib/lb/entrypoint.mjs
WORKDIR /app/services/node-systems
ENV NODE_ENV=production
# The distroless "nonroot" user, written as a number so orchestrators can verify it.
USER 65532:65532
EXPOSE 8002
# The image's own entrypoint is `node`; the wrapper writes the service's key and starts
# heartbeats, then runs the script named by the command (docker-compose.yml names others:
# src/worker.ts, src/cli/migrate.ts and src/cli/seed.ts).
ENTRYPOINT ["/nodejs/bin/node", "/usr/local/lib/lb/entrypoint.mjs"]
CMD ["src/main.ts"]
