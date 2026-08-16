// ─────────────────────────────────────────────────────────────────
// Narrative and suggested questions.
//
// Two things the projection owed the UI and did not deliver: a plain
// account of what the reader is looking at, and the next questions worth
// asking. Both were in the original data shape and were dropped when the
// engine was implemented.
//
// The hard constraint on both is the same one three separate reviews
// raised: guided curiosity is the fastest route to turning this product
// into a chatbot with extra steps. Generic prompts ("tell me more about
// this") erode the fact-versus-inference distinction the whole design
// rests on.
//
// So every sentence and every question here is derived from something
// the model actually holds, and each carries the `basis` that produced
// it. If a fact is absent, the corresponding sentence is absent too —
// nothing is padded to make the panel look full, and a gap is stated as
// a gap ("no tests reference this") rather than passed over in silence.
//
// Pure and deterministic. No model calls, no clock reads.
// ─────────────────────────────────────────────────────────────────

import type { Link, Node, Schema } from '@/types'
import { summariseEvidence, type EvidenceSummary, type Lens } from './types'

export type NarrativeBlock = {
  text: string
  /** Evidence backing this sentence, so a reader can interrogate it. */
  evidence: EvidenceSummary
  /** Entity ids the sentence refers to. */
  refs: string[]
}

export type SuggestedQuestion = {
  text: string
  /** Lens that would answer it. */
  targetLens: Lens
  /** Entity the answer is about, when it differs from the current focus. */
  targetFocusId?: string
  /**
   * What in the model prompted this question. Present so a question can
   * be traced to a fact rather than appearing as an unexplained prompt.
   */
  basis: string
}

const OUTCOME_LINK_TYPE = 'outcome'
const TESTS_LINK_TYPE = 'tests'
const DOCUMENTS_LINK_TYPE = 'documents'

type Neighbourhood = {
  outcomes: Node[]
  failureOutcomes: Node[]
  tests: Node[]
  documents: Node[]
  decisions: Node[]
  dependents: number
}

