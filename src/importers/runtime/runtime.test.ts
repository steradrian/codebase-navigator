import { describe, expect, it } from 'vitest'
import type { Link, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import {
  applyRuntimeEvidence,
  operationPathMatcher,
  parseHar,
  parseOtel,
} from '@/importers/runtime'

const node = (id: string, name: string, type = 'api', over: Partial<Node> = {}): Node => ({
  id, name, type, description: 'd', origin: 'auto:openapi', ...over,
})

const outcomeLink = (opId: string, status: string): Link => ({
  id: `${opId}__outcome__${opId}:outcome:${status}`,
  source: opId, target: `${opId}:outcome:${status}`,
  label: 'can result in', description: '', type: 'outcome', origin: 'auto:openapi',
})

/** An operation declaring 200 and 404, with a templated path. */
const specSchema = (): Schema => ({
  meta: { name: 'R', version: SCHEMA_VERSION },
  nodeTypes: {}, linkTypes: {},
  nodes: [
    node('op', 'GET /api/player/payments/{id}'),
    node('op:outcome:200', '200 Success', 'outcome'),
    node('op:outcome:404', '404 Not found', 'outcome'),
  ],
  links: [outcomeLink('op', '200'), outcomeLink('op', '404')],
  paths: [], journeys: [], annotations: [],
})

const har = (entries: unknown[]) => ({ log: { entries } })
const harEntry = (method: string, url: string, status: number, time?: number) => ({
  request: { method, url }, response: { status }, time, startedDateTime: '2026-08-14T10:00:00Z',
})

describe('parseHar', () => {
  it('reads method, path and status', () => {
    const r = parseHar(har([harEntry('GET', 'https://x.test/api/player/payments/8213?v=1', 200, 42)]))
    expect(r.observations).toEqual([{
      method: 'GET', path: '/api/player/payments/8213', status: 200,
      durationMs: 42, at: '2026-08-14T10:00:00Z',
    }])
  })

  it('strips the query string', () => {
    const r = parseHar(har([harEntry('GET', 'https://x.test/a?b=c', 200)]))
    expect(r.observations[0].path).toBe('/a')
  })

  it('handles a relative url', () => {
    expect(parseHar(har([harEntry('POST', '/api/deposit', 201)])).observations[0].path)
      .toBe('/api/deposit')
  })

  it('warns on an entry it cannot read instead of dropping it silently', () => {
    const r = parseHar(har([{ request: { method: 'GET' } }]))
    expect(r.observations).toEqual([])
    expect(r.warnings[0]).toMatchObject({ kind: 'malformed_entry', index: 0 })
  })

  it('says plainly when the file is not a HAR', () => {
    expect(parseHar({ nope: true }).warnings[0]).toMatchObject({ kind: 'unsupported_shape' })
  })
})

describe('parseOtel', () => {
  const span = (attrs: Record<string, string | number>, times?: [string, string]) => ({
    attributes: Object.entries(attrs).map(([key, v]) => ({
      key,
      value: typeof v === 'number' ? { intValue: v } : { stringValue: v },
    })),
    startTimeUnixNano: times?.[0],
    endTimeUnixNano: times?.[1],
  })
  const otlp = (spans: unknown[]) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] })

  it('reads current semantic-convention attributes', () => {
    const r = parseOtel(otlp([span({
      'http.request.method': 'GET', 'url.path': '/api/x', 'http.response.status_code': 200,
    })]))
    expect(r.observations).toEqual([{ method: 'GET', path: '/api/x', status: 200, durationMs: undefined }])
  })

  it('reads the older attribute names collectors still emit', () => {
    const r = parseOtel(otlp([span({
      'http.method': 'POST', 'http.target': '/api/y', 'http.status_code': 500,
    })]))
    expect(r.observations[0]).toMatchObject({ method: 'POST', path: '/api/y', status: 500 })
  })

  it('computes duration from span timestamps', () => {
    const r = parseOtel(otlp([span(
      { 'http.method': 'GET', 'url.path': '/a', 'http.status_code': 200 },
      ['1000000000', '1050000000'],
    )]))
    expect(r.observations[0].durationMs).toBeCloseTo(50)
  })

  it('ignores non-HTTP spans without warning about them', () => {
    // Most spans in a real export are database or internal spans; warning
    // on each would bury the ones that matter.
    const r = parseOtel(otlp([span({ 'db.system': 'postgresql' })]))
    expect(r.observations).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('warns on a span that looks like HTTP but is incomplete', () => {
    const r = parseOtel(otlp([span({ 'http.method': 'GET' })]))
    expect(r.warnings[0]).toMatchObject({ kind: 'malformed_entry' })
  })

  it('says plainly when the file is not an OTLP export', () => {
    expect(parseOtel({ nope: true }).warnings[0]).toMatchObject({ kind: 'unsupported_shape' })
  })
})

