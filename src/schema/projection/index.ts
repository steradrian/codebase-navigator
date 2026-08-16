// ─────────────────────────────────────────────────────────────────
// computeProjection — the boundary between the model and the UI.
//
// Given a focus, an altitude and a lens, return the handful of entities
// that matter right now. The UI never sees the graph; it sees this.
//
// Pure and deterministic. Ties break on id so repeated calls with the
// same arguments produce byte-identical output.
// ─────────────────────────────────────────────────────────────────

import type { Altitude, EvidenceSource, Node, Schema } from '@/types'
import { nearestPopulatedAltitude, populatedAltitudes } from '@/schema/altitude'
import {
  behaviouralImportance,
  evidenceScore,
  proximityFrom,
  recencyScore,
  similarity,
  trailPriors,
  type Proximity,
} from './relevance'
import { buildNarrative, buildSuggestedQuestions } from './narrative'
import {
  DEFAULT_BUDGET,
  DEFAULT_DEPTH,
  LENS_PROFILES,
  resolutionOf,
  summariseEvidence,
  type ExplorationQuery,
  type Lens,
  type ProjectedEntity,
  type ProjectedRelationship,
  type Projection,
  type ProjectionNotice,
  type RelationToFocus,
} from './types'

/** How strongly diversity is traded against raw relevance during selection. */
const DIVERSITY_LAMBDA = 0.35

/** Below this many candidates, widen the search rather than return a stub. */
const WIDEN_RATIO = 0.5

const SYNTHETIC_PRODUCT_PREFIX = 'synthetic:product:'
const SYNTHETIC_DOMAIN_PREFIX = 'synthetic:domain:'

/**
 * Lenses whose ranking depends on evidence the extractors do not yet
 * produce. They still run — the framework is identical — but the
 * projection says so rather than presenting an empty or arbitrary
 * result as an answer.
 */
const EVIDENCE_DEPENDENT: Partial<Record<Lens, { sources: EvidenceSource[]; reason: string }>> = {
  why: {
    sources: ['documentation', 'human', 'git'],
    reason: 'no documentation, git or human evidence has been extracted yet',
  },
  history: { sources: ['git'], reason: 'no git evidence has been extracted yet' },
  tests: { sources: ['test'], reason: 'no test evidence has been extracted yet' },
  runtime: { sources: ['runtime'], reason: 'no runtime evidence has been extracted yet' },
}

const relationToFocus = (focus: Node, candidate: Node): RelationToFocus => {
  if (focus.id === candidate.id) return 'self'
  if (focus.parent === candidate.id) return 'ancestor'
  if (focus.children?.includes(candidate.id)) return 'descendant'
  return 'peer'
}

const toProjected = (
  node: Node,
  focus: Node,
  relevance: number,
  whyRelevant: string[],
): ProjectedEntity => ({
  id: node.id,
  name: node.name,
  type: node.type,
  altitude: node.altitude ?? 'implementation',
  entity: node.entity,
  domain: node.domain,
  relationToFocus: relationToFocus(focus, node),
  relevance,
  resolution: resolutionOf(node),
  evidence: summariseEvidence(node.evidence),
  isHub: node.isHub === true,
  whyRelevant,
  synthetic: false,
})

const syntheticEntity = (
  id: string,
  name: string,
  altitude: Altitude,
  relevance: number,
  whyRelevant: string[],
  domain?: string,
): ProjectedEntity => ({
  id,
  name,
  type: altitude,
  altitude,
  domain,
  relationToFocus: 'peer',
  relevance,
  // Synthesised aggregates describe a grouping, not a claim about the
  // code, so they are neither evidenced nor unresolved.
  resolution: 'resolved',
  evidence: {
    strongestSource: null,
    confidence: null,
    bySource: [],
    aiInferred: false,
    humanVerified: false,
    conflict: null,
    count: 0,
  },
  isHub: false,
  whyRelevant,
  synthetic: true,
})

/**
 * Product and domain tiers have no stored members — no importer emits
 * them — so they are built from the catalogue at query time.
 */
function synthesiseCoarse(schema: Schema, altitude: Altitude, focus: Node | null): ProjectedEntity[] {
  if (altitude === 'product') {
    return [
      syntheticEntity(
        `${SYNTHETIC_PRODUCT_PREFIX}${schema.meta.name}`,
        schema.meta.name,
        'product',
        1,
        ['the whole product'],
      ),
    ]
  }

  const domains = new Set(schema.meta.domains ?? [])
  for (const n of schema.nodes) {
    if (n.altitude === 'domain' && n.name) domains.add(n.name)
  }

  return [...domains].sort().map((d) => {
    const why: string[] = [`${schema.nodes.filter((n) => n.domain === d).length} entities`]
    // The subject key is what stays fixed across a zoom, so the focus's
    // own domain ranks first when zooming out to this tier.
    const isFocusDomain = focus?.domain === d
    if (isFocusDomain) why.unshift('contains your current focus')
    return syntheticEntity(
      `${SYNTHETIC_DOMAIN_PREFIX}${d}`,
      d,
      'domain',
      isFocusDomain ? 1 : 0.6,
      why,
      d,
    )
  })
}

