// ─────────────────────────────────────────────────────────────────
// Projection layer — types and per-lens configuration.
//
// The UI never receives the graph. It asks "given what I'm looking at,
// what matters right now?" and gets back ~12 entities. That boundary is
// what stops this product collapsing back into a node-and-arrow dump.
//
// The scoring model here is deliberately NOT "graph decay with a
// per-lens weight table". That design was tested and fails on real
// numbers: with dependency edges at 0.85, a two-hop dependency chain
// scores 0.7225, beating a one-hop edge of an unlisted type at 0.6.
// Under that model the test covering the focused file ranks below an
// unrelated transitive dependency, and hub nodes — one hop from almost
// everything via the strongest edge type — dominate every lens.
//
// So structural proximity is one term among several. Signals traversal
// physically cannot see (evidence trust, recency, journey membership,
// where the user has already been) are first-class, and each lens
// chooses how much to lean on each.
// ─────────────────────────────────────────────────────────────────

import type { Altitude, Evidence, EvidenceSource, Node } from '@/types'

export type Lens =
  | 'overview'
  | 'behavior'
  | 'journey'
  | 'code'
  | 'why'
  | 'impact'
  | 'runtime'
  | 'history'
  | 'tests'

export type RelationToFocus = 'self' | 'ancestor' | 'descendant' | 'peer'

/**
 * How well the model actually understands an entity, as opposed to how
 * relevant it is. Drives the "out of focus until explored" rendering:
 * an unresolved entity should look unresolved rather than be quietly
 * presented with the same confidence as a well-evidenced one.
 */
export type Resolution = 'resolved' | 'partial' | 'unresolved'

export type EvidenceSummary = {
  /** Highest-trust source backing this entity, or null when unevidenced. */
  strongestSource: EvidenceSource | null
  /** Mean stated confidence; null when nothing carried a score. */
  confidence: number | null
  /** True when any contributing evidence was AI-inferred. */
  aiInferred: boolean
  count: number
}

export type ProjectedEntity = {
  id: string
  name: string
  type: string
  altitude: Altitude
  entity?: string
  domain?: string

  relationToFocus: RelationToFocus
  /** Final composite score in 0..1. */
  relevance: number
  resolution: Resolution
  evidence: EvidenceSummary
  isHub: boolean

  /**
   * Short machine-generated reasons this surfaced, e.g.
   * ["shares the payment entity", "on your trail"]. Shown to the user:
   * a ranked list nobody can interrogate is indistinguishable from an
   * arbitrary one.
   */
  whyRelevant: string[]

  /** True for product/domain entities synthesised rather than stored. */
  synthetic: boolean
}

export type ProjectedRelationship = {
  linkId: string
  source: string
  target: string
  type?: string
  label: string
  evidence: EvidenceSummary
}

export type ExplorationQuery = {
  focusId: string
  altitude: Altitude
  lens: Lens

  /** Hops of graph traversal. Defaults per altitude — see DEFAULT_DEPTH. */
  depth?: number

  /**
   * Previously focused ids, oldest first. Required rather than optional:
   * "no history" is a real state and should be stated, not inferred from
   * an absent field.
   */
  trail: string[]

  /** Overrides the per-altitude node budget. */
  budget?: number

  /**
   * ISO 8601 "now", used only by the recency term. Passed in rather than
   * read from the clock so projections stay pure and testable. When
   * absent the recency term contributes nothing instead of guessing.
   */
  now?: string
}

export type ProjectionNotice =
  | { kind: 'altitude_substituted'; requested: Altitude; used: Altitude }
  | { kind: 'altitude_unavailable'; requested: Altitude }
  | { kind: 'widened'; from: number; to: number }
  | { kind: 'lens_unsupported_by_data'; lens: Lens; reason: string }
  /**
   * Nothing surfaced. An empty result is ambiguous on its own — the user
   * cannot tell "this entity genuinely stands alone" from "extraction
   * missed its relationships", and on real specs the second is common:
   * a 4,243-line OpenAPI document yielded 25 links across 66 nodes,
   * leaving 26 isolated.
   */
  | { kind: 'focus_isolated'; focusId: string }
  | { kind: 'no_candidates_at_altitude'; altitude: Altitude; depth: number }

