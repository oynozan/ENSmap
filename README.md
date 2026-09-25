# ENSmap

A Bubblemaps-style explorer for ENS names. Given an ENS name, ENSmap draws
that name and its subname tree as bubbles and links them to the addresses
they sent funds to. See [`docs/spec.md`](docs/spec.md) for the full build
plan and spec deviations.

## Setup

- Node 24.21+ (see `.nvmrc`), pnpm 12.6 (`corepack enable pnpm`, or
  `corepack pnpm@12.6.0 <command>` if that needs elevated permissions).
- `pnpm install`
- Copy `.env.example` to `.env` and fill in what you need. Every variable is
  optional; without credentials ENSmap runs against recorded fixtures.

## Workspace layout

- `packages/core`: adapters, pipeline, classification, aggregation and graph
  builder. Runs offline against recorded fixtures.
- `packages/cli` (later phase): `ensmap tree | bonds | labels | map <name>`.
- `apps/api` (later phase): HTTP API, Postgres with Drizzle migrations.
- `apps/web` (later phase): Vite + React map UI.

## Scripts

- `pnpm run format` / `pnpm run format:check`: Prettier.
- `pnpm run lint`: ESLint.
- `pnpm run typecheck`: `tsc --noEmit` across all packages.
- `pnpm run test`: Vitest across all packages.
- `pnpm run ci`: format:check, then lint, then typecheck, then test.
- `pnpm run ensmap`: run the CLI (`packages/cli`, added in a later phase).
