// ─────────────────────────────────────────────────────────────────
// Relevance scoring for the projection layer.
//
// Five independent terms, combined per-lens. Structural proximity is
// one of them, not the whole model — see the reasoning in ./types.ts.
//
// Every function here is pure and clock-free. Recency takes "now" as an
// argument so a projection is reproducible.
// ─────────────────────────────────────────────────────────────────

import type { Evidence, Journey, Node, Schema } from '@/types'
import {
  LENS_PRIMARY_EVIDENCE,
  SOURCE_TRUST,
  UNEVIDENCED_TRUST,
  type Lens,
  type LensProfile,
} from './types'

export type Proximity = { score: number; distance: number }

/** Decay per link type. Tuned for topical closeness, not failure propagation. */
const PROXIMITY_DECAY: Readonly<Record<string, number>> = {
  dependency: 0.7,
  data_flow: 0.7,
  triggers: 0.6,
}
const DEFAULT_PROXIMITY_DECAY = 0.65
const MIN_PROXIMITY = 0.02

const decayFor = (type: string | undefined): number => {
  if (!type) return DEFAULT_PROXIMITY_DECAY
  return PROXIMITY_DECAY[type] ?? DEFAULT_PROXIMITY_DECAY
}

/**
 * Best-path proximity from a set of seeds, by multiplicative decay with
 * iterative relaxation — the same traversal shape as `computeBlastRadius`,
 * but scoring topical closeness rather than failure severity, and honouring
 * the lens's link-type filter.
 *
 * Seeds may carry a prior below 1, which is how trail entries contribute
 * without needing a second traversal.
 */
export function proximityFrom(
  schema: Schema,
  seeds: ReadonlyMap<string, number>,
  profile: LensProfile,
  maxDepth: number,
): Map<string, Proximity> {
  const allowed = profile.allowedLinkTypes ? new Set(profile.allowedLinkTypes) : null

  const outgoing = new Map<string, { neighbor: string; type?: string }[]>()
  const incoming = new Map<string, { neighbor: string; type?: string }[]>()
  for (const l of schema.links) {
    // An excluded relationship must be genuinely absent: merely
    // down-weighting it still lets it accumulate across hops.
    if (allowed && !allowed.has(l.type ?? '')) continue
    if (!outgoing.has(l.source)) outgoing.set(l.source, [])
    outgoing.get(l.source)!.push({ neighbor: l.target, type: l.type })
    if (!incoming.has(l.target)) incoming.set(l.target, [])
    incoming.get(l.target)!.push({ neighbor: l.source, type: l.type })
  }

  const neighboursOf = (id: string): { neighbor: string; type?: string }[] => {
    if (profile.direction === 'downstream') return outgoing.get(id) ?? []
    if (profile.direction === 'upstream') return incoming.get(id) ?? []
    return [...(outgoing.get(id) ?? []), ...(incoming.get(id) ?? [])]
  }

  const best = new Map<string, Proximity>()
  const queue: string[] = []
  for (const [id, prior] of seeds) {
    best.set(id, { score: prior, distance: 0 })
    queue.push(id)
  }

  while (queue.length > 0) {
    const current = queue.shift()!
    const here = best.get(current)!
    if (here.distance >= maxDepth) continue

    for (const { neighbor, type } of neighboursOf(current)) {
      const candidate = here.score * decayFor(type)
      if (candidate < MIN_PROXIMITY) continue
      const existing = best.get(neighbor)
      if (existing === undefined || candidate > existing.score) {
        best.set(neighbor, { score: candidate, distance: here.distance + 1 })
        queue.push(neighbor)
      }
    }
  }

  return best
}

/**
 * How much the trail vouches for a node.
 *
 * Recent stops count for more than early ones — the trail is a thought
 * in progress, and what the user looked at last is the best evidence of
 * what they are chasing now.
 */
export function trailPriors(trail: readonly string[]): Map<string, number> {
  const priors = new Map<string, number>()
  const n = trail.length
  trail.forEach((id, i) => {
    const recency = (i + 1) / n // oldest → ~0, newest → 1
    const prior = 0.4 + 0.6 * recency
    const existing = priors.get(id)
    if (existing === undefined || prior > existing) priors.set(id, prior)
  })
  return priors
}

/**
 * Trust in what we know about a node, in 0..1.
 *
 * Combines provenance with stated confidence. A lens that names primary
 * evidence sources boosts matches, which is how `tests` ranks
 * test-derived facts highly without a test-shaped subgraph to walk.
 */
export function evidenceScore(evidence: Evidence[] | undefined, lens: Lens): number {
  if (!evidence || evidence.length === 0) return UNEVIDENCED_TRUST

  const primary = LENS_PRIMARY_EVIDENCE[lens]
  let best = 0
  for (const e of evidence) {
    const trust = SOURCE_TRUST[e.source] ?? UNEVIDENCED_TRUST
    // Unscored evidence is not disbelieved — absence of a number means
    // nobody scored it, which is different from scoring it zero.
    const stated = e.confidence ?? 0.8
    let score = trust * stated
    if (primary?.includes(e.source)) score = Math.min(1, score * 1.5)
    if (score > best) best = score
  }
  return best
}

const DAY_MS = 24 * 60 * 60 * 1000
const RECENCY_HALF_LIFE_DAYS = 30

/**
 * Recency of a node's last change, in 0..1.
 *
 * Returns a neutral 0 when either timestamp is missing or unparseable,
 * so an absent clock contributes nothing rather than inventing a
 * ranking signal.
 */
export function recencyScore(node: Node, now: string | undefined): number {
  if (!now) return 0
  const modified = node.metadata?.lastModified
  if (!modified) return 0

  const nowMs = Date.parse(now)
  const thenMs = Date.parse(modified)
  if (Number.isNaN(nowMs) || Number.isNaN(thenMs)) return 0

  const ageDays = (nowMs - thenMs) / DAY_MS
  if (ageDays < 0) return 1 // future-dated; treat as maximally recent
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

/**
 * How central a node is to the product's described behaviour, from
 * journey membership. Normalised against the busiest node so the term
 * stays in 0..1 regardless of how many journeys a project has authored.
 */
export function behaviouralImportance(journeys: readonly Journey[] | undefined): Map<string, number> {
  const counts = new Map<string, number>()
  for (const j of journeys ?? []) {
    // A node referenced by several steps of one journey is counted once
    // per journey: breadth across flows is the signal, not verbosity
    // within a single flow.
    const seen = new Set<string>()
    for (const step of j.steps) {
      if (!step.nodeId || seen.has(step.nodeId)) continue
      seen.add(step.nodeId)
      counts.set(step.nodeId, (counts.get(step.nodeId) ?? 0) + 1)
    }
  }

  const max = Math.max(0, ...counts.values())
  if (max === 0) return counts
  const normalised = new Map<string, number>()
  for (const [id, count] of counts) normalised.set(id, count / max)
  return normalised
}

/**
 * Similarity between two nodes, for diversity-aware selection.
 *
 * Used to stop a single cluster — or a hub and its immediate
 * neighbourhood — filling the whole budget.
 */
export function similarity(a: Node, b: Node): number {
  let score = 0
  if (a.entity && a.entity === b.entity) score += 0.5
  if (a.domain && a.domain === b.domain) score += 0.3
  if (a.type === b.type) score += 0.2
  return Math.min(1, score)
}
