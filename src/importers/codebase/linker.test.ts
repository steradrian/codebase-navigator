import { describe, expect, it } from 'vitest'
import type { Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { extractCodebaseApiLinks, extractBackendToApiLinks } from '@/importers/codebase/linker'

/**
 * Build a minimal schema with a matching OpenAPI API node and a
 * codebase file node for each file in the input. Mirrors what the
 * live app would have after importing both.
 */
function makeSchemaFor(
  files: Map<string, string>,
  operations: Array<{ method: string; path: string }>,
): Schema {
  const nodes: Node[] = []
  for (const [p] of files) {
    nodes.push({
      id: `codebase:file:${p}`,
      name: p.split('/').pop() ?? p,
      type: 'ui',
      description: p,
      origin: 'auto:codebase',
    })
  }
  for (const op of operations) {
    const safePath = op.path.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '')
    nodes.push({
      id: `openapi:op:${op.method.toLowerCase()}:${safePath || 'root'}`,
      name: `${op.method.toUpperCase()} ${op.path}`,
      type: 'api',
      description: op.path,
      origin: 'auto:openapi',
      group: 'api',
    })
  }
  return {
    meta: { name: 'test', version: SCHEMA_VERSION, sources: ['auto:codebase', 'auto:openapi'] },
    nodeTypes: { ui: { color: '#abc', label: 'UI' }, api: { color: '#def', label: 'API' } },
    linkTypes: { data_flow: { color: '#111', label: 'Data' } },
    nodes,
    links: [],
    paths: [],
    annotations: [],
  }
}

describe('extractCodebaseApiLinks — pass 1 (direct client calls)', () => {
  it('emits an edge for client.GET with a literal path', () => {
    const files = new Map([
      ['lib/api/payments/client.ts', `
        import { client } from '@/lib/api/openapi-client'
        export async function fetchPayments() {
          return client.GET('/admin/payments')
        }
      `],
    ])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/admin/payments' }])
    const result = extractCodebaseApiLinks(files, schema)

    expect(result.links).toHaveLength(1)
    expect(result.links[0].source).toBe('codebase:file:lib/api/payments/client.ts')
    expect(result.links[0].target).toMatch(/openapi:op:get:/)
    expect(result.links[0].label).toBe('calls')
    expect(result.links[0].origin).toBe('auto:linker')
    expect(result.stats.directHits).toBe(1)
    expect(result.stats.matched).toBe(1)
  })

  it('handles path parameters verbatim ({id} is not substituted)', () => {
    const files = new Map([
      ['lib/api/bets/client.ts', `client.GET('/admin/game_rounds/{id}', { params: { path: { id } } })`],
    ])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/admin/game_rounds/{id}' }])
    const result = extractCodebaseApiLinks(files, schema)
    expect(result.links).toHaveLength(1)
  })

  it('supports all HTTP methods and both quote styles', () => {
    const files = new Map([
      ['api.ts', `
        client.POST('/a')
        client.PUT("/b")
        client.DELETE(\`/c\`)
        client.PATCH('/d')
      `],
    ])
    const schema = makeSchemaFor(files, [
      { method: 'POST', path: '/a' },
      { method: 'PUT', path: '/b' },
      { method: 'DELETE', path: '/c' },
      { method: 'PATCH', path: '/d' },
    ])
    const result = extractCodebaseApiLinks(files, schema)
    expect(result.links).toHaveLength(4)
  })

  it('warns when a path exists in code but has no matching API node', () => {
    const files = new Map([['a.ts', `client.GET('/missing')`]])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/something-else' }])
    const result = extractCodebaseApiLinks(files, schema)
    expect(result.links).toHaveLength(0)
    expect(result.warnings.some((w) => w.kind === 'unmatched_path')).toBe(true)
    expect(result.stats.unmatched).toBe(1)
  })
})

describe('extractCodebaseApiLinks — pass 2 (raw fetch)', () => {
  it('extracts the path from a template-literal fetch() with a config base', () => {
    const files = new Map([
      ['lib/api/players/search.ts', `
        const response = await fetch(
          \`\${config.API_BASE_URL}/admin/players/filter\`,
          { method: 'POST', body: JSON.stringify(data) }
        )
      `],
    ])
    const schema = makeSchemaFor(files, [{ method: 'POST', path: '/admin/players/filter' }])
    const result = extractCodebaseApiLinks(files, schema)
    expect(result.links).toHaveLength(1)
    expect(result.links[0].target).toMatch(/openapi:op:post:/)
  })

  it('assumes GET when the method is not specified, and warns', () => {
    const files = new Map([
      ['a.ts', `fetch(\`\${BASE}/admin/x\`, { headers: {} })`],
    ])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/admin/x' }])
    const result = extractCodebaseApiLinks(files, schema)
    expect(result.links).toHaveLength(1)
    expect(result.warnings.some((w) => w.kind === 'fetch_without_method')).toBe(true)
  })
})

