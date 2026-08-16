// ─────────────────────────────────────────────────────────────────
// Entity lens (GE-113).
//
// Given an anchor node and a target entity, compute the "ego
// subgraph" — the set of node IDs that belong to that entity's
// flow radiating from the anchor. Used to scope the 3D view so
// users can answer "show me just the Payment connections from
// this file."
//
// Pure function. No side effects.
// ─────────────────────────────────────────────────────────────────

import type { Schema } from '@/types'

/**
 * For a selected node, return the entity chips: each entity that
 * appears on the node's direct peers, with a count. Sorted by
 * count descending. The selected node's own entity (if any) is
 * excluded to avoid a redundant chip.
 */
export function peerEntityChips(
  schema: Schema,
  anchorId: string,
): Array<{ entity: string; count: number }> {
  const counts = new Map<string, number>()
  const anchor = schema.nodes.find((n) => n.id === anchorId)

  for (const l of schema.links) {
    let peerId: string | undefined
    if (l.source === anchorId) peerId = l.target
    else if (l.target === anchorId) peerId = l.source
    if (!peerId) continue

    const peer = schema.nodes.find((n) => n.id === peerId)
    if (!peer?.entity) continue

    counts.set(peer.entity, (counts.get(peer.entity) ?? 0) + 1)
  }

  // Include the anchor's own entity even if no peers share it —
  // the user starting from a domain entity node (e.g. Bonus DB
  // schema) wants to lens into their own entity's flow.
  if (anchor?.entity && !counts.has(anchor.entity)) {
    counts.set(anchor.entity, 0)
  }

  return [...counts.entries()]
    .map(([entity, count]) => ({ entity, count }))
    .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity))
}

/**
 * Compute the lens subgraph: starting from `anchorId`, traverse
 * peers whose `entity === lensEntity`, then THEIR peers with the
 * same entity, etc. The anchor itself is always included regardless
 * of its own entity. Returns the set of node IDs in the subgraph.
 *
 * Depth is unbounded but naturally bounded by the entity's size.
 * A budget cap prevents runaway traversal on pathological graphs.
 */
export function entityLensSubgraph(
  schema: Schema,
  anchorId: string,
  lensEntity: string,
  budget = 5000,
): Set<string> {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]))

  // Adjacency for quick lookup.
  const adj = new Map<string, string[]>()
  for (const l of schema.links) {
    const a = adj.get(l.source) ?? []
    a.push(l.target)
    adj.set(l.source, a)
    const b = adj.get(l.target) ?? []
    b.push(l.source)
    adj.set(l.target, b)
  }

  const result = new Set<string>([anchorId])
  const frontier = [anchorId]
  let visited = 0

  while (frontier.length > 0 && visited < budget) {
    const current = frontier.pop()!
    visited++
    for (const neighborId of adj.get(current) ?? []) {
      if (result.has(neighborId)) continue
      const neighbor = byId.get(neighborId)
      if (!neighbor) continue
      if (neighbor.entity !== lensEntity) continue
      result.add(neighborId)
      frontier.push(neighborId)
    }
  }

  return result
}

/**
 * Compute the FULL entity subgraph — every node in the graph that
 * carries `entity === lensEntity`, plus every node directly adjacent
 * to any of them (so edges between entity nodes and their immediate
 * non-entity neighbors are visible for navigation context).
 *
 * Used when the lens is "global" — not anchored to a single node
 * but scoping the entire graph to one entity's flow. Stays stable
 * as the user clicks through nodes within the flow.
 */
export function globalEntitySubgraph(
  schema: Schema,
  lensEntity: string,
): Set<string> {
  // Step 1: all nodes tagged with this entity.
  const result = new Set<string>()
  for (const n of schema.nodes) {
    if (n.entity === lensEntity) result.add(n.id)
  }

  // Step 2: add immediate neighbors of entity nodes so the user
  // can see the boundary (e.g. a hook that imports a client file
  // but isn't itself tagged with this entity yet).
  const neighbors = new Set<string>()
  for (const l of schema.links) {
    if (result.has(l.source) && !result.has(l.target)) neighbors.add(l.target)
    if (result.has(l.target) && !result.has(l.source)) neighbors.add(l.source)
  }
  for (const id of neighbors) result.add(id)

  return result
}