export type Projection = {
  focus: ProjectedEntity
  altitude: Altitude
  lens: Lens
  nodes: ProjectedEntity[]
  relationships: ProjectedRelationship[]

  meta: {
    /** Candidates considered before the budget cut — lets the UI say "12 of 340". */
    totalCandidates: number
    budget: number
    /**
     * Anything the projection did that the user did not ask for.
     * Surfaced rather than silent: a view that quietly substitutes a
     * different altitude misrepresents the granularity of everything
     * on screen.
     */
    notices: ProjectionNotice[]
  }
}

// ─── lens configuration ──────────────────────────────────────

export type ScoreWeights = {
  structural: number
  trail: number
  evidence: number
  recency: number
  behavioral: number
}

export type LensProfile = {
  /**
   * Link types permitted to carry relevance. `null` means all.
   *
   * This is a filter, not a weight. Both sides of the design review
   * agreed on it independently: down-weighting an irrelevant edge type
   * still lets it accumulate through multi-hop paths, so an excluded
   * relationship must be genuinely excluded.
   */
  allowedLinkTypes: readonly string[] | null

  weights: ScoreWeights

  /**
   * Multiplier applied to hub nodes. Hubs sit one hop from nearly
   * everything, so without damping they win every lens on structure
   * alone — the opposite of relevance.
   */
  hubDampening: number

  /** Traversal direction; only `impact` is inherently directional. */
  direction: 'downstream' | 'upstream' | 'both'
}

/**
 * Per-lens profiles.
 *
 * `why`, `history` and `tests` deliberately weight structure low. The
 * ADR that answers "why does this exist" is typically one weak edge
 * away, while an irrelevant dependency chain is two strong ones — so
 * ranking those lenses by traversal produces confident wrong answers.
 * They lean on evidence provenance and recency instead.
 */
export const LENS_PROFILES: Readonly<Record<Lens, LensProfile>> = {
  overview: {
    allowedLinkTypes: null,
    weights: { structural: 0.45, trail: 0.15, evidence: 0.15, recency: 0.05, behavioral: 0.2 },
    hubDampening: 0.3,
    direction: 'both',
  },
  behavior: {
    allowedLinkTypes: ['triggers', 'data_flow'],
    weights: { structural: 0.35, trail: 0.1, evidence: 0.15, recency: 0.05, behavioral: 0.35 },
    hubDampening: 0.4,
    direction: 'downstream',
  },
  journey: {
    allowedLinkTypes: ['triggers', 'data_flow'],
    weights: { structural: 0.2, trail: 0.1, evidence: 0.1, recency: 0.05, behavioral: 0.55 },
    hubDampening: 0.3,
    direction: 'both',
  },
  code: {
    allowedLinkTypes: ['dependency'],
    weights: { structural: 0.6, trail: 0.15, evidence: 0.15, recency: 0.1, behavioral: 0.0 },
    hubDampening: 0.5,
    direction: 'both',
  },
  why: {
    allowedLinkTypes: null,
    weights: { structural: 0.15, trail: 0.1, evidence: 0.6, recency: 0.15, behavioral: 0.0 },
    hubDampening: 0.2,
    direction: 'both',
  },
  impact: {
    allowedLinkTypes: null,
    weights: { structural: 0.8, trail: 0.05, evidence: 0.1, recency: 0.05, behavioral: 0.0 },
    // Hubs are the point of an impact query, not noise to suppress.
    hubDampening: 1,
    direction: 'downstream',
  },
  runtime: {
    allowedLinkTypes: ['data_flow', 'triggers'],
    weights: { structural: 0.4, trail: 0.1, evidence: 0.4, recency: 0.1, behavioral: 0.0 },
    hubDampening: 1,
    direction: 'downstream',
  },
  history: {
    allowedLinkTypes: null,
    weights: { structural: 0.15, trail: 0.1, evidence: 0.25, recency: 0.5, behavioral: 0.0 },
    hubDampening: 0.3,
    direction: 'both',
  },
  tests: {
    allowedLinkTypes: null,
    weights: { structural: 0.2, trail: 0.05, evidence: 0.7, recency: 0.05, behavioral: 0.0 },
    hubDampening: 0.3,
    direction: 'both',
  },
}

