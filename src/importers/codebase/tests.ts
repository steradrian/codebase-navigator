// ─────────────────────────────────────────────────────────────────
// Test extraction.
//
// Test files were previously dropped at the door: `SKIP_FILE_PATTERNS`
// matched `.test.` / `.spec.` / `.stories.` and emitted a skipped_file
// warning. That left the Tests lens with nothing to show and the `test`
// evidence source with no producer, even though tests are the single
// most reliable statement a codebase makes about its own behaviour.
//
// A test is treated as evidence ABOUT its subject, not merely as another
// file. That distinction is what lets the Tests lens answer "how do we
// know this works", and what lets evidence-weighted lenses rank a
// well-tested entity above an untested one.
//
// Subject resolution is deliberately conservative — naming convention
// first, then a single unambiguous relative import. A test that imports
// six modules is not claimed to test all six; over-claiming coverage is
// worse than reporting none, because it silently converts "untested" into
// "tested" in exactly the view a reader consults to find gaps.
//
// Pure and deterministic.
// ─────────────────────────────────────────────────────────────────

import type { Evidence, Link, Node } from '@/types'
import { CODE_EXT, extractImports, norm, resolveImport } from '@/importers/codebase/resolve'

/** Files that are tests rather than product code. */
export const TEST_FILE_PATTERNS = [/\.test\./, /\.spec\./] as const

/** Link type connecting a test to the thing it verifies. */
export const TESTS_LINK_TYPE = 'tests'

export type TestWarning =
  | { kind: 'test_subject_unresolved'; test: string }
  | { kind: 'test_subject_ambiguous'; test: string; candidates: number }

export type TestExtractionResult = {
  nodes: Node[]
  links: Link[]
  /** Evidence to attach to each subject node, keyed by its file path. */
  evidenceBySubject: Map<string, Evidence[]>
  warnings: TestWarning[]
  stats: { testFiles: number; casesFound: number; subjectsResolved: number }
}

export const isTestFile = (path: string): boolean =>
  TEST_FILE_PATTERNS.some((re) => re.test(norm(path)))

export const testNodeId = (path: string): string => `codebase:test:${norm(path)}`

/**
 * Scenario declarations, in two forms.
 *
 * The first alternative handles table-driven tests, where the name comes
 * after an intermediate argument list — `it.each([...])('case %s', ...)`.
 * The second handles the ordinary form and its `.only` / `.skip` / `.todo`
 * modifiers. Table-driven cases are common enough that missing them
 * would understate coverage in exactly the view built to reveal gaps.
 *
 * `describe` is deliberately excluded: a group is not a scenario.
 */
const TEST_CASE_RE = new RegExp(
  [
    String.raw`\b(?:it|test)\.each\s*(?:\([\s\S]*?\)|\x60[\s\S]*?\x60)\s*\(\s*['"\x60]([^'"\x60]+)['"\x60]`,
    String.raw`\b(?:it|test)(?:\.\w+)*\s*\(\s*['"\x60]([^'"\x60]+)['"\x60]`,
  ].join('|'),
  'g',
)

/** Scenario names declared in a test file, in source order, deduplicated. */
export function extractTestCases(source: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  TEST_CASE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TEST_CASE_RE.exec(source)) !== null) {
    const name = (m[1] ?? m[2] ?? '').trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * The path a test file is named after, if that file exists.
 *
 * `wallet/deposit.test.ts` → `wallet/deposit.ts`. The extension is not
 * assumed to match: a `.test.ts` may cover a `.tsx` component.
 */
function subjectByNaming(testPath: string, fileSet: ReadonlySet<string>): string | null {
  const p = norm(testPath)
  const stripped = p.replace(/\.(test|spec)\./, '.')
  if (stripped === p) return null

  if (fileSet.has(stripped)) return stripped

  const withoutExt = stripped.replace(CODE_EXT, '')
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = `${withoutExt}${ext}`
    if (fileSet.has(candidate)) return candidate
  }
  // A test named after a directory's entry point, e.g. foo/index.test.ts.
  return null
}

