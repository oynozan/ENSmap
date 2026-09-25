# ENSmap

A Bubblemaps-style explorer for ENS names. Given an ENS name, ENSmap draws
that name and its subname tree as bubbles and links them to the addresses
they sent funds to. See [`docs/spec.md`](docs/spec.md) for the full build
plan and spec deviations.

## Setup

- Node >=24.12 (see `.nvmrc` and `engines`), pnpm 12.6 (`corepack enable
  pnpm`, or `corepack pnpm@12.6.0 <command>` if that needs elevated
  permissions).
- pnpm may not be on `PATH`; use `corepack pnpm@12.6.0 …`, or
  `corepack enable pnpm` if you have permission to. `pnpm ensmap …` runs
  from the repo root; from a subdirectory use `pnpm -w ensmap …`.
- `pnpm install`
- Copy `.env.example` to `.env` and fill in what you need. Every variable is
  optional; without credentials ENSmap runs against recorded fixtures.

## Workspace layout

- `packages/core`: adapters, pipeline, classification, aggregation and graph
  builder. Runs offline against recorded fixtures.
- `packages/db`: Postgres/PGlite schema and Drizzle migrations.
- `packages/cli`: `ensmap tree | bonds | labels | map <name>`.
- `apps/api`: HTTP API, Postgres with Drizzle migrations.
- `apps/web`: Vite + React map UI.

## Scripts

- `pnpm run format` / `pnpm run format:check`: Prettier.
- `pnpm run lint`: ESLint.
- `pnpm run typecheck`: `tsc -p tsconfig.json` per package (`apps/web` also
  runs `vite build`).
- `pnpm run test`: Vitest across all packages.
- `pnpm run ci`: format:check, then lint, then typecheck, then db:drift,
  then test.
- `pnpm run ensmap`: run the CLI (`packages/cli`).
