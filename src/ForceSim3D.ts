// ─────────────────────────────────────────────────────────────────
// 3D FORCE-DIRECTED LAYOUT ENGINE
//
// Simple physics simulation: repulsion between all nodes, attraction
// along links, centering force, group cohesion, and velocity damping.
//
// Good enough for <200 nodes. For larger graphs, swap in a Barnes-Hut
// approximation or use d3-force-3d / ngraph.forcelayout.
// ─────────────────────────────────────────────────────────────────

import type { Node, Link } from '@/types'

export type ForceSimConfig = {
  repulsion: number
  attraction: number
  centering: number
  damping: number
  groupCohesion: number
  idealLinkDistance: number
  alphaDecay: number
  initialSpread: number
  initialRandomness: number
}

export type ForceSimConfigInput = Partial<ForceSimConfig>

export type SimulatedNode = Node & {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

export type SimulatedLink = Link & {
  sourceNode: SimulatedNode | undefined
  targetNode: SimulatedNode | undefined
}

type GroupCenter = { x: number; y: number; z: number; count: number }

export class ForceSim3D {
  readonly config: Pick<
    ForceSimConfig,
    'repulsion' | 'attraction' | 'centering' | 'damping' | 'groupCohesion' | 'idealLinkDistance' | 'alphaDecay'
  > & { alphaDecay: number }

  readonly nodes: SimulatedNode[]
  readonly links: SimulatedLink[]
  alpha: number
  /** When true, the simulation collapses node z coords toward 0 each tick. */
  mode2D: boolean = false
  /**
   * Toggle the Barnes-Hut approximation for repulsion. When undefined,
   * the sim auto-selects based on node count (above ~60 nodes the
   * tree overhead pays for itself). Set explicitly in tests for
   * deterministic comparison.
   */
  useBarnesHut: boolean | undefined = undefined
  /** Barnes-Hut approximation threshold. Higher = faster but looser. */
  theta: number = 0.8

  constructor(nodes: Node[], links: Link[], config: ForceSimConfigInput = {}) {
    const {
      repulsion = 2200,
      attraction = 0.005,
      centering = 0.008,
      damping = 0.87,
      groupCohesion = 0.003,
      idealLinkDistance = 35,
      alphaDecay = 0.994,
      initialSpread = 60,
      initialRandomness = 50,
    } = config

    this.config = { repulsion, attraction, centering, damping, groupCohesion, idealLinkDistance, alphaDecay }

    // Initialize node positions — group nodes together by angle
    const groups: Record<string, number> = {}
    nodes.forEach((n) => {
      if (n.group) groups[n.group] = (groups[n.group] || 0) + 1
    })
    const groupKeys = Object.keys(groups)
    const groupAngle: Record<string, number> = {}
    groupKeys.forEach((g, i) => {
      groupAngle[g] = (i / groupKeys.length) * Math.PI * 2
    })

    this.nodes = nodes.map((n) => {
      const a = (n.group && groupAngle[n.group]) || 0
      return {
        ...n,
        x: Math.cos(a) * initialSpread + (Math.random() - 0.5) * initialRandomness,
        y: (Math.random() - 0.5) * (initialRandomness * 1.6),
        z: Math.sin(a) * initialSpread + (Math.random() - 0.5) * initialRandomness,
        vx: 0,
        vy: 0,
        vz: 0,
      }
    })

    this.links = links.map((l) => ({
      ...l,
      sourceNode: this.nodes.find((n) => n.id === l.source),
      targetNode: this.nodes.find((n) => n.id === l.target),
    }))

    this.alpha = 1
  }

  /**
   * Run one tick of the simulation.
   * @returns true if simulation is still active (alpha > threshold)
   */
  tick(): boolean {
    if (this.alpha < 0.001) return false

    const { nodes, links, config } = this
    const { repulsion, attraction, centering, damping, groupCohesion, idealLinkDistance } = config

    // ── Compute group centers ──
    const groupCenters: Record<string, GroupCenter> = {}
    for (const n of nodes) {
      if (!n.group) continue
      if (!groupCenters[n.group]) groupCenters[n.group] = { x: 0, y: 0, z: 0, count: 0 }
      const gc = groupCenters[n.group]
      gc.x += n.x
      gc.y += n.y
      gc.z += n.z
      gc.count++
    }
    for (const g in groupCenters) {
      const c = groupCenters[g]
      c.x /= c.count
      c.y /= c.count
      c.z /= c.count
    }

    // ── Repulsion ──
    // Barnes-Hut approximation (O(n log n)) kicks in above a small
    // threshold where its overhead is worth it; exact O(n²) stays
    // the default for tiny graphs where it's both faster and simpler
    // to reason about. Auto-select unless `useBarnesHut` is set.
    const useBH = this.useBarnesHut ?? nodes.length > 60
    if (useBH) {
      applyBarnesHutRepulsion(nodes, repulsion * this.alpha, this.theta)
    } else {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dz = a.z - b.z
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
          const f = (repulsion * this.alpha) / (dist * dist)
          const fx = (dx / dist) * f
          const fy = (dy / dist) * f
          const fz = (dz / dist) * f
          a.vx += fx
          a.vy += fy
          a.vz += fz
          b.vx -= fx
          b.vy -= fy
          b.vz -= fz
        }
      }
    }

    // ── Attraction (along links) ──
    for (const l of links) {
      const a = l.sourceNode
      const b = l.targetNode
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
      const f = (dist - idealLinkDistance) * attraction * this.alpha
      const fx = (dx / dist) * f
      const fy = (dy / dist) * f
      const fz = (dz / dist) * f
      a.vx += fx
      a.vy += fy
      a.vz += fz
      b.vx -= fx
      b.vy -= fy
      b.vz -= fz
    }

    // ── Centering + group cohesion + damping ──
    for (const n of nodes) {
      // Pull toward origin
      n.vx -= n.x * centering * this.alpha
      n.vy -= n.y * centering * this.alpha
      n.vz -= n.z * centering * this.alpha

      // Pull toward group center
      if (n.group && groupCenters[n.group]) {
        const gc = groupCenters[n.group]
        n.vx += (gc.x - n.x) * groupCohesion * this.alpha
        n.vy += (gc.y - n.y) * groupCohesion * this.alpha
        n.vz += (gc.z - n.z) * groupCohesion * this.alpha
      }

      // Apply damping and update position
      n.vx *= damping
      n.vy *= damping
      n.vz *= damping
      n.x += n.vx
      n.y += n.vy
      n.z += n.vz

      // 2D mode: collapse z smoothly toward 0
      if (this.mode2D) {
        n.vz = 0
        n.z *= 0.85
      }
    }

    this.alpha *= config.alphaDecay
    return true
  }

  /** Toggle 2D projection mode. Reheats the simulation so motion animates. */
  setMode2D(on: boolean, reheatAlpha = 0.3): void {
    this.mode2D = on
    this.reheat(reheatAlpha)
  }

  /**
   * Reheat the simulation (useful after user drags a node)
   */
  reheat(alpha: number = 0.3): void {
    this.alpha = Math.max(this.alpha, alpha)
  }

  /**
   * Get a node by id
   */
  getNode(id: string): SimulatedNode | undefined {
    return this.nodes.find((n) => n.id === id)
  }

  /**
   * Get all links connected to a node
   */
  getConnections(nodeId: string): SimulatedLink[] {
    return this.links.filter((l) => l.source === nodeId || l.target === nodeId)
  }

  /**
   * Get all node ids connected to a given node (including itself)
   */
  getConnectedIds(nodeId: string): Set<string> {
    const ids = new Set<string>([nodeId])
    for (const l of this.links) {
      if (l.source === nodeId) ids.add(l.target)
      if (l.target === nodeId) ids.add(l.source)
    }
    return ids
  }
}

