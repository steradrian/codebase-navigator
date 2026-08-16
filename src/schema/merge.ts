// ─────────────────────────────────────────────────────────────────
// Non-destructive schema merge (GE-007).
//
// Pure function: takes an existing working schema and a candidate
// schema (usually from an importer) and returns a merged schema plus
// a structured conflict report.
//
// CONTRACT
// --------
// 1. Manual entities are sacred — never overwritten, never silently
//    dropped. A collision with an auto candidate of the same ID is
//    logged and the manual entity wins.
// 2. Auto entities are authoritative only within their own origin.
//    An OpenAPI re-import may drop or update its own auto:openapi
//    entities but never touches auto:codebase entities from a
//    different importer.
// 3. Manual edits on auto entities are tracked per-field via
//    `manualOverrides: string[]`. When the candidate tries to change
//    an overridden field, the manual value wins and the conflict
//    is logged.
// 4. Dropping an auto node that a manual path (or manual link)
//    references is blocked. The node stays with its prior state and
//    the conflict is logged.
// 5. Auto links orphaned by a node drop are silently removed. Manual
//    links that end up orphaned are preserved — they're the user's
//    problem to notice, and dropping them would violate rule 1.
// 6. Paths and annotations carried by the existing schema are always
//    preserved. Candidate paths/annotations are ignored (importers
//    don't produce these today).
// 7. Running merge twice with the same inputs produces byte-identical
//    output — required for test stability and user trust.
// ─────────────────────────────────────────────────────────────────

import type {
  Link,
  MergeConflict,
  MergeResult,
  Node,
  Origin,
  Schema,
} from '@/types'
import { assignAltitudes } from '@/schema/altitude'
import { humanEvidenceOf } from '@/schema/verify'

// Fields that are structural identity — never merged, never tracked.
const STRUCTURAL_NODE_FIELDS = new Set(['id', 'origin', 'manualOverrides'])
const STRUCTURAL_LINK_FIELDS = new Set(['id', 'origin', 'manualOverrides'])

const isAuto = (origin: Origin): boolean => origin.startsWith('auto:')

/** Deep equality via stable JSON. Good enough for the metadata/weight/etc. values we store. */
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Merge a candidate schema into an existing schema.
 *
 * Both inputs are treated as immutable — the result is a freshly
 * constructed schema, and neither `existing` nor `candidate` is
 * mutated.
 */
/**
 * Authored journeys always survive a re-import untouched.
 *
 * Derived flows are a separate collection and follow the opposite rule:
 * the importer owns them, so the candidate's flows replace the existing
 * ones outright.
 */
function mergeJourneys(existing: Schema, candidate: Schema): Schema['journeys'] {
  const authored = (existing.journeys ?? []).filter((j) => !j.origin || j.origin === 'manual')
  return authored.length > 0 ? authored : existing.journeys
}

function mergeFlows(existing: Schema, candidate: Schema): Schema['flows'] {
  return candidate.flows ?? existing.flows
}

