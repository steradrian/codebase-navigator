// ─────────────────────────────────────────────────────────────────
// Entity extractor (GE-103, superseded by GE-115 catalog).
//
// In the closed-vocabulary model (GE-115), the entity catalog comes
// from the OpenAPI spec's `components.schemas`. Codebase nodes get
// their entity via propagation (GE-115b) along call/implementation
// edges — NOT via filename / folder extraction.
//
// This file retains:
//   - `backfillEntities` — delegates to OpenAPI catalog extraction
//     when schema was imported from OpenAPI; otherwise leaves nodes
//     untouched (propagation handles the rest).
//   - `entityCounts`, `mergeEntity`, `renameEntity` — catalog ops
//     used by the review dialog (GE-116).
//   - `singularize`, `extractEntity` — kept as deprecated no-ops for
//     manual-override compatibility and to avoid breaking tests until
//     they're updated.
//
// Pure functions. No I/O.
// ─────────────────────────────────────────────────────────────────

import type { Node, Schema } from '@/types'

export type ExtractContext = {
  schema: Schema
}

// ─── legacy helpers (retained for backwards compatibility) ──

const SINGULARIZE_OVERRIDES: Record<string, string> = {
  analytics: 'analytics',
  news: 'news',
  status: 'status',
  series: 'series',
  species: 'species',
  data: 'data',
  media: 'media',
  metadata: 'metadata',
  people: 'person',
  children: 'child',
}

export function singularize(raw: string): string {
  const lower = raw.toLowerCase().trim()
  if (!lower) return ''
  const override = SINGULARIZE_OVERRIDES[lower]
  if (override) return override
  if (lower.endsWith('ies') && lower.length > 3) return lower.slice(0, -3) + 'y'
  if (lower.endsWith('ses') && lower.length > 3) return lower.slice(0, -2)
  if (lower.endsWith('xes') && lower.length > 3) return lower.slice(0, -2)
  if (lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1)
  return lower
}

/**
 * In the closed-vocabulary model, extraction only returns a value
 * when the caller has set a manual override. Everything else flows
 * through the catalog (GE-115) + propagation (GE-115b).
 */
export function extractEntity(node: Node, _context?: ExtractContext): string | undefined {
  if (node.manualOverrides?.includes('entity')) return node.entity
  return undefined
}

/**
 * Leaves already-tagged nodes untouched. New closed-vocabulary
 * model: the OpenAPI parser tags nodes during import; propagation
 * (GE-115b) covers the rest. This function is retained as the API
 * surface for the load-path upgrade (GE-114) but has nothing to do
 * on schemas produced by the new importer.
 */
export function backfillEntities(schema: Schema): Schema {
  // No-op: propagation (GE-115b) now handles everything that extraction
  // used to do. Kept as an identity function to avoid breaking call
  // sites; `upgradeLoadedSchema` in migrate.ts calls propagation instead.
  return schema
}

export function entityCounts(schema: Schema): Array<{ entity: string; count: number }> {
  const counts = new Map<string, number>()
  for (const n of schema.nodes) {
    if (!n.entity) continue
    counts.set(n.entity, (counts.get(n.entity) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([entity, count]) => ({ entity, count }))
    .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity))
}

export function mergeEntity(schema: Schema, from: string, to: string): Schema {
  const nodes = schema.nodes.map((n) => {
    if (n.entity === from) return { ...n, entity: to }
    return n
  })
  const existingDict = schema.meta.entities ?? []
  const nextDict = Array.from(new Set(existingDict.filter((e) => e !== from).concat(to))).sort()
  return { ...schema, nodes, meta: { ...schema.meta, entities: nextDict } }
}

export function renameEntity(schema: Schema, from: string, to: string): Schema {
  return mergeEntity(schema, from, to)
}
