# ENSmap — build plan

You are building ENSmap, a Bubblemaps-style explorer for ENS names. Given an ENS name, ENSmap draws that name and its subname tree as bubbles and links them to the addresses they sent funds to. Each link (a bond) shows the tokens and amounts moved. Known exchange and DEX addresses are labeled and treated as hubs so they don't create false clusters.

Work through the phases in section 7 in order. At the end of each phase, run the tests and check the acceptance criteria. Then stop and post a short summary (what was built, what is stubbed, open questions) before starting the next phase.

## 1. Ground rules

- Check every external interface against its current docs before writing code against it: ENSNode Omnigraph, Alchemy Transfers API, DefiLlama coins API, Dune API, Bitquery Labels API, JSON-RPC. Don't guess field names or endpoints, and never hardcode a contract or wallet address from memory. Every curated address carries a source URL.
- ENSv2 status as of 2026-09-26: contracts are not final, the public Beta runs on Sepolia (redeployed 2026-09-15), and there is no mainnet deployment yet. Re-check this at the start. ENSmap never depends on ENSv2 contract addresses. It reads all ENS data through ENSNode, whose Omnigraph serves ENSv1 and ENSv2 in one model.
- The ENS namespace is config, not code:
  - `mainnet`: real transfers and labels. Names are ENSv1 today and ENSv2 after launch.
  - `sepolia-v2`: the ENSv2 Beta. Used to test tree handling; it has no meaningful CEX or DEX data.
- Default to the NameHash-hosted ENSNode instance for each namespace, with the URL configurable per namespace.
- Use `enscli ensnode omnigraph schema` to look up exact Omnigraph types and fields.
- Normalize input names (ENSIP-15) before any query, and display beautified names.
- TypeScript in strict mode everywhere.
- Secrets live only in env and never reach the browser: `ALCHEMY_API_KEY` (Transfers API and JSON-RPC), `ENSNODE_URL_MAINNET`, `ENSNODE_URL_SEPOLIA_V2`, `DUNE_API_KEY`, `BITQUERY_API_KEY`, `DATABASE_URL`.
- Comments only for non-obvious lines, section splits and file headers.
- Rate-limit and retry third-party calls with backoff, cache aggressively, and log API call counts per map build.
- Don't invent product, brand or feature names. Use "ENSmap" and plain descriptive labels, and ask if something needs a name. No company or personal branding anywhere.

## 2. What the user sees

Two map modes:
- **Name-rooted (primary).** Input: an ENS name. Shows the name, its subname tree, the wallet each name resolves to, and the counterparties those wallets sent funds to.
- **Registry-rooted (phase 6).** Input: a name whose subregistry holds subnames (in ENSv2 each registry is its own ERC1155 collection). Shows one bubble per holder wallet, labeled with its primary name, with the subnames it holds as satellites.

Node kinds:
- `name`: the root and other in-scope names.
- `subname`: a satellite bubble attached to its parent (priority subnode).
- `counterparty`: an address a bound wallet sent funds to. Shows its primary name if it has one, otherwise a short address, and whether it is an EOA or a contract.
- `deposit`: a counterparty identified as a CEX deposit address, labeled with its exchange.
- `cexHub`: one per exchange, merging its hot and cold wallets. Hidden by default.
- `dexHub`: one per DEX protocol, covering its pools, routers, settlement contracts and the Uniswap v4 PoolManager. Hidden by default.
- `timeNode`: a hub split by time window (section 5.7).
- `collapsed`: a "+N more" placeholder for capped subtrees or counterparties. Expands on click.

Edge kinds:
- `subname` (strong): parent → child. A child reachable through several parents (a shared subregistry) gets one edge per parent, never a duplicate node.
- `bond` (weak): wallet → counterparty, outgoing transfers only, aggregated per pair. It carries per-token amount, USD at transfer time, count, and first and last time. Drawn with an arrow. When two in-scope wallets sent to each other, draw one two-way bond instead.
- `sweep`: deposit → cexHub.
- `hub`: counterparty → dexHub, cexHub or timeNode.

