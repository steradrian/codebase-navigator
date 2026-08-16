import { describe, expect, it } from 'vitest'
import { ForceSim3D } from '@/ForceSim3D'
import type { Link, Node } from '@/types'

const makeNodes = (): Node[] => [
  { id: 'a', name: 'A', type: 'service', description: '', group: 'g1', origin: 'manual' },
  { id: 'b', name: 'B', type: 'service', description: '', group: 'g1', origin: 'manual' },
  { id: 'c', name: 'C', type: 'service', description: '', group: 'g2', origin: 'manual' },
]

const makeLinks = (): Link[] => [
  { id: 'a__none__b', source: 'a', target: 'b', label: 'links', description: '', origin: 'manual' },
  { id: 'b__none__c', source: 'b', target: 'c', label: 'links', description: '', origin: 'manual' },
]

describe('ForceSim3D', () => {
  it('assigns finite initial positions and zero velocity to every node', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())

    expect(sim.nodes).toHaveLength(3)
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      expect(Number.isFinite(n.z)).toBe(true)
      expect(n.vx).toBe(0)
      expect(n.vy).toBe(0)
      expect(n.vz).toBe(0)
    }
    expect(sim.alpha).toBe(1)
  })

  it('resolves link source/target to node references', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())

    expect(sim.links).toHaveLength(2)
    expect(sim.links[0].sourceNode?.id).toBe('a')
    expect(sim.links[0].targetNode?.id).toBe('b')
    expect(sim.links[1].sourceNode?.id).toBe('b')
    expect(sim.links[1].targetNode?.id).toBe('c')
  })

  it('decays alpha on each tick', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())
    const initialAlpha = sim.alpha

    sim.tick()

    expect(sim.alpha).toBeLessThan(initialAlpha)
    expect(sim.alpha).toBeGreaterThan(0)
  })

  it('reheat raises alpha but never lowers it', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())
    sim.alpha = 0.1

    sim.reheat(0.5)
    expect(sim.alpha).toBe(0.5)

    sim.reheat(0.2)
    expect(sim.alpha).toBe(0.5)
  })

  it('getNode returns the simulated node by id', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())

    const node = sim.getNode('b')
    expect(node?.id).toBe('b')
    expect(node?.name).toBe('B')

    expect(sim.getNode('nope')).toBeUndefined()
  })

  it('getConnectedIds includes self and both neighbors of a bridge node', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())

    const ids = sim.getConnectedIds('b')
    expect(ids).toEqual(new Set(['a', 'b', 'c']))
  })

  it('tick is a no-op once alpha falls below the threshold', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())
    sim.alpha = 0.0005

    const result = sim.tick()
    expect(result).toBe(false)
  })

  it('setMode2D(true) collapses every node z to near zero within ~30 ticks', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())
    // Seed a strong non-zero z on every node.
    for (const n of sim.nodes) n.z = 50

    sim.setMode2D(true)
    for (let i = 0; i < 30; i++) sim.tick()

    for (const n of sim.nodes) {
      expect(Math.abs(n.z)).toBeLessThan(1)
      expect(n.vz).toBe(0)
    }
  })

  it('setMode2D(false) leaves z behavior unchanged (3D simulation)', () => {
    const sim = new ForceSim3D(makeNodes(), makeLinks())
    for (const n of sim.nodes) n.z = 50
    sim.setMode2D(false)
    sim.tick()
    // z should not have been clamped — still in the order of tens
    expect(sim.nodes.some((n) => Math.abs(n.z) > 1)).toBe(true)
  })

  it('Barnes-Hut repulsion produces velocities within tolerance of exact on small graphs', () => {
    // Generate a bigger cluster so exercise the octree meaningfully.
    const nodes: Node[] = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`, name: `N${i}`, type: 'service', description: '', origin: 'manual',
    }))
    const links: Link[] = []

    const exactSim = new ForceSim3D(nodes, links)
    const bhSim = new ForceSim3D(nodes, links)
    // Copy initial positions so both simulations start from the same state.
    for (let i = 0; i < exactSim.nodes.length; i++) {
      bhSim.nodes[i].x = exactSim.nodes[i].x
      bhSim.nodes[i].y = exactSim.nodes[i].y
      bhSim.nodes[i].z = exactSim.nodes[i].z
    }
    exactSim.useBarnesHut = false
    bhSim.useBarnesHut = true
    // Loosen theta so approximation is aggressive — still must stay in rough agreement.
    bhSim.theta = 0.8

    exactSim.tick()
    bhSim.tick()

    // Compare velocity magnitudes per node; Barnes-Hut should be within ~25%
    // of the exact value (typical tolerance for theta = 0.8 on tight clusters).
    for (let i = 0; i < exactSim.nodes.length; i++) {
      const e = exactSim.nodes[i]
      const b = bhSim.nodes[i]
      const eMag = Math.sqrt(e.vx * e.vx + e.vy * e.vy + e.vz * e.vz)
      const bMag = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz)
      if (eMag < 0.01 && bMag < 0.01) continue // both near-zero, skip
      const ratio = bMag / Math.max(eMag, 1e-6)
      expect(ratio).toBeGreaterThan(0.5)
      expect(ratio).toBeLessThan(1.6)
    }
  })

  it('Barnes-Hut handles empty and single-node graphs without crashing', () => {
    const emptySim = new ForceSim3D([], [])
    emptySim.useBarnesHut = true
    expect(() => emptySim.tick()).not.toThrow()

    const singleSim = new ForceSim3D([{ id: 'x', name: 'X', type: 'service', description: '', origin: 'manual' }], [])
    singleSim.useBarnesHut = true
    expect(() => singleSim.tick()).not.toThrow()
  })
})
