import { describe, expect, it } from 'vitest'
import type { LegacySchema, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { linkId, migrate, upgradeLoadedSchema } from '@/schema/migrate'
import { validate } from '@/schema/validate'

// ─── fixtures ────────────────────────────────────────────────

const legacy: LegacySchema = {
  meta: { name: 'Fixture', version: '0.2' },
  nodeTypes: {
    service: { color: '#abc', label: 'Service' },
    database: { color: '#def', label: 'Database' },
  },
  nodes: [
    { id: 'a', name: 'A', type: 'service', description: 'Service A' },
    { id: 'b', name: 'B', type: 'database', description: 'DB B', group: 'data' },
  ],
  links: [
    { source: 'a', target: 'b', label: 'reads', description: 'A reads B', type: 'data_flow' },
  ],
  paths: [
    {
      id: 'p1',
      name: 'Flow',
      description: 'A to B',
      color: '#f0f',
      steps: [
        { nodeId: 'a', annotation: 'start' },
        { nodeId: 'b', annotation: 'end' },
      ],
    },
  ],
}

/** Build a fresh, valid v1.0 schema for mutation in validator tests. */
const makeValid = (): Schema => migrate(legacy)

// ─── migrate ─────────────────────────────────────────────────

describe('migrate', () => {
  it('produces a v1.0 schema that passes the validator', () => {
    const v1 = migrate(legacy)
    const result = validate(v1)
    expect(result.ok).toBe(true)
  })

  it('is deterministic — same input produces byte-identical output', () => {
    const a = migrate(legacy)
    const b = migrate(legacy)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('stamps every node and link with origin: "manual"', () => {
    const v1 = migrate(legacy)
    expect(v1.nodes.every((n) => n.origin === 'manual')).toBe(true)
    expect(v1.links.every((l) => l.origin === 'manual')).toBe(true)
  })

  it('assigns deterministic link IDs derived from source/type/target', () => {
    const v1 = migrate(legacy)
    expect(v1.links[0].id).toBe(linkId('a', 'b', 'data_flow'))
  })

  it('populates SchemaMeta.sources with ["manual"] and bumps version to the current SCHEMA_VERSION', () => {
    const v1 = migrate(legacy)
    expect(v1.meta.version).toBe(SCHEMA_VERSION)
    expect(v1.meta.sources).toEqual(['manual'])
  })

  it('seeds linkTypes registry with the three built-in types', () => {
    const v1 = migrate(legacy)
    expect(Object.keys(v1.linkTypes).sort()).toEqual(['data_flow', 'dependency', 'triggers'])
  })

  it('preserves existing nodeTypes registry from the legacy schema', () => {
    const v1 = migrate(legacy)
    expect(v1.nodeTypes).toEqual(legacy.nodeTypes)
  })
})

// ─── validate ────────────────────────────────────────────────

describe('validate — happy path', () => {
  it('accepts a clean v1.0 schema with no errors', () => {
    const result = validate(makeValid())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
})

describe('validate — structural errors', () => {
  it('rejects duplicate node IDs', () => {
    const s = makeValid()
    s.nodes.push({ ...s.nodes[0] })
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ kind: 'duplicate_node_id', id: 'a' })
  })

  it('rejects duplicate link IDs', () => {
    const s = makeValid()
    s.links.push({ ...s.links[0] })
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.kind === 'duplicate_link_id')).toBe(true)
  })

  it('rejects a link whose source node does not exist', () => {
    const s = makeValid()
    s.links[0].source = 'ghost'
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.kind === 'link_missing_source_node')).toBe(true)
  })

  it('rejects a link whose target node does not exist', () => {
    const s = makeValid()
    s.links[0].target = 'ghost'
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.kind === 'link_missing_target_node')).toBe(true)
  })

  it('rejects a node whose type is not in the registry', () => {
    const s = makeValid()
    s.nodes[0].type = 'not_a_type'
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ kind: 'node_type_not_registered', nodeId: 'a', type: 'not_a_type' })
  })

  it('rejects a link whose type is not in the registry', () => {
    const s = makeValid()
    s.links[0].type = 'not_a_link_type'
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.kind === 'link_type_not_registered')).toBe(true)
  })

  it('rejects a node missing a required field', () => {
    const s = makeValid()
    // deliberately break the shape
    delete (s.nodes[0] as { name?: string }).name
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.kind === 'node_missing_required_field')).toBe(true)
  })

  it('rejects a path step referencing a missing node', () => {
    const s = makeValid()
    s.paths[0].steps[1].nodeId = 'ghost'
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({
      kind: 'path_step_missing_node',
      pathId: 'p1',
      stepIndex: 1,
      nodeId: 'ghost',
    })
  })
})

