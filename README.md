# ENSmap

A Bubblemaps-style explorer for ENS names. Given an ENS name, ENSmap draws
that name and its subname tree as bubbles and links them to the addresses
they sent funds to. See [`docs/spec.md`](docs/spec.md) for the full build
plan and spec deviations.

## Setup

- Node >=24.12 (see `.nvmrc` and `engines`), pnpm 12.6 (`corepack enable pnpm`, or `corepack pnpm@12.6.0 <command>` if that needs elevated permissions).
- pnpm may not be on `PATH`; use `corepack pnpm@12.6.0 …`, or `corepack enable pnpm` if you have permission to. `pnpm ensmap …` runs from the repo root; from a subdirectory use `pnpm -w ensmap …`.
- `pnpm install`
- Copy `.env.example` to `.env` and fill in what you need. Every variable is
  optional; without credentials the CLI calls keyless, rate-limited public
  endpoints live. Only the tests replay recorded fixtures (see
  `ENSMAP_FIXTURES` under [Environment](#environment)).

## Workspace layout

- `packages/core`: adapters, pipeline, classification, aggregation and graph
  builder. Its tests run offline against recorded fixtures.
- `packages/db`: Postgres/PGlite schema and Drizzle migrations.
- `packages/cli`: `ensmap tree <name>` today; `bonds`, `labels` and `map`
  arrive in later phases.
- `apps/api`: HTTP API, Postgres with Drizzle migrations.
- `apps/web`: not started yet. The frontend stays empty until the UI phase.

## Scripts

- `pnpm run format` / `pnpm run format:check`: Prettier.
- `pnpm run lint`: ESLint.
- `pnpm run typecheck`: `tsc -p tsconfig.json` per package.
- `pnpm run test`: Vitest across all packages.
- `pnpm run ci`: format:check, then lint, then typecheck, then db:drift,
  then test.
- `pnpm run ensmap`: run the CLI (`packages/cli`).

## Usage

```sh
pnpm ensmap tree <name> [-n, --namespace <mainnet|sepolia-v2>] [--json] [--max-names <n>]
```

`tree` walks the subname tree of `<name>`, resolves every name's ETH address
through the Universal Resolver, and prints one indented line per name:

```text
$ pnpm ensmap tree seller-a.eth -n sepolia-v2
seller-a.eth · 0xc0f5…9fa6 · verified · home · registry shared with: vet402.eth
  agent-1.seller-a.eth · 0x9335…7244 · verified · home
  agent-2.seller-a.eth · no wallet · canonical: agent-2.vet402.eth · tags: alias-path, alias-unresolved
  atst.seller-a.eth · no wallet · canonical: atst.vet402.eth · tags: alias-path, alias-unresolved
  obs.seller-a.eth · no wallet · canonical: obs.vet402.eth · tags: alias-path, alias-unresolved
5 names (indexed: 5) · truncated: no · wallets: 2
warning: keyless public RPC: rate-limited; set ALCHEMY_API_KEY or RPC_URL_11155111
API calls: ens-dev-graphql=5, rpc=12
```

- Each line shows the beautified name, the short wallet, `verified` or
  `unverified`, and `home` or `same wallet as <name>`. It adds
  `also under: …` for a name with several parents, `canonical: …` for a name
  reached through an alias path, `registry shared with: …` for an ENSv2
  registry that parents outside the tree also use, and any tags.
- Tags: `expired`, `unresolvable` (a label shown as `[labelhash]`),
  `alias-path`, `alias-unresolved` (an alias path answered by an ancestor's
  resolver, so no wallet is bound), `index-mismatch` (the index and the
  resolver disagree on the address of a canonical name),
  `resolution-error:<error>` and `deleted` (a root with neither owner nor
  resolver).
- The footer reads `N names (indexed: M | ≥M) · truncated: yes|no · wallets: K`,
  followed by warnings. `≥M` means the index total is a lower bound.
- `--json` prints the whole name map as JSON instead.
- `--max-names` stops the walk earlier than the 1,000-name fetch cap.
- API call counts per provider go to stderr after every run.
- Exit codes: `0` ok, `1` invalid name or arguments, `2` name not found in the
  namespace's index, `3` a provider failed after its retries.

## Environment

Every variable is optional. Copy `.env.example` to `.env`; `pnpm ensmap`
loads it. Secret values are redacted from errors, logs and fixtures.

| Variable                                                | Used for                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GRAPH_API_KEY`                                         | The Graph gateway for the mainnet ENS subgraph. Without it the keyless, heavily rate-limited hosted endpoint is used. |
| `ALCHEMY_API_KEY`                                       | Alchemy JSON-RPC for both namespaces. Without it, and without `RPC_URL_<chainId>`, a public keyless RPC is used.      |
| `RPC_URL_1`, `RPC_URL_11155111`                         | JSON-RPC endpoint per chain, taking precedence over Alchemy.                                                          |
| `ENS_SOURCE_KIND_MAINNET`, `ENS_SOURCE_KIND_SEPOLIA_V2` | `ens-subgraph` or `ens-dev-graphql`. Defaults: `ens-subgraph` on mainnet, `ens-dev-graphql` on sepolia-v2.            |
| `ENS_SOURCE_URL_MAINNET`, `ENS_SOURCE_URL_SEPOLIA_V2`   | Name source URL override. The Graph key is only sent when the override host is `gateway.thegraph.com`.                |
| `ENSMAP_FIXTURES`                                       | `record`, `replay` or `off`. Tests default to `replay`; the CLI defaults to `off`.                                    |
| `DATABASE_URL`                                          | Postgres or PGlite, used from Phase 2.                                                                                |
| `DUNE_API_KEY`, `BITQUERY_API_KEY`                      | Label sources, used from Phase 3.                                                                                     |
| `ENSNODE_URL_MAINNET`, `ENSNODE_URL_SEPOLIA_V2`         | Reserved and unused.                                                                                                  |

## Known limitations

- **Gateway-only subnames.** Subnames that exist only behind a CCIP-Read
  gateway cannot be enumerated. `tree` lists what the index holds, and the
  footer shows the index total.
- **Unnormalized labels.** A label that is unknown or not ENSIP-15
  normalized is shown as `[labelhash]`, tagged `unresolvable` and never
  forward-resolved.
- **Keyless rate limits.** The keyless ENS subgraph is heavily rate-limited
  (set `GRAPH_API_KEY`), and the public RPCs are rate-limited (set
  `ALCHEMY_API_KEY` or `RPC_URL_<chainId>`). The public mainnet RPC also
  prunes old blocks, so a binding whose record history starts before its
  horizon falls back to the registration date, with a warning.
- **`graphql.ens.dev`.** The sepolia-v2 source is the indexer the ENS Beta
  app uses. It is undocumented for third parties, has no published terms, can
  change without notice, and holds only ENSv2 data.
- **Alias paths of shared registries are not found by name.** An ENSv2
  registry shared by several parents has one canonical parent. A root given
  through another parent, such as `agent-2.seller-a.eth` for
  `agent-2.vet402.eth`, is not in the index by name and exits `2`. Start from
  the canonical name or from the parent.
- **Alias paths bind only their own resolver's answer.** A child of a shared
  registry is resolved on its in-scope path, the path the walk reached it by,
  which can differ from its canonical path. When that path falls back to an
  ancestor's resolver instead of the child's own, the answer is the
  ancestor's record, so no wallet is bound and the name is tagged
  `alias-unresolved`.
- **Truncated walks** can over-report the parents outside the tree that
  share a registry, since the unwalked part of the tree counts as outside.
- **CCIP-Read gateway calls** time out after 10 s, and the name then gets a
  `resolution-error:<error>` tag. They still bypass the shared HTTP client, so
  they are neither retried nor recorded as fixtures; routing them through it is
  planned for Phase 2.
- **ENSv2 on mainnet.** As of 2026-09-26 ENSv2 is not deployed on mainnet,
  and mainnet names come from the ENSv1 subgraph. Moving mainnet to an
  ENSv2-capable source is configuration (`ENS_SOURCE_KIND_MAINNET`,
  `ENS_SOURCE_URL_MAINNET`) when it speaks a schema ENSmap already supports;
  a new schema needs one new adapter.
- **Phase 1 scope.** Only coin type 60 on the namespace's own chain is
  bound, and nothing is cached between runs.