describe('extractCodebaseApiLinks — pass 3 (import indirection)', () => {
  it('links a hook file to the endpoint of an imported-and-called function', () => {
    const files = new Map([
      ['lib/api/players/client.ts', `
        import { client } from './openapi-client'
        export async function fetchPlayers() {
          return client.GET('/admin/players')
        }
      `],
      ['hooks/use-players.ts', `
        import { fetchPlayers } from '../lib/api/players/client'
        export function usePlayers() {
          return useQuery({ queryFn: () => fetchPlayers() })
        }
      `],
    ])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/admin/players' }])
    const result = extractCodebaseApiLinks(files, schema)

    // Expect two edges:
    //  - lib/api/players/client.ts → GET /admin/players  (direct, pass 1)
    //  - hooks/use-players.ts → GET /admin/players        (indirect, pass 3)
    expect(result.links).toHaveLength(2)
    const sources = result.links.map((l) => l.source).sort()
    expect(sources).toEqual([
      'codebase:file:hooks/use-players.ts',
      'codebase:file:lib/api/players/client.ts',
    ])
    expect(result.stats.indirectHits).toBeGreaterThan(0)
  })

  it('does NOT link when the imported function is never called', () => {
    const files = new Map([
      ['lib/api/x.ts', `export async function fetchX() { client.GET('/x') }`],
      ['consumer.ts', `import { fetchX } from './lib/api/x'\n// never calls fetchX`],
    ])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/x' }])
    const result = extractCodebaseApiLinks(files, schema)
    // Only the direct edge (pass 1), no indirect edge for consumer.
    expect(result.links).toHaveLength(1)
    expect(result.links[0].source).toBe('codebase:file:lib/api/x.ts')
  })

  it('resolves @/ alias to both src/ and repo-root layouts', () => {
    const files = new Map([
      ['src/lib/api/x.ts', `export async function fetchX() { client.GET('/x') }`],
      ['src/hooks/y.ts', `import { fetchX } from '@/lib/api/x'\nfetchX()`],
    ])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/x' }])
    const result = extractCodebaseApiLinks(files, schema)
    expect(result.links.length).toBeGreaterThanOrEqual(2)
  })
})

describe('extractCodebaseApiLinks — dedup + determinism', () => {
  it('is idempotent — rerunning against a schema that already has the edges emits nothing', () => {
    const files = new Map([['a.ts', `client.GET('/x')`]])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/x' }])
    const first = extractCodebaseApiLinks(files, schema)
    expect(first.links).toHaveLength(1)

    // Fold the first-run output into the schema, then rerun.
    const next: Schema = { ...schema, links: [...schema.links, ...first.links] }
    const second = extractCodebaseApiLinks(files, next)
    expect(second.links).toHaveLength(0)
  })

  it('produces deterministic link IDs across runs', () => {
    const files = new Map([['a.ts', `client.GET('/x')`]])
    const schema = makeSchemaFor(files, [{ method: 'GET', path: '/x' }])
    const a = extractCodebaseApiLinks(files, schema)
    const b = extractCodebaseApiLinks(files, schema)
    expect(JSON.stringify(a.links)).toBe(JSON.stringify(b.links))
  })
})

// ─── BE handler → OpenAPI linker (GE-110) ────────────────────

/**
 * Build a schema containing OpenAPI op nodes and BE handler nodes.
 * Mirrors the shape produced by the Go plugin + OpenAPI importer.
 */
function makeBeSchema(
  handlers: Array<{ method: string; path: string; backend?: string }>,
  operations: Array<{ method: string; path: string }>,
  existingLinks: Schema['links'] = [],
): Schema {
  const nodes: Node[] = []

  for (const op of operations) {
    const safePath = op.path.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '')
    nodes.push({
      id: `openapi:op:${op.method.toLowerCase()}:${safePath || 'root'}`,
      name: `${op.method.toUpperCase()} ${op.path}`,
      type: 'api',
      description: op.path,
      origin: 'auto:openapi',
      group: 'api',
    })
  }

  for (const h of handlers) {
    const backend = h.backend ?? 'go'
    const safePath = h.path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+$/g, '')
    nodes.push({
      id: `codebase:${backend}:op:${h.method.toUpperCase()}:${safePath}`,
      name: `${h.method.toUpperCase()} ${h.path}`,
      type: 'api',
      description: `handlers/main.go:10`,
      group: `${backend} handlers`,
      origin: 'auto:codebase',
      metadata: { backend, filePath: 'handlers/main.go', line: 10 },
    })
  }

  return {
    meta: { name: 'test', version: SCHEMA_VERSION, sources: ['auto:codebase', 'auto:openapi'] },
    nodeTypes: { api: { color: '#69f0ae', label: 'API' } },
    linkTypes: { data_flow: { color: '#111', label: 'Data' } },
    nodes,
    links: existingLinks,
    paths: [],
    annotations: [],
  }
}

