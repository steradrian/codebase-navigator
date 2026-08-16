// ─────────────────────────────────────────────────────────────────
// Entity search.
//
// Results are grouped by what kind of thing they are, because a developer
// searching "session" is usually looking for one particular sense of the
// word and needs to see the alternatives to pick.
//
// That is also why ambiguity is a first-class result rather than a
// ranking problem. The spec's own example — "Session" could mean the
// Session domain, the Session model, SessionStore, useSession, or
// /api/session — is not solved by putting one of them first. Guessing
// silently sends the reader down the wrong branch with no signal that a
// choice was ever made, so when several distinct kinds of thing match a
// term equally well, the response says so and lets the reader choose.
//
// Pure and deterministic.
// ─────────────────────────────────────────────────────────────────

import type { Node, Schema } from '@/types'

export type SearchGroup =
  | 'domains'
  | 'behavior'
  | 'outcomes'
  | 'system'
  | 'code'
  | 'tests'
  | 'docs'
  | 'other'

export type SearchResult = {
  id: string
  name: string
  type: string
  group: SearchGroup
  altitude: Node['altitude']
  domain?: string
  entity?: string
  /** 0..1 match strength. */
  score: number
  /** Why this matched, so a surprising result is explicable. */
  matchedOn: 'name' | 'description' | 'id'
}

export type SearchInterpretation = {
  /** How this reading of the term would be described to a reader. */
  label: string
  group: SearchGroup
  ids: string[]
}

export type SearchResponse = {
  query: string
  groups: Array<{ group: SearchGroup; results: SearchResult[] }>
  total: number
  /**
   * True when the term reads equally well as several different kinds of
   * thing. The UI must ask rather than pick.
   */
  ambiguous: boolean
  interpretations: SearchInterpretation[]
}

const GROUP_BY_TYPE: Readonly<Record<string, SearchGroup>> = {
  domain: 'domains',
  api: 'behavior',
  feature: 'behavior',
  outcome: 'outcomes',
  database: 'system',
  service: 'system',
  external: 'system',
  test: 'tests',
  document: 'docs',
  decision: 'docs',
  page: 'code',
  layout: 'code',
  client: 'code',
  hook: 'code',
  component: 'code',
  util: 'code',
  ui: 'code',
}

const GROUP_ORDER: readonly SearchGroup[] = [
  'domains', 'behavior', 'outcomes', 'system', 'code', 'tests', 'docs', 'other',
] as const

const LABEL_BY_GROUP: Readonly<Record<SearchGroup, string>> = {
  domains: 'the domain',
  behavior: 'an operation',
  outcomes: 'an outcome',
  system: 'a stored entity',
  code: 'an implementation',
  tests: 'a test',
  docs: 'a document',
  other: 'something else',
}

export const groupFor = (node: Node): SearchGroup => GROUP_BY_TYPE[node.type] ?? 'other'

const norm = (s: string): string => s.toLowerCase().trim()

/**
 * Match strength for one node.
 *
 * Exact name beats prefix beats substring; identifier and description
 * matches rank below all of them, since a word appearing in prose is much
 * weaker evidence of intent than a thing actually being called that.
 */
function scoreNode(node: Node, q: string): { score: number; matchedOn: SearchResult['matchedOn'] } | null {
  const name = norm(node.name)
  if (name === q) return { score: 1, matchedOn: 'name' }
  if (name.startsWith(q)) return { score: 0.85, matchedOn: 'name' }
  if (name.includes(q)) return { score: 0.7, matchedOn: 'name' }
  if (norm(node.id).includes(q)) return { score: 0.5, matchedOn: 'id' }
  if (norm(node.description).includes(q)) return { score: 0.35, matchedOn: 'description' }
  return null
}

/** Score at or above which a match counts as naming the thing directly. */
const STRONG_MATCH = 0.7

export function search(schema: Schema, query: string, limit = 40): SearchResponse {
  const q = norm(query)
  if (q === '') {
    return { query, groups: [], total: 0, ambiguous: false, interpretations: [] }
  }

  const scored: SearchResult[] = []
  for (const node of schema.nodes) {
    const hit = scoreNode(node, q)
    if (!hit) continue
    scored.push({
      id: node.id,
      name: node.name,
      type: node.type,
      group: groupFor(node),
      altitude: node.altitude,
      domain: node.domain,
      entity: node.entity,
      score: hit.score,
      matchedOn: hit.matchedOn,
    })
  }

  // Domains are catalogue entries rather than nodes, so they would
  // otherwise be unfindable by name.
  for (const domain of schema.meta.domains ?? []) {
    const d = norm(domain)
    if (!d.includes(q)) continue
    scored.push({
      id: `synthetic:domain:${domain}`,
      name: domain,
      type: 'domain',
      group: 'domains',
      altitude: 'domain',
      domain,
      score: d === q ? 1 : 0.8,
      matchedOn: 'name',
    })
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const capped = scored.slice(0, limit)

  const byGroup = new Map<SearchGroup, SearchResult[]>()
  for (const r of capped) {
    const list = byGroup.get(r.group) ?? []
    list.push(r)
    byGroup.set(r.group, list)
  }

  // Ambiguity is judged on strong matches only. A term appearing in the
  // prose of several unrelated files is not a genuine choice of meaning.
  const strongGroups = new Map<SearchGroup, string[]>()
  for (const r of capped) {
    if (r.score < STRONG_MATCH) continue
    const ids = strongGroups.get(r.group) ?? []
    ids.push(r.id)
    strongGroups.set(r.group, ids)
  }

  const interpretations: SearchInterpretation[] = GROUP_ORDER
    .filter((g) => strongGroups.has(g))
    .map((g) => ({ label: LABEL_BY_GROUP[g], group: g, ids: strongGroups.get(g)! }))

  return {
    query,
    groups: GROUP_ORDER
      .filter((g) => byGroup.has(g))
      .map((g) => ({ group: g, results: byGroup.get(g)! })),
    total: scored.length,
    ambiguous: interpretations.length > 1,
    interpretations,
  }
}
