import { describe, expect, it } from 'vitest'
import type { Journey, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { assessIndexing } from '@/schema/indexing'

const node = (id: string, type: string, over: Partial<Node> = {}): Node => ({
  id, name: id, type, description: 'd', origin: 'auto:codebase', ...over,
})

const mkSchema = (nodes: Node[], journeys: Journey[] = []): Schema => ({
  meta: { name: 'I', version: SCHEMA_VERSION },
  nodeTypes: {}, linkTypes: {},
  nodes, links: [], paths: [], journeys, annotations: [],
})

const stageOf = (s: Schema, id: string) =>
  assessIndexing(s).stages.find((x) => x.id === id)!

describe('assessIndexing', () => {
  it('reports a stage complete when it produced something', () => {
    expect(stageOf(mkSchema([node('a', 'component')]), 'components'))
      .toMatchObject({ status: 'complete', produced: 1 })
  })

  it('distinguishes "found nothing" from "cannot run"', () => {
    // "No runtime source is connected" and "we looked and found none"
    // are different statements, and an empty bar tells the reader
    // nothing about whether to go connect something.
    const s = mkSchema([node('a', 'component')])
    expect(stageOf(s, 'runtime').status).toBe('unsupported')
    expect(stageOf(s, 'database').status).toBe('partial')
    expect(stageOf(s, 'database').detail).toBe('Ran, but found nothing to map.')
  })

  it('counts test mapping from evidence, not from file type', () => {
    const s = mkSchema([node('a', 'hook', { evidence: [{ source: 'test' }] })])
    expect(stageOf(s, 'tests')).toMatchObject({ status: 'complete', produced: 1 })
  })

  it('counts git analysis from evidence', () => {
    const s = mkSchema([node('a', 'hook', { evidence: [{ source: 'git' }] })])
    expect(stageOf(s, 'git').produced).toBe(1)
  })

  it('counts documentation from document and decision nodes', () => {
    const s = mkSchema([node('d', 'document'), node('a', 'decision')])
    expect(stageOf(s, 'documentation').produced).toBe(2)
  })

  it('marks classification partial while entities remain unassigned', () => {
    const s = mkSchema([node('a', 'api', { domain: 'pay' }), node('b', 'api')])
    const c = stageOf(s, 'classification')
    expect(c.status).toBe('partial')
    expect(c.detail).toContain('1 entities are not assigned')
  })

  it('marks classification complete when every entity has a domain', () => {
    const s = mkSchema([node('a', 'api', { domain: 'pay' })])
    expect(stageOf(s, 'classification').status).toBe('complete')
  })

  it('reports flow derivation from derived flows', () => {
    const f: Journey = { id: 'f', name: 'F', description: '', color: '#fff', steps: [], transitions: [] }
    const s: Schema = { ...mkSchema([node('a', 'api')]), flows: [f] }
    expect(stageOf(s, 'journeys').produced).toBe(1)
  })

  it('does not count authored journeys as an indexing stage', () => {
    // Authoring is a human activity, not something the pipeline runs.
    // Counting it here would make the index look incomplete simply
    // because nobody had written a journey yet.
    const j: Journey = { id: 'j', name: 'J', description: '', color: '#fff', steps: [], transitions: [] }
    expect(stageOf(mkSchema([node('a', 'api')], [j]), 'journeys').produced).toBe(0)
  })

  it('rolls up to partial when any runnable stage is partial', () => {
    expect(assessIndexing(mkSchema([node('a', 'component')])).status).toBe('partial')
  })

  it('excludes unsupported stages from the roll-up', () => {
    // Runtime being unavailable should not make an otherwise complete
    // index look broken.
    const s = mkSchema([
      node('page', 'page'), node('c', 'component'), node('api', 'api', { domain: 'd' }),
      node('db', 'database'), node('o', 'outcome'), node('doc', 'document'),
      node('t', 'hook', { domain: 'd', evidence: [{ source: 'test' }, { source: 'git' }] }),
    ], [{ id: 'j', name: 'J', description: '', color: '#f', steps: [], transitions: [] }])
    const r = assessIndexing(s)
    expect(r.stages.find((x) => x.id === 'runtime')!.status).toBe('unsupported')
    expect(r.status).toBe('partial') // classification still incomplete here
  })

  it('is deterministic', () => {
    const s = mkSchema([node('a', 'component')])
    expect(JSON.stringify(assessIndexing(s))).toBe(JSON.stringify(assessIndexing(s)))
  })
})