// ─────────────────────────────────────────────────────────────────
// Barnes-Hut octree repulsion (GE-018).
//
// Build an octree of node positions, compute a center-of-mass per
// cell, then for each target node traverse the tree: treat any cell
// whose size-to-distance ratio is below `theta` as a single point
// mass (approximation), else recurse. Complexity drops from O(n²)
// to roughly O(n log n).
//
// Implementation notes:
//   - Trees are rebuilt every tick. Pre-allocating would help but
//     the cost is already dominated by the traversal.
//   - We use non-OOP flat arrays for children (indexed 0-7) to
//     reduce allocation overhead and GC pressure.
//   - Self-force is skipped: a leaf cell containing only the target
//     node contributes nothing.
// ─────────────────────────────────────────────────────────────────

type OctreeCell = {
  // Axis-aligned bounds
  minX: number; minY: number; minZ: number
  maxX: number; maxY: number; maxZ: number
  // Aggregate mass (node count) and center of mass
  mass: number
  cx: number; cy: number; cz: number
  // Children, or null if leaf
  children: (OctreeCell | null)[] | null
  // If leaf with a single occupant, the occupant; else null
  occupant: SimulatedNode | null
}

const BH_MAX_DEPTH = 20
const BH_MIN_SIZE = 0.5

function newCell(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): OctreeCell {
  return {
    minX, minY, minZ, maxX, maxY, maxZ,
    mass: 0, cx: 0, cy: 0, cz: 0,
    children: null, occupant: null,
  }
}

function octantIndex(cell: OctreeCell, x: number, y: number, z: number): number {
  const midX = (cell.minX + cell.maxX) * 0.5
  const midY = (cell.minY + cell.maxY) * 0.5
  const midZ = (cell.minZ + cell.maxZ) * 0.5
  const xBit = x >= midX ? 1 : 0
  const yBit = y >= midY ? 2 : 0
  const zBit = z >= midZ ? 4 : 0
  return xBit | yBit | zBit
}

