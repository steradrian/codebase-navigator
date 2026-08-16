// ─────────────────────────────────────────────────────────────────
// v0.2 → v1.0 schema migration.
//
// Pure function: given a legacy schema, produce a v1.0 schema with
// sensible defaults for new fields. Deterministic — the same input
// produces byte-identical output, which is required for the merge
// engine (GE-007) and for a stable initial state across re-runs.
// ─────────────────────────────────────────────────────────────────

import type {
  GuidedPath,
  Journey,
  JourneyStep,
  JourneyTransition,
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
 * Lift a linear `GuidedPath` into a v1.3 `Journey`.
 *
 * A linear path is the degenerate case of a journey: N steps joined by
 * N-1 unconditional transitions, no branches. Ids are derived from the
 * path id and step index so repeated conversions are byte-stable — the
 * same requirement that makes `linkId()` deterministic.
 *
 * Every step is emitted as `kind: 'action'`, including the last one.
 * Marking the final step as an `outcome` would require inventing an
 * `OutcomeKind` the source data never stated, and a fabricated outcome
 * is worse than an absent one for a tool whose premise is that
 * inference stays distinguishable from fact.
 */
export function journeyFromPath(path: GuidedPath): Journey {
  const steps: JourneyStep[] = path.steps.map((s, i) => ({
    id: `${path.id}__s${i}`,
    name: s.nodeId,
    annotation: s.annotation,
    kind: 'action' as const,
    nodeId: s.nodeId,
    duration: s.duration,
  }))

  const transitions: JourneyTransition[] = steps.slice(0, -1).map((s, i) => ({
    id: `${path.id}__t${i}`,
    from: s.id,
    to: steps[i + 1].id,
  }))

  return {
    id: path.id,
    name: path.name,
    description: path.description,
    color: path.color,
    category: path.category,
    entryStepIds: steps.length > 0 ? [steps[0].id] : [],
    steps,
    transitions,
  }
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
    journeys: paths.map(journeyFromPath),
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
      // Must mirror the v1.3 journey backfill below: this branch also
      // stamps the current version, and the idempotency guard would
      // then skip the upgrade forever, stranding the schema without
      // journeys.
      journeys: cleaned.journeys ?? cleaned.paths.map(journeyFromPath),
      meta: { ...cleaned.meta, version: SCHEMA_VERSION },
    })
  }

  if (schema.meta.version === SCHEMA_VERSION && schema.meta.lastPropagationAt && schema.journeys) {
    return schema
  }
  // Version bump happens unconditionally when below current; propagation
  // runs when entities haven't been propagated yet (lastPropagationAt
  // absent) OR after a version bump to pick up new GE-115b semantics.
  const bumped: Schema = {
    ...schema,
    // v1.2 → v1.3: mirror linear paths into branching journeys. Only
    // when `journeys` is absent — a schema that already carries
    // hand-authored journeys must not have them clobbered by the
    // lossy linear projections of the same flows.
    journeys: schema.journeys ?? schema.paths.map(journeyFromPath),
    meta: { ...schema.meta, version: SCHEMA_VERSION },
  }
  return propagateEntities(bumped)
}
