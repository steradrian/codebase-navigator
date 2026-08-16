// ─────────────────────────────────────────────────────────────────
// Semantic change summary.
//
// `computeDiff` answers "which entities were added, removed or
// modified". That is the wrong altitude for the /changes feed, which is
// supposed to lead with what a change MEANT to the product — which
// journeys it touched, which behaviour forked differently, which tests
// now matter, which documentation may have gone stale.
//
// Everything here is derived from the structural diff plus the two
// schemas. Nothing is inferred about intent: the summary reports what
// moved and what is connected to it, and stops there. "This change is
// risky" is a judgement the model has no basis for; "this change altered
// two journeys and removed a failure branch" is a fact.
//
// Pure and deterministic.
// ─────────────────────────────────────────────────────────────────

import type { Journey, Node, OutcomeKind, Schema } from '@/types'
import { computeDiff, type SchemaDiff } from '@/schema/diff'

export type JourneyImpact = {
  id: string
  name: string
  kind: 'added' | 'removed' | 'changed' | 'affected'
}

export type BehaviorChange = {
  operationId: string
  operationName: string
  /** Outcomes the operation can now reach that it could not before. */
  addedOutcomes: OutcomeKind[]
  /** Outcomes it can no longer reach. */
  removedOutcomes: OutcomeKind[]
}

/**
 * How well the change itself is understood.
 *
 * Deliberately about evidence coverage, not risk. Whether a change is
 * dangerous depends on things the model cannot see; whether we can
 * explain what moved is something it can measure honestly.
 */
export type ChangeConfidence = 'high' | 'medium' | 'low'

export type SemanticChangeSummary = {
  affectedDomains: string[]
  journeys: JourneyImpact[]
  behavior: BehaviorChange[]
  /** Tests attached to entities that moved. */
  affectedTests: string[]
  /** Documents describing entities that moved, and so possibly now wrong. */
  possiblyStaleDocs: string[]
  confidence: ChangeConfidence
  /** True when nothing of product significance moved. */
  trivial: boolean
}

export type SemanticChange = {
  structural: SchemaDiff
  summary: SemanticChangeSummary
}

const OUTCOME_LINK_TYPE = 'outcome'
const TESTS_LINK_TYPE = 'tests'
const DOCUMENTS_LINK_TYPE = 'documents'

/** Outcome kinds each operation can reach, keyed by operation id. */
function outcomesByOperation(schema: Schema): Map<string, Set<OutcomeKind>> {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]))
  const out = new Map<string, Set<OutcomeKind>>()
  for (const link of schema.links) {
    if (link.type !== OUTCOME_LINK_TYPE) continue
    const kind = byId.get(link.target)?.metadata?.outcomeKind
    if (!kind) continue
    const set = out.get(link.source) ?? new Set<OutcomeKind>()
    set.add(kind)
    out.set(link.source, set)
  }
  return out
}

/** Nodes reachable from `ids` over one link type, in the given direction. */
function neighboursOver(
  schema: Schema,
  ids: ReadonlySet<string>,
  linkType: string,
  dir: 'from' | 'to',
): Node[] {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]))
  const found = new Map<string, Node>()
  for (const link of schema.links) {
    if (link.type !== linkType) continue
    const anchor = dir === 'from' ? link.target : link.source
    const other = dir === 'from' ? link.source : link.target
    if (!ids.has(anchor)) continue
    const node = byId.get(other)
    if (node) found.set(node.id, node)
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}

const journeyTouches = (journey: Journey, ids: ReadonlySet<string>): boolean =>
  journey.steps.some((s) => s.nodeId !== undefined && ids.has(s.nodeId))

/**
 * Summarise what a change meant, given the schemas either side of it.
 */
export function summariseChange(before: Schema, after: Schema): SemanticChange {
  const structural = computeDiff(before, after)

  // Every entity that moved, from the product's point of view.
  const movedNodeIds = new Set<string>([
    ...structural.nodes.added.map((n) => n.id),
    ...structural.nodes.removed.map((n) => n.id),
    ...structural.nodes.modified.map((m) => m.after.id),
  ])

  const movedNodes: Node[] = [
    ...structural.nodes.added,
    ...structural.nodes.modified.map((m) => m.after),
  ]

  const affectedDomains = [
    ...new Set(
      [...movedNodes, ...structural.nodes.removed]
        .map((n) => n.domain)
        .filter((d): d is string => Boolean(d)),
    ),
  ].sort()

  // ── behaviour: which operations gained or lost a branch ──
  const beforeOutcomes = outcomesByOperation(before)
  const afterOutcomes = outcomesByOperation(after)
  const afterById = new Map(after.nodes.map((n) => [n.id, n]))
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]))

  const behavior: BehaviorChange[] = []
  for (const operationId of [...new Set([...beforeOutcomes.keys(), ...afterOutcomes.keys()])].sort()) {
    const was = beforeOutcomes.get(operationId) ?? new Set<OutcomeKind>()
    const now = afterOutcomes.get(operationId) ?? new Set<OutcomeKind>()
    const added = [...now].filter((k) => !was.has(k)).sort()
    const removed = [...was].filter((k) => !now.has(k)).sort()
    if (added.length === 0 && removed.length === 0) continue

    const node = afterById.get(operationId) ?? beforeById.get(operationId)
    behavior.push({
      operationId,
      operationName: node?.name ?? operationId,
      addedOutcomes: added,
      removedOutcomes: removed,
    })
  }

  // ── journeys: added, removed, changed, or merely touched ──
  const journeys: JourneyImpact[] = [
    ...structural.journeys.added.map((j) => ({ id: j.id, name: j.name, kind: 'added' as const })),
    ...structural.journeys.removed.map((j) => ({ id: j.id, name: j.name, kind: 'removed' as const })),
    ...structural.journeys.modified.map((m) => ({
      id: m.after.id, name: m.after.name, kind: 'changed' as const,
    })),
  ]
  const namedJourneyIds = new Set(journeys.map((j) => j.id))
  for (const journey of after.journeys ?? []) {
    if (namedJourneyIds.has(journey.id)) continue
    // A journey whose own definition is untouched can still be affected
    // when an entity it walks through moves underneath it.
    if (journeyTouches(journey, movedNodeIds)) {
      journeys.push({ id: journey.id, name: journey.name, kind: 'affected' })
    }
  }
  journeys.sort((a, b) => a.id.localeCompare(b.id))

  const affectedTests = neighboursOver(after, movedNodeIds, TESTS_LINK_TYPE, 'from')
    .map((n) => n.name)
  const possiblyStaleDocs = neighboursOver(after, movedNodeIds, DOCUMENTS_LINK_TYPE, 'from')
    .map((n) => n.name)

  // Confidence reflects how much of what moved we can account for, not
  // how dangerous it is.
  const evidenced = movedNodes.filter((n) => (n.evidence?.length ?? 0) > 0).length
  const ratio = movedNodes.length === 0 ? 1 : evidenced / movedNodes.length
  const confidence: ChangeConfidence = ratio >= 0.8 ? 'high' : ratio >= 0.4 ? 'medium' : 'low'

  return {
    structural,
    summary: {
      affectedDomains,
      journeys,
      behavior,
      affectedTests,
      possiblyStaleDocs,
      confidence,
      trivial:
        journeys.length === 0 &&
        behavior.length === 0 &&
        movedNodeIds.size === 0,
    },
  }
}
