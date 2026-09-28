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

# Lint every TypeScript and Vue package.
lint:
    pnpm lint

# Type-check every package.
typecheck:
    pnpm typecheck

# Run every unit test suite.
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
