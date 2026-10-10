# LB-07's sandbox image (services/node-systems/src/sandbox.ts): one Node process that holds the
# staging shop on the loopback interface and the browser runner's API on the container's own
# address, and drives a headless Chromium over the shop (infra/docker-compose.yml, lb07-sandbox).
# Build context: the repository root.
#
# Three stages. `deps` installs the Node systems' production dependencies exactly as
# node-systems.Dockerfile does, and the sandbox takes four of them. `browser` downloads the
# Chromium build that playwright-core drives, checks it against its pinned SHA-256, and gathers
# the Debian libraries it loads (lb07-sandbox-browser.sh). The runtime is the distroless Node
# image the other Node services run on: no shell, no package manager, a non-root user, and
# nothing but the code, the four packages, the browser and its libraries. No secret is baked in:
# the one key the sandbox holds comes from Compose at run time. Base images are pinned by digest:
# `just pin-images` refreshes them.

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS deps
WORKDIR /repo
# corepack reads `packageManager` from package.json, so the image installs with the same pnpm as
# CI and local runs.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/common/package.json packages/common/
COPY packages/contracts/package.json packages/contracts/
COPY services/node-systems/package.json services/node-systems/
RUN pnpm install --frozen-lockfile --prod --filter "@lb/node-systems..."
# The sandbox's code (src/sandbox.ts, and the runner and the shop it starts) imports four packages
# and nothing else: playwright-core drives the browser, axe-core is the accessibility check the
# runner injects into the shop's pages, zod checks the runner's protocol, and @lb/contracts holds
# LB-07's shared schemas. They go into one node_modules at the root of the runtime's /app, where
# Node finds them from the service's code and from @lb/contracts' alike: the three from npm as
# plain folders (none of them has a dependency of its own), @lb/contracts as a link to its source,
# because Node strips the types of a file only outside node_modules.
RUN mkdir -p /sandbox/node_modules/@lb \
 && cp -RL services/node-systems/node_modules/playwright-core services/node-systems/node_modules/axe-core \
        services/node-systems/node_modules/zod /sandbox/node_modules/ \
 && ln -s ../../packages/contracts /sandbox/node_modules/@lb/contracts

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS browser
# What the download needs, the libraries Chrome Headless Shell links against (its deb.deps, less
# what a headless shell never opens), and fontconfig's settings with one font family (DejaVu, which
# fontconfig prefers for every generic name; fonts-dejavu-mono comes with it). The versions
# are Debian 13's at build time, security fixes included: pinning each would break the build
# whenever Debian ships a fix, and the scan in images.yml checks what was taken.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
        libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libdbus-1-3 libexpat1 \
        libgbm1 libglib2.0-0t64 libnspr4 libnss3 libudev1 libx11-6 libxcb1 libxcomposite1 \
        libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 fontconfig-config fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
# The runtime image's own package records: the libraries it already has are not copied again.
COPY --from=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e /var/lib/dpkg/status.d /runtime-packages
COPY --from=deps /sandbox/node_modules/playwright-core/browsers.json /tmp/browsers.json
COPY --chmod=0555 infra/docker/lb07-sandbox-browser.sh /usr/local/bin/lb07-sandbox-browser
RUN lb07-sandbox-browser /tmp/browsers.json /runtime-packages

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS runtime
LABEL org.opencontainers.image.title="lb-lb07-sandbox" \
      org.opencontainers.image.description="LB-07 QA Engineer's sandbox: the staging shop and the browser runner, with a pinned Chrome Headless Shell." \
      org.opencontainers.image.source="https://github.com/Landry12-BAS/Portfolio"
# The browser's libraries, its fonts and their package records, then the browser itself.
COPY --from=browser /rootfs /
COPY --from=browser /opt/chromium /opt/chromium
# The repository's own layout, so the service's code finds its packages and @lb/contracts by
# the paths it uses in development.
WORKDIR /app
COPY --from=deps /sandbox/node_modules ./node_modules
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY services/node-systems/package.json ./services/node-systems/
COPY services/node-systems/src ./services/node-systems/src
COPY infra/docker/lb07-sandbox-healthcheck.mjs /usr/local/lib/lb/healthcheck.mjs
WORKDIR /app/services/node-systems
# HOME is the writable tmpfs (docker-compose.yml): Chromium keeps its NSS database and fontconfig
# its cache under it. The root filesystem is read-only.
ENV NODE_ENV=production \
    HOME=/tmp \
    LB07_BROWSER_PATH=/opt/chromium/chrome-headless-shell
# The distroless "nonroot" user, written as a number so orchestrators can verify it.
USER 65532:65532
EXPOSE 8008
# Both servers answer from inside the container (lb07-sandbox-healthcheck.mjs). Compose runs the
# same check on the same schedule; this one serves a plain `docker run`.
HEALTHCHECK --interval=15s --timeout=6s --start-period=30s --retries=4 \
    CMD ["/nodejs/bin/node", "/usr/local/lib/lb/healthcheck.mjs"]
# No entrypoint wrapper: the sandbox holds no service key and keeps no heartbeat file.
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["src/sandbox.ts"]
