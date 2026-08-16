import { describe, expect, it } from 'vitest'
import { parseCodebase } from '@/importers/codebase'
import { validate } from '@/schema/validate'

describe('parseCodebase — empty / trivial inputs', () => {
  it('empty map produces a valid empty schema', () => {
    const result = parseCodebase(new Map())
    expect(result.ok).toBe(true)
    expect(result.schema!.nodes).toEqual([])
    expect(result.schema!.links).toEqual([])
    expect(validate(result.schema!).ok).toBe(true)
  })

  it('single-file map produces one node with no links', () => {
    const files = new Map([['app/page.tsx', 'export default function Page() { return <div/> }']])
    const result = parseCodebase(files)
    expect(result.schema!.nodes).toHaveLength(1)
    expect(result.schema!.nodes[0].name).toMatch(/Page:/)
    expect(result.schema!.links).toEqual([])
  })
})

describe('parseCodebase — classification', () => {
  it('classifies app/page.tsx, app/layout.tsx, app/route.ts correctly', () => {
    const files = new Map([
      ['app/page.tsx', ''],
      ['app/dashboard/page.tsx', ''],
      ['app/layout.tsx', ''],
      ['app/api/users/route.ts', ''],
      ['components/Button.tsx', ''],
    ])
    const result = parseCodebase(files)
    const byPath = Object.fromEntries(result.schema!.nodes.map((n) => [n.description, n]))
    expect(byPath['app/page.tsx'].name).toMatch(/^Page:/)
    expect(byPath['app/dashboard/page.tsx'].name).toContain('/dashboard')
    expect(byPath['app/layout.tsx'].name).toMatch(/^Layout:/)
    expect(byPath['app/api/users/route.ts'].type).toBe('api')
    expect(byPath['components/Button.tsx'].name).toBe('Button')
  })
})

describe('parseCodebase — import resolution', () => {
  it('resolves a relative import with extension elision', () => {
    const files = new Map([
      ['app/page.tsx', 'import { Button } from "../components/Button"\n'],
      ['components/Button.tsx', 'export function Button() { return null }'],
    ])
    const result = parseCodebase(files)
    expect(result.schema!.links).toHaveLength(1)
    expect(result.schema!.links[0].type).toBe('dependency')
    expect(result.stats.importsResolved).toBe(1)
  })

  it('resolves a directory/index import', () => {
    const files = new Map([
      ['app/page.tsx', 'import { UI } from "../components/ui"\n'],
      ['components/ui/index.tsx', 'export const UI = {}'],
    ])
    const result = parseCodebase(files)
    expect(result.schema!.links).toHaveLength(1)
    expect(result.schema!.links[0].target).toContain('components/ui/index.tsx')
  })

  it('resolves the @/ alias (to src/ or repo-root)', () => {
    const files = new Map([
      ['src/app/page.tsx', 'import { Helper } from "@/lib/helper"\n'],
      ['src/lib/helper.ts', 'export const Helper = {}'],
    ])
    const result = parseCodebase(files)
    expect(result.stats.importsResolved).toBe(1)
  })

  it('skips bare imports (node_modules) with a warning', () => {
    const files = new Map([
      ['app/page.tsx', 'import React from "react"\nimport clsx from "clsx"\n'],
    ])
    const result = parseCodebase(files)
    expect(result.stats.importsFound).toBe(2)
    expect(result.stats.importsResolved).toBe(0)
    expect(result.warnings.filter((w) => w.kind === 'bare_import_skipped')).toHaveLength(2)
  })

  it('logs an unresolved_import warning when target file is missing', () => {
    const files = new Map([
      ['app/page.tsx', 'import { Missing } from "../components/Missing"\n'],
    ])
    const result = parseCodebase(files)
    expect(result.warnings.some((w) => w.kind === 'unresolved_import')).toBe(true)
  })
})

describe('parseCodebase — skipping', () => {
  it('skips story, d.ts, config, and node_modules files', () => {
    const files = new Map([
      ['app/page.tsx', ''],
      ['components/Button.stories.tsx', ''],
      ['types.d.ts', ''],
      ['next.config.js', ''],
      ['node_modules/foo/index.ts', ''],
    ])
    const result = parseCodebase(files)
    expect(result.schema!.nodes).toHaveLength(1) // only app/page.tsx
    expect(result.warnings.filter((w) => w.kind === 'skipped_file').length).toBeGreaterThanOrEqual(4)
  })

  it('extracts test files rather than skipping them', () => {
    // Previously `.test.` matched SKIP_FILE_PATTERNS and was discarded,
    // leaving the Tests lens with nothing and the `test` evidence source
    // with no producer.
    const files = new Map([
      ['app/page.tsx', ''],
      ['app/page.test.tsx', `it('renders', () => {})`],
    ])
    const result = parseCodebase(files)
    const types = result.schema!.nodes.map((n) => n.type).sort()
    expect(types).toContain('test')
    expect(result.warnings.some((w) => w.kind === 'skipped_file' && w.path.includes('.test.'))).toBe(false)
  })

  it('still excludes stories, which are a rendering harness not a behaviour claim', () => {
    const files = new Map([['components/Button.stories.tsx', `it('x', () => {})`]])
    const result = parseCodebase(files)
    expect(result.schema!.nodes).toHaveLength(0)
  })
})

describe('parseCodebase — output contract', () => {
  it('tags everything with origin: auto:codebase', () => {
    const files = new Map([
      ['app/page.tsx', 'import { B } from "../components/B"\n'],
      ['components/B.tsx', ''],
    ])
    const result = parseCodebase(files)
    expect(result.schema!.nodes.every((n) => n.origin === 'auto:codebase')).toBe(true)
    expect(result.schema!.links.every((l) => l.origin === 'auto:codebase')).toBe(true)
    expect(result.schema!.meta.sources).toEqual(['auto:codebase'])
  })

  it('is deterministic across repeated runs', () => {
    const files = new Map([
      ['app/page.tsx', 'import { B } from "../components/B"\n'],
      ['components/B.tsx', ''],
    ])
    const a = parseCodebase(files).schema
    const b = parseCodebase(files).schema
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('produces a schema that passes the v1.0 validator', () => {
    const files = new Map([
      ['app/page.tsx', 'import { B } from "../components/B"\n'],
      ['components/B.tsx', ''],
    ])
    const { schema } = parseCodebase(files)
    expect(validate(schema!).ok).toBe(true)
  })
})
