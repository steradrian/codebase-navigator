// ─────────────────────────────────────────────────────────────────
// Entity propagation (GE-115b).
//
// After GE-115 tags API operations and database nodes with their
// entity + domain, this pass walks the cross-stack edges (calls,
// implementations, imports) to tag the rest of the graph:
//
//   - FE client functions that CALL an API op → inherit op.entity
//   - BE handlers that IMPLEMENT an API op    → inherit op.entity
//   - A file that IMPORTS an entity-tagged file → inherits transitively
//
// Conflicts (a node reached from multiple entities) → Unclassified.
// Nodes imported by ≥ 3 distinct entities are flagged `isHub: true`.
//
// Pure function. Idempotent: running twice produces the same output.
// Respects `manualOverrides: ['entity']` — the user's choice wins.
// ─────────────────────────────────────────────────────────────────

import type { Link, Node, Schema } from '@/types'

const HUB_THRESHOLD = 3

type EntityDomainPair = { entity?: string; domain?: string }

/**
 * Run the propagation pass. Returns a new schema where every node
 * that connects to an entity-tagged seed via call / implementation /
 * import edges inherits the entity + domain. Nodes reached from
 * multiple entities are left unset (Unclassified) and flagged as
 * hubs if the count ≥ 3. Sets `meta.lastPropagationAt` to the
 * current ISO timestamp.
 */
