# One command surface for the monorepo. Run `just` to list the recipes.

default:
    @just --list

# Install every workspace dependency.
install:
    pnpm install

# Lint every TypeScript and Vue package.
lint:
    pnpm lint

# Type-check every package.
typecheck:
    pnpm typecheck

# Run every test suite.
test:
    pnpm test

# Fail if any generated file is stale (the CI drift check).
check:
    pnpm check

# Regenerate the icon sprite and registry after editing packages/icons/svg.
icons:
    pnpm --filter @lb/icons build
