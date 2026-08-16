// ─────────────────────────────────────────────────────────────────
// Structural schema diff (GE-016).
//
// Given two v1.0 schemas, produce a structured report of what
// changed: nodes/links/paths that were added, removed, or modified.
// For modified entities, include per-field changes (before/after
// values) so the UI can render specific diffs without re-running
// the comparison.
//
// This is a two-way diff; rename detection is deliberately out of
// scope — a node whose ID changed is reported as "removed + added".
// Consumers that care about rename semantics should track IDs
// stably at the importer layer (see GE-006's deterministic IDs).
// ─────────────────────────────────────────────────────────────────

import type { GuidedPath, Link, Node, Schema } from '@/types'

export type FieldChange = {
  field: string
  before: unknown
  after: unknown
}

export type NodeDiff = {
  added: Node[]
  removed: Node[]
  modified: Array<{ before: Node; after: Node; changes: FieldChange[] }>
}

export type LinkDiff = {
  added: Link[]
  removed: Link[]
  modified: Array<{ before: Link; after: Link; changes: FieldChange[] }>
}

export type PathDiff = {
  added: GuidedPath[]
  removed: GuidedPath[]
  modified: Array<{ before: GuidedPath; after: GuidedPath; changes: FieldChange[] }>
}

export type SchemaDiff = {
  nodes: NodeDiff
  links: LinkDiff
  paths: PathDiff
  /** Summary counts — computed from the above, cached here for the UI. */
  totals: {
    nodesAdded: number
    nodesRemoved: number
    nodesModified: number
    linksAdded: number
    linksRemoved: number
    linksModified: number
    pathsAdded: number
    pathsRemoved: number
    pathsModified: number
  }
}

// Fields to surface as changes. Structural identity (id, origin)
// skipped — if origin changed, that's noise for the user.
const NODE_FIELDS: readonly (keyof Node)[] = [
  'name', 'type', 'description', 'group', 'owner', 'parent', 'children', 'collapsed', 'metadata',
]
const LINK_FIELDS: readonly (keyof Link)[] = [
  'source', 'target', 'label', 'description', 'type', 'weight', 'metadata',
]
const PATH_FIELDS: readonly (keyof GuidedPath)[] = [
  'name', 'description', 'color', 'category', 'steps',
]

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T)[],
): FieldChange[] {
  const changes: FieldChange[] = []
  for (const f of fields) {
    if (!eq(before[f], after[f])) {
      changes.push({ field: String(f), before: before[f], after: after[f] })
    }
  }
  return changes
}

function diffCollection<T extends { id: string }>(
  before: T[],
  after: T[],
  fields: readonly (keyof T)[],
): {
  added: T[]
  removed: T[]
  modified: Array<{ before: T; after: T; changes: FieldChange[] }>
} {
  const beforeById = new Map(before.map((e) => [e.id, e]))
  const afterById = new Map(after.map((e) => [e.id, e]))

  const added: T[] = []
  const removed: T[] = []
  const modified: Array<{ before: T; after: T; changes: FieldChange[] }> = []

  for (const [id, a] of afterById) {
    const b = beforeById.get(id)
    if (!b) {
      added.push(a)
    } else {
      const changes = diffFields(b as Record<string, unknown>, a as Record<string, unknown>, fields as readonly string[])
      if (changes.length > 0) modified.push({ before: b, after: a, changes })
    }
  }
  for (const [id, b] of beforeById) {
    if (!afterById.has(id)) removed.push(b)
  }
  return { added, removed, modified }
}

export function computeDiff(before: Schema, after: Schema): SchemaDiff {
  const nodes = diffCollection(before.nodes, after.nodes, NODE_FIELDS)
  const links = diffCollection(before.links, after.links, LINK_FIELDS)
  const paths = diffCollection(before.paths, after.paths, PATH_FIELDS)

  return {
    nodes,
    links,
    paths,
    totals: {
      nodesAdded: nodes.added.length,
      nodesRemoved: nodes.removed.length,
      nodesModified: nodes.modified.length,
      linksAdded: links.added.length,
      linksRemoved: links.removed.length,
      linksModified: links.modified.length,
      pathsAdded: paths.added.length,
      pathsRemoved: paths.removed.length,
      pathsModified: paths.modified.length,
    },
  }
}

/** True when the diff describes zero structural change. */
export function isEmptyDiff(diff: SchemaDiff): boolean {
  const t = diff.totals
  return (
    t.nodesAdded + t.nodesRemoved + t.nodesModified +
    t.linksAdded + t.linksRemoved + t.linksModified +
    t.pathsAdded + t.pathsRemoved + t.pathsModified === 0
  )
}
