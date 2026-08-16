import { describe, expect, it } from 'vitest'
import type { Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import {
  MAX_EVIDENCE_COMMITS,
  applyGitHistory,
  authorsByPath,
  parseGitLog,
} from '@/importers/git'

const LOG = [
  'C|aaa111|2026-08-10T10:00:00Z|Ada|feat: add deposit flow',
  'src/wallet/deposit.ts',
  'src/wallet/index.ts',
  '',
  'C|bbb222|2026-06-01T09:00:00Z|Lin|fix: correct rounding',
  'src/wallet/deposit.ts',
  '',
  'C|ccc333|2026-01-15T08:00:00Z|Ada|chore: tidy',
  'src/legacy/removed.ts',
].join('\n')

const mkNode = (id: string, over: Partial<Node> = {}): Node => ({
  id, name: id, type: 'component', description: '', origin: 'auto:codebase', ...over,
})

const mkSchema = (nodes: Node[]): Schema => ({
  meta: { name: 'G', version: SCHEMA_VERSION },
  nodeTypes: {}, linkTypes: {},
  nodes, links: [], paths: [], journeys: [], annotations: [],
})

describe('parseGitLog', () => {
  it('parses commits with their file lists', () => {
    const { commits } = parseGitLog(LOG)
    expect(commits).toHaveLength(3)
    expect(commits[0]).toMatchObject({ hash: 'aaa111', author: 'Ada', subject: 'feat: add deposit flow' })
    expect(commits[0].files).toEqual(['src/wallet/deposit.ts', 'src/wallet/index.ts'])
  })

  it('preserves newest-first order as git emits it', () => {
    expect(parseGitLog(LOG).commits.map((c) => c.hash)).toEqual(['aaa111', 'bbb222', 'ccc333'])
  })

  it('keeps a subject containing the field separator intact', () => {
    const { commits } = parseGitLog('C|h1|2026-01-01T00:00:00Z|Ada|fix: a|b parsing\nsrc/a.ts')
    expect(commits[0].subject).toBe('fix: a|b parsing')
  })

  it('handles an empty log', () => {
    expect(parseGitLog('').commits).toEqual([])
  })

  it('handles a commit that touched no files', () => {
    const { commits } = parseGitLog('C|h1|2026-01-01T00:00:00Z|Ada|empty')
    expect(commits[0].files).toEqual([])
  })

  it('warns on a malformed header rather than fabricating a commit', () => {
    const { commits, warnings } = parseGitLog('C|broken\nsrc/a.ts')
    expect(commits).toEqual([])
    expect(warnings.some((w) => w.kind === 'malformed_header')).toBe(true)
  })

  it('warns on file lines appearing before any commit header', () => {
    const { warnings } = parseGitLog('src/orphan.ts\nC|h1|2026-01-01T00:00:00Z|Ada|s')
    expect(warnings.some((w) => w.kind === 'orphan_file_line')).toBe(true)
  })

  it('does not attach a malformed commit’s files to the previous commit', () => {
    const raw = 'C|h1|2026-01-01T00:00:00Z|Ada|first\nsrc/a.ts\nC|bad\nsrc/should-not-attach.ts'
    const { commits } = parseGitLog(raw)
    expect(commits[0].files).toEqual(['src/a.ts'])
  })
})

describe('applyGitHistory', () => {
  const commits = parseGitLog(LOG).commits
  const schema = () =>
    mkSchema([
      mkNode('codebase:file:src/wallet/deposit.ts'),
      mkNode('codebase:file:src/wallet/index.ts'),
      mkNode('openapi:op:get:api_player'),
    ])

  it('sets lastModified from the newest commit touching the file', () => {
    const { schema: s } = applyGitHistory(schema(), commits)
    const n = s.nodes.find((x) => x.id === 'codebase:file:src/wallet/deposit.ts')
    expect(n?.metadata?.lastModified).toBe('2026-08-10T10:00:00Z')
  })

  it('records git evidence with the commit hash and subject verbatim', () => {
    const { schema: s } = applyGitHistory(schema(), commits)
    const n = s.nodes.find((x) => x.id === 'codebase:file:src/wallet/deposit.ts')
    expect(n?.evidence?.[0]).toMatchObject({
      source: 'git', commit: 'aaa111', note: 'feat: add deposit flow', confidence: 1,
    })
  })

  it('records every commit that touched the file, newest first', () => {
    const { schema: s } = applyGitHistory(schema(), commits)
    const n = s.nodes.find((x) => x.id === 'codebase:file:src/wallet/deposit.ts')
    expect(n?.evidence?.map((e) => e.commit)).toEqual(['aaa111', 'bbb222'])
  })

  it('leaves nodes with no history untouched', () => {
    const { schema: s } = applyGitHistory(schema(), commits)
    const n = s.nodes.find((x) => x.id === 'openapi:op:get:api_player')
    expect(n?.evidence).toBeUndefined()
    expect(n?.metadata?.lastModified).toBeUndefined()
  })

  it('counts history paths matching no node as unmatched', () => {
    const { stats } = applyGitHistory(schema(), commits)
    // src/legacy/removed.ts has no node — a deleted file.
    expect(stats.unmatchedPaths).toBe(1)
    expect(stats.nodesTouched).toBe(2)
  })

  it('is idempotent — re-importing does not duplicate git evidence', () => {
    const once = applyGitHistory(schema(), commits).schema
    const twice = applyGitHistory(once, commits).schema
    expect(twice.nodes).toEqual(once.nodes)
  })

  it('preserves evidence from other sources while replacing git entries', () => {
    const s = mkSchema([
      mkNode('codebase:file:src/wallet/deposit.ts', {
        evidence: [{ source: 'documentation', note: 'ADR-3' }],
      }),
    ])
    const out = applyGitHistory(s, commits).schema.nodes[0]
    expect(out.evidence?.some((e) => e.source === 'documentation')).toBe(true)
    expect(out.evidence?.some((e) => e.source === 'git')).toBe(true)
  })

  it('caps evidence per node', () => {
    const many = Array.from({ length: MAX_EVIDENCE_COMMITS + 4 }, (_, i) =>
      `C|h${i}|2026-0${(i % 9) + 1}-01T00:00:00Z|Ada|c${i}\nsrc/a.ts`).join('\n')
    const s = mkSchema([mkNode('codebase:file:src/a.ts')])
    const out = applyGitHistory(s, parseGitLog(many).commits).schema.nodes[0]
    expect(out.evidence).toHaveLength(MAX_EVIDENCE_COMMITS)
  })

  it('respects a manual override on metadata', () => {
    const s = mkSchema([
      mkNode('codebase:file:src/wallet/deposit.ts', {
        metadata: { lastModified: '1999-01-01T00:00:00Z' },
        manualOverrides: ['metadata'],
      }),
    ])
    const out = applyGitHistory(s, commits).schema.nodes[0]
    expect(out.metadata?.lastModified).toBe('1999-01-01T00:00:00Z')
  })

  it('respects a manual override on evidence', () => {
    const s = mkSchema([
      mkNode('codebase:file:src/wallet/deposit.ts', {
        evidence: [{ source: 'human', note: 'verified by hand' }],
        manualOverrides: ['evidence'],
      }),
    ])
    const out = applyGitHistory(s, commits).schema.nodes[0]
    expect(out.evidence).toEqual([{ source: 'human', note: 'verified by hand' }])
  })

  it('matches a node via metadata.filePath when the id is not path-derived', () => {
    const s = mkSchema([mkNode('custom:node:1', { metadata: { filePath: 'src/wallet/deposit.ts' } })])
    const out = applyGitHistory(s, commits).schema.nodes[0]
    expect(out.metadata?.lastModified).toBe('2026-08-10T10:00:00Z')
  })

  it('does not mutate the input schema', () => {
    const s = schema()
    const before = JSON.stringify(s)
    applyGitHistory(s, commits)
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('authorsByPath', () => {
  it('lists distinct authors per path, newest first', () => {
    const map = authorsByPath(parseGitLog(LOG).commits)
    expect(map.get('src/wallet/deposit.ts')).toEqual(['Ada', 'Lin'])
  })

  it('omits commits with no author', () => {
    const map = authorsByPath(parseGitLog('C|h|2026-01-01T00:00:00Z||subject\nsrc/a.ts').commits)
    expect(map.get('src/a.ts')).toBeUndefined()
  })
})
