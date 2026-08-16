import { describe, expect, it } from 'vitest'
import {
  DOCUMENTS_LINK_TYPE,
  docNodeId,
  extractReferencedPaths,
  extractSummary,
  extractTitle,
  isDecisionRecord,
  isDocFile,
  parseDocs,
} from '@/importers/docs'

describe('isDocFile', () => {
  it('recognises markdown variants', () => {
    expect(isDocFile('README.md')).toBe(true)
    expect(isDocFile('docs/a.mdx')).toBe(true)
    expect(isDocFile('src/a.ts')).toBe(false)
  })
})

describe('extractTitle', () => {
  it('uses the first heading', () => {
    expect(extractTitle('docs/a.md', '# Session handling\n\ntext')).toBe('Session handling')
  })

  it('falls back to the filename when there is no heading', () => {
    expect(extractTitle('docs/session-notes.md', 'no heading here')).toBe('session-notes')
  })

  it('ignores a heading inside a code fence appearing later', () => {
    expect(extractTitle('docs/a.md', '# Real title\n\n```\n# not a title\n```')).toBe('Real title')
  })

  it('does not mistake a shell comment for the only heading', () => {
    // casino-frontend's README has no heading at all, and its first `#`
    // is a shell comment inside a bash fence — which produced a document
    // titled "or". The earlier fence test passed only because a real
    // heading happened to come first.
    const readme = [
      'This is a Next.js project.',
      '',
      '```bash',
      'npm run dev',
      '# or',
      'yarn dev',
      '```',
    ].join('\n')
    expect(extractTitle('README.md', readme)).toBe('README')
  })
})