export function merge(existing: Schema, candidate: Schema): MergeResult {
  const conflicts: MergeConflict[] = []

  // Origins this candidate claims authority over. Used to scope
  // the "auto is authoritative for auto" rule.
  const candidateOrigins = new Set<Origin>(candidate.meta.sources ?? [])

  // Fast lookup tables.
  const existingNodesById = new Map(existing.nodes.map((n) => [n.id, n]))
  const candidateNodesById = new Map(candidate.nodes.map((n) => [n.id, n]))
  const existingLinksById = new Map(existing.links.map((l) => [l.id, l]))
  const candidateLinksById = new Map(candidate.links.map((l) => [l.id, l]))

  // Index manual path/link references to enable deletion-blocking.
  const manualPathRefs = new Map<string, string[]>() // nodeId → [pathId...]
  for (const p of existing.paths) {
    for (const step of p.steps) {
      const arr = manualPathRefs.get(step.nodeId) ?? []
      arr.push(p.id)
      manualPathRefs.set(step.nodeId, arr)
    }
  }
  const manualLinkRefs = new Map<string, string[]>() // nodeId → [linkId...]
  for (const l of existing.links) {
    if (l.origin !== 'manual') continue
    for (const ref of [l.source, l.target]) {
      const arr = manualLinkRefs.get(ref) ?? []
      arr.push(l.id)
      manualLinkRefs.set(ref, arr)
    }
  }

  // ── PHASE 1: resolve node fate ──
  const mergedNodes: Node[] = []
  const mergedNodeIds = new Set<string>()

  // 1a. Walk existing nodes — decide keep / update / drop.
  for (const existingNode of existing.nodes) {
    const cand = candidateNodesById.get(existingNode.id)

    // Manual entity: never overwritten. If candidate has a same-ID
    // auto version, log it and keep ours.
    if (existingNode.origin === 'manual') {
      if (cand && isAuto(cand.origin)) {
        conflicts.push({
          kind: 'manual_shadows_auto_candidate',
          entityType: 'node',
          entityId: existingNode.id,
        })
      }
      mergedNodes.push(existingNode)
      mergedNodeIds.add(existingNode.id)
      continue
    }

    // Auto entity outside the candidate's authority — pass through unchanged.
    if (!candidateOrigins.has(existingNode.origin)) {
      mergedNodes.push(existingNode)
      mergedNodeIds.add(existingNode.id)
      continue
    }

    // Auto entity inside candidate's authority.
    if (!cand) {
      // Candidate says this node no longer exists. Delete — unless
      // a manual path / manual link references it.
      const blockingPaths = manualPathRefs.get(existingNode.id) ?? []
      const blockingLinks = manualLinkRefs.get(existingNode.id) ?? []
      if (blockingPaths.length > 0 || blockingLinks.length > 0) {
        conflicts.push({
          kind: 'manual_blocks_auto_deletion',
          entityType: 'node',
          entityId: existingNode.id,
          blockedBy: { pathIds: blockingPaths, linkIds: blockingLinks },
        })
        mergedNodes.push(existingNode)
        mergedNodeIds.add(existingNode.id)
      }
      // Otherwise: the node is dropped (simply not pushed).
      continue
    }

    // Same-ID auto candidate — merge field by field, respecting overrides.
    const overrides = new Set(existingNode.manualOverrides ?? [])
    const merged: Node = { ...cand }
    // Preserve structural fields from candidate (id, origin) but carry
    // override metadata from existing.
    merged.manualOverrides = existingNode.manualOverrides

    for (const field of Object.keys({ ...existingNode, ...cand })) {
      if (STRUCTURAL_NODE_FIELDS.has(field)) continue
      const eKey = field as keyof Node
      const existingVal = existingNode[eKey]
      const candVal = cand[eKey]
      if (overrides.has(field)) {
        // Manual value wins. If candidate proposes something different, log it.
        if (!eq(existingVal, candVal)) {
          conflicts.push({
            kind: 'manual_override_wins',
            entityType: 'node',
            entityId: existingNode.id,
            field,
            kept: existingVal,
            rejected: candVal,
          })
        }
        ;(merged as Record<string, unknown>)[field] = existingVal
      }
      // Non-overridden field: candidate's value already sits in `merged` via {...cand}.
    }

    // Human verification survives re-import. An importer knows nothing
    // about who confirmed what, so letting its evidence array replace
    // the existing one would silently discard the most valuable
    // knowledge in the system. Extractor-derived evidence is still taken
    // from the candidate — only confirmations are carried forward.
    const carriedHuman = humanEvidenceOf(existingNode)
    if (carriedHuman.length > 0 && !overrides.has('evidence')) {
      const fromCandidate = (merged.evidence ?? []).filter((e) => e.source !== 'human')
      merged.evidence = [...fromCandidate, ...carriedHuman]
    }

    mergedNodes.push(merged)
    mergedNodeIds.add(existingNode.id)
  }

  // 1b. Walk candidate nodes — add new ones not yet seen.
  for (const candNode of candidate.nodes) {
    if (mergedNodeIds.has(candNode.id)) continue
    mergedNodes.push(candNode)
    mergedNodeIds.add(candNode.id)
  }

  // ── PHASE 2: resolve link fate (same logic as nodes, minus path-blocking) ──
  const mergedLinks: Link[] = []
  const mergedLinkIds = new Set<string>()

  for (const existingLink of existing.links) {
    const cand = candidateLinksById.get(existingLink.id)

    if (existingLink.origin === 'manual') {
      if (cand && isAuto(cand.origin)) {
        conflicts.push({
          kind: 'manual_shadows_auto_candidate',
          entityType: 'link',
          entityId: existingLink.id,
        })
      }
      mergedLinks.push(existingLink)
      mergedLinkIds.add(existingLink.id)
      continue
    }

    if (!candidateOrigins.has(existingLink.origin)) {
      mergedLinks.push(existingLink)
      mergedLinkIds.add(existingLink.id)
      continue
    }

    if (!cand) {
      // Auto link no longer in candidate: drop.
      continue
    }

    const overrides = new Set(existingLink.manualOverrides ?? [])
    const merged: Link = { ...cand }
    merged.manualOverrides = existingLink.manualOverrides

    for (const field of Object.keys({ ...existingLink, ...cand })) {
      if (STRUCTURAL_LINK_FIELDS.has(field)) continue
      const eKey = field as keyof Link
      const existingVal = existingLink[eKey]
      const candVal = cand[eKey]
      if (overrides.has(field)) {
        if (!eq(existingVal, candVal)) {
          conflicts.push({
            kind: 'manual_override_wins',
            entityType: 'link',
            entityId: existingLink.id,
            field,
            kept: existingVal,
            rejected: candVal,
          })
        }
        ;(merged as Record<string, unknown>)[field] = existingVal
      }
    }

    mergedLinks.push(merged)
    mergedLinkIds.add(existingLink.id)
  }

  for (const candLink of candidate.links) {
    if (mergedLinkIds.has(candLink.id)) continue
    mergedLinks.push(candLink)
    mergedLinkIds.add(candLink.id)
  }

  // ── PHASE 3: drop orphaned auto links ──
  const finalLinks = mergedLinks.filter((l) => {
    if (l.origin === 'manual') return true
    return mergedNodeIds.has(l.source) && mergedNodeIds.has(l.target)
  })

  // ── PHASE 4: union registries, preserve existing paths + annotations ──
  const mergedSources = unionSources(existing.meta.sources, candidate.meta.sources)

  // GE-115: merge entity + domain catalogs from both schemas.
  // The candidate (imported) may carry a fresh catalog; the existing
  // may carry user edits. Union + sort for determinism.
  const mergedEntities = Array.from(new Set([
    ...(existing.meta.entities ?? []),
    ...(candidate.meta.entities ?? []),
  ])).sort()
  const mergedDomains = Array.from(new Set([
    ...(existing.meta.domains ?? []),
    ...(candidate.meta.domains ?? []),
  ])).sort()

  const mergedSchema: Schema = {
    meta: {
      ...existing.meta,
      sources: mergedSources,
      entities: mergedEntities.length > 0 ? mergedEntities : existing.meta.entities,
      domains: mergedDomains.length > 0 ? mergedDomains : existing.meta.domains,
    },
    nodeTypes: { ...existing.nodeTypes, ...candidate.nodeTypes },
    linkTypes: { ...existing.linkTypes, ...candidate.linkTypes },
    nodes: sortById(mergedNodes),
    links: sortById(finalLinks),
    paths: existing.paths,
    // v1.3 — authored journeys are sacred and always survive a
    // re-import. Derived flows are a separate collection owned by the
    // importer, so the candidate's replace the existing ones.
    journeys: mergeJourneys(existing, candidate),
    flows: mergeFlows(existing, candidate),
    annotations: existing.annotations,
  }

  // Altitude depends only on node type + isHub, both already resolved
  // above, so recompute it here rather than leaving `meta.altitudeCoverage`
  // describing the pre-merge node set. The zoom control gates on that
  // count, and a stale one would offer tiers the merged graph no longer
  // has (or hide tiers it just gained).
  return { schema: assignAltitudes(mergedSchema), conflicts }
}

// ─── helpers ─────────────────────────────────────────────────

function unionSources(a?: Origin[], b?: Origin[]): Origin[] {
  const set = new Set<Origin>([...(a ?? []), ...(b ?? [])])
  return [...set].sort()
}

function sortById<T extends { id: string }>(arr: T[]): T[] {
  return [...arr].sort((x, y) => x.id.localeCompare(y.id))
}