describe('validate — parent/child consistency', () => {
  it('accepts a consistent parent/child relationship', () => {
    const s = makeValid()
    s.nodes.push(
      { id: 'p', name: 'Parent', type: 'service', description: 'p', origin: 'manual', children: ['a'] },
    )
    s.nodes[0].parent = 'p'
    const result = validate(s)
    expect(result.ok).toBe(true)
  })

  it('rejects a child pointing at a non-existent parent', () => {
    const s = makeValid()
    s.nodes[0].parent = 'ghost'
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ kind: 'parent_missing', nodeId: 'a', parent: 'ghost' })
  })

  it('rejects a parent pointing at a non-existent child', () => {
    const s = makeValid()
    s.nodes[0].children = ['ghost']
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.kind === 'child_missing')).toBe(true)
  })

  it('rejects an asymmetric parent/child relationship', () => {
    const s = makeValid()
    // 'a' claims 'b' as parent, but 'b' does not list 'a' as a child
    s.nodes[0].parent = 'b'
    const result = validate(s)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.kind === 'parent_child_inconsistent')).toBe(true)
  })
})

// ─── upgradeLoadedSchema (GE-114) ────────────────────────────

describe('upgradeLoadedSchema', () => {
  // Build a minimal v1.0 schema: no meta.entities, no entity on nodes.
  // Use extractor-visible shapes: api node with an OpenAPI tag (group),
  // plus a codebase-origin node with a path in description.
  // Build a valid current-version schema and then downgrade `meta.version`
  // to simulate a graph stored before GE-103 shipped.
  const stored: Schema = {
    meta: { name: 'Stored', version: SCHEMA_VERSION, sources: ['auto:openapi'] },
    nodeTypes: { api: { color: '#abc', label: 'API' }, ui: { color: '#def', label: 'UI' } },
    linkTypes: {},
    nodes: [
      { id: 'n1', name: 'POST /payments', type: 'api', description: '', origin: 'auto:openapi', group: 'Payments' },
      { id: 'n2', name: 'BillingCard', type: 'ui', description: 'src/billing/BillingCard.tsx', origin: 'auto:codebase' },
    ],
    links: [],
    paths: [],
    annotations: [],
  }
  stored.meta.version = '1.0' as typeof SCHEMA_VERSION

  it('bumps meta.version to the current SCHEMA_VERSION', () => {
    const upgraded = upgradeLoadedSchema(stored)
    expect(upgraded.meta.version).toBe(SCHEMA_VERSION)
    // In the closed-vocabulary model (GE-115), backfill no longer
    // invents entities from filenames. Stored pre-v1.2 nodes without
    // entity remain unset until propagation runs (GE-115b).
    expect(upgraded.nodes.find((n) => n.id === 'n1')?.entity).toBeUndefined()
    expect(upgraded.nodes.find((n) => n.id === 'n2')?.entity).toBeUndefined()
  })

  it('is idempotent — running it twice produces the same result', () => {
    const once = upgradeLoadedSchema(stored)
    const twice = upgradeLoadedSchema(once)
    expect(twice).toBe(once) // short-circuit returns the same reference
  })

  it('returns the input unchanged when already on SCHEMA_VERSION with propagation done', () => {
    const current: Schema = {
      ...stored,
      meta: {
        ...stored.meta,
        version: SCHEMA_VERSION,
        lastPropagationAt: '2026-01-01T00:00:00Z',
      },
    }
    expect(upgradeLoadedSchema(current)).toBe(current)
  })

  it('cleans up stale auto entity tags from the old extractor on load', () => {
    // Simulate the user's `Ann test` graph: v1.2, propagation done,
    // empty catalog, but nodes still carrying junk entities from the
    // old open-vocabulary extractor (filename heuristics).
    const stuck: Schema = {
      meta: {
        name: 'Stuck',
        version: SCHEMA_VERSION,
        sources: ['auto:codebase'],
        entities: [],
        domains: [],
        lastPropagationAt: '2026-01-01T00:00:00.000Z',
      },
      nodeTypes: {}, linkTypes: {},
      nodes: [
        { id: 'n1', name: 'theme.ts', type: 'ui', description: '', origin: 'auto:codebase', entity: 'theme' },
        { id: 'n2', name: 'utils.ts', type: 'ui', description: '', origin: 'auto:codebase', entity: 'util' },
        { id: 'n3', name: 'manual', type: 'service', description: '', origin: 'manual', entity: 'kept' },
      ],
      links: [], paths: [], annotations: [],
    }
    const upgraded = upgradeLoadedSchema(stuck)
    // Junk entity tags wiped on auto nodes.
    expect(upgraded.nodes.find((n) => n.id === 'n1')?.entity).toBeUndefined()
    expect(upgraded.nodes.find((n) => n.id === 'n2')?.entity).toBeUndefined()
    // Manual node untouched.
    expect(upgraded.nodes.find((n) => n.id === 'n3')?.entity).toBe('kept')
  })

  it('preserves manual entity assignments during backfill', () => {
    const withManual: Schema = {
      ...stored,
      nodes: [
        { id: 'n1', name: 'PaymentForm', type: 'ui', description: '', origin: 'auto:openapi', entity: 'custom-entity', manualOverrides: ['entity'] },
        ...stored.nodes.slice(1),
      ],
    }
    const upgraded = upgradeLoadedSchema(withManual)
    expect(upgraded.nodes.find((n) => n.id === 'n1')?.entity).toBe('custom-entity')
  })
})
