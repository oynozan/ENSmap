# ENSmap web map — design

Status: approved in chat on 2026-09-26. Branch: `phase-5-web`, cut from `main` at 48934b2, which includes Phase 1.

## Intent

The user wants a first website now, ahead of Phases 2–4. It is a plain page:

- a fully rounded search bar at the top, drawn as a border only, with a circular search button inside it;
- a d3 node map filling the rest of the page;
- a dark theme on `#191919`;
- Lexend Deca and Manrope at thin and light weights only.

The map shows real data that exists today: an ENS name on the Sepolia ENSv2 Beta, its subname tree, and the wallet each name resolves to. Transfer bonds, hubs and clusters arrive with Phases 2–4.

**Done when:**

- Typing `seller-a.eth` or `gloomy.eth` and pressing Enter or the button shows the tree, laid out and settling smoothly.
- Clicking a bubble opens a slim panel with its details.
- The page works at phone width.
- A 300-node map pans and zooms smoothly (95th-percentile frame time at most 20 ms).
- `pnpm run ci` is green offline.

## User decisions

| Topic   | Decision                                                                         |
| ------- | -------------------------------------------------------------------------------- |
| Data    | Real names and wallets from a new API endpoint; no mock bonds.                   |
| Network | Sepolia ENSv2 Beta only. No network control in the UI.                           |
| Click   | A slim details panel.                                                            |
| Git     | Merge `phase-1` into `main` (done), then build on `phase-5-web`. Local only.     |
| Style   | Keep it plain. Everything past the search bar, map, colour and fonts is my call. |

## Architecture

```
browser (apps/web)                 apps/api (Hono)                  packages/core
─────────────────                  ───────────────                  ─────────────
SearchBar ─┐
           ├─ fetch /api/map/… ──► GET /map/name/:name ──► MapService ──► buildNameMap (Phase 1)
URL state ─┘   (Vite dev proxy)     400/404/502 JSON        (6 h cache,   └► buildGraph → Graph
MapView ◄── Graph (zod-parsed) ◄──────────────────────────  in-flight
  ├ LayoutEngine (Web Worker, d3-force)                      dedupe)
  └ MapRenderer (canvas 2D) + d3-zoom
DetailsPanel · StatusLine · NodeList (keyboard)
```

- The browser only imports `@ensmap/core/schema`, which depends on zod alone.
- Every other core module stays server-side, so no secret or Node-only code reaches the bundle.

## 1. Graph schema — `packages/core/src/schema/index.ts` (early slice of Phase 4)

The schema is written in zod, is browser-safe, and is versioned. It carries the spec §5.9 shape plus four optional node fields (◆). Phase 4 extends it rather than replacing it.

- **`GRAPH_VERSION = 1`**
- **`NodeKind`:** `name | subname | counterparty | deposit | cexHub | dexHub | timeNode | collapsed`
- **`EdgeKind`:** `subname | bond | sweep | hub`
- **`SizeMetric`:** `outgoingUsd | subnamesHeld | walletBalanceUsd`

**`GraphNode`:**

```
{ id, kind, label, address?, names?, homeName?, chainId?, verified?, tags[],
  labelSource?, confidence?, size: { metric, value }, clusterId?, collapsedCount?,
  ◆ verifiedBy?, ◆ owner?, ◆ canonical?, ◆ sharedWith? }
```

- `id` is the source domain id.
- `label` is the beautified name.
- `address` is the bound wallet, lowercase.
- `names` holds the node ids of every name bound to the same wallet, home first. It is present only when `address` is set.
- `homeName` is the node id of that wallet's home name.
- ◆ `owner` is the name's owner address.
- ◆ `canonical` is the beautified canonical name, set only for `alias-path` nodes.
- ◆ `sharedWith` holds the beautified names outside the tree that share this node's registry.
- ◆ `verifiedBy` is `primary-name` or `owner`, set only on verified bindings.

**`GraphEdge`:**

```
{ id, source, target, kind, directed, tokens?, usdTotal?, count?, firstAt?, lastAt? }
```