describe('extractBackendToApiLinks — basic matching', () => {
  it('emits an edge when a BE handler matches an OpenAPI op by name', () => {
    const schema = makeBeSchema(
      [{ method: 'GET', path: '/admin/players' }],
      [{ method: 'GET', path: '/admin/players' }],
    )
    const result = extractBackendToApiLinks(schema)

    expect(result.links).toHaveLength(1)
    expect(result.links[0].source).toMatch(/^openapi:op:get:/)
    expect(result.links[0].target).toMatch(/^codebase:go:op:GET:/)
    expect(result.links[0].label).toBe('implemented by')
    expect(result.links[0].type).toBe('data_flow')
    expect(result.links[0].origin).toBe('auto:linker')
    expect(result.stats.beHandlersSeen).toBe(1)
    expect(result.stats.matched).toBe(1)
    expect(result.stats.unmatchedBe).toBe(0)
    expect(result.stats.unmatchedOpenapi).toBe(0)
  })

  it('does NOT match when method differs (GET vs POST)', () => {
    const schema = makeBeSchema(
      [{ method: 'GET', path: '/x' }],
      [{ method: 'POST', path: '/x' }],
    )
    const result = extractBackendToApiLinks(schema)

    expect(result.links).toHaveLength(0)
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings.some((w) => w.kind === 'unmatched_be_handler')).toBe(true)
    expect(result.warnings.some((w) => w.kind === 'unmatched_openapi_op')).toBe(true)
    expect(result.stats.unmatchedBe).toBe(1)
    expect(result.stats.unmatchedOpenapi).toBe(1)
  })

  it('matches paths with {id} placeholders (already normalized by BE parser)', () => {
    const schema = makeBeSchema(
      [{ method: 'GET', path: '/admin/game_rounds/{id}' }],
      [{ method: 'GET', path: '/admin/game_rounds/{id}' }],
    )
    const result = extractBackendToApiLinks(schema)
    expect(result.links).toHaveLength(1)
  })

  it('matches multiple handlers to multiple ops', () => {
    const schema = makeBeSchema(
      [
        { method: 'GET', path: '/admin/players' },
        { method: 'POST', path: '/admin/players' },
        { method: 'DELETE', path: '/admin/players/{id}' },
      ],
      [
        { method: 'GET', path: '/admin/players' },
        { method: 'POST', path: '/admin/players' },
        { method: 'DELETE', path: '/admin/players/{id}' },
      ],
    )
    const result = extractBackendToApiLinks(schema)
    expect(result.links).toHaveLength(3)
    expect(result.stats.matched).toBe(3)
    expect(result.warnings).toHaveLength(0)
  })
})

describe('extractBackendToApiLinks — warnings', () => {
  it('warns for unmatched BE handlers and unmatched OpenAPI ops', () => {
    const schema = makeBeSchema(
      [{ method: 'GET', path: '/be-only' }],
      [{ method: 'GET', path: '/spec-only' }],
    )
    const result = extractBackendToApiLinks(schema)

    expect(result.links).toHaveLength(0)
    const beWarning = result.warnings.find((w) => w.kind === 'unmatched_be_handler')
    expect(beWarning).toBeDefined()
    expect(beWarning!.path).toBe('/be-only')

    const opWarning = result.warnings.find((w) => w.kind === 'unmatched_openapi_op')
    expect(opWarning).toBeDefined()
    expect(opWarning!.path).toBe('/spec-only')
  })

  it('reports correct stats with partial matches', () => {
    const schema = makeBeSchema(
      [
        { method: 'GET', path: '/matched' },
        { method: 'POST', path: '/be-only' },
      ],
      [
        { method: 'GET', path: '/matched' },
        { method: 'PUT', path: '/spec-only' },
      ],
    )
    const result = extractBackendToApiLinks(schema)

    expect(result.stats.beHandlersSeen).toBe(2)
    expect(result.stats.matched).toBe(1)
    expect(result.stats.unmatchedBe).toBe(1)
    expect(result.stats.unmatchedOpenapi).toBe(1)
    expect(result.links).toHaveLength(1)
  })
})

