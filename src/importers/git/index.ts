// ─────────────────────────────────────────────────────────────────
// Git history importer.
//
// Two responsibilities, kept separate so both stay pure:
//   parseGitLog()     — text produced by `git log` → structured commits
//   applyGitHistory() — commits + schema → schema enriched with
//                       `metadata.lastModified` and git `Evidence`
//
// This importer creates no nodes. It annotates the ones the codebase
// importer already produced, which is why it needs no new `Origin`
// value and cannot invent structure that isn't in the graph.
//
// Why this exists: relevance scoring had four of its five terms sitting
// at zero on real data, because nothing populated evidence, recency, or
// journeys. Every directly-connected node therefore scored identically
// — `1 * decayFor(type)` — and ranking inside a distance band came down
// to alphabetical order. Git is the cheapest real signal available: it
// is already in every repository, needs no configuration, and is fact
// rather than inference.
//
// Expected input format (note --name-only):
//
//   git log --pretty=format:'C|%H|%cI|%an|%s' --name-only
//
// Pure and deterministic. Reads no clock and shells out to nothing.
// ─────────────────────────────────────────────────────────────────

import type { Evidence, Node, Schema } from '@/types'

export type GitCommit = {
  hash: string
  /** ISO 8601 committer date. */
  date: string
  author: string
  subject: string
  files: string[]
}

export type GitParseWarning =
  | { kind: 'malformed_header'; line: string }
  | { kind: 'orphan_file_line'; line: string }

export type GitParseResult = {
  commits: GitCommit[]
  warnings: GitParseWarning[]
}

/** Commit header sentinel; matches the --pretty format documented above. */
const HEADER_PREFIX = 'C|'

/**
 * How many commits are recorded as evidence per node.
 *
 * Bounded because evidence is persisted with the schema and a
 * long-lived file can appear in thousands of commits. The most recent
 * few answer "how did this get here" — the rest is archaeology that
 * belongs in git itself, not in the model.
 */
export const MAX_EVIDENCE_COMMITS = 5

export function parseGitLog(raw: string): GitParseResult {
  const commits: GitCommit[] = []
  const warnings: GitParseWarning[] = []
  let current: GitCommit | null = null

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue

    if (line.startsWith(HEADER_PREFIX)) {
      // hash|date|author|subject — the subject may itself contain '|',
      // so split only the first four fields and keep the remainder.
      const rest = line.slice(HEADER_PREFIX.length)
      const parts = rest.split('|')
      if (parts.length < 3) {
        warnings.push({ kind: 'malformed_header', line })
        current = null
        continue
      }
      const [hash, date, author, ...subjectParts] = parts
      if (!hash || !date) {
        warnings.push({ kind: 'malformed_header', line })
        current = null
        continue
      }
      current = {
        hash,
        date,
        author: author ?? '',
        subject: subjectParts.join('|'),
        files: [],
      }
      commits.push(current)
      continue
    }

    if (current === null) {
      warnings.push({ kind: 'orphan_file_line', line })
      continue
    }
    current.files.push(line)
  }

  return { commits, warnings }
}

const FILE_NODE_PREFIX = 'codebase:file:'

/** The repo-relative path a node represents, or null if it represents none. */
function pathForNode(node: Node): string | null {
  if (node.id.startsWith(FILE_NODE_PREFIX)) return node.id.slice(FILE_NODE_PREFIX.length)
  return node.metadata?.filePath ?? null
}

export type GitHistoryStats = {
  commitsParsed: number
  nodesTouched: number
  /** Paths seen in history that match no node — usually deleted files. */
  unmatchedPaths: number
}

export type ApplyGitResult = {
  schema: Schema
  stats: GitHistoryStats
}

/**
 * Enrich a schema with git history.
 *
 * `commits` are expected newest-first, which is what `git log` emits.
 * The order is not re-sorted: dates in a repository can be
 * non-monotonic after rebases, and trusting the caller's ordering keeps
 * this deterministic rather than clock-dependent.
 *
 * Nodes listing `'metadata'` or `'evidence'` in `manualOverrides` keep
 * their existing values, matching how every other field is protected.
 */
export function applyGitHistory(schema: Schema, commits: readonly GitCommit[]): ApplyGitResult {
  // path → commits touching it, newest first (input order preserved).
  const byPath = new Map<string, GitCommit[]>()
  for (const commit of commits) {
    for (const file of commit.files) {
      const list = byPath.get(file)
      if (list) list.push(commit)
      else byPath.set(file, [commit])
    }
  }

  const matchedPaths = new Set<string>()
  let nodesTouched = 0

  const nodes = schema.nodes.map((node) => {
    const path = pathForNode(node)
    if (!path) return node
    const history = byPath.get(path)
    if (!history || history.length === 0) return node

    matchedPaths.add(path)
    const overrides = new Set(node.manualOverrides ?? [])
    const newest = history[0]

    const metadata =
      overrides.has('metadata')
        ? node.metadata
        : { ...node.metadata, lastModified: newest.date }

    let evidence = node.evidence
    if (!overrides.has('evidence')) {
      const gitEvidence: Evidence[] = history.slice(0, MAX_EVIDENCE_COMMITS).map((c) => ({
        source: 'git' as const,
        // That a commit touched this file is a fact, not an estimate.
        // What the change MEANT is not claimed here — the subject line
        // is recorded verbatim as the note so a reader can judge it.
        confidence: 1,
        commit: c.hash,
        note: c.subject,
        verifiedAt: c.date,
      }))
      // Preserve evidence from other sources; replace only git entries,
      // so re-importing history is idempotent rather than cumulative.
      const nonGit = (node.evidence ?? []).filter((e) => e.source !== 'git')
      evidence = [...nonGit, ...gitEvidence]
    }

    nodesTouched++
    return { ...node, metadata, evidence }
  })

  let unmatchedPaths = 0
  for (const path of byPath.keys()) if (!matchedPaths.has(path)) unmatchedPaths++

  return {
    schema: { ...schema, nodes },
    stats: { commitsParsed: commits.length, nodesTouched, unmatchedPaths },
  }
}

/**
 * Distinct authors per path, newest-first order preserved.
 *
 * Not applied to the schema — ownership is a separate concern from
 * relevance, and `Node.owner` is user-authored. Exposed because the
 * History lens needs it and recomputing it elsewhere would duplicate
 * the traversal.
 */
export function authorsByPath(commits: readonly GitCommit[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const commit of commits) {
    if (!commit.author) continue
    for (const file of commit.files) {
      const list = out.get(file) ?? []
      if (!list.includes(commit.author)) list.push(commit.author)
      out.set(file, list)
    }
  }
  return out
}