- `subname` edges use id `subname:<parentId>:<childId>` and `directed: true`.

**`GraphMeta`:**

```
{ namespace, root, computedAt, caps, filters, totals, truncated[], warnings[] }
```

- `root` is the root node id.
- `caps` is `{ fetch: 1000 }`.
- `filters` is `{}` for now; Phase 4 adds fields.
- `totals` is `{ names, indexed: { value, exact }, wallets }`.
- `truncated` contains `'names'` when the walk was truncated.
- `warnings` holds the name map's warnings, redacted.

**`Graph`:** `{ version: 1, nodes, edges, meta }`

## 2. Graph builder — `buildGraph(r: NameMapResult, computedAt: Date): Graph`

This lives in `packages/core/src/graph/buildGraph.ts`, which is server-side.

- **Kinds.** The root and every wallet group's home name get `name`. Every other node is a `subname`.
- **Edges.** Each in-scope parent → child pair becomes one `subname` edge. A self-parent edge, where a registry contains its own node, is dropped, and the node keeps the tag `self-parent`.
- **Wallet fields.**
  - `address` and `verified` come from the node's binding.
  - `homeName` and `names` come from `wallets`.
  - A node without a binding has no `address`.
- **Tags** are the name map's tags for the node, such as `expired`, `alias-path` and `alias-unresolved`.
- **Size.** The metric is `subnamesHeld`, and the value is the number of distinct descendants below the node, not counting the node itself. Once bonds exist, the default metric becomes `outgoingUsd`.
- **Order.** Output is deterministic: nodes in tree BFS order, edges sorted by id.

## 3. API — `apps/api`

**Route.** `GET /map/name/:name?namespace=<mainnet|sepolia-v2>` returns `Graph` JSON. The namespace defaults to `mainnet`, as in the CLI; the web always sends `sepolia-v2`.

**`MapService`.** Injected through `AppDeps` so tests can fake it.

- The default implementation runs `resolveNamespace`, `createNamespaceDeps`, `buildNameMap` and `buildGraph`.
- It keeps an in-memory cache keyed by `namespace:normalizedName`, with the spec's 6 h TTL and at most 100 entries (the oldest is evicted).
- Concurrent requests for the same key share one build.
- Failures are not cached.
- Phase 4 moves the cache to the `maps` table.

**Errors.** Every error body has the shape `{ error: { code, message, labels? } }`. Nothing echoes a secret; each message passes through `redact`.

| Case                | Status | `code`                                             |
| ------------------- | ------ | -------------------------------------------------- |
| Name fails ENSIP-15 | 400    | `invalid-name`, with per-label reasons in `labels` |
| Unknown namespace   | 400    | `invalid-namespace`                                |
| Name not found      | 404    | `not-found`                                        |
| Provider failed     | 502    | `provider-error`, naming the provider              |
| Anything else       | 500    | `internal`, with a generic message                 |

**Dev scripts.**

- The API listens on `:3000` via `tsx watch`.
- Root `pnpm dev` runs the API and the web together (`pnpm --parallel`).

## 4. Web — `apps/web` (Vite and React)

Only the search bar, panel, status line and node list are React. The map is plain TypeScript behind two interfaces, so sigma.js could replace it later:

- **`LayoutEngine`:** `start(model)`, `onPositions(cb)`, `stop()`.
- **`MapRenderer`:** `draw(frame)`, `resize(w, h, dpr)`.

**Modules** (in `src/`):