/** Everything about a focus that narrative and questions are derived from. */
function neighbourhood(schema: Schema, focus: Node): Neighbourhood {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]))
  const linked = (type: string, dir: 'out' | 'in'): Node[] => {
    const out: Node[] = []
    for (const l of schema.links) {
      if (l.type !== type) continue
      const matches = dir === 'out' ? l.source === focus.id : l.target === focus.id
      if (!matches) continue
      const other = byId.get(dir === 'out' ? l.target : l.source)
      if (other) out.push(other)
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  const outcomes = linked(OUTCOME_LINK_TYPE, 'out')
  const docs = linked(DOCUMENTS_LINK_TYPE, 'in')

  return {
    outcomes,
    failureOutcomes: outcomes.filter((o) => o.metadata?.outcomeKind !== 'success'),
    tests: linked(TESTS_LINK_TYPE, 'in'),
    documents: docs.filter((d) => d.type === 'document'),
    decisions: docs.filter((d) => d.type === 'decision'),
    dependents: schema.links.filter((l: Link) => l.target === focus.id).length,
  }
}

const list = (names: string[], max = 3): string => {
  const shown = names.slice(0, max)
  const rest = names.length - shown.length
  const joined =
    shown.length <= 1
      ? shown.join('')
      : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  return rest > 0 ? `${joined}, and ${rest} more` : joined
}

/**
 * A short account of the focused entity, built only from held facts.
 *
 * Deliberately not a summary of the code — the model does not read
 * implementations, and writing prose that sounds like it does would be
 * inference presented as description.
 */
export function buildNarrative(schema: Schema, focus: Node): NarrativeBlock[] {
  const blocks: NarrativeBlock[] = []
  const n = neighbourhood(schema, focus)
  const evidence = summariseEvidence(focus.evidence)

  const placed = focus.domain
    ? `${focus.name} is part of the ${focus.domain} domain.`
    : `${focus.name} has not been assigned to a domain.`
  blocks.push({ text: placed, evidence, refs: [focus.id] })

  if (n.outcomes.length > 0) {
    const failures = n.failureOutcomes.map((o) => o.name)
    blocks.push({
      text:
        failures.length > 0
          ? `It can end in ${n.outcomes.length} declared outcomes, including ${list(failures)}.`
          : `It declares ${n.outcomes.length} outcome${n.outcomes.length === 1 ? '' : 's'}, all successful.`,
      evidence: summariseEvidence(n.outcomes[0].evidence),
      refs: n.outcomes.map((o) => o.id),
    })
  }

  if (n.tests.length > 0) {
    const cases = n.tests.reduce((a, t) => a + (t.metadata?.testCases?.length ?? 0), 0)
    blocks.push({
      text: `${cases} test case${cases === 1 ? '' : 's'} across ${n.tests.length} file${
        n.tests.length === 1 ? '' : 's'
      } verify it.`,
      evidence: summariseEvidence(n.tests[0].evidence),
      refs: n.tests.map((t) => t.id),
    })
  } else if (focus.altitude === 'implementation') {
    // Stated rather than omitted: an absent sentence reads as "not
    // checked", which is not the same as "checked and found nothing".
    blocks.push({
      text: 'No tests reference this.',
      evidence: summariseEvidence(undefined),
      refs: [],
    })
  }

  if (n.decisions.length > 0) {
    blocks.push({
      text: `Its rationale is recorded in ${list(n.decisions.map((d) => d.name))}.`,
      evidence: summariseEvidence(n.decisions[0].evidence),
      refs: n.decisions.map((d) => d.id),
    })
  }

  if (evidence.conflict) {
    blocks.push({
      text: `Sources disagree about this: ${evidence.conflict.sources.join(' and ')}.`,
      evidence,
      refs: [focus.id],
    })
  }

  return blocks
}

/**
 * Questions worth asking next, each grounded in a specific fact.
 *
 * Ordered by how much the answer would change the reader's picture:
 * unexplained disagreement first, then untested behaviour, then
 * ordinary exploration. A question is emitted only when the model holds
 * the fact that motivates it.
 */
export function buildSuggestedQuestions(schema: Schema, focus: Node): SuggestedQuestion[] {
  const questions: SuggestedQuestion[] = []
  const n = neighbourhood(schema, focus)
  const evidence = summariseEvidence(focus.evidence)

  if (evidence.conflict) {
    questions.push({
      text: `Why do ${evidence.conflict.sources.join(' and ')} disagree about ${focus.name}?`,
      targetLens: 'why',
      basis: `evidence spread of ${evidence.conflict.spread.toFixed(2)} between sources`,
    })
  }

  if (n.failureOutcomes.length > 0) {
    questions.push({
      text: `What happens when ${focus.name} returns ${n.failureOutcomes[0].name}?`,
      targetLens: 'behavior',
      targetFocusId: n.failureOutcomes[0].id,
      basis: `${n.failureOutcomes.length} declared failure outcome(s)`,
    })
  }

  if (n.tests.length === 0 && n.outcomes.length > 0) {
    questions.push({
      text: `Are ${focus.name}'s failure paths tested?`,
      targetLens: 'tests',
      basis: 'declared outcomes with no linked tests',
    })
  }

  if (focus.isHub) {
    questions.push({
      text: `What breaks if ${focus.name} changes?`,
      targetLens: 'impact',
      basis: 'flagged as shared infrastructure',
    })
  } else if (n.dependents >= 3) {
    questions.push({
      text: `What depends on ${focus.name}?`,
      targetLens: 'impact',
      basis: `${n.dependents} incoming relationships`,
    })
  }

  if (n.decisions.length > 0) {
    questions.push({
      text: `Why was ${focus.name} built this way?`,
      targetLens: 'why',
      targetFocusId: n.decisions[0].id,
      basis: `recorded decision: ${n.decisions[0].name}`,
    })
  } else if (n.documents.length > 0) {
    questions.push({
      text: `What does the documentation say about ${focus.name}?`,
      targetLens: 'why',
      basis: `${n.documents.length} document(s) reference it`,
    })
  }

  if (focus.metadata?.lastModified) {
    questions.push({
      text: `What changed in ${focus.name} recently?`,
      targetLens: 'history',
      basis: `last modified ${focus.metadata.lastModified}`,
    })
  }

  return questions
}