Interactions:
- Click a name: its wallet, verified status, owner, other names on the same wallet, and outgoing totals by token.
- Click a bond: per-token breakdown and a paginated transaction list with explorer links.
- Clusters: connected components (section 5.8), each with its own color. A cluster panel lists members and total USD.

Controls:
- Filters: tokens, minimum USD per bond.
- Attribution window: `while bound` (default) or `full wallet history`.
- Toggles: include unverified bindings, show CEX hubs, show DEX hubs, time windows on/off.
- Bubble size metric.

## 3. Architecture

pnpm monorepo:
- `packages/core`: adapters, pipeline, classification, aggregation and graph builder. Runs offline against recorded fixtures.
- `packages/cli`: `ensmap tree | bonds | labels | map <name>`, used to verify each phase.
- `apps/api`: HTTP API, Postgres with Drizzle migrations, caches and refresh jobs.
- `apps/web`: Vite + React, d3-force in a Web Worker, canvas renderer.

Adapters are interfaces in core, each swappable:
- `NameSource`: ENSNode Omnigraph via `enssdk`. Leave room for ENSDb (SQL on a self-hosted ENSNode) for bulk builds later.
- `TransferSource`: Alchemy `alchemy_getAssetTransfers`.
- `PriceSource`: DefiLlama coins API, historical prices.
- `LabelSource`: curated JSON, Dune, Bitquery.
- `ChainReader`: JSON-RPC `eth_getCode`, `eth_getTransactionCount` and `eth_call` probes.

## 4. Data model (Postgres)

- `names`: id, namespace, name, parent_ids[], registry, owner, resolver, registered_at, expiry.
- `bindings`: name_id, chain_id, address, valid_from, valid_to, verified, source.
- `transfers`: chain_id, unique_id, tx_hash, block, timestamp, from, to, asset (native or token address), raw_value, decimals, category.
- `sync_cursors`: chain_id, address, last_block, truncated.
- `prices`: chain_id, token, hour_bucket, usd.
- `addresses`: chain_id, address, is_contract, nonce, primary_name, checked_at.
- `labels`: chain_id, address, kind, entity, source, confidence, source_url, updated_at. `kind` is one of cex_hot, cex_cold, cex_deposit, dex_router, dex_pool, dex_singleton.
- `maps`: params_hash, graph_json, computed_at.

## 5. Pipeline

### 5.1 Name tree
- Fetch the root with `domain(by: { name })` and walk `subdomains` breadth-first with pagination. Read owner, registry and subregistry, `resolver.effective`, resolved profile addresses and registration dates, using whatever fields the schema actually exposes.
- Deduplicate by Omnigraph domain id, and store every parent a domain is reachable through. ENSv2 shared subregistries make one token a subname of several parents.
- Fetch cap: 1,000 names per map. Display cap: 250 names (section 5.9).
- Gateway-only (CCIP-Read) subnames can't be enumerated and are out of scope. Show the Omnigraph `totalCount` so the user sees what is indexed.

### 5.2 Bindings (name → wallet)
- A name's wallet is its resolved ETH address (coin type 60) through its effective resolver. The owner is stored as a property.
- `verified` means the wallet's ETH primary name equals this name, or the wallet equals the owner. Unverified bindings are often stale records left by a previous holder. They render dimmed and are excluded from clusters by default.
- `valid_from` comes from record history when available. Use the Omnigraph if it exposes history; otherwise read logs:
  - ENSv2: resolver `Linked` + `AddressUpdated` events.
  - ENSv1: resolver `AddrChanged` / `AddressChanged` events.
  - Fallback: the name's current registration start.
  - `valid_to` is null for current bindings.
- Build a `wallet → names` map and give each wallet one home name:
  - its verified primary name, if that name is in scope;
  - otherwise the shallowest in-scope name, with ties broken by label.
- Bonds attach to the home name's bubble. Other names on the same wallet get a "same wallet" marker and highlight together on hover. A transfer is never emitted as bonds from more than one name.
- Chains: config `chains`, default `[1]`. Base, Arbitrum or Optimism wallets can be added later via ENSIP-11 coin types.