| Module                  | Job                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.ts`                | `fetchGraph(name, signal)`. Calls `/api/map/name/<enc>?namespace=sepolia-v2`, parses the reply with `Graph`, and maps API errors to one message.        |
| `url.ts`                | Reads and writes `?name=`. Back and forward re-run the search.                                                                                          |
| `map/forceConfig.ts`    | Every force and size number, in one file.                                                                                                               |
| `map/model.ts`          | Pure. Turns a `Graph` into sim nodes and links, with radii and draw styles.                                                                             |
| `map/layout.worker.ts`  | The d3-force simulation. Posts `Float32Array` positions each tick, as a transfer. Under reduced motion it runs to rest first and posts once.            |
| `map/workerLayout.ts`   | Implements `LayoutEngine` over the worker.                                                                                                              |
| `map/canvasRenderer.ts` | Implements `MapRenderer`. DPR-aware canvas 2D; redraws on a rAF only when something changed.                                                            |
| `map/hitTest.ts`        | Pure. Finds the bubble under the pointer with a linear scan, which is enough at 1,000 names.                                                            |
| `map/MapView.tsx`       | Owns the canvas, d3-zoom (drag to pan, wheel or pinch to zoom), hover, selection and same-wallet highlight.                                             |
| `ui/SearchBar.tsx`      | The bordered pill with the circular button inside.                                                                                                      |
| `ui/DetailsPanel.tsx`   | The slim right-hand panel; a bottom sheet under 640 px.                                                                                                 |
| `ui/StatusLine.tsx`     | Bottom-left line in the form `6 names · indexed 6 · sepolia-v2 · 1 warning`. An expandable list, reachable by keyboard, shows the warnings.             |
| `ui/NodeList.tsx`       | Keyboard access. A list of buttons, one per node, visible only while focused. Focusing one draws a focus ring on its bubble, and Enter opens its panel. |
| `theme.css`             | Colour tokens, font faces, focus styles and reduced-motion rules.                                                                                       |

**Forces.** Every number lives in `forceConfig.ts`:

- **`subname` links:** short and strong, so subnames orbit their parent.
- **Many-body:** repulsion.
- **Collision:** radius equal to the bubble radius.
- **Position:** a weak centre and x/y pull, so small trees don't drift.

**Radius.** Grows with √(1 + size.value) above a minimum. `subname` bubbles are smaller than `name` bubbles, and the root is the largest.

### Visual system

| Name   | Hex       | Role                                                                            |
| ------ | --------- | ------------------------------------------------------------------------------- |
| ground | `#191919` | Page and canvas background                                                      |
| bone   | `#e6e3dc` | Primary text, bubble outlines, hover and selection (about 14:1 contrast)        |
| ash    | `#9a9894` | Secondary text and labels (about 6.2:1)                                         |
| line   | `#6a6a6a` | Search bar, panel and button borders; edges (about 3.3:1, the non-text minimum) |
| sage   | `#8fc1a9` | Outline of names with a verified wallet (about 8.7:1)                           |
| coral  | `#e08a7a` | The error line and the `expired` marker (about 6.8:1)                           |

**Fonts.** Both are self-hosted from `@fontsource-variable/lexend-deca` and `@fontsource-variable/manrope`, so there are no Google requests.

- **Lexend Deca:**
  - weight 200 for the search text, bubble labels and the panel title;
  - weight 100 for the empty-state hint.
- **Manrope:** weight 200 for the panel body, addresses, numbers and the status line; weight 300 wherever 200 is too faint below 13 px.
- **Canvas:** it waits on `document.fonts.load` before drawing labels.

**Search bar.**

- Centred, 48 px tall, `min(560px, 100% - 32px)` wide.
- A 1 px `line` border, a 999 px radius and a transparent fill.
- The circular button is 36 px, border only, with a 1.25 px stroke magnifier icon, inset 6 px from the right.
- While loading, the button's border becomes a rotating arc. Under reduced motion it shows a static ellipsis instead.

**Bubbles.**

- A 1 px outline with a fill of `bone` at 4 % alpha.
- The outline is `sage` when the wallet is verified.
- An unverified wallet has a 40 % alpha outline.
- A name with no wallet has a dashed outline.
- An `expired` name gets a small `coral` dot.
- Edges are 1 px `line` at 60 % alpha.
- Labels are drawn for the root, for hovered or selected nodes, and for every node once zoom ≥ 1.4.

**Hover and click.**

- Hovering brightens the node and every node on the same wallet.
- Clicking selects a node and opens the panel.
- Clicking empty space or pressing Esc closes the panel.

