import { describe, expect, it } from 'vitest'
import type { GuidedPath, Journey, LegacySchema, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { journeyFromPath, linkId, migrate, upgradeLoadedSchema } from '@/schema/migrate'
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
      // v1.3: "fully current" now includes a populated `journeys`.
      // Without it the upgrade must still run, or a schema stamped
      // v1.3 by an earlier code path would never get its journeys.
      journeys: [],
      meta: {
        ...stored.meta,
        version: SCHEMA_VERSION,
        lastPropagationAt: '2026-01-01T00:00:00Z',
      },
    }
    expect(upgradeLoadedSchema(current)).toBe(current)
  })

  it('upgrades a v1.3-stamped schema that is missing journeys', () => {
    const stamped: Schema = {
      ...stored,
      meta: {
        ...stored.meta,
        version: SCHEMA_VERSION,
        lastPropagationAt: '2026-01-01T00:00:00Z',
      },
    }
    expect(stamped.journeys).toBeUndefined()
    expect(upgradeLoadedSchema(stamped).journeys).toEqual([])
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

// ─── v1.3: evidence + branching journeys ─────────────────────

describe('journeyFromPath (v1.3)', () => {
  const path: GuidedPath = {
    id: 'checkout',
    name: 'Checkout',
    description: 'User pays',
    color: '#fff',
    category: 'user_journey',
    steps: [
      { nodeId: 'a', annotation: 'starts', duration: '~200ms' },
      { nodeId: 'b', annotation: 'validates' },
      { nodeId: 'c', annotation: 'done' },
    ],
  }

  it('emits one step per path step, joined by n-1 transitions', () => {
    const j = journeyFromPath(path)
    expect(j.steps).toHaveLength(3)
    expect(j.transitions).toHaveLength(2)
    expect(j.transitions.map((t) => [t.from, t.to])).toEqual([
      ['checkout__s0', 'checkout__s1'],
      ['checkout__s1', 'checkout__s2'],
    ])
  })

  it('is deterministic — repeated conversion is byte-stable', () => {
    expect(journeyFromPath(path)).toEqual(journeyFromPath(path))
  })

  it('preserves annotations, duration, and node links', () => {
    const j = journeyFromPath(path)
    expect(j.steps[0]).toMatchObject({ nodeId: 'a', annotation: 'starts', duration: '~200ms' })
  })

  it('does not fabricate an outcome for the final step', () => {
    const j = journeyFromPath(path)
    expect(j.steps.every((s) => s.kind === 'action')).toBe(true)
    expect(j.steps.every((s) => s.outcome === undefined)).toBe(true)
  })

  it('marks the first step as the entry point', () => {
    expect(journeyFromPath(path).entryStepIds).toEqual(['checkout__s0'])
  })

  it('handles a single-step path without emitting transitions', () => {
    const single = journeyFromPath({ ...path, steps: [{ nodeId: 'a', annotation: 'only' }] })
    expect(single.steps).toHaveLength(1)
    expect(single.transitions).toEqual([])
  })

  it('handles an empty path without producing a phantom entry step', () => {
    const empty = journeyFromPath({ ...path, steps: [] })
    expect(empty.steps).toEqual([])
    expect(empty.transitions).toEqual([])
    expect(empty.entryStepIds).toEqual([])
  })
})

describe('upgradeLoadedSchema — journey backfill (v1.3)', () => {
  const base: Schema = {
    meta: { name: 'J', version: '1.2' as typeof SCHEMA_VERSION },
    nodeTypes: { service: { color: '#abc', label: 'S' } },
    linkTypes: {},
    nodes: [{ id: 'a', name: 'A', type: 'service', description: '', origin: 'manual' }],
    links: [],
    paths: [
      { id: 'p1', name: 'P1', description: '', color: '#fff', steps: [{ nodeId: 'a', annotation: 'x' }] },
    ],
    annotations: [],
  }

  it('mirrors linear paths into journeys', () => {
    const up = upgradeLoadedSchema(base)
    expect(up.journeys).toHaveLength(1)
    expect(up.journeys?.[0].id).toBe('p1')
  })

  it('leaves the deprecated paths array intact for existing consumers', () => {
    expect(upgradeLoadedSchema(base).paths).toEqual(base.paths)
  })

  it('does not clobber hand-authored journeys', () => {
    const authored: Journey = {
      id: 'hand',
      name: 'Hand-authored',
      description: '',
      color: '#fff',
      steps: [{ id: 's', name: 'S', annotation: '', kind: 'action' }],
      transitions: [],
    }
    const up = upgradeLoadedSchema({ ...base, journeys: [authored] })
    expect(up.journeys).toEqual([authored])
  })
})

describe('validate — journeys and evidence (v1.3)', () => {
  const base: Schema = {
    meta: { name: 'V', version: SCHEMA_VERSION },
    nodeTypes: { service: { color: '#abc', label: 'S' } },
    linkTypes: {},
    nodes: [{ id: 'a', name: 'A', type: 'service', description: '', origin: 'manual' }],
    links: [],
    paths: [],
    journeys: [],
    annotations: [],
  }

  const journey = (over: Partial<Journey>): Journey => ({
    id: 'j',
    name: 'J',
    description: '',
    color: '#fff',
    steps: [],
    transitions: [],
    ...over,
  })

  it('accepts a well-formed branching journey', () => {
    const j = journey({
      steps: [
        { id: 's1', name: 'Submit', annotation: '', kind: 'action', nodeId: 'a' },
        { id: 's2', name: 'Valid?', annotation: '', kind: 'condition' },
        { id: 'ok', name: 'Done', annotation: '', kind: 'outcome', outcome: 'success' },
        { id: 'bad', name: 'Invalid', annotation: '', kind: 'outcome', outcome: 'validation_error' },
      ],
      transitions: [
        { id: 't1', from: 's1', to: 's2' },
        { id: 't2', from: 's2', to: 'ok', condition: 'valid' },
        { id: 't3', from: 's2', to: 'bad', condition: 'invalid' },
      ],
      entryStepIds: ['s1'],
    })
    expect(validate({ ...base, journeys: [j] }).ok).toBe(true)
  })

  it('accepts a transition that rejoins and one that loops back', () => {
    const j = journey({
      steps: [
        { id: 's1', name: 'Try', annotation: '', kind: 'action' },
        { id: 's2', name: 'Failed?', annotation: '', kind: 'condition' },
        { id: 'ok', name: 'Done', annotation: '', kind: 'outcome', outcome: 'success' },
      ],
      transitions: [
        { id: 't1', from: 's1', to: 's2' },
        { id: 't2', from: 's2', to: 's1', condition: 'retry' },
        { id: 't3', from: 's2', to: 'ok' },
      ],
    })
    expect(validate({ ...base, journeys: [j] }).ok).toBe(true)
  })

  it('rejects duplicate journey ids', () => {
    const r = validate({ ...base, journeys: [journey({}), journey({})] })
    expect(r.errors).toContainEqual({ kind: 'duplicate_journey_id', id: 'j' })
  })

  it('rejects duplicate step ids within a journey', () => {
    const j = journey({
      steps: [
        { id: 'dup', name: 'A', annotation: '', kind: 'action' },
        { id: 'dup', name: 'B', annotation: '', kind: 'action' },
      ],
    })
    const r = validate({ ...base, journeys: [j] })
    expect(r.errors).toContainEqual({ kind: 'journey_duplicate_step_id', journeyId: 'j', stepId: 'dup' })
  })

  it('rejects a step pointing at a node that does not exist', () => {
    const j = journey({ steps: [{ id: 's', name: 'S', annotation: '', kind: 'action', nodeId: 'ghost' }] })
    const r = validate({ ...base, journeys: [j] })
    expect(r.errors).toContainEqual({
      kind: 'journey_step_missing_node', journeyId: 'j', stepId: 's', nodeId: 'ghost',
    })
  })

  it('rejects a transition referencing an unknown step', () => {
    const j = journey({
      steps: [{ id: 's1', name: 'S', annotation: '', kind: 'action' }],
      transitions: [{ id: 't1', from: 's1', to: 'ghost' }],
    })
    const r = validate({ ...base, journeys: [j] })
    expect(r.errors).toContainEqual({
      kind: 'journey_transition_missing_step', journeyId: 'j', transitionId: 't1', stepId: 'ghost',
    })
  })

  it('rejects an entry step that does not exist', () => {
    const j = journey({ entryStepIds: ['ghost'] })
    const r = validate({ ...base, journeys: [j] })
    expect(r.errors).toContainEqual({ kind: 'journey_entry_step_missing', journeyId: 'j', stepId: 'ghost' })
  })

  it('rejects an outcome on a non-outcome step', () => {
    const j = journey({
      steps: [{ id: 's', name: 'S', annotation: '', kind: 'action', outcome: 'success' }],
    })
    const r = validate({ ...base, journeys: [j] })
    expect(r.errors).toContainEqual({
      kind: 'journey_outcome_on_non_outcome_step', journeyId: 'j', stepId: 's',
    })
  })

  it('rejects an outcome step with no outcome kind', () => {
    const j = journey({ steps: [{ id: 's', name: 'S', annotation: '', kind: 'outcome' }] })
    const r = validate({ ...base, journeys: [j] })
    expect(r.errors).toContainEqual({
      kind: 'journey_outcome_step_missing_outcome', journeyId: 'j', stepId: 's',
    })
  })

  it('treats absent confidence as unscored, not invalid', () => {
    const nodes = [{ ...base.nodes[0], evidence: [{ source: 'static_analysis' as const }] }]
    expect(validate({ ...base, nodes }).ok).toBe(true)
  })

  it('accepts confidence at both bounds', () => {
    const nodes = [{
      ...base.nodes[0],
      evidence: [
        { source: 'human' as const, confidence: 0 },
        { source: 'ai_inference' as const, confidence: 1 },
      ],
    }]
    expect(validate({ ...base, nodes }).ok).toBe(true)
  })

  it('rejects out-of-range confidence on a node', () => {
    const nodes = [{ ...base.nodes[0], evidence: [{ source: 'ai_inference' as const, confidence: 1.4 }] }]
    const r = validate({ ...base, nodes })
    expect(r.errors).toContainEqual({
      kind: 'evidence_confidence_out_of_range', entityType: 'node', entityId: 'a', confidence: 1.4,
    })
  })

  it('rejects NaN confidence', () => {
    const nodes = [{ ...base.nodes[0], evidence: [{ source: 'runtime' as const, confidence: NaN }] }]
    expect(validate({ ...base, nodes }).ok).toBe(false)
  })

  it('rejects out-of-range confidence on a journey transition', () => {
    const j = journey({
      steps: [
        { id: 's1', name: 'A', annotation: '', kind: 'action' },
        { id: 's2', name: 'B', annotation: '', kind: 'action' },
      ],
      transitions: [{ id: 't1', from: 's1', to: 's2', evidence: [{ source: 'test', confidence: -0.2 }] }],
    })
    const r = validate({ ...base, journeys: [j] })
    expect(r.errors).toContainEqual({
      kind: 'evidence_confidence_out_of_range',
      entityType: 'journey_transition', entityId: 't1', confidence: -0.2,
    })
  })
})