### 5.3 Transfers
- For each unique wallet, call `alchemy_getAssetTransfers` with:
  - `fromAddress` set to the wallet;
  - categories `external` and `erc20`, plus `internal` on Ethereum mainnet only;
  - `excludeZeroValue: true` and `withMetadata: true`;
  - pagination by `pageKey`.
- The initial sync fetches newest-first up to 5,000 transfers per wallet. If a wallet hits the cap, set `truncated` and surface it in the UI.
- Later syncs fetch from the cursor block onward.
- Store raw transfers keyed by (chain_id, unique_id).

### 5.4 Filters
- Drop zero-value transfers, even though the API already excludes them.
- Keep ERC-20 transfers only for tokens that have a DefiLlama price at transfer time or are on a curated allowlist. This removes fake-token `Transfer` events that spoof the wallet as sender, and most spam.
- With `while bound`, drop transfers outside the binding window. With `full wallet history`, keep all transfers of current wallets.
- Fixture tests:
  - a zero-value `transferFrom(victim, lookalike, 0)` is dropped;
  - a fake token emitting `Transfer(victim, x, v)` is dropped;
  - real ETH and USDC transfers pass.

### 5.5 Prices and aggregation
- USD per transfer = amount × price at transfer time, using cached hourly buckets.
- Bond key is (wallet, counterparty).
  - Per token: amount (decimals applied), USD, count.
  - Per bond: USD total, count, first and last time, transaction ids.
- Per wallet, keep the top 15 counterparties by USD and merge the rest into a `collapsed` node.
- Always keep a counterparty that two or more in-scope wallets sent to, whatever its rank. Those are the cluster links.

### 5.6 Counterparty classification
Precedence: curated, then Bitquery / Dune, then on-chain probe, then heuristic. Store source and confidence on every label and show both in the UI.

1. Wallet of an in-scope name → bond to that name's home bubble. This is how clusters between names form.
2. Labeled CEX hot or cold wallet → the exchange's `cexHub`.
3. Labeled CEX deposit address → `deposit` node, plus a `sweep` edge to the exchange's `cexHub`.
4. DEX → the protocol's `dexHub`. Sources:
   - curated routers, settlement contracts and the Uniswap v4 PoolManager;
   - pools found by probing `factory()` and matching a curated factory list (Uniswap v2/v3 and forks).
5. Unlabeled counterparty among a wallet's kept counterparties → sweep heuristic:
   - fetch its outgoing transfers in the 72 hours after it received funds;
   - if at least 90% of that value went to one exchange's known wallets, label it `deposit` with source `heuristic`.
6. Anything else → `counterparty`, typed EOA or contract via `eth_getCode`, and named by its ETH primary name if it has one.

Supernodes are labeled hot wallets, DEX routers and singletons, and any EOA with nonce ≥ 100,000. They are treated as hubs:
- hidden by default;
- near-zero link strength;
- no supernode ↔ supernode edges;
- truncated transaction lists.

Label sources:
- **Curated** `labels/curated.json` in the repo: exchange hot and cold wallets from the exchanges' own proof-of-reserves pages, and DEX routers, factories and PoolManager from protocol docs. Each entry has a source URL.
- **Dune** `cex.addresses` (exchange wallets) and `cex.deposit_addresses` (deposit addresses detected from consolidation patterns). Import via the Dune API and refresh daily. First check that the Dune plan has access to these tables; if it doesn't, skip Dune.
- **Bitquery** Labels API: `cex-hot-wallet`, `cex-cold-wallet`, `cex-deposit-address`, and DEX routers and pools. Up to 100 addresses per query. Call it on demand for unlabeled counterparties and cache the result.

### 5.7 Time nodes
For each `cexHub` and `dexHub`, bucket the in-scope wallets' edges into time windows (default 15 minutes, configurable).
- A window touched by two or more distinct in-scope wallets becomes a visible `timeNode`, labeled with the protocol or exchange and the UTC window. Those wallets' edges attach to it.
- All other edges stay on the hidden hub.

This shows coordinated swaps or deposits without letting one hub merge everything.

