import { describe, expect, it } from 'vitest'
import type { Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { assignAltitudes } from '@/schema/altitude'
import { search } from '@/schema/search'

const mkNode = (id: string, name: string, type: string, over: Partial<Node> = {}): Node => ({
  id, name, type, description: 'd', origin: 'auto:codebase', ...over,
})

const mkSchema = (nodes: Node[], domains: string[] = []): Schema =>
  assignAltitudes({
    meta: { name: 'S', version: SCHEMA_VERSION, domains },
    nodeTypes: {}, linkTypes: {},
    nodes, links: [], paths: [], journeys: [], annotations: [],
  })

/** The spec's own ambiguity example. */
const sessionWorld = () =>
  mkSchema(
    [
      mkNode('db:session', 'Session', 'database'),
      mkNode('code:useSession', 'useSession', 'hook'),
      mkNode('code:store', 'SessionStore', 'util'),
      mkNode('op:session', 'GET /api/session', 'api'),
    ],
    ['session'],
  )

describe('search — matching', () => {
  it('ranks an exact name above a prefix above a substring', () => {
    const s = mkSchema([
      mkNode('a', 'deposit', 'hook'),
      mkNode('b', 'depositForm', 'component'),
      mkNode('c', 'useDepositState', 'hook'),
    ])
    const ids = search(s, 'deposit').groups.flatMap((g) => g.results).map((r) => r.id)
    expect(ids.slice(0, 3)).toEqual(['a', 'b', 'c'])
  })

  it('reports what each result matched on', () => {
    const s = mkSchema([mkNode('a', 'Wallet', 'hook', { description: 'handles deposit' })])
    expect(search(s, 'deposit').groups[0].results[0].matchedOn).toBe('description')
  })

  it('ranks a description hit below a name hit', () => {
    // A word appearing in prose is much weaker evidence of intent than a
    // thing actually being called that.
    const s = mkSchema([
      mkNode('named', 'deposit', 'hook'),
      mkNode('prose', 'Wallet', 'hook', { description: 'deposit logic' }),
    ])
    const results = search(s, 'deposit').groups.flatMap((g) => g.results)
    expect(results[0].id).toBe('named')
  })

  it('finds catalogued domains, which are not nodes', () => {
    const s = mkSchema([], ['payment'])
    expect(search(s, 'payment').groups[0].results[0]).toMatchObject({
      name: 'payment', group: 'domains',
    })
  })

  it('returns nothing for an empty query', () => {
    expect(search(sessionWorld(), '   ').total).toBe(0)
  })

  it('is case insensitive', () => {
    const s = mkSchema([mkNode('a', 'SessionStore', 'util')])
    expect(search(s, 'sessionstore').total).toBe(1)
  })
})

describe('search — grouping', () => {
  it('groups results by what kind of thing they are', () => {
    const groups = search(sessionWorld(), 'session').groups.map((g) => g.group)
    expect(groups).toContain('domains')
    expect(groups).toContain('system')
    expect(groups).toContain('code')
    expect(groups).toContain('behavior')
  })

  it('orders groups consistently for stable rendering', () => {
    const groups = search(sessionWorld(), 'session').groups.map((g) => g.group)
    expect(groups.indexOf('domains')).toBeLessThan(groups.indexOf('code'))
  })

  it('respects the result limit', () => {
    const s = mkSchema(Array.from({ length: 30 }, (_, i) => mkNode(`n${i}`, `session${i}`, 'hook')))
    const r = search(s, 'session', 5)
    expect(r.groups.flatMap((g) => g.results)).toHaveLength(5)
    // The total still reports what existed before the cut.
    expect(r.total).toBe(30)
  })
})

describe('search — ambiguity', () => {
  it('flags a term that reads equally well as several kinds of thing', () => {
    // The spec's example: "Session" could mean the domain, the model,
    // SessionStore, useSession, or /api/session. Putting one of them
    // first does not solve this — it hides that a choice was made.
    const r = search(sessionWorld(), 'session')
    expect(r.ambiguous).toBe(true)
    expect(r.interpretations.length).toBeGreaterThan(1)
  })

  it('describes each reading so the user can choose', () => {
    const labels = search(sessionWorld(), 'session').interpretations.map((i) => i.label)
    expect(labels).toContain('the domain')
    expect(labels).toContain('a stored entity')
  })

  it('does not call an unambiguous term ambiguous', () => {
    const s = mkSchema([mkNode('a', 'useDeposit', 'hook'), mkNode('b', 'useDepositForm', 'hook')])
    expect(search(s, 'usedeposit').ambiguous).toBe(false)
  })

  it('ignores weak prose matches when judging ambiguity', () => {
    // A term appearing in the description of unrelated files is not a
    // genuine choice of meaning.
    const s = mkSchema([
      mkNode('a', 'useDeposit', 'hook'),
      mkNode('b', 'Wallet', 'database', { description: 'mentions usedeposit somewhere' }),
    ])
    expect(search(s, 'usedeposit').ambiguous).toBe(false)
  })

  it('is deterministic', () => {
    const s = sessionWorld()
    expect(JSON.stringify(search(s, 'session'))).toBe(JSON.stringify(search(s, 'session')))
  })
})
