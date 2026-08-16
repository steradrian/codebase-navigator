import { describe, expect, it } from 'vitest'
import type { Journey, Link, Node, OutcomeKind, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { validate } from '@/schema/validate'
import { deriveJourneys, derivedJourneyId, withDerivedJourneys } from '@/schema/journey/derive'

const op = (id: string, name: string): Node => ({
  id, name, type: 'api', description: `${name} description`, origin: 'auto:openapi',
})

const outcome = (opId: string, status: string, kind: OutcomeKind, name: string): Node => ({
  id: `${opId}:outcome:${status}`,
  name,
  type: 'outcome',
  description: `${name} description`,
  origin: 'auto:openapi',
  metadata: { outcomeKind: kind },
})

const outcomeLink = (opId: string, outcomeId: string): Link => ({
  id: `${opId}__outcome__${outcomeId}`,
  source: opId, target: outcomeId,
  label: 'can result in', description: '', type: 'outcome', origin: 'auto:openapi',
})

const mkSchema = (nodes: Node[], links: Link[], journeys: Journey[] = []): Schema => ({
  meta: { name: 'D', version: SCHEMA_VERSION },
  nodeTypes: { api: { color: '#0', label: 'API' }, outcome: { color: '#1', label: 'Outcome' } },
  linkTypes: { outcome: { color: '#2', label: 'Outcome' } },
  nodes, links, paths: [], journeys, annotations: [],
})

/** An operation that forks three ways, as OpenAPI extraction yields. */
const forking = () => {
  const o = op('op1', 'POST /deposit')
  const outs = [
    outcome('op1', '201', 'success', '201 Success'),
    outcome('op1', '400', 'validation_error', '400 Validation failed'),
    outcome('op1', '401', 'permission_denied', '401 Permission denied'),
  ]
  return mkSchema([o, ...outs], outs.map((x) => outcomeLink('op1', x.id)))
}

describe('deriveJourneys', () => {
  it('emits one journey per forking operation', () => {
    const j = deriveJourneys(forking())
    expect(j).toHaveLength(1)
    expect(j[0].id).toBe(derivedJourneyId('op1'))
  })

  it('builds an action step that branches to every outcome', () => {
    const [j] = deriveJourneys(forking())
    expect(j.steps[0]).toMatchObject({ kind: 'action', nodeId: 'op1' })
    expect(j.steps.filter((s) => s.kind === 'outcome')).toHaveLength(3)
    expect(j.transitions).toHaveLength(3)
    expect(j.transitions.every((t) => t.from === 'call')).toBe(true)
  })

  it('carries each outcome kind onto its step', () => {
    const [j] = deriveJourneys(forking())
    const kinds = j.steps.filter((s) => s.kind === 'outcome').map((s) => s.outcome).sort()
    expect(kinds).toEqual(['permission_denied', 'success', 'validation_error'])
  })

  it('uses the declared response as the branch condition, inventing nothing', () => {
    const [j] = deriveJourneys(forking())
    expect(j.transitions.map((t) => t.condition).sort()).toEqual([
      '201 Success', '400 Validation failed', '401 Permission denied',
    ])
  })

  it('marks derived journeys inferred, never verified', () => {
    // Declared responses say what CAN happen, not that anyone confirmed
    // the product behaves this way.
    expect(deriveJourneys(forking())[0].status).toBe('inferred')
  })

  it('does not claim user intent', () => {
    // A user's goal is "deposit money", which spans several operations
    // and screens and cannot be recovered from a spec.
    expect(deriveJourneys(forking())[0].category).toBe('data_flow')
  })

  it('carries the importer origin so re-import can refresh it', () => {
    expect(deriveJourneys(forking())[0].origin).toBe('auto:openapi')
  })

  it('skips an operation with only one outcome', () => {
    // A one-way "it succeeds" flow tells a reader nothing they did not
    // already know; journeys exist to show where behaviour forks.
    const o = op('op1', 'GET /x')
    const out = outcome('op1', '200', 'success', '200 Success')
    expect(deriveJourneys(mkSchema([o, out], [outcomeLink('op1', out.id)]))).toEqual([])
  })

  it('skips operations with no outcomes at all', () => {
    expect(deriveJourneys(mkSchema([op('op1', 'GET /x')], []))).toEqual([])
  })

  it('produces schemas the validator accepts', () => {
    const s = withDerivedJourneys(forking())
    expect(validate(s).ok).toBe(true)
  })

  it('is deterministic regardless of link order', () => {
    const a = forking()
    const b = { ...forking(), links: [...forking().links].reverse() }
    expect(JSON.stringify(deriveJourneys(a))).toBe(JSON.stringify(deriveJourneys(b)))
  })
})

describe('withDerivedJourneys', () => {
  it('adds derived journeys to a schema that had none', () => {
    expect(withDerivedJourneys(forking()).journeys).toHaveLength(1)
  })

  it('never overwrites an authored journey', () => {
    const authored: Journey = {
      id: derivedJourneyId('op1'),
      name: 'Deposit money', description: 'hand written', color: '#fff',
      origin: 'manual', steps: [], transitions: [],
    }
    const s = { ...forking(), journeys: [authored] }
    const out = withDerivedJourneys(s).journeys!
    expect(out).toHaveLength(1)
    expect(out[0].description).toBe('hand written')
  })

  it('replaces stale derived journeys rather than accumulating them', () => {
    const stale: Journey = {
      id: 'derived:journey:gone', name: 'old', description: '', color: '#fff',
      origin: 'auto:openapi', steps: [], transitions: [],
    }
    const out = withDerivedJourneys({ ...forking(), journeys: [stale] }).journeys!
    expect(out.map((j) => j.id)).toEqual([derivedJourneyId('op1')])
  })

  it('keeps authored journeys alongside derived ones', () => {
    const authored: Journey = {
      id: 'authored:1', name: 'Invite teammate', description: '', color: '#fff',
      origin: 'manual', steps: [], transitions: [],
    }
    const out = withDerivedJourneys({ ...forking(), journeys: [authored] }).journeys!
    expect(out.map((j) => j.id).sort()).toEqual(['authored:1', derivedJourneyId('op1')])
  })
})