**Panel contents.**

- Beautified name.
- Wallet, full address, copyable.
- `verified by primary name` / `verified by owner` / `unverified` / `no wallet`.
- Owner.
- Other names on the same wallet; each one is clickable and selects that node.
- `canonical`, `registry shared with` and tags, when present.

**Empty state.** A centred hint in Lexend Deca 100, `ash`: "Search a name on the Sepolia ENSv2 Beta".

**Errors.** One `coral` line under the bar, in Manrope 200:

- a lookup that takes longer than 90 s: "The lookup took too long. Try again.";

- the API message, such as "Name not found on the Sepolia ENSv2 Beta";
- for an invalid name, the first per-label reason.

**Accessibility.**

- Keyboard focus is visible: a 1 px `bone` ring with a 2 px offset.
- The panel and search bar are ordinary focusable HTML.
- `prefers-reduced-motion` turns off the panel slide, the spinner and live layout ticks.

## 5. Testing and verification

**Core (`schema`, `graph`).** Unit tests over fake name maps:

- Kinds: root and home get `name`, the rest `subname`.
- One edge per parent pair.
- A self-parent edge is dropped and the node tagged `self-parent`.
- Alias `canonical` and `sharedWith` are set.
- `names` and `homeName` are right.
- Descendant counts are correct on a shared-registry tree and on a cycle.
- The output parses with `Graph`, and running the builder twice gives the same output.
- The schema module imports only zod; a test checks its import list.

**API.**

- Contract tests with a fake `MapService`: 200 bodies parse with `Graph`, and every error code and status in §3 is covered.
- A redaction test: a secret inside a provider error never appears in the response.
- Cache tests with a fake clock: a hit inside 6 h, a miss after, in-flight dedupe, and errors not cached.
- One replay test runs the real `MapService` on recorded `seller-a.eth` fixtures.

**Web (Vitest).**

- Pure tests: `model` (radii, styles, kinds), `hitTest`, `url`, and `api` (error mapping, schema rejection).
- jsdom tests:
  - `SearchBar`: Enter and a click both submit, an empty input does nothing, and the busy state is shown;
  - `DetailsPanel`: the fields render, a same-wallet click selects, and Esc closes.

**Build.** The web package's `typecheck` runs `tsc --noEmit && vite build`, so `pnpm run ci` covers the bundle. A test also greps the built bundle for env var names and fails if any appear.

**Visual.** `apps/web/scripts/screenshot.ts` drives the installed Chrome through `playwright-core` (channel `chrome`, no browser download). It is live and outside CI.

- It screenshots desktop and 390 px views of `seller-a.eth` and `gloomy.eth` against the live API.
- It serves a synthetic 300-node graph through request interception and reports frame times during a scripted pan and zoom.
- Target: the 95th-percentile frame time is at most 20 ms.

## 6. Spec deviations (added to `docs/spec.md`)

11. The web is built before Phases 2–4, by user decision. Until Phase 4, the map shows names and wallets only.
12. The web shows the `sepolia-v2` namespace only and has no network control.
13. The graph schema and builder land early as a slice of Phase 4. Nodes gain the optional fields `verifiedBy`, `owner`, `canonical` and `sharedWith`, and `meta` gains `warnings`.
14. Node kinds: the root and wallet home names are `name`; the others are `subname`.
15. Until bonds exist, the default size metric is `subnamesHeld` (descendant count).
16. There is no 250-name display cap and no "+N more" collapse yet. Everything fetched is shown, up to the 1,000-name fetch cap.
17. The map cache is in memory, with the spec's 6 h TTL, until Phase 4 adds the `maps` table.

## Out of scope

- Bonds, hubs, time nodes, clusters and the cluster panel.
- The filter and toggle UI, and collapse and expand.
- The `/node`, `/bond` and `/expand` endpoints.
- The `maps` table cache.
- Mainnet in the UI.
- Dragging nodes.
- Production hosting or serving the built web from the API.