/**
 * Greedy selection that trades raw relevance against redundancy.
 *
 * A pure top-N fills the budget with one tight cluster, and lets a hub
 * plus its immediate neighbourhood crowd out everything else. Penalising
 * similarity to what is already chosen keeps the returned set legible as
 * a set rather than as a ranked list.
 */
function selectDiverse(
  candidates: { node: Node; score: number; why: string[] }[],
  budget: number,
): { node: Node; score: number; why: string[] }[] {
  const pool = [...candidates]
  const chosen: { node: Node; score: number; why: string[] }[] = []

  while (chosen.length < budget && pool.length > 0) {
    let bestIndex = 0
    let bestValue = -Infinity

    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
      let maxSim = 0
      for (const s of chosen) {
        const sim = similarity(c.node, s.node)
        if (sim > maxSim) maxSim = sim
      }
      const value = c.score - DIVERSITY_LAMBDA * maxSim
      // Deterministic tie-break so identical inputs give identical output.
      if (value > bestValue || (value === bestValue && c.node.id < pool[bestIndex].node.id)) {
        bestValue = value
        bestIndex = i
      }
    }

    chosen.push(pool[bestIndex])
    pool.splice(bestIndex, 1)
  }

  return chosen
}

export function computeProjection(schema: Schema, query: ExplorationQuery): Projection {
  const notices: ProjectionNotice[] = []
  const profile = LENS_PROFILES[query.lens]

  const focusNode = schema.nodes.find((n) => n.id === query.focusId) ?? null

  // ── resolve altitude, loudly ──
  const populated = populatedAltitudes(schema)
  let altitude = query.altitude
  if (!populated.includes(altitude)) {
    const nearest = nearestPopulatedAltitude(schema, altitude)
    if (nearest === null) {
      notices.push({ kind: 'altitude_unavailable', requested: altitude })
    } else {
      notices.push({ kind: 'altitude_substituted', requested: altitude, used: nearest })
      altitude = nearest
    }
  }

  // Checked per required source, not "is there any evidence at all".
  // The coarse version stopped firing the moment ANY extractor produced
  // anything, so the runtime lens silently returned nothing instead of
  // saying it had no runtime data — the exact silent-emptiness this
  // notice exists to prevent.
  const dependency = EVIDENCE_DEPENDENT[query.lens]
  if (
    dependency &&
    !schema.nodes.some((n) => n.evidence?.some((e) => dependency.sources.includes(e.source)))
  ) {
    notices.push({ kind: 'lens_unsupported_by_data', lens: query.lens, reason: dependency.reason })
  }

  const budget = query.budget ?? DEFAULT_BUDGET[altitude]
  const depth = query.depth ?? DEFAULT_DEPTH[altitude]

  const focus: ProjectedEntity = focusNode
    ? toProjected(focusNode, focusNode, 1, ['your current focus'])
    : syntheticEntity(query.focusId, query.focusId, altitude, 1, ['your current focus'])

  // ── coarse tiers are synthesised, not traversed ──
  if (altitude === 'product' || altitude === 'domain') {
    const synthesised = synthesiseCoarse(schema, altitude, focusNode)
      .filter((e) => e.id !== focus.id)
      .sort((a, b) => (b.relevance - a.relevance) || a.id.localeCompare(b.id))
    return {
      focus,
      altitude,
      lens: query.lens,
      nodes: synthesised.slice(0, budget),
      relationships: [],
      // Synthesised tiers describe a grouping rather than a specific
      // entity, so there is nothing factual to narrate about them.
      narrative: focusNode ? buildNarrative(schema, focusNode) : [],
      suggestedQuestions: focusNode ? buildSuggestedQuestions(schema, focusNode) : [],
      meta: { totalCandidates: synthesised.length, budget, notices },
    }
  }

  // ── scoring terms ──
  // Structural reach and trail reach are traversed separately rather
  // than as one multi-seeded walk: merging them would let a trail entry
  // inflate a node's structural proximity to the focus, conflating
  // "close to what you're looking at" with "close to where you've been".
  const structural = proximityFrom(schema, new Map([[query.focusId, 1]]), profile, depth)
  const trailReach = proximityFrom(schema, trailPriors(query.trail), profile, depth)
  // Authored journeys only. Derived flows contain every operation and
  // its own outcomes, so feeding them in would give every operation an
  // identical behavioural score and destroy the term's discrimination.
  const behavioural = behaviouralImportance(schema.journeys)
  const trailSet = new Set(query.trail)

  const score = (node: Node): { score: number; why: string[]; proximity: Proximity | undefined } => {
    const w = profile.weights
    const prox = structural.get(node.id)
    const structuralTerm = prox?.score ?? 0
    const trailTerm = trailSet.has(node.id) ? 1 : (trailReach.get(node.id)?.score ?? 0)
    const evidenceTerm = evidenceScore(node.evidence, query.lens)
    const recencyTerm = recencyScore(node, query.now)
    const behaviourTerm = behavioural.get(node.id) ?? 0

    let total =
      w.structural * structuralTerm +
      w.trail * trailTerm +
      w.evidence * evidenceTerm +
      w.recency * recencyTerm +
      w.behavioral * behaviourTerm

    if (node.isHub) total *= profile.hubDampening

    const why: string[] = []
    if (prox && prox.distance <= 1) why.push('directly connected')
    else if (prox) why.push(`${prox.distance} hops away`)
    if (trailSet.has(node.id)) why.push('on your trail')
    if (node.entity && node.entity === focusNode?.entity) why.push(`shares the ${node.entity} entity`)
    if (behaviourTerm > 0) why.push('appears in a journey')
    if (recencyTerm > 0.5) why.push('changed recently')
    if (node.isHub) why.push('shared infrastructure')

    return { score: Math.min(1, total), why, proximity: prox }
  }

  const collect = (searchDepth: number) => {
    const reach =
      searchDepth === depth
        ? structural
        : proximityFrom(schema, new Map([[query.focusId, 1]]), profile, searchDepth)

    return schema.nodes
      .filter((n) => n.id !== query.focusId)
      .filter((n) => (n.altitude ?? 'implementation') === altitude)
      .filter((n) => reach.has(n.id) || trailSet.has(n.id))
      .map((n) => {
        const s = score(n)
        return { node: n, score: s.score, why: s.why }
      })
      .filter((c) => c.score > 0)
  }

  let candidates = collect(depth)

  // A thin neighbourhood should widen the search, not return a stub that
  // looks like an answer.
  if (candidates.length < budget * WIDEN_RATIO) {
    const widened = collect(depth + 1)
    if (widened.length > candidates.length) {
      notices.push({ kind: 'widened', from: depth, to: depth + 1 })
      candidates = widened
    }
  }

  candidates.sort((a, b) => (b.score - a.score) || a.node.id.localeCompare(b.node.id))
  const selected = selectDiverse(candidates, budget)

  const nodes = selected.map((c) => toProjected(c.node, focusNode ?? c.node, c.score, c.why))

  // Only edges between entities actually returned — a relationship
  // pointing at something off-screen is a dangling reference the UI
  // cannot render honestly.
  const visible = new Set([focus.id, ...nodes.map((n) => n.id)])
  const allowed = profile.allowedLinkTypes ? new Set(profile.allowedLinkTypes) : null
  const relationships: ProjectedRelationship[] = schema.links
    .filter((l) => visible.has(l.source) && visible.has(l.target))
    .filter((l) => !allowed || allowed.has(l.type ?? ''))
    .map((l) => ({
      linkId: l.id,
      source: l.source,
      target: l.target,
      type: l.type,
      label: l.label,
      evidence: summariseEvidence(l.evidence),
    }))
    .sort((a, b) => a.linkId.localeCompare(b.linkId))

  // An empty projection must say why. Silence here reads as "nothing is
  // related", when the usual cause is that extraction never produced the
  // relationships in the first place.
  if (nodes.length === 0 && focusNode) {
    const hasAnyLink = schema.links.some(
      (l) => l.source === query.focusId || l.target === query.focusId,
    )
    if (!hasAnyLink) notices.push({ kind: 'focus_isolated', focusId: query.focusId })
    else notices.push({ kind: 'no_candidates_at_altitude', altitude, depth })
  }

  return {
    focus,
    altitude,
    lens: query.lens,
    nodes,
    relationships,
    narrative: focusNode ? buildNarrative(schema, focusNode) : [],
    suggestedQuestions: focusNode ? buildSuggestedQuestions(schema, focusNode) : [],
    meta: { totalCandidates: candidates.length, budget, notices },
  }
}

export * from './types'