### 5.8 Clusters
Clusters are connected components over `bond` edges between name bubbles and non-hub nodes: counterparties, deposits and, when enabled, time nodes. Unverified bindings are excluded unless the user turns them on.

### 5.9 Graph builder and caps
- Display the root, the top 250 names by outgoing USD under the current filters, and the ancestors of every displayed name. Other children collapse into "+N more" under their parent.
- Size metric:
  - `outgoingUsd`: default for name-rooted maps.
  - `subnamesHeld`: default for registry-rooted maps.
  - `walletBalanceUsd`: optional, from Alchemy token balances × prices.
- Output a versioned JSON schema defined with zod in core:
  - Node: `{ id, kind, label, address?, names?, homeName?, chainId?, verified?, tags[], labelSource?, confidence?, size: { metric, value }, clusterId?, collapsedCount? }`
  - Edge: `{ id, source, target, kind, directed, tokens?: [{ symbol, address, amount, usd, count }], usdTotal?, count?, firstAt?, lastAt? }`
  - Meta: `{ namespace, root, computedAt, caps, filters, totals, truncated[] }`

## 6. API and web

API:
- `GET /map/name/:name` and `GET /map/registry/:name` return graph JSON. Namespace and filters are query params.
  - Results are cached by params hash and recomputed when older than 6 hours.
  - Wallet transfers are refreshed incrementally in the background.
- `GET /node/:id`
- `GET /bond/:source/:target` (paginated transactions)
- `GET /expand/:collapsedId`

Web:
- Run d3-force in a Web Worker with a canvas renderer, both behind interfaces so sigma.js + graphology can replace them if maps outgrow a few thousand nodes.
- Forces (keep every number in one config file for tuning):
  - `subname` links short and strong, so subnames orbit their parent;
  - `bond` links long and weak, with strength scaled by log10 of USD total;
  - `hub` and `sweep` links near zero;
  - many-body repulsion;
  - collision radius equal to bubble radius.
- Visual encoding:
  - radius ∝ √size, with a minimum;
  - subnames smaller than names;
  - unverified bindings dimmed;
  - hubs visually distinct from wallets;
  - bond width by log USD, arrows on one-way bonds, dominant token and amount on hover.
- Panels: node details, bond breakdown, cluster list, filters.
- Before building the UI, propose a compact design plan: 4–6 named hex colors, typefaces and their roles, and a layout sketch. Ground it in the subject (ENS identity and onchain forensics) and avoid templated defaults. Build only after approval.
- Quality floor: responsive, visible keyboard focus, reduced motion respected, accessible contrast.

## 7. Phases

0. **Scaffold.** Monorepo, strict TS, lint, test runner, env loading, Postgres and migrations, CI.
   - Done when CI runs the tests green.
1. **Names and bindings.** NameSource, tree walk, dedupe with multiple parents, bindings with `verified` and windows, home-name rule, and `ensmap tree <name> --namespace`.
   - Done when it works on a real mainnet name with subnames.
   - It also works on a `sepolia-v2` name whose subregistry is shared by two parents (set one up, or ask me to).
   - Unit tests cover dedupe and the home-name rule.
2. **Bonds.** TransferSource, cursors, filters, prices, aggregation, and `ensmap bonds <name>`.
   - Done when the poisoning fixtures are dropped.
   - A sample of amounts and USD values matches a block explorer.
   - A re-run only fetches new blocks.
3. **Labels.** Label adapters, curated JSON with sources, on-chain probes, sweep heuristic, supernodes, time nodes, and `ensmap labels <address...>`.
   - Done when known exchange hot wallets and a Uniswap v3 pool classify correctly.
   - A detected deposit address shows its exchange, source and confidence.
4. **Graph and API.** Graph builder, clusters, caps and collapse, schema, endpoints, caching.
   - Done when `/map/name/<name>` returns schema-valid JSON and contract tests pass.
5. **Web.** Design plan approval, map, panels, filters.
   - Done when a 250-name map stays responsive while panning and zooming.
   - Filters and toggles update without a refetch where possible.
   - Hub and time-node toggles behave as specified.
