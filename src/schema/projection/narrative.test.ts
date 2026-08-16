import { describe, expect, it } from 'vitest'
import type { Link, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { assignAltitudes } from '@/schema/altitude'
import { buildNarrative, buildSuggestedQuestions } from '@/schema/projection/narrative'

const mkNode = (id: string, type: string, over: Partial<Node> = {}): Node => ({
  id, name: id, type, description: 'd', origin: 'auto:openapi', ...over,
})

const mkLink = (source: string, target: string, type: string): Link => ({
  id: `${source}__${type}__${target}`,
  source, target, label: type, description: '', type, origin: 'auto:openapi',
})

const mkSchema = (nodes: Node[], links: Link[] = []): Schema =>
  assignAltitudes({
    meta: { name: 'N', version: SCHEMA_VERSION },
    nodeTypes: {}, linkTypes: {},
    nodes, links, paths: [], journeys: [], annotations: [],
  })

/** An operation with a success and two failure outcomes, as OpenAPI yields. */
const withOutcomes = () => {
  const nodes = [
    mkNode('op', 'api', { name: 'POST /deposit', domain: 'payment' }),
    mkNode('ok', 'outcome', { name: '201 Success', metadata: { outcomeKind: 'success' } }),
    mkNode('bad', 'outcome', { name: '400 Validation failed', metadata: { outcomeKind: 'validation_error' } }),
    mkNode('denied', 'outcome', { name: '401 Permission denied', metadata: { outcomeKind: 'permission_denied' } }),
  ]
  const links = ['ok', 'bad', 'denied'].map((t) => mkLink('op', t, 'outcome'))
  return mkSchema(nodes, links)
}

describe('buildNarrative', () => {
  it('places the focus in its domain', () => {
    const s = withOutcomes()
    const blocks = buildNarrative(s, s.nodes[0])
    expect(blocks[0].text).toBe('POST /deposit is part of the payment domain.')
  })

  it('says so plainly when the focus has no domain', () => {
    const s = mkSchema([mkNode('x', 'api', { name: 'X' })])
    expect(buildNarrative(s, s.nodes[0])[0].text).toBe('X has not been assigned to a domain.')
  })

  it('reports outcomes, leading with the failures', () => {
    const s = withOutcomes()
    const text = buildNarrative(s, s.nodes[0]).map((b) => b.text).join(' ')
    expect(text).toContain('3 declared outcomes')
    expect(text).toContain('400 Validation failed')
    expect(text).toContain('401 Permission denied')
  })

  it('notes when every declared outcome is a success', () => {
    const s = mkSchema(
      [mkNode('op', 'api', { name: 'GET /x' }),
       mkNode('ok', 'outcome', { name: '200 Success', metadata: { outcomeKind: 'success' } })],
      [mkLink('op', 'ok', 'outcome')],
    )
    expect(buildNarrative(s, s.nodes[0]).map((b) => b.text).join(' '))
      .toContain('all successful')
  })

  it('counts test cases covering the focus', () => {
    const s = mkSchema(
      [mkNode('f', 'hook', { name: 'useDeposit' }),
       mkNode('t', 'test', { name: 'd.test.ts', metadata: { testCases: ['a', 'b'] } })],
      [mkLink('t', 'f', 'tests')],
    )
    expect(buildNarrative(s, s.nodes[0]).map((b) => b.text).join(' '))
      .toContain('2 test cases across 1 file')
  })

  it('states the absence of tests rather than staying silent', () => {
    // An omitted sentence reads as "not checked", which is not the same
    // as "checked and found nothing".
    const s = mkSchema([mkNode('f', 'hook', { name: 'useDeposit' })])
    expect(buildNarrative(s, s.nodes[0]).map((b) => b.text)).toContain('No tests reference this.')
  })

  it('cites a recorded decision when one exists', () => {
    const s = mkSchema(
      [mkNode('f', 'hook', { name: 'useDeposit' }),
       mkNode('d', 'decision', { name: 'ADR-2 Use idempotency keys' })],
      [mkLink('d', 'f', 'documents')],
    )
    expect(buildNarrative(s, s.nodes[0]).map((b) => b.text).join(' '))
      .toContain('ADR-2 Use idempotency keys')
  })

  it('surfaces disagreement between sources', () => {
    const s = mkSchema([mkNode('f', 'hook', {
      name: 'useDeposit',
      evidence: [{ source: 'test', confidence: 1 }, { source: 'ai_inference', confidence: 0.1 }],
    })])
    expect(buildNarrative(s, s.nodes[0]).map((b) => b.text).join(' '))
      .toContain('Sources disagree')
  })

  it('attaches refs so every sentence is traceable', () => {
    const s = withOutcomes()
    const outcomeBlock = buildNarrative(s, s.nodes[0]).find((b) => b.text.includes('outcomes'))!
    expect(outcomeBlock.refs.sort()).toEqual(['bad', 'denied', 'ok'])
  })

  it('is deterministic', () => {
    const s = withOutcomes()
    expect(JSON.stringify(buildNarrative(s, s.nodes[0])))
      .toBe(JSON.stringify(buildNarrative(s, s.nodes[0])))
  })
})

describe('buildSuggestedQuestions', () => {
  it('asks about a declared failure path', () => {
    const s = withOutcomes()
    const q = buildSuggestedQuestions(s, s.nodes[0])
    expect(q.some((x) => x.text.includes('400 Validation failed'))).toBe(true)
  })

  it('points each question at the lens that would answer it', () => {
    const s = withOutcomes()
    const failure = buildSuggestedQuestions(s, s.nodes[0]).find((x) => x.text.includes('400'))!
    expect(failure.targetLens).toBe('behavior')
    expect(failure.targetFocusId).toBe('bad')
  })

  it('grounds every question in a stated basis', () => {
    // A prompt without a traceable reason is indistinguishable from
    // generic chat filler, which is what this field exists to prevent.
    const s = withOutcomes()
    for (const q of buildSuggestedQuestions(s, s.nodes[0])) {
      expect(q.basis.length).toBeGreaterThan(0)
    }
  })

  it('leads with unexplained disagreement', () => {
    const s = mkSchema([mkNode('f', 'hook', {
      name: 'useDeposit',
      evidence: [{ source: 'test', confidence: 1 }, { source: 'ai_inference', confidence: 0.1 }],
    })])
    expect(buildSuggestedQuestions(s, s.nodes[0])[0].text).toContain('disagree')
  })

  it('asks whether failure paths are tested when they are not', () => {
    const s = withOutcomes()
    const q = buildSuggestedQuestions(s, s.nodes[0]).find((x) => x.targetLens === 'tests')
    expect(q?.text).toBe("Are POST /deposit's failure paths tested?")
    expect(q?.basis).toBe('declared outcomes with no linked tests')
  })

  it('asks about blast radius for shared infrastructure', () => {
    const s = mkSchema([mkNode('u', 'util', { name: 'formatMoney', isHub: true })])
    const q = buildSuggestedQuestions(s, s.nodes[0])
    expect(q.some((x) => x.text.includes('What breaks if') && x.targetLens === 'impact')).toBe(true)
  })

  it('emits nothing when the model holds no facts to ask about', () => {
    // Silence is correct here — padding the panel would manufacture
    // curiosity the data cannot satisfy.
    const s = mkSchema([mkNode('bare', 'external', { name: 'Bare' })])
    expect(buildSuggestedQuestions(s, s.nodes[0])).toEqual([])
  })

  it('is deterministic', () => {
    const s = withOutcomes()
    expect(JSON.stringify(buildSuggestedQuestions(s, s.nodes[0])))
      .toBe(JSON.stringify(buildSuggestedQuestions(s, s.nodes[0])))
  })
})
