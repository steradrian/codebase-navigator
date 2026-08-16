# Graph Explorer — Backlog

Index of all tickets. Each ticket is a self-contained markdown file in this directory. This file is the index, not the source of truth — always open the individual ticket for scope, acceptance criteria, and context.

## Conventions

- **IDs** are assigned in proposed execution order (`GE-001` → `GE-030`). They are stable — never renumber.
- Follow-up tickets get a `b` suffix (e.g., `GE-018b`).
- **Status** values: `TODO` | `IN PROGRESS` | `DONE` | `PARTIAL` | `BLOCKED` | `CANCELLED`. Update in the ticket file itself.
- **Checkboxes**: `[x]` done, `[~]` partial, `[ ]` todo.
- **Effort** values: `S` (<1 day), `M` (1–3 days), `L` (3+ days). Rough.
- Each ticket is implementation-agnostic — no code blocks, no prescribed file structure. The implementing agent chooses the approach.
- Dependencies are listed explicitly. Respect them — some tickets will fail silently if built out of order.

## MVP Thesis

**The Narrative Demo** — point at a real OpenAPI spec (or codebase), watch the graph materialize, click a guided path, watch the camera fly through annotated nodes, share the URL. That demo is what every MVP ticket serves.

---

## Scaffolding

- [x] [GE-001](./GE-001.md) — TypeScript migration
- [x] [GE-002](./GE-002.md) — Vitest + test harness setup
- [x] [GE-003](./GE-003.md) — Schema v1.0 migration (data model + types)
- [x] [GE-004](./GE-004.md) — Bugfix: Three.js scene rebuild on `activePath` change
- [x] [GE-005](./GE-005.md) — Rename `source_meta` → `origin` across schema

## Phase 1 — Foundation

- [x] [GE-006](./GE-006.md) — OpenAPI parser (pure function)
- [x] [GE-007](./GE-007.md) — Schema merge engine (non-destructive)
- [x] [GE-008](./GE-008.md) — OpenAPI import UI
- [x] [GE-009](./GE-009.md) — In-app schema editor UI
- [x] [GE-010](./GE-010.md) — Export / import schema as JSON
- [x] [GE-011](./GE-011.md) — Group hull visualization
- [x] [GE-012](./GE-012.md) — 2D toggle view

## Phase 2 — Intelligence

- [x] [GE-013](./GE-013.md) — Semantic zoom with cluster collapse
- [x] [GE-014](./GE-014.md) — Impact analysis / blast radius
- [x] [GE-015](./GE-015.md) — Guided path authoring UI
- [x] [GE-016](./GE-016.md) — Schema diff view
- [x] [GE-017](./GE-017.md) — AI-generated node descriptions

## Phase 3 — Scale (demo-ready)

- [~] [GE-018](./GE-018.md) — Web Worker physics (Barnes-Hut) · Barnes-Hut shipped; worker deferred to [GE-018b](./GE-018b.md)
- [~] [GE-019](./GE-019.md) — Instanced rendering + LOD · label LOD shipped; instanced meshes deferred to [GE-019b](./GE-019b.md)
- [x] [GE-020](./GE-020.md) — Local persistence: Postgres via Docker + Drizzle + Hono (rescoped)
- [x] [GE-022](./GE-022.md) — Shareable deep links (URL state)
- [x] [GE-023](./GE-023.md) — Multi-user annotations

## Phase 4 — Ecosystem (demo-ready)

- [x] [GE-026](./GE-026.md) — Codebase parser (AST → graph)
- [x] [GE-026c](./GE-026c.md) — Link codebase UI to OpenAPI endpoints
- [x] [GE-029](./GE-029.md) — Natural language queries

## Phase 5 — UX + entity-flow storytelling

Track A — data model + core UX
- [x] [GE-103](./GE-103.md) — Entity tagging (schema v1.1)
- [x] [GE-101](./GE-101.md) — Navigation history (back / forward / breadcrumb)
- [x] [GE-102](./GE-102.md) — Hover tooltips on nodes
- [x] [GE-107](./GE-107.md) — Help panel + richer button tooltips

Track B — visualization (depends on GE-103)
- [x] [GE-105](./GE-105.md) — Connection panel redesign
- [x] [GE-104](./GE-104.md) — Filter rail
- [x] [GE-106](./GE-106.md) — Color-by-entity rendering mode
- [x] [GE-108](./GE-108.md) — Legend counts + click-to-filter-by-type

Track C — backend parsing (full-stack flow)
- [x] [GE-109](./GE-109.md) — BE codebase parser (Go-first, plugin architecture)
- [x] [GE-110](./GE-110.md) — BE handlers → OpenAPI operations linker

Track D — hub & entity-lens (triggered by real-workload evidence from `Ann test`)
- [x] [GE-114](./GE-114.md) — Backfill entities on load for pre-v1.1 schemas
- [ ] [GE-111](./GE-111.md) — Entity-grouped peers in the connection panel
- [ ] [GE-112](./GE-112.md) — Hub visual marker · now consumes `node.isHub` from GE-115b
- [ ] [GE-113](./GE-113.md) — Entity pivot from any selected node · entity/domain toggle per GE-115

Track E — closed-vocabulary catalog (two-level: entity + domain from OpenAPI)
- [ ] [GE-115](./GE-115.md) — Catalog from `components.schemas` + `tags`; unwrap response shapes; deprecate filename extractors
- [ ] [GE-115b](./GE-115b.md) — Entity propagation across graph edges; computes `node.isHub` as byproduct
- [ ] [GE-116](./GE-116.md) — Catalog curator (review dialog rewrite; Catalog + Unclassified tabs)
- [ ] [GE-104b](./GE-104b.md) — Filter rail: add Domain facet

---

## Follow-ups (post-MVP, triggered by real workloads)

- [ ] [GE-001b](./GE-001b.md) — Enable TypeScript strict mode
- [ ] [GE-018b](./GE-018b.md) — Move force simulation into a Web Worker
- [ ] [GE-019b](./GE-019b.md) — Migrate nodes to InstancedMesh + batched links

## Post-demo (deferred pending strategic decisions)

These tickets were scoped as MVP but deferred once the MVP target narrowed to a local-first demo. They remain valid designs; revisit when the commercial / deployment story is decided.

- [ ] [GE-021](./GE-021.md) — Progressive / lazy subgraph loading · requires server API at scale
- [ ] [GE-024](./GE-024.md) — Real-time sync (WebSockets) · requires multi-user, deployed server
- [ ] [GE-025](./GE-025.md) — CI/CD integration (auto-regenerate on deploy) · requires deployed server
- [ ] [GE-027](./GE-027.md) — Figma component tree import · narrow audience; BYO Figma token friction
- [ ] [GE-028](./GE-028.md) — Health overlays (Sentry / Datadog) · requires live observability data
- [ ] [GE-030](./GE-030.md) — Embeddable widget · requires hosted URL to embed
- [ ] [GE-117](./GE-117.md) — DB schema importer as catalog source · unblocks internal-table entities not exposed via OpenAPI

---

## Open strategic questions

Unresolved. These are decisions that must be made before the Post-demo tickets can move back to active.

- **Hosting model** — currently local-only via Docker. Deployment target (Fly / Supabase / self-hosted) undecided. Unblocks GE-024, GE-025, GE-030.
- **Auth / multi-tenancy** — single-user for MVP. Unblocks GE-024.
- **Schema versioning** — latest-only for MVP. A future history feature would open time-travel + diff-over-time.
- **Commercial angle** — internal tooling or product? Influences which Post-demo tickets earn priority.