/**
 * Which `Evidence.source` values a lens treats as its primary signal.
 * Used by the evidence term so the `tests` lens ranks test-derived
 * facts highly without needing a test-shaped subgraph to traverse.
 */
export const LENS_PRIMARY_EVIDENCE: Readonly<Partial<Record<Lens, readonly EvidenceSource[]>>> = {
  why: ['documentation', 'human', 'git'],
  history: ['git'],
  tests: ['test'],
  runtime: ['runtime'],
}

/** Coarse tiers hold fewer, larger things; fine tiers need more to read as a set. */
export const DEFAULT_BUDGET: Readonly<Record<Altitude, number>> = {
  product: 6,
  domain: 8,
  behavior: 12,
  system: 12,
  implementation: 16,
  code: 16,
}

/** Coarse tiers have fewer, larger neighbours, so fewer hops suffice. */
export const DEFAULT_DEPTH: Readonly<Record<Altitude, number>> = {
  product: 1,
  domain: 1,
  behavior: 2,
  system: 2,
  implementation: 3,
  code: 3,
}

/**
 * How much each evidence source is trusted, independent of the
 * confidence the evidence itself states. A human confirmation outranks
 * an AI inference even when the inference claims higher confidence —
 * self-reported certainty is not a substitute for provenance.
 */
export const SOURCE_TRUST: Readonly<Record<EvidenceSource, number>> = {
  human: 1.0,
  test: 0.95,
  static_analysis: 0.9,
  runtime: 0.85,
  documentation: 0.7,
  git: 0.65,
  ai_inference: 0.4,
}

/**
 * Score used for an entity carrying no evidence at all.
 *
 * Neutral rather than zero: almost nothing carries evidence yet, and
 * scoring absence as disbelief would rank every unevidenced node below
 * a single low-confidence AI guess.
 */
export const UNEVIDENCED_TRUST = 0.5

export const summariseEvidence = (evidence: Evidence[] | undefined): EvidenceSummary => {
  if (!evidence || evidence.length === 0) {
    return { strongestSource: null, confidence: null, aiInferred: false, count: 0 }
  }
  let strongest: EvidenceSource | null = null
  let strongestTrust = -1
  let confidenceSum = 0
  let confidenceCount = 0
  let aiInferred = false

  for (const e of evidence) {
    const trust = SOURCE_TRUST[e.source] ?? UNEVIDENCED_TRUST
    if (trust > strongestTrust) {
      strongestTrust = trust
      strongest = e.source
    }
    if (e.source === 'ai_inference') aiInferred = true
    if (e.confidence !== undefined) {
      confidenceSum += e.confidence
      confidenceCount += 1
    }
  }

  return {
    strongestSource: strongest,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
    aiInferred,
    count: evidence.length,
  }
}

/**
 * How well-understood an entity is.
 *
 * Deliberately independent of relevance: a highly relevant node we know
 * nothing about must still render as unresolved rather than borrow
 * confidence from its ranking.
 */
export const resolutionOf = (node: Node): Resolution => {
  const described = node.description.trim().length > 0
  const classified = Boolean(node.entity || node.domain)
  if (described && classified) return 'resolved'
  if (described || classified) return 'partial'
  return 'unresolved'
}