/**
 * Resolve what a test verifies.
 *
 * Naming convention wins outright. Otherwise a single resolvable relative
 * import is accepted as the subject; more than one is reported as
 * ambiguous rather than guessed at, since attributing a test to the wrong
 * subject makes an untested entity look covered.
 */
export function resolveTestSubject(
  testPath: string,
  source: string,
  fileSet: ReadonlySet<string>,
): { subject: string | null; ambiguous: number } {
  const named = subjectByNaming(testPath, fileSet)
  if (named) return { subject: named, ambiguous: 0 }

  const candidates = new Set<string>()
  for (const spec of extractImports(source)) {
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) continue
    const resolved = resolveImport(spec, testPath, fileSet)
    if (resolved && !isTestFile(resolved)) candidates.add(resolved)
  }

  if (candidates.size === 1) return { subject: [...candidates][0], ambiguous: 0 }
  return { subject: null, ambiguous: candidates.size }
}

/**
 * Build test nodes, their links to subjects, and the evidence each test
 * contributes to the thing it verifies.
 *
 * `files` should contain test files; `productFileSet` is the set of
 * non-test paths that already have nodes, used for subject resolution.
 */
export function extractTests(
  files: ReadonlyMap<string, string>,
  productFileSet: ReadonlySet<string>,
): TestExtractionResult {
  const nodes: Node[] = []
  const links: Link[] = []
  const evidenceBySubject = new Map<string, Evidence[]>()
  const warnings: TestWarning[] = []
  let casesFound = 0
  let subjectsResolved = 0
  let testFiles = 0

  // Sorted so output does not depend on file-read order.
  const testPaths = [...files.keys()].filter(isTestFile).sort()

  for (const testPath of testPaths) {
    const source = files.get(testPath) ?? ''
    testFiles++

    const cases = extractTestCases(source)
    casesFound += cases.length
    const leaf = norm(testPath).split('/').pop() ?? testPath

    const { subject, ambiguous } = resolveTestSubject(testPath, source, productFileSet)

    nodes.push({
      id: testNodeId(testPath),
      name: leaf,
      type: 'test',
      description:
        cases.length > 0
          ? `${cases.length} test case${cases.length === 1 ? '' : 's'} in ${leaf}`
          : `Test file ${leaf}`,
      origin: 'auto:codebase',
      group: 'tests',
      metadata: { filePath: norm(testPath), testCases: cases },
    })

    if (!subject) {
      if (ambiguous > 1) {
        warnings.push({ kind: 'test_subject_ambiguous', test: norm(testPath), candidates: ambiguous })
      } else {
        warnings.push({ kind: 'test_subject_unresolved', test: norm(testPath) })
      }
      continue
    }

    subjectsResolved++
    links.push({
      id: `${testNodeId(testPath)}__${TESTS_LINK_TYPE}__codebase:file:${subject}`,
      source: testNodeId(testPath),
      target: `codebase:file:${subject}`,
      label: 'tests',
      description: `${leaf} verifies ${subject}.`,
      type: TESTS_LINK_TYPE,
      origin: 'auto:codebase',
      evidence: [{ source: 'test', confidence: 1, file: norm(testPath) }],
    })

    // The subject gains test-derived evidence. This is what makes an
    // entity rank as better-understood under evidence-weighted lenses
    // than an identical entity nobody has tested.
    const existing = evidenceBySubject.get(subject) ?? []
    existing.push({
      source: 'test',
      confidence: 1,
      file: norm(testPath),
      note:
        cases.length > 0
          ? `Verified by ${cases.length} test case${cases.length === 1 ? '' : 's'} in ${leaf}`
          : `Verified by ${leaf}`,
    })
    evidenceBySubject.set(subject, existing)
  }

  return {
    nodes,
    links,
    evidenceBySubject,
    warnings,
    stats: { testFiles, casesFound, subjectsResolved },
  }
}
