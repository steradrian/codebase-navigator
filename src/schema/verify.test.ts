import { describe, expect, it } from 'vitest'
import type { Evidence, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { humanEvidenceOf, isHumanVerified, unverifyNode, verifyNode } from '@/schema/verify'
import { summariseEvidence } from '@/schema/projection'
import { merge } from '@/schema/merge'

const mkNode = (id: string, evidence?: Evidence[]): Node => ({
  id, name: id, type: 'service', description: 'd', origin: 'auto:codebase', evidence,
})

const mkSchema = (nodes: Node[], sources: Schema['meta']['sources'] = ['auto:codebase']): Schema => ({
  meta: { name: 'V', version: SCHEMA_VERSION, sources },
  nodeTypes: { service: { color: '#000', label: 'S' } },
  linkTypes: {},
  nodes, links: [], paths: [], journeys: [], annotations: [],
})

const AT = '2026-08-14T10:00:00Z'

describe('verifyNode', () => {
  it('records a human confirmation at full confidence', () => {
    const s = verifyNode(mkSchema([mkNode('a')]), 'a', { author: 'Ada', at: AT })
    const e = s.nodes[0].evidence!.find((x) => x.source === 'human')!
    expect(e).toMatchObject({ source: 'human', confidence: 1, verifiedAt: AT })
    expect(e.note).toBe('Verified by Ada')
  })

  it('keeps the author’s justification when given', () => {
    const s = verifyNode(mkSchema([mkNode('a')]), 'a', {
      author: 'Ada', at: AT, note: 'matches the deposit spec',
    })
    expect(s.nodes[0].evidence![0].note).toBe('Ada: matches the deposit spec')
  })

  it('adds to existing evidence rather than replacing it', () => {
    // A person agreeing with static analysis is a separate claim from
    // the analysis itself; collapsing them loses the distinction between
    // a confirmed fact and an unexamined one.
    const s = verifyNode(
      mkSchema([mkNode('a', [{ source: 'static_analysis', confidence: 1 }])]),
      'a', { author: 'Ada', at: AT },
    )
    expect(s.nodes[0].evidence).toHaveLength(2)
    expect(s.nodes[0].evidence!.some((e) => e.source === 'static_analysis')).toBe(true)
  })

  it('does not let one person inflate the evidence count by re-verifying', () => {
    let s = mkSchema([mkNode('a')])
    s = verifyNode(s, 'a', { author: 'Ada', at: AT })
    s = verifyNode(s, 'a', { author: 'Ada', at: '2026-08-15T10:00:00Z' })
    expect(humanEvidenceOf(s.nodes[0])).toHaveLength(1)
    expect(s.nodes[0].evidence![0].verifiedAt).toBe('2026-08-15T10:00:00Z')
  })

  it('records confirmations from different people separately', () => {
    let s = mkSchema([mkNode('a')])
    s = verifyNode(s, 'a', { author: 'Ada', at: AT })
    s = verifyNode(s, 'a', { author: 'Lin', at: AT })
    expect(humanEvidenceOf(s.nodes[0])).toHaveLength(2)
  })

  it('returns the schema unchanged for an unknown node', () => {
    const s = mkSchema([mkNode('a')])
    expect(verifyNode(s, 'ghost', { author: 'Ada', at: AT })).toBe(s)
  })

  it('does not mutate its input', () => {
    const s = mkSchema([mkNode('a')])
    const before = JSON.stringify(s)
    verifyNode(s, 'a', { author: 'Ada', at: AT })
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('unverifyNode', () => {
  it('removes only that author’s confirmation', () => {
    let s = mkSchema([mkNode('a', [{ source: 'git', confidence: 1 }])])
    s = verifyNode(s, 'a', { author: 'Ada', at: AT })
    s = verifyNode(s, 'a', { author: 'Lin', at: AT })
    s = unverifyNode(s, 'a', 'Ada')
    const human = humanEvidenceOf(s.nodes[0])
    expect(human).toHaveLength(1)
    expect(human[0].note).toContain('Lin')
    expect(s.nodes[0].evidence!.some((e) => e.source === 'git')).toBe(true)
  })
})

describe('isHumanVerified', () => {
  it('reflects whether a person has confirmed the entity', () => {
    expect(isHumanVerified(mkNode('a'))).toBe(false)
    expect(isHumanVerified(mkNode('a', [{ source: 'human' }]))).toBe(true)
  })
})

describe('merge — human verification survives re-import', () => {
  it('carries confirmations forward when an importer re-runs', () => {
    // The failure this prevents: an importer knows nothing about who
    // verified what, so its evidence array replacing the existing one
    // would silently discard the most valuable knowledge in the system.
    const verified = verifyNode(
      mkSchema([mkNode('a', [{ source: 'static_analysis', confidence: 1 }])]),
      'a', { author: 'Ada', at: AT },
    )
    const reimported = mkSchema([mkNode('a', [{ source: 'static_analysis', confidence: 1 }])])

    const merged = merge(verified, reimported).schema
    expect(humanEvidenceOf(merged.nodes[0])).toHaveLength(1)
  })

  it('still takes fresh extractor evidence from the importer', () => {
    const verified = verifyNode(
      mkSchema([mkNode('a', [{ source: 'git', commit: 'old' }])]),
      'a', { author: 'Ada', at: AT },
    )
    const reimported = mkSchema([mkNode('a', [{ source: 'git', commit: 'new' }])])

    const merged = merge(verified, reimported).schema
    const git = merged.nodes[0].evidence!.filter((e) => e.source === 'git')
    expect(git).toHaveLength(1)
    expect(git[0].commit).toBe('new')
  })
})

describe('summariseEvidence — conflict', () => {
  it('reports the strongest source’s confidence, not a mean', () => {
    // Averaging was the previous behaviour: a human-verified fact at 1.0
    // and an AI guess at 0.2 blended into an unremarkable 0.6, so a
    // reader could not tell a well-evidenced entity from a contested one.
    const s = summariseEvidence([
      { source: 'human', confidence: 1 },
      { source: 'ai_inference', confidence: 0.2 },
    ])
    expect(s.confidence).toBe(1)
    expect(s.strongestSource).toBe('human')
  })

  it('flags materially disagreeing sources', () => {
    const s = summariseEvidence([
      { source: 'test', confidence: 1 },
      { source: 'ai_inference', confidence: 0.2 },
    ])
    expect(s.conflict).not.toBeNull()
    expect(s.conflict!.sources).toContain('test')
    expect(s.conflict!.spread).toBeCloseTo(0.8)
  })

  it('does not flag ordinary variation as a conflict', () => {
    const s = summariseEvidence([
      { source: 'static_analysis', confidence: 1 },
      { source: 'git', confidence: 0.9 },
    ])
    expect(s.conflict).toBeNull()
  })

  it('needs two scored sources before it can see disagreement', () => {
    const s = summariseEvidence([
      { source: 'static_analysis', confidence: 1 },
      { source: 'documentation' },
    ])
    expect(s.conflict).toBeNull()
  })

  it('breaks confidence down per source so the UI can show who says what', () => {
    const s = summariseEvidence([
      { source: 'test', confidence: 1 },
      { source: 'test', confidence: 0.8 },
      { source: 'ai_inference', confidence: 0.2 },
    ])
    expect(s.bySource).toEqual([
      { source: 'test', confidence: 1, count: 2 },
      { source: 'ai_inference', confidence: 0.2, count: 1 },
    ])
  })

  it('marks human verification distinctly from AI inference', () => {
    const s = summariseEvidence([{ source: 'human' }, { source: 'ai_inference' }])
    expect(s.humanVerified).toBe(true)
    expect(s.aiInferred).toBe(true)
  })

  it('returns an empty summary for an unevidenced entity', () => {
    expect(summariseEvidence(undefined)).toMatchObject({
      strongestSource: null, confidence: null, bySource: [], conflict: null, count: 0,
    })
  })
})
