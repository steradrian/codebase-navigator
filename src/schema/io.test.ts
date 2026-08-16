import { describe, expect, it } from 'vitest'
import { serialize } from '@/schema/io'
import { migrate } from '@/schema/migrate'
import type { LegacySchema } from '@/types'

const fixture: LegacySchema = {
  meta: { name: 'Fixture', version: '0.2' },
  nodeTypes: {
    service: { color: '#abc', label: 'Service' },
  },
  nodes: [
    { id: 'a', name: 'A', type: 'service', description: 'alpha' },
    { id: 'b', name: 'B', type: 'service', description: 'beta' },
  ],
  links: [{ source: 'a', target: 'b', label: 'flows', description: 'a to b' }],
  paths: [],
}

describe('serialize', () => {
  it('produces byte-identical output on repeated runs', () => {
    const schema = migrate(fixture)
    expect(serialize(schema)).toBe(serialize(schema))
  })

  it('sorts object keys for stable diffs', () => {
    const schema = migrate(fixture)
    const json = serialize(schema)
    // Keys at the top level should appear in alphabetical order.
    const firstKeyPositions = [
      '"annotations"',
      '"linkTypes"',
      '"links"',
      '"meta"',
      '"nodeTypes"',
      '"nodes"',
      '"paths"',
    ].map((k) => json.indexOf(k))
    const sorted = [...firstKeyPositions].sort((a, b) => a - b)
    expect(firstKeyPositions).toEqual(sorted)
  })

  it('round-trips through JSON.parse without loss', () => {
    const schema = migrate(fixture)
    const parsed = JSON.parse(serialize(schema))
    expect(parsed).toEqual(schema)
  })
})