describe('extractSummary', () => {
  it('takes the first prose paragraph', () => {
    const src = '# Title\n\nDeposits are validated before submission.\n\nSecond para.'
    expect(extractSummary(src)).toBe('Deposits are validated before submission.')
  })

  it('skips code fences, lists and tables', () => {
    const src = '# T\n\n```ts\nconst x = 1\n```\n\n- a bullet\n\n| col |\n\nActual prose here.'
    expect(extractSummary(src)).toBe('Actual prose here.')
  })

  it('truncates long prose with an ellipsis', () => {
    const src = `# T\n\n${'word '.repeat(200)}`
    const summary = extractSummary(src, 50)
    expect(summary.length).toBeLessThanOrEqual(50)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('returns empty string for a document with no prose', () => {
    expect(extractSummary('# Only a title')).toBe('')
  })
})

describe('isDecisionRecord', () => {
  it('recognises an adr directory', () => {
    expect(isDecisionRecord('docs/adr/0001-use-redis.md', 'Use Redis', '')).toBe(true)
    expect(isDecisionRecord('docs/decisions/x.md', 'X', '')).toBe(true)
  })

  it('recognises a numbered ADR title', () => {
    expect(isDecisionRecord('notes/x.md', 'ADR-14 Session storage', '')).toBe(true)
  })

  it('recognises a recorded status section', () => {
    // A recorded status is what makes a document a decision, whatever
    // folder it happens to live in.
    expect(isDecisionRecord('notes/x.md', 'Session storage', '## Status\n\nAccepted')).toBe(true)
  })

  it('treats ordinary documentation as documentation', () => {
    expect(isDecisionRecord('docs/testing-guide.md', 'Testing guide', 'How to run tests')).toBe(false)
  })
})

describe('extractReferencedPaths', () => {
  const known = new Set(['src/wallet/deposit.ts', 'src/ui/Button.tsx'])

  it('finds paths mentioned in prose or backticks', () => {
    const src = 'See `src/wallet/deposit.ts` and src/ui/Button.tsx for details.'
    expect(extractReferencedPaths(src, known)).toEqual(['src/ui/Button.tsx', 'src/wallet/deposit.ts'])
  })

  it('resolves a path written without its src prefix', () => {
    expect(extractReferencedPaths('see wallet/deposit.ts', known)).toEqual(['src/wallet/deposit.ts'])
  })

  it('strips a leading ./', () => {
    expect(extractReferencedPaths('see ./src/wallet/deposit.ts', known)).toEqual(['src/wallet/deposit.ts'])
  })

  it('drops references to files that do not exist', () => {
    // Documentation must not vouch for something the codebase lacks.
    expect(extractReferencedPaths('see src/gone/removed.ts', known)).toEqual([])
  })

  it('does not match prose that merely names a concept', () => {
    // "deposit" is not a claim about src/wallet/deposit.ts.
    expect(extractReferencedPaths('The deposit flow validates input.', known)).toEqual([])
  })

  it('deduplicates repeated mentions', () => {
    const src = 'src/wallet/deposit.ts and again src/wallet/deposit.ts'
    expect(extractReferencedPaths(src, known)).toEqual(['src/wallet/deposit.ts'])
  })
})

describe('parseDocs', () => {
  const known = new Set(['src/wallet/deposit.ts'])
  const run = (path: string, source: string) => parseDocs(new Map([[path, source]]), known)

  it('emits a document node with title and summary', () => {
    const r = run('docs/deposits.md', '# Deposits\n\nHow deposits work.\n\nsrc/wallet/deposit.ts')
    expect(r.nodes[0]).toMatchObject({
      id: docNodeId('docs/deposits.md'),
      type: 'document',
      name: 'Deposits',
      description: 'How deposits work.',
    })
  })

  it('marks a decision record distinctly from documentation', () => {
    const r = run('docs/adr/0001-redis.md', '# Use Redis\n\nBecause X.\n\nsrc/wallet/deposit.ts')
    expect(r.nodes[0].type).toBe('decision')
    expect(r.stats.decisions).toBe(1)
  })

  it('links a document to the files it names', () => {
    const r = run('docs/deposits.md', '# D\n\nsee src/wallet/deposit.ts')
    expect(r.links[0]).toMatchObject({
      source: docNodeId('docs/deposits.md'),
      target: 'codebase:file:src/wallet/deposit.ts',
      type: DOCUMENTS_LINK_TYPE,
      label: 'documents',
    })
  })

  it('labels a decision link as deciding rather than documenting', () => {
    const r = run('docs/adr/1.md', '# ADR-1 X\n\nsrc/wallet/deposit.ts')
    expect(r.links[0].label).toBe('decides')
  })

  it('contributes documentation evidence to the referenced entity', () => {
    // This is what the Why lens actually reads.
    const r = run('docs/deposits.md', '# Deposits\n\nsrc/wallet/deposit.ts')
    expect(r.evidenceBySubject.get('src/wallet/deposit.ts')?.[0]).toMatchObject({
      source: 'documentation', file: 'docs/deposits.md', note: 'Deposits',
    })
  })

  it('marks decision evidence so rationale is distinguishable from usage docs', () => {
    const r = run('docs/adr/1.md', '# ADR-1 Use Redis\n\nsrc/wallet/deposit.ts')
    expect(r.evidenceBySubject.get('src/wallet/deposit.ts')?.[0].note)
      .toBe('Decision: ADR-1 Use Redis')
  })

  it('warns about a document that references nothing checkable', () => {
    const r = run('README.md', '# Project\n\nWelcome.')
    expect(r.links).toEqual([])
    expect(r.warnings).toContainEqual({ kind: 'doc_references_nothing', path: 'README.md' })
  })

  it('still emits a node for an unreferencing document so it stays findable', () => {
    expect(run('README.md', '# Project').nodes).toHaveLength(1)
  })

  it('is deterministic regardless of map order', () => {
    const a = parseDocs(new Map([['b.md', '# B'], ['a.md', '# A']]), known)
    const b = parseDocs(new Map([['a.md', '# A'], ['b.md', '# B']]), known)
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes))
  })
})
