import { describe, expect, it } from 'vitest'
import type { OpenAPIOperation } from '@/importers/openapi/types'
import {
  OUTCOME_LINK_TYPE,
  extractOutcomes,
  outcomeKindForStatus,
  outcomeNodeId,
} from '@/importers/openapi/outcomes'

describe('outcomeKindForStatus', () => {
  it('maps the codes a real spec actually declares', () => {
    // Frequencies observed in casino-frontend's spec: 401, 422, 400, 404, 412.
    expect(outcomeKindForStatus('401')).toBe('permission_denied')
    expect(outcomeKindForStatus('403')).toBe('permission_denied')
    expect(outcomeKindForStatus('422')).toBe('validation_error')
    expect(outcomeKindForStatus('400')).toBe('validation_error')
    expect(outcomeKindForStatus('404')).toBe('not_found')
    expect(outcomeKindForStatus('412')).toBe('conflict')
  })

  it('maps rate limiting and timeouts', () => {
    expect(outcomeKindForStatus('429')).toBe('rate_limited')
    expect(outcomeKindForStatus('408')).toBe('timeout')
    expect(outcomeKindForStatus('504')).toBe('timeout')
  })

  it('treats any 2xx as success and any other 5xx as server error', () => {
    expect(outcomeKindForStatus('200')).toBe('success')
    expect(outcomeKindForStatus('204')).toBe('success')
    expect(outcomeKindForStatus('500')).toBe('server_error')
    expect(outcomeKindForStatus('503')).toBe('server_error')
  })

  it('refuses to guess at "default"', () => {
    // OpenAPI defines `default` as "any response not otherwise listed",
    // which is not a specific outcome.
    expect(outcomeKindForStatus('default')).toBeNull()
  })

  it('refuses to guess at an unlisted 4xx', () => {
    expect(outcomeKindForStatus('418')).toBeNull()
    expect(outcomeKindForStatus('451')).toBeNull()
  })

  it('returns null for nonsense rather than throwing', () => {
    expect(outcomeKindForStatus('')).toBeNull()
    expect(outcomeKindForStatus('abc')).toBeNull()
  })
})

describe('extractOutcomes', () => {
  const op = (responses: OpenAPIOperation['responses']): OpenAPIOperation => ({ responses })
  const run = (o: OpenAPIOperation) =>
    extractOutcomes(o, 'openapi:op:post:api_deposit', 'POST /api/deposit', { domain: 'payment' })

  it('emits one node per declared response', () => {
    const r = run(op({ '200': {}, '401': {}, '422': {} }))
    expect(r.nodes).toHaveLength(3)
    expect(r.nodes.map((n) => n.name)).toEqual([
      '200 Success', '401 Permission denied', '422 Validation failed',
    ])
  })

  it('records the outcome kind so the UI need not re-derive it', () => {
    const r = run(op({ '429': {} }))
    expect(r.nodes[0].metadata?.outcomeKind).toBe('rate_limited')
  })

  it('links each outcome back to its operation', () => {
    const r = run(op({ '404': {} }))
    expect(r.links).toHaveLength(1)
    expect(r.links[0]).toMatchObject({
      source: 'openapi:op:post:api_deposit',
      target: outcomeNodeId('openapi:op:post:api_deposit', '404'),
      type: OUTCOME_LINK_TYPE,
      label: 'can result in',
    })
  })

  it('marks outcomes as static analysis, not inference', () => {
    // The response is literally written in the specification.
    const r = run(op({ '401': {} }))
    expect(r.nodes[0].evidence?.[0]).toMatchObject({ source: 'static_analysis', confidence: 1 })
    expect(r.links[0].evidence?.[0]).toMatchObject({ source: 'static_analysis' })
  })

  it("prefers the API author's own description", () => {
    const r = run(op({ '401': { description: 'Session token missing or expired' } }))
    expect(r.nodes[0].description).toBe('Session token missing or expired')
  })

  it('falls back to a plain statement rather than inventing detail', () => {
    const r = run(op({ '401': {} }))
    expect(r.nodes[0].description).toBe('POST /api/deposit can return 401.')
  })

  it('inherits entity and domain so outcomes share their operation’s subject key', () => {
    const r = extractOutcomes(op({ '200': {} }), 'op1', 'GET /x', {
      entity: 'payment', domain: 'payment', group: 'Payments',
    })
    expect(r.nodes[0]).toMatchObject({ entity: 'payment', domain: 'payment', group: 'Payments' })
  })

  it('warns on a status it cannot map instead of dropping it silently', () => {
    const r = run(op({ '200': {}, default: {} }))
    expect(r.nodes).toHaveLength(1)
    expect(r.warnings).toContainEqual({
      kind: 'unmapped_status', operation: 'POST /api/deposit', status: 'default',
    })
  })

  it('handles an operation declaring no responses', () => {
    expect(extractOutcomes({}, 'op1', 'GET /x', {})).toEqual({
      nodes: [], links: [], warnings: [],
    })
  })

  it('is deterministic regardless of key order in the source document', () => {
    const a = run(op({ '422': {}, '200': {}, '401': {} }))
    const b = run(op({ '200': {}, '401': {}, '422': {} }))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('produces ids stable across re-imports', () => {
    expect(outcomeNodeId('openapi:op:get:api_player', '401'))
      .toBe('openapi:op:get:api_player:outcome:401')
  })
})
