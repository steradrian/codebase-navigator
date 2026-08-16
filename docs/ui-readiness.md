# UI Readiness Register

What the current backend can serve for the "Living Software Understanding System" UI spec, what needs building, and what cannot be built honestly yet.

Every claim below was verified against code, not inferred from documentation. Measurements come from running the real pipeline against `casino-frontend` (731 source files, a 4,243-line OpenAPI spec, 580 commits).

---

## Verdict

**The schema is roughly one full layer ahead of the extractors, and the server is roughly one full layer behind the schema.**

`types.ts` already models nearly everything the spec describes — `Journey`, `JourneyTransition.condition`, `OutcomeKind`, `Evidence`, provenance, confidence. The extractors mostly do not produce it, and the server cannot store or query it.

Concretely:

- **5 of 9 lenses would render empty** — Behavior, Journey, Why, Runtime, Tests.
- **6 of 7 evidence sources have no producer.** Only `git` emits anything.
- **Trails do not exist.** The spec's central concept has no type, table, or endpoint.
- **The server answers exactly one question:** "give me the whole graph."

Building the UI now would produce a convincing Overview/Code/Impact experience and four or five dead tabs.

---

## Three structural blockers

### 1. There is no queryable entity model

The backend stores one JSONB blob per project across two tables (`graphs`, `annotations`) and exposes eight endpoints, all graph-level CRUD. There is no projection, search, trail, coverage, or change endpoint.

Every route in the spec needs addressable entities, per-entity projections, cross-entity search, versioned snapshots, and durable per-user state. None of that is expressible over an opaque document that must be loaded whole.

`computeProjection` — the model→UI boundary the whole architecture rests on — runs **client-side only** and has no HTTP surface.

### 2. Five lenses have no data source

| Lens | State | Why |
|---|---|---|
| Behavior | empty | Nothing extracts conditionals, error handlers, or state transitions. `OutcomeKind` has zero producers. |
| Journey | empty | Journeys only ever come from hand-authored linear paths. No branches, actors, roles, or flags are extracted anywhere. |
| Why | empty | `.md` is rejected at the file-read boundary, so ADRs, docs and READMEs are never read. Only git subject lines exist. |
| Runtime | empty | No traces, spans, logs, analytics, or error monitoring. |
| Tests | empty | Test files are **deliberately excluded** by `SKIP_FILE_PATTERNS`. |

### 3. Trails are entirely absent

The spec requires each trail step to preserve focus, lens, depth, question, notes and timestamp, and trails to be saved, replayed, shared, forked, annotated, and detected as stale.

Today `ExplorationQuery.trail` is a `string[]` of node ids, consumed for scoring and never persisted. In-app navigation history is a React ref that dies on reload.

---

## What is genuinely ready

These work today and are measured, not assumed:

- **Projection engine** — focus + altitude + lens + trail → ranked entities with explanations, budgets, diversity selection, and honest notices. Tested to 29 cases; hub-dampening and diversity were mutation-verified.
- **Semantic zoom** — six altitude tiers, coverage counts, loud degradation when a tier is empty. Real spec run: product 1 · domain 10 · behavior 50 · system 120 · implementation 483 · code 0.
- **Impact** — weighted blast radius, upstream and downstream.
- **Extraction** — OpenAPI, codebase (file-level), Go backend, transitive API linking, git history. 646 nodes, ~1,700 links, 3% isolated on the real repo.
- **Merge** — non-destructive, manual-override-aware, deterministic.
- **Diff** — structural, now including journeys.

---

## Cheapest high-value wins, in order

**1. Parse OpenAPI error responses → the Behavior lens.**
The importer reads only `['200','201','202','203','204']`. The real spec declares **56 error responses** — 21×401, 11×422, 11×400, 9×404, 4×412 — which map almost directly onto `OutcomeKind`: 401→`permission_denied`, 422/400→`validation_error`, 404→`not_found`, 412→`conflict`.

The emptiest and most novel lens has real, code-derived outcome data already sitting in a file we parse. This is the single best ratio of value to effort in the register.

