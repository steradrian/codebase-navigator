// ─────────────────────────────────────────────────────────────────
// Blast-radius computation (GE-014).
//
// Pure function: given a start node, walk the graph in either
// direction and return every reachable node with a severity score
// and a hop distance. Severity decays per link type:
//
//   dependency → 0.85  (strong coupling — X depends on Y, Y breaks, X breaks)
//   data_flow  → 0.65  (moderate — data stops flowing, caches may soften)
//   triggers   → 0.50  (loose — event not firing degrades, doesn't break)
//   default    → 0.60
//
// Severities multiply along a path. We use iterative relaxation so
// that a long all-dependency chain can outrank a short data_flow hop.
// Results are sorted by severity desc, then distance asc.
// ─────────────────────────────────────────────────────────────────

import type { Schema } from '@/types'

export type Direction = 'downstream' | 'upstream'

export type BlastImpact = {
  nodeId: string
  severity: number
  distance: number
}

const DECAY_BY_TYPE: Record<string, number> = {
  dependency: 0.85,
  data_flow: 0.65,
  triggers: 0.5,
}
const DEFAULT_DECAY = 0.6
const MIN_SEVERITY = 0.05

const decayFor = (type: string | undefined): number =>
  (type && DECAY_BY_TYPE[type]) ?? DEFAULT_DECAY

/**
 * Compute blast radius from `startNodeId`. If the start node is not in
 * the schema, returns an empty array.
 */
export function computeBlastRadius(
  schema: Schema,
  startNodeId: string,
  direction: Direction,
): BlastImpact[] {
  // Fast neighbor lookup: for each node id, list of (neighbor, link).
  // Build both outgoing (downstream) and incoming (upstream) maps.
  const outgoing = new Map<string, { neighbor: string; type: string | undefined }[]>()
  const incoming = new Map<string, { neighbor: string; type: string | undefined }[]>()
  for (const l of schema.links) {
    if (!outgoing.has(l.source)) outgoing.set(l.source, [])
    outgoing.get(l.source)!.push({ neighbor: l.target, type: l.type })
    if (!incoming.has(l.target)) incoming.set(l.target, [])
    incoming.get(l.target)!.push({ neighbor: l.source, type: l.type })
  }
  const edges = direction === 'downstream' ? outgoing : incoming

  if (!schema.nodes.some((n) => n.id === startNodeId)) return []

  // severities[id] = best known severity to reach this node
  const severities = new Map<string, number>([[startNodeId, 1]])
  const distances = new Map<string, number>([[startNodeId, 0]])
  const queue: string[] = [startNodeId]

  while (queue.length > 0) {
    const current = queue.shift()!
    const currentSev = severities.get(current)!
    const currentDist = distances.get(current)!
    const neighbors = edges.get(current) ?? []

    for (const { neighbor, type } of neighbors) {
      const decay = decayFor(type)
      const candidateSev = currentSev * decay
      if (candidateSev < MIN_SEVERITY) continue
      const existing = severities.get(neighbor)
      if (existing === undefined || candidateSev > existing) {
        severities.set(neighbor, candidateSev)
        distances.set(neighbor, currentDist + 1)
        queue.push(neighbor)
      }
    }
  }

  const impacts: BlastImpact[] = []
  for (const [nodeId, severity] of severities) {
    impacts.push({ nodeId, severity, distance: distances.get(nodeId)! })
  }
  impacts.sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity
    return a.distance - b.distance
  })
  return impacts
}

/** Utility: map severity to a red-gradient hex color for rendering. */
export function severityColor(severity: number): string {
  // Blend from bright red (1.0) to muted dark red (~0.05)
  const t = Math.max(0, Math.min(1, severity))
  // R stays near max, G / B scale with (1 - t)
  const g = Math.round(64 * (1 - t))
  const b = Math.round(80 * (1 - t))
  return `rgb(255, ${g}, ${b})`
}