export function propagateEntities(schema: Schema): Schema {
  // Working state: node id → set of entities that reached it during
  // propagation. `domain` is tracked similarly for optional inherit.
  const entitiesReached = new Map<string, Set<string>>()
  const domainsReached = new Map<string, Set<string>>()

  // Pre-seeded nodes (catalog-assigned from GE-115, or manual
  // overrides) are locked — propagation can neither overwrite nor
  // extend their entity set. This keeps authoritative tags stable
  // through the fixed-point loop.
  const locked = new Set<string>()
  for (const n of schema.nodes) {
    if (n.entity) {
      entitiesReached.set(n.id, new Set([n.entity]))
      locked.add(n.id)
    }
    if (n.domain) {
      domainsReached.set(n.id, new Set([n.domain]))
    }
  }

  // Build adjacency maps once.
  const outgoing = new Map<string, Link[]>()
  const incoming = new Map<string, Link[]>()
  for (const l of schema.links) {
    const o = outgoing.get(l.source) ?? []
    o.push(l)
    outgoing.set(l.source, o)
    const i = incoming.get(l.target) ?? []
    i.push(l)
    incoming.set(l.target, i)
  }

  // Helper: propagate one entity+domain pair to a node. Returns true
  // if this was new information (i.e. extended the set). Used to drive
  // fixed-point iteration.
  const addReached = (nodeId: string, payload: EntityDomainPair): boolean => {
    // Locked nodes are authoritative — propagation cannot extend them.
    if (locked.has(nodeId)) return false
    let changed = false
    if (payload.entity) {
      const set = entitiesReached.get(nodeId) ?? new Set<string>()
      if (!set.has(payload.entity)) {
        set.add(payload.entity)
        entitiesReached.set(nodeId, set)
        changed = true
      }
    }
    if (payload.domain) {
      const set = domainsReached.get(nodeId) ?? new Set<string>()
      if (!set.has(payload.domain)) {
        set.add(payload.domain)
        domainsReached.set(nodeId, set)
        changed = true
      }
    }
    return changed
  }

  // Combined view: the entity+domain currently assigned to a node
  // during iteration (respecting single-value rule — multiple entities
  // collapse to Unclassified at the end).
  const currentEntity = (nodeId: string): string | undefined => {
    const set = entitiesReached.get(nodeId)
    if (!set || set.size !== 1) return undefined
    const [v] = set
    return v
  }
  const currentDomain = (nodeId: string): string | undefined => {
    const set = domainsReached.get(nodeId)
    if (!set || set.size !== 1) return undefined
    const [v] = set
    return v
  }

  // Fixed-point loop: keep propagating until no new entity hits. Cheap
  // — in practice converges in a handful of iterations.
  let iterations = 0
  const MAX_ITERATIONS = 20 // safety net against unexpected cycles
  let anyChange = true
  while (anyChange && iterations < MAX_ITERATIONS) {
    anyChange = false
    iterations++

    for (const link of schema.links) {
      // Only flow edges carry entity propagation.
      if (link.type !== 'data_flow' && link.type !== 'dependency') continue

      if (link.type === 'data_flow') {
        // Two shapes, identified by label:
        //   - "calls"         → caller (source) inherits from op (target)
        //   - "implemented by"→ handler (target) inherits from op (source)
        //   - "accepts" / "returns" (OpenAPI request/response) — API op
        //     already carries its entity from GE-115; DB node is the
        //     other endpoint. Propagate in BOTH directions so DB nodes
        //     tagged by the catalog reinforce the API op's entity, and
        //     vice versa.
        const payloadForward: EntityDomainPair = {
          entity: currentEntity(link.source),
          domain: currentDomain(link.source),
        }
        const payloadBackward: EntityDomainPair = {
          entity: currentEntity(link.target),
          domain: currentDomain(link.target),
        }

        const label = link.label?.toLowerCase() ?? ''
        if (label === 'calls') {
          // target has entity (API op), flows to source (caller).
          if (payloadBackward.entity) {
            if (addReached(link.source, payloadBackward)) anyChange = true
          }
        } else if (label === 'implemented by') {
          // source has entity (API op), flows to target (handler).
          if (payloadForward.entity) {
            if (addReached(link.target, payloadForward)) anyChange = true
          }
        } else {
          // Catch-all for 'accepts'/'returns' and any other data_flow
          // semantics: propagate in both directions.
          if (payloadForward.entity) {
            if (addReached(link.target, payloadForward)) anyChange = true
          }
          if (payloadBackward.entity) {
            if (addReached(link.source, payloadBackward)) anyChange = true
          }
        }
      } else if (link.type === 'dependency') {
        // A imports B. source = A (importer), target = B (imported).
        // Entity flows from B → A: the thing that imports a domain-
        // tagged module inherits the domain. Does NOT propagate in
        // the other direction (would push importers' entities onto
        // shared utility files).
        const payload: EntityDomainPair = {
          entity: currentEntity(link.target),
          domain: currentDomain(link.target),
        }
        if (payload.entity) {
          if (addReached(link.source, payload)) anyChange = true
        }
      }
    }
  }

  // ── Hub detection ──
  // A node is a hub if ≥ 3 distinct entities IMPORT it (incoming
  // dependency edges from nodes with distinct entities). This is
  // independent of whether the hub itself ended up tagged.
  const hubSet = new Set<string>()
  for (const node of schema.nodes) {
    const inLinks = incoming.get(node.id) ?? []
    const entitiesOfImporters = new Set<string>()
    for (const l of inLinks) {
      if (l.type !== 'dependency') continue
      const sourceEntities = entitiesReached.get(l.source)
      if (!sourceEntities) continue
      for (const e of sourceEntities) entitiesOfImporters.add(e)
    }
    if (entitiesOfImporters.size >= HUB_THRESHOLD) hubSet.add(node.id)
  }

  // ── Apply results to produce the new schema ──
  const nodes = schema.nodes.map((n) => {
    // Respect manual overrides (even if propagation would disagree).
    if (n.manualOverrides?.includes('entity')) {
      const out: Node = { ...n, isHub: hubSet.has(n.id) || undefined }
      return cleanNode(out)
    }

    const reachedEntities = entitiesReached.get(n.id)
    const reachedDomains = domainsReached.get(n.id)
    const isConflict = (reachedEntities?.size ?? 0) > 1

    const resolvedEntity =
      !reachedEntities || reachedEntities.size === 0
        ? undefined
        : reachedEntities.size === 1
          ? [...reachedEntities][0]
          : undefined // conflict: stays Unclassified

    // Domain: inherit only if exactly one — conflicts blank it too.
    const resolvedDomain =
      !reachedDomains || reachedDomains.size !== 1
        ? undefined
        : [...reachedDomains][0]

    return cleanNode({
      ...n,
      entity: resolvedEntity,
      domain: resolvedDomain,
      isHub: hubSet.has(n.id) || isConflict || undefined,
    })
  })

  // Keep `lastPropagationAt` stable: derive from the schema's
  // lastUpdated when available, else leave it fixed for determinism
  // in tests and merge-engine byte-identity checks.
  const stamp = schema.meta.lastUpdated ?? '1970-01-01T00:00:00.000Z'
  return {
    ...schema,
    nodes,
    meta: {
      ...schema.meta,
      lastPropagationAt: stamp,
    },
  }
}

/** Drop undefined fields that would otherwise pollute JSON diffs. */
function cleanNode(n: Node): Node {
  const copy: Record<string, unknown> = { ...n }
  for (const k of ['entity', 'domain', 'isHub', 'manualOverrides'] as const) {
    if (copy[k] === undefined) delete copy[k]
  }
  return copy as Node
}
