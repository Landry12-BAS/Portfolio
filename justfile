# One command surface for the monorepo. Run `just` to list the recipes.

default:
    @just --list

# Install every workspace dependency.
install:
    pnpm install

# Run the site with hot reload on http://localhost:3000.
dev:
    pnpm --filter @lb/web dev

# Build the site for production.
build:
    pnpm --filter @lb/web build

# Run the AI gateway with reload on http://127.0.0.1:8080 (settings in services/gateway/.env).
gateway:
    pnpm --filter @lb/gateway dev

# Make a service key pair or mint a service token for local gateway calls.
gateway-token *args:
    pnpm --silent --filter @lb/gateway token {{args}}

# Lint every TypeScript and Vue package.
lint:
    pnpm lint

# Type-check every package.
typecheck:
    pnpm typecheck

# Run every unit and integration test suite. Integration tests start Redis with
# Docker, or use LB_TEST_REDIS_URL when it is set.
test:
    pnpm test

# Build the site, then run the end-to-end, accessibility and security-header tests.
e2e: build
    pnpm --filter @lb/web e2e

# Fail if any generated file is stale (the CI drift check).
check:
    pnpm check

# Regenerate the icon sprite and registry after editing packages/icons/svg.
icons:
    pnpm --filter @lb/icons build