describe('extractBackendToApiLinks — dedup + determinism', () => {
  it('is idempotent — rerunning with existing edges emits nothing new', () => {
    const schema = makeBeSchema(
      [{ method: 'GET', path: '/admin/players' }],
      [{ method: 'GET', path: '/admin/players' }],
    )
    const first = extractBackendToApiLinks(schema)
    expect(first.links).toHaveLength(1)

    const next: Schema = { ...schema, links: [...schema.links, ...first.links] }
    const second = extractBackendToApiLinks(next)
    expect(second.links).toHaveLength(0)
  })

  it('produces deterministic link IDs across runs', () => {
    const schema = makeBeSchema(
      [{ method: 'GET', path: '/x' }, { method: 'POST', path: '/y' }],
      [{ method: 'GET', path: '/x' }, { method: 'POST', path: '/y' }],
    )
    const a = extractBackendToApiLinks(schema)
    const b = extractBackendToApiLinks(schema)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('output is sorted by link ID for stable ordering', () => {
    const schema = makeBeSchema(
      [
        { method: 'POST', path: '/b' },
        { method: 'GET', path: '/a' },
      ],
      [
        { method: 'POST', path: '/b' },
        { method: 'GET', path: '/a' },
      ],
    )
    const result = extractBackendToApiLinks(schema)
    expect(result.links).toHaveLength(2)
    const ids = result.links.map((l) => l.id)
    expect(ids).toEqual([...ids].sort())
  })
})

describe('extractBackendToApiLinks — edge cases', () => {
  it('returns empty result when schema has no BE handler nodes', () => {
    const schema = makeBeSchema([], [{ method: 'GET', path: '/x' }])
    const result = extractBackendToApiLinks(schema)
    expect(result.links).toHaveLength(0)
    expect(result.stats.beHandlersSeen).toBe(0)
    expect(result.stats.matched).toBe(0)
    // All OpenAPI ops are unmatched.
    expect(result.stats.unmatchedOpenapi).toBe(1)
  })

  it('returns empty result when schema has no OpenAPI op nodes', () => {
    const schema = makeBeSchema([{ method: 'GET', path: '/x' }], [])
    const result = extractBackendToApiLinks(schema)
    expect(result.links).toHaveLength(0)
    expect(result.stats.beHandlersSeen).toBe(1)
    expect(result.stats.unmatchedBe).toBe(1)
  })

  it('ignores codebase nodes that lack metadata.backend (e.g. file nodes)', () => {
    const schema: Schema = {
      meta: { name: 'test', version: SCHEMA_VERSION, sources: ['auto:codebase', 'auto:openapi'] },
      nodeTypes: { api: { color: '#69f0ae', label: 'API' }, ui: { color: '#ffd740', label: 'UI' } },
      linkTypes: { data_flow: { color: '#111', label: 'Data' } },
      nodes: [
        {
          id: 'codebase:file:src/app.ts',
          name: 'app.ts',
          type: 'ui',
          description: 'src/app.ts',
          origin: 'auto:codebase',
        },
        {
          id: 'openapi:op:get:admin_x',
          name: 'GET /admin/x',
          type: 'api',
          description: '/admin/x',
          origin: 'auto:openapi',
          group: 'api',
        },
      ],
      links: [],
      paths: [],
      annotations: [],
    }
    const result = extractBackendToApiLinks(schema)
    expect(result.links).toHaveLength(0)
    expect(result.stats.beHandlersSeen).toBe(0)
  })
})

// ─── transitive indirection ──────────────────────────────────

describe('extractCodebaseApiLinks — multi-hop indirection', () => {
  // The shape real apps actually have, and the reason one hop was not
  // enough: a component imports a hook, the hook calls a fetch
  // function, and only that fetch function names the endpoint.
  // Declared deepest-consumer-first ON PURPOSE. In dependency order a
  // single round resolves the whole chain by accident: each wrapper is
  // promoted just before its consumer is visited. Reversing the order
  // means the consumer is seen before its dependency is known, so only
  // a genuine fixed-point loop links it — which is what this suite is
  // supposed to be testing. Real file trees give no ordering guarantee.
  const chain = () =>
    new Map<string, string>([
      ['src/components/Profile.tsx', `
        import { usePlayer } from '../hooks/use-player'
        export function Profile() { const p = usePlayer(); return null }
      `],
      ['src/hooks/use-player.ts', `
        import { getPlayer } from '../api/fetch-functions'
        export const usePlayer = () => getPlayer()
      `],
      ['src/api/fetch-functions.ts', `
        import { client } from './client'
        export function getPlayer() { return client.GET('/api/player') }
      `],
    ])

  const ops = [{ method: 'GET', path: '/api/player' }]
  const targets = (files: Map<string, string>) => {
    const r = extractCodebaseApiLinks(files, makeSchemaFor(files, ops))
    return r.links.map((l) => l.source)
  }

  it('links the direct caller', () => {
    expect(targets(chain())).toContain('codebase:file:src/api/fetch-functions.ts')
  })

  it('links the first wrapper (one hop)', () => {
    expect(targets(chain())).toContain('codebase:file:src/hooks/use-player.ts')
  })

  it('links the second wrapper, which one-hop resolution missed', () => {
    expect(targets(chain())).toContain('codebase:file:src/components/Profile.tsx')
  })

  it('does not link a file that imports without calling', () => {
    const files = chain()
    files.set('src/components/Unused.tsx', `
      import { usePlayer } from '../hooks/use-player'
      export function Unused() { return null }
    `)
    expect(targets(files)).not.toContain('codebase:file:src/components/Unused.tsx')
  })

  it('counts each emitted edge once despite repeated rounds', () => {
    const files = chain()
    const r = extractCodebaseApiLinks(files, makeSchemaFor(files, ops))
    expect(r.stats.indirectHits).toBe(r.links.length - r.stats.directHits)
    expect(new Set(r.links.map((l) => l.id)).size).toBe(r.links.length)
  })

  it('is deterministic across runs', () => {
    const a = extractCodebaseApiLinks(chain(), makeSchemaFor(chain(), ops))
    const b = extractCodebaseApiLinks(chain(), makeSchemaFor(chain(), ops))
    expect(JSON.stringify(a.links)).toBe(JSON.stringify(b.links))
  })

  it('terminates on a circular import chain', () => {
    const files = new Map<string, string>([
      ['src/a.ts', `
        import { b } from './b'
        import { client } from './client'
        export function a() { b(); return client.GET('/api/player') }
      `],
      ['src/b.ts', `
        import { a } from './a'
        export function b() { return a() }
      `],
    ])
    const r = extractCodebaseApiLinks(files, makeSchemaFor(files, ops))
    expect(r.links.length).toBeGreaterThan(0)
  })
})

describe('extractCodebaseApiLinks — JSX usage counts as a call', () => {
  const ops = [{ method: 'GET', path: '/api/player' }]
  const build = (consumer: string) =>
    new Map<string, string>([
      ['src/components/Consumer.tsx', consumer],
      ['src/api/fetch-functions.ts', `
        import { client } from './client'
        export const PlayerCard = () => client.GET('/api/player')
      `],
    ])
  const sources = (files: Map<string, string>) => {
    const r = extractCodebaseApiLinks(files, makeSchemaFor(files, ops))
    return r.links.map((l) => l.source)
  }

  it('links a component rendered as JSX', () => {
    const files = build(`
      import { PlayerCard } from '../api/fetch-functions'
      export function Consumer() { return <PlayerCard /> }
    `)
    expect(sources(files)).toContain('codebase:file:src/components/Consumer.tsx')
  })

  it('links a JSX element carrying props', () => {
    const files = build(`
      import { PlayerCard } from '../api/fetch-functions'
      export function Consumer() { return <PlayerCard id={1} /> }
    `)
    expect(sources(files)).toContain('codebase:file:src/components/Consumer.tsx')
  })

  it('still links a plain function call', () => {
    const files = build(`
      import { PlayerCard } from '../api/fetch-functions'
      export function Consumer() { return PlayerCard() }
    `)
    expect(sources(files)).toContain('codebase:file:src/components/Consumer.tsx')
  })

  it('does not link a bare mention with no usage', () => {
    const files = build(`
      import { PlayerCard } from '../api/fetch-functions'
      export const label = 'PlayerCard is unused here'
    `)
    expect(sources(files)).not.toContain('codebase:file:src/components/Consumer.tsx')
  })

  it('does not match a longer name that merely starts the same', () => {
    const files = build(`
      import { PlayerCard } from '../api/fetch-functions'
      export function Consumer() { return <PlayerCardExtended /> }
    `)
    expect(sources(files)).not.toContain('codebase:file:src/components/Consumer.tsx')
  })
})
