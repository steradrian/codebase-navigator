# UI Readiness Register

What the current backend can serve for the "Living Software Understanding System" UI spec, what needs building, and what cannot be built honestly yet.

Every claim below was verified against code, not inferred from documentation. Measurements come from running the real pipeline against `casino-frontend` (731 source files, a 4,243-line OpenAPI spec, 580 commits).

---

## Verdict

**The extractors have caught up with the schema, and the server can now answer the questions the interface asks.**

- **8 of 9 lenses have data.** Only Runtime is empty, and it works — it needs a telemetry export to read.
- **6 of 7 evidence sources have a producer.** Only `ai_inference` has none, by choice.
- **17 endpoints, 9 of them computed** rather than fetched.
- **Trails exist**, persisted and freshness-assessed.

---

## What the blockers became

| Register blocker | Now |
|---|---|
| No queryable entity model | **Resolved** — projection, search, coverage, changes, indexing and trail routes; writes snapshot the state they replace |
| Five lenses with no data source | **Resolved** — Behavior (108 outcomes), Tests (149 files, 1,329 scenarios), Why (documents and decisions), History (git), Journey (32 derived flows) |
| Trails absent | **Resolved** — persisted per-row with focus/lens/altitude/question/note/timestamp, forkable, freshness-assessed |
| Runtime | **Remains** — HAR and OTel ingestion work and report spec-vs-reality mismatches, but nothing in a repository says what happened at run time |
| Identity, roles, ownership | **Remains** — the spec's team surfaces need authentication that does not exist |

---

## Measured on the real repository

Full pipeline against casino-frontend: 731 source files, a 4,243-line OpenAPI spec, 580 commits, 19 markdown files.

```
nodes 914 · links 2,002 · journeys 32

evidence by source
  git 740 · static_analysis 108 · test 148 · documentation 19 · runtime 0 · human 0

understanding coverage
  entities 21%  journeys 4%  behavior 100%  evidence 92%
  tests 18%     why 2%       runtime 0%     freshness 66%    overall 38%

indexing: 10 of 12 stages complete
  domain classification partial — 755 entities unassigned
  runtime unsupported — no source connected
```

Low numbers are findings, not defects. Journey coverage is 4% because derived journeys cover API
operations while most nodes are component files. `why` is 2% because this repository documents
components rather than decisions — it has no ADRs. Both are facts about the codebase the tool can
now state.

---

## What the UI still needs from us

1. **Decide the Runtime story.** Designs need a genuine "no telemetry connected" state.
2. **Author one real user journey.** Derived journeys describe single operations; a user goal like
   "deposit money" spans several and only a person can say where it starts and ends.
3. **Add identity** if team surfaces are in scope.
4. **Retire the old UI.** `GraphExplorer.tsx` and `urlState.ts` come out when the new one lands.

---

## Known traps

- **Three backend importers are stubs.** `nodejs.ts`, `python.ts`, `rust.ts` return
  `unsupported_language`. The Node plugin claims `.js .mjs .cjs .ts`, so a JS-dominant tree
  dispatches to a stub and yields nothing.
- **The dev server loads the API lazily via `ssrLoadModule`.** Do not revert to a direct import:
  Vite inlines the config's graph where `@/` does not resolve, failing with an error that names no file.
- **Name collision on "lens".** `src/schema/entity/lens.ts` is entity-scoped subgraph filtering,
  unrelated to the spec's lenses.
- **`Health` is declared and consumed nowhere.**
- **The `code` altitude is empty** because extraction is file-level — deliberately deferred after review.

*Verified against source, not inferred from documentation. 580 tests passing, typecheck clean.*
