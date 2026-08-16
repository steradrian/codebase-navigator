// ─────────────────────────────────────────────────────────────────
// Documentation importer.
//
// The Why lens asks "why does this exist, and why does it behave this
// way". Until now it had almost nothing: `.md` was rejected at the
// file-read boundary, so ADRs, READMEs and design notes were never seen,
// and the `documentation` evidence source had no producer. The only
// rationale in the system was git commit subject lines.
//
// The important output here is not the document nodes. It is the
// `documentation` evidence attached to the entities a document actually
// describes — that is what the Why lens reads, and it is independent of
// whatever zoom tier the reader happens to be at.
//
// References are resolved by explicit file path only. A document that
// says `src/wallet/deposit.ts` is making a checkable claim about that
// file; a document that merely uses the word "deposit" is not. Matching
// on prose would manufacture rationale for entities nobody documented,
// which is the precise failure the evidence model exists to prevent.
//
// Pure and deterministic.
// ─────────────────────────────────────────────────────────────────

import type { Evidence, Link, Node } from '@/types'

export const DOC_EXT = /\.(md|mdx|markdown)$/i

export type DocWarning = { kind: 'doc_references_nothing'; path: string }

export type DocsParseResult = {
  nodes: Node[]
  links: Link[]
  /** Evidence to attach to each referenced node, keyed by its file path. */
  evidenceBySubject: Map<string, Evidence[]>
  warnings: DocWarning[]
  stats: { docs: number; decisions: number; references: number }
}

/** Link type connecting a document to something it describes. */
export const DOCUMENTS_LINK_TYPE = 'documents'

export const isDocFile = (path: string): boolean => DOC_EXT.test(path)

export const docNodeId = (path: string): string => `docs:file:${path}`

/** Paths conventionally holding architecture decision records. */
const DECISION_DIR_RE = /(^|\/)(adr|adrs|decisions|architecture-decisions)(\/|$)/i
const DECISION_TITLE_RE = /^ADR[\s-]?\d+/i
// An ADR's defining feature is a recorded status, not its folder.
const DECISION_STATUS_RE = /^\s*#{1,4}\s*status\s*$/im

/**
 * Whether a document records a decision rather than describing usage.
 *
 * The distinction matters to the Why lens: "we chose Redis because of
 * X, and that decision is Accepted" is a different kind of claim from
 * "here is how to run the app", and presenting them identically would
 * flatten rationale into documentation.
 */
export function isDecisionRecord(path: string, title: string, source: string): boolean {
  if (DECISION_DIR_RE.test(path)) return true
  if (DECISION_TITLE_RE.test(title)) return true
  return DECISION_STATUS_RE.test(source)
}

/**
 * Source with fenced code blocks removed.
 *
 * Shell snippets routinely contain `# comment` lines, which are
 * indistinguishable from markdown headings once the fence is ignored. A
 * README documenting `npm run dev` / `# or` / `yarn dev` and carrying no
 * real heading otherwise yields a document titled "or".
 */
function stripFences(source: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (!inFence) out.push(line)
  }
  return out.join('\n')
}

/** First markdown heading, or the filename when the document has none. */
export function extractTitle(path: string, source: string): string {
  const heading = stripFences(source).match(/^\s*#\s+(.+?)\s*$/m)
  if (heading) return heading[1].trim()
  return (path.split('/').pop() ?? path).replace(DOC_EXT, '')
}

/**
 * First prose paragraph, used as the document's description.
 *
 * Headings, code fences, list markers and blockquotes are skipped so the
 * summary reads as a sentence rather than as fragments of structure.
 */
export function extractSummary(source: string, maxLength = 280): string {
  const lines = source.split('\n')
  let inFence = false
  const paragraph: string[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (/^```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (line === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (/^#{1,6}\s/.test(line)) continue
    if (/^[-*+>]\s/.test(line)) continue
    if (/^\|/.test(line)) continue
    paragraph.push(line)
  }

  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

// Anything that looks like a repo-relative source path, with or without
// surrounding backticks, parentheses or quotes.
const PATH_RE = /[\w./-]*[\w-]+\/[\w./-]*\.(?:tsx?|jsx?|mjs|cjs|go|py|rs)\b/g

/**
 * Source files a document explicitly names, restricted to paths that
 * actually exist in the graph.
 *
 * A mention of a file that was deleted or never existed is dropped
 * rather than recorded, so documentation cannot vouch for something the
 * codebase does not contain.
 */
export function extractReferencedPaths(
  source: string,
  knownPaths: ReadonlySet<string>,
): string[] {
  const found = new Set<string>()
  PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_RE.exec(source)) !== null) {
    const raw = m[0].replace(/^\.\//, '')
    if (knownPaths.has(raw)) { found.add(raw); continue }
    // Documents commonly omit a leading `src/`.
    const prefixed = `src/${raw}`
    if (knownPaths.has(prefixed)) found.add(prefixed)
  }
  return [...found].sort()
}

/**
 * Parse markdown into document nodes, links to what they describe, and
 * documentation evidence for those subjects.
 *
 * `knownPaths` is the set of source-file paths already present in the
 * graph; only references resolving into it are recorded.
 */
export function parseDocs(
  files: ReadonlyMap<string, string>,
  knownPaths: ReadonlySet<string>,
): DocsParseResult {
  const nodes: Node[] = []
  const links: Link[] = []
  const evidenceBySubject = new Map<string, Evidence[]>()
  const warnings: DocWarning[] = []
  let decisions = 0
  let references = 0

  const docPaths = [...files.keys()].filter(isDocFile).sort()

  for (const path of docPaths) {
    const source = files.get(path) ?? ''
    const title = extractTitle(path, source)
    const summary = extractSummary(source)
    const decision = isDecisionRecord(path, title, source)
    if (decision) decisions++

    const id = docNodeId(path)
    nodes.push({
      id,
      name: title,
      type: decision ? 'decision' : 'document',
      description: summary || `Documentation file ${path}`,
      origin: 'auto:codebase',
      group: 'docs',
      metadata: { filePath: path },
    })

    const referenced = extractReferencedPaths(source, knownPaths)
    if (referenced.length === 0) {
      warnings.push({ kind: 'doc_references_nothing', path })
      continue
    }

    for (const target of referenced) {
      references++
      links.push({
        id: `${id}__${DOCUMENTS_LINK_TYPE}__codebase:file:${target}`,
        source: id,
        target: `codebase:file:${target}`,
        label: decision ? 'decides' : 'documents',
        description: `${title} refers to ${target}.`,
        type: DOCUMENTS_LINK_TYPE,
        origin: 'auto:codebase',
        evidence: [{ source: 'documentation', file: path, confidence: 1 }],
      })

      const existing = evidenceBySubject.get(target) ?? []
      existing.push({
        source: 'documentation',
        // The reference is explicit and checkable; whether the prose is
        // still true is a staleness question, not a confidence one.
        confidence: 1,
        file: path,
        note: decision ? `Decision: ${title}` : title,
      })
      evidenceBySubject.set(target, existing)
    }
  }

  return {
    nodes,
    links,
    evidenceBySubject,
    warnings,
    stats: { docs: docPaths.length, decisions, references },
  }
}