6. **Registry-rooted map and ENSv2 readiness.** Registry mode, with every ENSv2-specific path tested on `sepolia-v2`.
   - Done when there is a written checklist confirming that ENSv2 on mainnet needs no ENSmap code change.

## 8. Out of scope

- Inbound transfers, including CEX withdrawals. Bonds are outgoing only.
- NFT transfers as bonds.
- Gateway-only subnames.
- A time-travel UI.
- A custom ENS indexer. Ask first if ENSNode lacks something essential.
- Accounts, payments, sharing and export.

## 9. Done

- All phases accepted.
- README with setup, env and usage, plus `.env.example`.
- Curated labels with sources.
- A known-limitations section covering gateway-only subnames, label coverage, the heuristic deposit detection and ENSv2 mainnet status.
## Spec deviations (written into `docs/spec.md` by Task 0.1)

1. **ENS data source.** ENS data comes from the ENS subgraph (mainnet), `graphql.ens.dev` (sepolia-v2) and the Universal Resolver, not the ENSNode Omnigraph. `NameSource` keeps room for Omnigraph and ENSDb adapters.
2. **New env.**
   - `GRAPH_API_KEY` (secret).
   - `ENS_SOURCE_KIND_MAINNET`, `ENS_SOURCE_KIND_SEPOLIA_V2` (`ens-subgraph | ens-dev-graphql`).
   - `ENS_SOURCE_URL_MAINNET`, `ENS_SOURCE_URL_SEPOLIA_V2`.
   - `RPC_URL_1`, `RPC_URL_11155111` (secret, since they may embed keys).
   - `ENSMAP_FIXTURES` (`record|replay|off`).
   - `ENSNODE_URL_*` stay reserved and unused.
3. **Indexed total.** "Show the Omnigraph `totalCount`" becomes "show the source's indexed total, marked exact or as a lower bound".
4. **Storage.** `packages/db` is added. `bindings` gains `namespace`. `prices.usd` is nullable, caching "no price". `transfers` uses `from_address`/`to_address`, because `from` and `to` are SQL keywords.
5. **Record history.** It comes from the index: subgraph resolver events for ENSv1, and `graphql.ens.dev` `Linked`/`AddressUpdated`/`ResolverUpdated` events for ENSv2. ENSmap does not scan logs itself. When the history is missing, incomplete or ends on a different value, the registration start is used.
6. **ENSv2 on mainnet.** The Phase 6 "no code change" criterion holds only if the ENSv2-capable mainnet source speaks a schema ENSmap already supports. Switching kinds is config (`ENS_SOURCE_KIND_MAINNET`); a new schema needs one new adapter.
7. **Walk limits.** A `maxLevels` depth cap (default 16) is added next to the 1,000-name cap. Subgraph children with owner 0x0 and no resolver count as deleted and are not listed.
8. **Resolution path.** A node's wallet and effective resolver come from resolving its in-scope path. This differs from the canonical path for ENSv2 shared registries; see Task 1.8.
9. **Caching.** Phase 1 persists and caches nothing across runs. The Store and read-through caching start in Phase 2.
10. **CI and chains.** CI is local (`pnpm run ci`), and tests run on PGlite. `chains` config exists with default `[namespace chain]`; only coin type 60 on L1 is bound until a later phase adds L2 chains.
11. The web is built before Phases 2–4, by user decision. Until Phase 4, the map shows names and wallets only.
12. The web shows the `sepolia-v2` namespace only and has no network control.
13. The graph schema and builder land early as a slice of Phase 4. Nodes gain the optional fields `verifiedBy`, `owner`, `canonical` and `sharedWith`, and `meta` gains `warnings`.
14. Node kinds: the root and wallet home names are `name`; the others are `subname`.
15. Until bonds exist, the default size metric is `subnamesHeld` (descendant count).
16. There is no 250-name display cap and no "+N more" collapse yet. Everything fetched is shown, up to the 1,000-name fetch cap.
17. The map cache is in memory, with the spec's 6 h TTL, until Phase 4 adds the `maps` table.