**2. Stop excluding tests → the Tests lens.**
`SKIP_FILE_PATTERNS` drops `.test.` / `.spec.` files and warns. Reading them and linking test → subject gives the Tests lens real content and lights up the `test` evidence source, which currently has no producer.

**3. Read markdown → the Why lens.**
`CODE_EXT` rejects `.md` at the file-read boundary. Reading README/ADR/docs populates the `documentation` evidence source and gives Why something beyond commit subjects.

**4. Restore `narrative` and `suggestedQuestions` to `Projection`.**
Both were in the original data-shape sketch and were dropped during implementation. `QuestionSuggestion` and every lens's explanatory copy depend on them.

**5. Persist trails.**
New table plus a richer `TrailStep` (focus, lens, altitude, question, note, timestamp). Unlocks `/trails`, `/home`'s "continue exploring", and the onboarding story that motivates the product.

---

## Data model gaps

| Requirement | Status | Note |
|---|---|---|
| AI-inferred, unknown/partial resolution | ready | `EvidenceSummary.aiInferred`, `Resolution` |
| Journey actors, entry points, branching, outcomes | ready | v1.3 |
| Confidence banding (High/Med/Low) | partial | only a raw 0..1 mean; no bands, no entity-level confidence |
| Recently-changed | partial | `metadata.lastModified` exists; not a persisted state |
| Human-verified | partial | `'human'` source exists; no verification record, no write path |
| Deprecated, stale, conflicting | **absent** | no fields |
| Relationship states (runtime-verified, conflicting, stale, hidden) | **absent** | `Link` has none |
| Knowledge conflict + resolution | **absent** | worse than missing — `summariseEvidence` *averages* confidence, so disagreement is silently blended away rather than surfaced |
| Journey variation (role / flag / subscription / device / region) | **absent** | only a free-text `condition` string |
| Journey status | **absent** | no field |
| Screen, Route, Test, Commit, PR, Issue, ADR as entities | **absent** | registered types are domain, database, service, feature, api, client, hook, component, page, layout, util, ui, external |
| Understanding coverage (8 dimensions, per domain) | **absent** | `meta.altitudeCoverage` counts nodes per zoom tier — a different measurement, not a substitute |
| Semantic change feed / before-vs-after behavior | **absent** | diff is structural (add/remove/modify counts) |
| Temporal model history ("before PR #1421") | **absent** | `PUT /graphs/:id` overwrites in place; no snapshots |
| Suggested questions / narrative | **absent** | dropped during projection implementation |
| Auth, identity, roles, domain ownership | **absent** | no users table; annotation author is a client-supplied string |

---

## Known traps

- **`nodejs.ts`, `python.ts`, `rust.ts` backend importers are 14-line stubs** returning `unsupported_language`. `nodejsPlugin` declares `['.js','.mjs','.cjs','.ts']`, so a JS/TS-dominant tree routed through `parseBackendCodebase` dispatches to a stub and silently yields nothing.
- **`Health` is declared in `types.ts` and consumed nowhere.** Dead field.
- **`src/schema/entity/lens.ts` means something unrelated to the spec's "lenses"** — it is entity-scoped subgraph filtering. Naming collision worth resolving before it confuses the UI work.
- **`ViewState` (URL sharing) encodes the retired 3D graph's state**, not focus/lens/altitude/trail. Deep links need redefining.
- **`code` altitude is empty** because extraction is file-level. Debated and deliberately deferred: the pathology is concentrated in one file, and a regex-based symbol extractor misses exports in 47% of files.

---

## Recommended sequence before UI

1. **Wins 1–3 above** (error responses, tests, markdown). Turns three dead lenses into partially populated ones using sources already on disk.
2. **Hand-author one branching journey** against real node ids — deposit or bonus claim. The only way Behavior and Journey get exercised, and what the prototype was always meant to test.
3. **Projection HTTP endpoint + trail persistence.** The minimum server surface any spec route needs.
4. **Then build the UI** against a backend that can actually answer its questions.

Steps 1 and 2 are what stop the first design review from hitting five empty tabs.