function subdivide(cell: OctreeCell): void {
  if (cell.children) return
  const midX = (cell.minX + cell.maxX) * 0.5
  const midY = (cell.minY + cell.maxY) * 0.5
  const midZ = (cell.minZ + cell.maxZ) * 0.5
  cell.children = [
    newCell(cell.minX, cell.minY, cell.minZ, midX, midY, midZ),
    newCell(midX, cell.minY, cell.minZ, cell.maxX, midY, midZ),
    newCell(cell.minX, midY, cell.minZ, midX, cell.maxY, midZ),
    newCell(midX, midY, cell.minZ, cell.maxX, cell.maxY, midZ),
    newCell(cell.minX, cell.minY, midZ, midX, midY, cell.maxZ),
    newCell(midX, cell.minY, midZ, cell.maxX, midY, cell.maxZ),
    newCell(cell.minX, midY, midZ, midX, cell.maxY, cell.maxZ),
    newCell(midX, midY, midZ, cell.maxX, cell.maxY, cell.maxZ),
  ]
}

function insertNode(cell: OctreeCell, node: SimulatedNode, depth: number): void {
  // Aggregate mass and center-of-mass on the way down.
  const newMass = cell.mass + 1
  cell.cx = (cell.cx * cell.mass + node.x) / newMass
  cell.cy = (cell.cy * cell.mass + node.y) / newMass
  cell.cz = (cell.cz * cell.mass + node.z) / newMass
  cell.mass = newMass

  // Stop subdividing at max depth or below minimum size (prevents
  // infinite recursion on coincident or near-coincident points).
  const size = Math.max(cell.maxX - cell.minX, cell.maxY - cell.minY, cell.maxZ - cell.minZ)
  if (depth >= BH_MAX_DEPTH || size < BH_MIN_SIZE) {
    // Leaf with multiple occupants — store only the most recent; the
    // aggregate mass/com is still correct, so the approximation holds.
    cell.occupant = node
    return
  }

  if (!cell.children) {
    if (!cell.occupant) {
      cell.occupant = node
      return
    }
    // Existing occupant needs to be pushed down; subdivide and re-insert.
    const prev = cell.occupant
    cell.occupant = null
    subdivide(cell)
    const prevIdx = octantIndex(cell, prev.x, prev.y, prev.z)
    insertNode(cell.children![prevIdx]!, prev, depth + 1)
  }

  const idx = octantIndex(cell, node.x, node.y, node.z)
  insertNode(cell.children![idx]!, node, depth + 1)
}

function applyForceFromCell(
  cell: OctreeCell,
  target: SimulatedNode,
  repulsion: number,
  theta: number,
): void {
  if (cell.mass === 0) return

  const dx = target.x - cell.cx
  const dy = target.y - cell.cy
  const dz = target.z - cell.cz
  const distSq = dx * dx + dy * dy + dz * dz
  if (distSq === 0) return // exact coincidence — skip to avoid NaN

  const size = Math.max(cell.maxX - cell.minX, cell.maxY - cell.minY, cell.maxZ - cell.minZ)

  // Barnes-Hut criterion: if the cell is a leaf OR looks small enough
  // from here, treat it as a single mass.
  const isLeaf = !cell.children
  const canApproximate = (size * size) / distSq < theta * theta

  if (isLeaf) {
    // Skip self-force (leaf holding exactly the target node).
    if (cell.occupant === target && cell.mass === 1) return
    // Otherwise treat this leaf as its aggregate mass.
  } else if (!canApproximate) {
    // Too close — recurse.
    for (const child of cell.children!) {
      if (child) applyForceFromCell(child, target, repulsion, theta)
    }
    return
  }

  const dist = Math.sqrt(distSq) || 1
  const f = (repulsion * cell.mass) / distSq
  target.vx += (dx / dist) * f
  target.vy += (dy / dist) * f
  target.vz += (dz / dist) * f
}

function applyBarnesHutRepulsion(
  nodes: SimulatedNode[],
  repulsion: number,
  theta: number,
): void {
  if (nodes.length === 0) return

  // Bounding box over all nodes.
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.z < minZ) minZ = n.z
    if (n.x > maxX) maxX = n.x
    if (n.y > maxY) maxY = n.y
    if (n.z > maxZ) maxZ = n.z
  }
  // Make the root cubic + slightly padded to avoid boundary edge cases.
  const pad = 1
  const sideX = maxX - minX, sideY = maxY - minY, sideZ = maxZ - minZ
  const side = Math.max(sideX, sideY, sideZ, 1) + pad * 2
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5
  const half = side * 0.5
  const root = newCell(cx - half, cy - half, cz - half, cx + half, cy + half, cz + half)

  for (const n of nodes) insertNode(root, n, 0)
  for (const n of nodes) applyForceFromCell(root, n, repulsion, theta)
}