describe('operationPathMatcher', () => {
  it('matches a concrete path against a templated one', () => {
    // Traffic carries values, specifications carry placeholders; without
    // this translation runtime evidence attaches to nothing.
    expect(operationPathMatcher('/api/player/payments/{id}').test('/api/player/payments/8213')).toBe(true)
  })

  it('does not let a parameter swallow extra segments', () => {
    expect(operationPathMatcher('/a/{id}').test('/a/b/c')).toBe(false)
  })

  it('tolerates a trailing slash', () => {
    expect(operationPathMatcher('/a/{id}').test('/a/1/')).toBe(true)
  })

  it('does not match a different route', () => {
    expect(operationPathMatcher('/api/players').test('/api/payments')).toBe(false)
  })
})

describe('applyRuntimeEvidence', () => {
  const obs = (method: string, path: string, status: number) => ({ method, path, status })

  it('attaches runtime evidence to the operation traffic exercised', () => {
    const r = applyRuntimeEvidence(specSchema(), [obs('GET', '/api/player/payments/1', 200)])
    const op = r.schema.nodes.find((n) => n.id === 'op')!
    expect(op.evidence?.find((e) => e.source === 'runtime')).toMatchObject({ confidence: 1 })
    expect(op.evidence?.find((e) => e.source === 'runtime')?.note).toContain('1 call')
  })

  it('adds to existing evidence rather than replacing it', () => {
    // An observation confirms an operation ran; it does not overwrite
    // what static analysis established about it.
    const s = specSchema()
    s.nodes[0] = { ...s.nodes[0], evidence: [{ source: 'static_analysis', confidence: 1 }] }
    const r = applyRuntimeEvidence(s, [obs('GET', '/api/player/payments/1', 200)])
    const sources = r.schema.nodes[0].evidence!.map((e) => e.source).sort()
    expect(sources).toEqual(['runtime', 'static_analysis'])
  })

  it('is idempotent — re-importing does not stack runtime entries', () => {
    const once = applyRuntimeEvidence(specSchema(), [obs('GET', '/api/player/payments/1', 200)]).schema
    const twice = applyRuntimeEvidence(once, [obs('GET', '/api/player/payments/1', 200)]).schema
    expect(twice.nodes[0].evidence!.filter((e) => e.source === 'runtime')).toHaveLength(1)
  })

  it('reports a status the specification never declared', () => {
    // The headline value: reality and the model have diverged.
    const r = applyRuntimeEvidence(specSchema(), [
      obs('GET', '/api/player/payments/1', 500),
      obs('GET', '/api/player/payments/2', 500),
    ])
    expect(r.mismatches).toEqual([{
      operationId: 'op',
      operationName: 'GET /api/player/payments/{id}',
      observedStatus: 500,
      observedCount: 2,
      declaredStatuses: ['200', '404'],
    }])
  })

  it('does not report a status the specification did declare', () => {
    const r = applyRuntimeEvidence(specSchema(), [obs('GET', '/api/player/payments/1', 404)])
    expect(r.mismatches).toEqual([])
  })

  it('counts traffic that matched no operation', () => {
    const r = applyRuntimeEvidence(specSchema(), [obs('GET', '/totally/unknown', 200)])
    expect(r.stats).toMatchObject({ observations: 1, matchedOperations: 0, unmatchedObservations: 1 })
  })

  it('does not match on path alone when the method differs', () => {
    const r = applyRuntimeEvidence(specSchema(), [obs('DELETE', '/api/player/payments/1', 200)])
    expect(r.stats.unmatchedObservations).toBe(1)
  })

  it('is deterministic', () => {
    const o = [obs('GET', '/api/player/payments/1', 500), obs('GET', '/api/player/payments/2', 503)]
    expect(JSON.stringify(applyRuntimeEvidence(specSchema(), o).mismatches))
      .toBe(JSON.stringify(applyRuntimeEvidence(specSchema(), o).mismatches))
  })
})
