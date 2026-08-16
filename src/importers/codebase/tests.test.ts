import { describe, expect, it } from 'vitest'
import {
  TESTS_LINK_TYPE,
  extractTestCases,
  extractTests,
  isTestFile,
  resolveTestSubject,
  testNodeId,
} from '@/importers/codebase/tests'

describe('isTestFile', () => {
  it('recognises the conventional suffixes', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true)
    expect(isTestFile('src/a.spec.tsx')).toBe(true)
  })

  it('does not treat stories or product code as tests', () => {
    expect(isTestFile('src/Button.stories.tsx')).toBe(false)
    expect(isTestFile('src/latest.ts')).toBe(false)
  })
})

describe('extractTestCases', () => {
  it('collects scenario names from it and test', () => {
    const src = `
      it('creates a session', () => {})
      test("rejects an expired token", () => {})
    `
    expect(extractTestCases(src)).toEqual(['creates a session', 'rejects an expired token'])
  })

  it('handles the .each / .only / .skip variants', () => {
    const src = `it.each([1])('case %s', () => {}); test.skip('later', () => {})`
    expect(extractTestCases(src)).toEqual(['case %s', 'later'])
  })

  it('deduplicates and preserves source order', () => {
    const src = `it('a', ()=>{}); it('b', ()=>{}); it('a', ()=>{})`
    expect(extractTestCases(src)).toEqual(['a', 'b'])
  })

  it('returns nothing for a file with no cases', () => {
    expect(extractTestCases('export const x = 1')).toEqual([])
  })

  it('does not match describe blocks as cases', () => {
    expect(extractTestCases(`describe('a group', () => {})`)).toEqual([])
  })
})

describe('resolveTestSubject', () => {
  const files = new Set(['src/wallet/deposit.ts', 'src/ui/Button.tsx', 'src/other.ts'])

  it('resolves by naming convention', () => {
    expect(resolveTestSubject('src/wallet/deposit.test.ts', '', files).subject)
      .toBe('src/wallet/deposit.ts')
  })

  it('resolves a .test.ts covering a .tsx component', () => {
    expect(resolveTestSubject('src/ui/Button.test.ts', '', files).subject)
      .toBe('src/ui/Button.tsx')
  })

  it('falls back to a single unambiguous relative import', () => {
    const src = `import { deposit } from './wallet/deposit'`
    expect(resolveTestSubject('src/checkout.test.ts', src, files).subject)
      .toBe('src/wallet/deposit.ts')
  })

  it('refuses to guess when a test imports several modules', () => {
    // Attributing a test to the wrong subject converts "untested" into
    // "tested" in exactly the view a reader consults to find gaps.
    const src = `
      import { deposit } from './wallet/deposit'
      import { Button } from './ui/Button'
    `
    const r = resolveTestSubject('src/checkout.test.ts', src, files)
    expect(r.subject).toBeNull()
    expect(r.ambiguous).toBe(2)
  })

  it('ignores imports of other test files', () => {
    const withHelper = new Set([...files, 'src/helpers.test.ts'])
    const src = `import { mk } from './helpers.test'`
    expect(resolveTestSubject('src/a.test.ts', src, withHelper).subject).toBeNull()
  })
})

describe('extractTests', () => {
  const productFiles = new Set(['src/wallet/deposit.ts'])
  const run = (source: string, path = 'src/wallet/deposit.test.ts') =>
    extractTests(new Map([[path, source]]), productFiles)

  const SRC = `
    it('accepts a valid deposit', () => {})
    it('rejects a negative amount', () => {})
  `

  it('emits a test node carrying its scenario names', () => {
    const r = run(SRC)
    expect(r.nodes).toHaveLength(1)
    expect(r.nodes[0]).toMatchObject({ type: 'test', name: 'deposit.test.ts' })
    expect(r.nodes[0].metadata?.testCases).toEqual([
      'accepts a valid deposit', 'rejects a negative amount',
    ])
  })

  it('links the test to the file it verifies', () => {
    const r = run(SRC)
    expect(r.links[0]).toMatchObject({
      source: testNodeId('src/wallet/deposit.test.ts'),
      target: 'codebase:file:src/wallet/deposit.ts',
      type: TESTS_LINK_TYPE,
    })
  })

  it('contributes test evidence to the subject, not just to itself', () => {
    // This is what makes a tested entity rank above an identical
    // untested one under evidence-weighted lenses.
    const r = run(SRC)
    const evidence = r.evidenceBySubject.get('src/wallet/deposit.ts')
    expect(evidence?.[0]).toMatchObject({ source: 'test', confidence: 1 })
    expect(evidence?.[0].note).toContain('2 test cases')
  })

  it('accumulates evidence when several tests cover one subject', () => {
    const r = extractTests(
      new Map([
        ['src/wallet/deposit.test.ts', `it('a', ()=>{})`],
        ['src/wallet/deposit.spec.ts', `it('b', ()=>{})`],
      ]),
      productFiles,
    )
    expect(r.evidenceBySubject.get('src/wallet/deposit.ts')).toHaveLength(2)
  })

  it('warns when a subject cannot be resolved rather than inventing one', () => {
    const r = extractTests(new Map([['src/orphan.test.ts', `it('x', ()=>{})`]]), productFiles)
    expect(r.links).toEqual([])
    expect(r.warnings).toContainEqual({ kind: 'test_subject_unresolved', test: 'src/orphan.test.ts' })
  })

  it('warns distinctly when the subject is ambiguous', () => {
    const files = new Set(['src/a.ts', 'src/b.ts'])
    const src = `import './a'\nimport './b'`
    const r = extractTests(new Map([['src/x.test.ts', src]]), files)
    expect(r.warnings).toContainEqual({
      kind: 'test_subject_ambiguous', test: 'src/x.test.ts', candidates: 2,
    })
  })

  it('still emits a node for an unresolved test so it is not invisible', () => {
    const r = extractTests(new Map([['src/orphan.test.ts', '']]), productFiles)
    expect(r.nodes).toHaveLength(1)
  })

  it('reports stats', () => {
    const r = run(SRC)
    expect(r.stats).toEqual({ testFiles: 1, casesFound: 2, subjectsResolved: 1 })
  })

  it('is deterministic regardless of map order', () => {
    const a = extractTests(new Map([['src/b.test.ts', ''], ['src/a.test.ts', '']]), productFiles)
    const b = extractTests(new Map([['src/a.test.ts', ''], ['src/b.test.ts', '']]), productFiles)
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes))
  })
})
