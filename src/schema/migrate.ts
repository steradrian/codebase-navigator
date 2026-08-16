// ─────────────────────────────────────────────────────────────────
// v0.2 → v1.0 schema migration.
//
// Pure function: given a legacy schema, produce a v1.0 schema with
// sensible defaults for new fields. Deterministic — the same input
// produces byte-identical output, which is required for the merge
// engine (GE-007) and for a stable initial state across re-runs.
// ─────────────────────────────────────────────────────────────────

import type {
  LegacySchema,
  LinkType,
  Schema,
} from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { propagateEntities } from '@/schema/entity/propagate'
import { hasStaleAutoEntityTags, resetAutoEntityTags } from '@/schema/entity/catalog'

/**
 * Default link-type registry derived from the types baked into v0.2's
 * renderer. Callers can override by passing their own in the migrated
 * schema post-migration; migration does not mutate user-supplied
 * registries.
 */
const DEFAULT_LINK_TYPES: Record<string, LinkType> = {
  data_flow: { color: '#1a4a6c', label: 'Data Flow', animated: true },
  dependency: { color: '#3a2a5c', label: 'Dependency', dashed: true },
  triggers: { color: '#4a3a1c', label: 'Triggers', animated: true },
}

/**
 * Deterministic link ID derived from its endpoints and type. This is
 * the primary key for annotations (GE-023) and diff tracking (GE-016),
 * so stability across re-imports is non-negotiable.
 */
export function linkId(source: string, target: string, type?: string): string {
  return `${source}__${type ?? 'none'}__${target}`
}

/**
 * Migrate a v0.2 schema to v1.0. Does not read the clock — callers who
 * want `lastUpdated` populated should set it themselves post-migration.
 */
export function migrate(legacy: LegacySchema): Schema {
  const nodes = legacy.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    description: n.description,
    group: n.group,
    owner: n.owner,
    origin: 'manual' as const,
  }))

  const links = legacy.links.map((l) => ({
    id: linkId(l.source, l.target, l.type),
    source: l.source,
    target: l.target,
    label: l.label,
    description: l.description,
    type: l.type,
    origin: 'manual' as const,
  }))

  const paths = legacy.paths.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    color: p.color,
    steps: p.steps.map((s) => ({
      nodeId: s.nodeId,
      annotation: s.annotation,
    })),
  }))

  const schema: Schema = {
    meta: {
      name: legacy.meta.name,
      version: SCHEMA_VERSION,
      sources: ['manual'],
    },
    nodeTypes: legacy.nodeTypes,
    linkTypes: DEFAULT_LINK_TYPES,
    nodes,
    links,
    paths,
    annotations: [],
  }
  // GE-115b — propagate entities across graph edges (no-op here since
  // this is a freshly migrated schema with no seeds, but keeps the call
  // site consistent with the downstream importers).
  return propagateEntities(schema)
}

/**
 * Upgrade a schema loaded from the API to the current SCHEMA_VERSION.
 *
 * Covers the v1.0 → v1.1 gap: graphs stored before GE-103 shipped
 * carry `meta.version === '1.0'` and have no `entity` field on any
 * node. Without this hook, every entity-aware feature (color-by-entity,
 * legend, filter rail, entity chips) silently no-ops on those graphs.
 *
 * Idempotent — if the schema is already on SCHEMA_VERSION the input
 * is returned unchanged. The version is bumped as part of the upgrade
 * so a subsequent save persists the upgraded shape and future loads
 * skip the migration.
 *
 * Call this at the single boundary where schemas enter React state
 * from the API (see GE-114).
 */
export function upgradeLoadedSchema(schema: Schema): Schema {
  // Stuck-state cleanup: graphs migrated under earlier versions still
  // carry `entity` values from the old open-vocabulary extractor
  // (filename-derived junk). Detect by the symptom — empty catalog +
  // nodes with entity values — and wipe them so the next OpenAPI
  // import + propagation can produce a clean catalog. This runs at
  // most once per stuck graph; once cleared, the condition is false.
  if (hasStaleAutoEntityTags(schema)) {
    const cleaned = resetAutoEntityTags(schema)
    return propagateEntities({
      ...cleaned,
      meta: { ...cleaned.meta, version: SCHEMA_VERSION },
    })
  }

  if (schema.meta.version === SCHEMA_VERSION && schema.meta.lastPropagationAt) {
    return schema
  }
  // Version bump happens unconditionally when below current; propagation
  // runs when entities haven't been propagated yet (lastPropagationAt
  // absent) OR after a version bump to pick up new GE-115b semantics.
  const bumped: Schema = {
    ...schema,
    meta: { ...schema.meta, version: SCHEMA_VERSION },
  }
  return propagateEntities(bumped)
}
