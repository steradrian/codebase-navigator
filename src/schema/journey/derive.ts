// ─────────────────────────────────────────────────────────────────
// Operation-flow derivation.
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
//   * They are NOT user journeys, and they are not stored as such.
//     "POST /api/payment_processing" is a system flow; a user's goal is
//     "deposit money", which spans several operations and screens and
//     cannot be recovered from a spec. They live in `schema.flows`,
//     never `schema.journeys`, so nothing downstream has to remember
//     the difference.
//   * A flow carries its importer's origin, so a re-import can refresh
//     it without touching anything a person wrote.
//
// Pure and deterministic.
// ─────────────────────────────────────────────────────────────────

import type { Journey, JourneyStep, JourneyTransition, Node, Schema } from '@/types'

/** Link type an importer uses to attach an outcome to its operation. */
const OUTCOME_LINK_TYPE = 'outcome'

export const flowId = (operationNodeId: string): string =>
  `derived:flow:${operationNodeId}`

const CALL_STEP = 'call'

/**
 * Flows implied by operations that declare more than one outcome.
 *
 * An operation with a single declared response has no branch, and a
 * one-way "it succeeds" flow tells a reader nothing they did not already
 * know — so it is not emitted. Flows exist to show where behaviour forks.
 */
export function deriveFlows(schema: Schema): Journey[] {
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

  const flows: Journey[] = []

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

    flows.push({
      id: flowId(operationId),
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

  return flows
}

/**
 * Attach derived flows to a schema.
 *
 * `journeys` is not touched. An authored journey and a derived flow are
 * different kinds of claim and never compete for the same slot. Previous
 * flows are replaced wholesale, so a re-import refreshes them rather
 * than accumulating duplicates.
 */
export function withDerivedFlows(schema: Schema): Schema {
  return { ...schema, flows: deriveFlows(schema) }
}
