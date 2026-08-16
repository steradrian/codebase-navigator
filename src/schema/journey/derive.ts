// ─────────────────────────────────────────────────────────────────
// Journey derivation.
//
// Journey coverage sat at 0% across every domain because nothing
// produced journeys: they existed only as hand-authored linear paths
// lifted into the v1.3 shape, and no real project had any.
//
// The alternative to hand-authoring fiction is to derive what the model
// can actually support. An operation and its declared responses describe
// a genuine branching flow — call it, and one of these outcomes happens
// — and every step of that flow points at a node the extractors really
// found.
//
// The limits of that are stated rather than papered over:
//
//   * These are `inferred`, never `verified`. Declared responses say what
//     CAN happen, not that anyone confirmed the product behaves this way.
//   * They are not user journeys. "POST /api/payment_processing" is a
//     system flow; a user's goal is "deposit money", which spans several
//     operations and screens and cannot be recovered from a spec. The
//     category is `data_flow`, and nothing here claims user intent.
//   * A derived journey carries its importer's origin, so the merge
//     engine can refresh it on re-import without touching anything a
//     person wrote.
//
// Pure and deterministic.
// ─────────────────────────────────────────────────────────────────

import type { Journey, JourneyStep, JourneyTransition, Node, Schema } from '@/types'

/** Link type an importer uses to attach an outcome to its operation. */
const OUTCOME_LINK_TYPE = 'outcome'

export const derivedJourneyId = (operationNodeId: string): string =>
  `derived:journey:${operationNodeId}`

const CALL_STEP = 'call'

/**
 * Journeys implied by operations that declare more than one outcome.
 *
 * An operation with a single declared response has no branch, and a
 * one-way "it succeeds" flow tells a reader nothing they did not already
 * know — so it is not emitted. Journeys exist here to show where
 * behaviour forks.
 */
export function deriveJourneys(schema: Schema): Journey[] {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]))

  // operation id → its outcome nodes
  const outcomesByOperation = new Map<string, Node[]>()
  for (const link of schema.links) {
    if (link.type !== OUTCOME_LINK_TYPE) continue
    const outcome = byId.get(link.target)
    if (!outcome) continue
    const list = outcomesByOperation.get(link.source) ?? []
    list.push(outcome)
    outcomesByOperation.set(link.source, list)
  }

  const journeys: Journey[] = []

  for (const operationId of [...outcomesByOperation.keys()].sort()) {
    const operation = byId.get(operationId)
    if (!operation) continue

    const outcomes = outcomesByOperation
      .get(operationId)!
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))

    if (outcomes.length < 2) continue

    const callStep: JourneyStep = {
      id: CALL_STEP,
      name: operation.name,
      annotation: operation.description,
      kind: 'action',
      nodeId: operation.id,
      evidence: operation.evidence,
    }

    const outcomeSteps: JourneyStep[] = outcomes.map((outcome) => ({
      id: outcome.id,
      name: outcome.name,
      annotation: outcome.description,
      kind: 'outcome',
      // Every outcome node carries its kind; without one it is not a
      // usable outcome step, so fall back to the vocabulary's catch-all
      // rather than dropping the branch silently.
      outcome: outcome.metadata?.outcomeKind ?? 'partial',
      nodeId: outcome.id,
      evidence: outcome.evidence,
    }))

    const transitions: JourneyTransition[] = outcomes.map((outcome) => ({
      id: `${CALL_STEP}__${outcome.id}`,
      from: CALL_STEP,
      to: outcome.id,
      // The condition is the outcome's own name ("401 Permission
      // denied"), which is what the specification actually stated. Any
      // richer phrasing would be invented.
      condition: outcome.name,
      evidence: outcome.evidence,
    }))

    journeys.push({
      id: derivedJourneyId(operationId),
      name: operation.name,
      description: operation.description,
      color: '#8b7cff',
      // Not `user_journey`: this is a system flow, and claiming user
      // intent the spec never stated would be the exact overreach the
      // evidence model exists to prevent.
      category: 'data_flow',
      origin: operation.origin,
      status: 'inferred',
      entryStepIds: [CALL_STEP],
      steps: [callStep, ...outcomeSteps],
      transitions,
    })
  }

  return journeys
}

/**
 * Merge derived journeys into a schema without disturbing authored ones.
 *
 * Authored journeys always win on id collision. Derived journeys from a
 * previous run are replaced wholesale, which is what makes re-import
 * refresh them rather than accumulate duplicates.
 */
export function withDerivedJourneys(schema: Schema): Schema {
  const derived = deriveJourneys(schema)
  const authored = (schema.journeys ?? []).filter(
    (j) => !j.origin || j.origin === 'manual',
  )
  const authoredIds = new Set(authored.map((j) => j.id))

  return {
    ...schema,
    journeys: [...authored, ...derived.filter((j) => !authoredIds.has(j.id))],
  }
}
