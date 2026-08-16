// ─────────────────────────────────────────────────────────────────
// Understanding coverage.
//
// Not test coverage. This measures how well the MODEL understands a part
// of the product — how much of it is classified, evidenced, explained,
// exercised by journeys, and still fresh.
//
// `meta.altitudeCoverage` is sometimes mistaken for this. It counts nodes
// per zoom tier, which answers "can I zoom here", not "do we understand
// this". They are different measurements and neither substitutes for the
// other.
//
// The governing rule is that an unmeasurable dimension reports `null`,
// never 0 and never 100. A domain with no HTTP operations has no
// behaviour to declare outcomes for; scoring it 0% would invent a gap,
// and scoring it 100% would invent knowledge. Both are worse than
// admitting the question does not apply — and this is the one view a
// reader consults precisely to find out where the model is blind.
//
// Pure and deterministic. `now` is supplied by the caller.
// ─────────────────────────────────────────────────────────────────

import type { Node, Schema } from '@/types'

export type CoverageDimension =
  | 'entities'
  | 'journeys'
  | 'behavior'
  | 'evidence'
  | 'tests'
  | 'why'
  | 'runtime'
  | 'freshness'

export const COVERAGE_DIMENSIONS: readonly CoverageDimension[] = [
  'entities',
  'journeys',
  'behavior',
  'evidence',
  'tests',
  'why',
  'runtime',
  'freshness',
] as const

export type DimensionScore = {
  /** 0..1, or null when the dimension does not apply to this population. */
  value: number | null
  covered: number
  /** Population the dimension was measured over; 0 means not applicable. */
  total: number
}

export type DomainCoverage = {
  /** Domain name, or null for the whole-product roll-up. */
  domain: string | null
  nodeCount: number
  dimensions: Record<CoverageDimension, DimensionScore>
  /** Mean of the applicable dimensions; null when none applied. */
  overall: number | null
}

export type CoverageReport = {
  product: DomainCoverage
  domains: DomainCoverage[]
  /** Nodes carrying no domain, which no per-domain figure accounts for. */
  unclassifiedNodes: number
}

/** Evidence older than this is treated as possibly stale. */
export const STALE_AFTER_DAYS = 180

const DAY_MS = 24 * 60 * 60 * 1000

const score = (covered: number, total: number): DimensionScore =>
  total === 0
    ? { value: null, covered: 0, total: 0 }
    : { value: covered / total, covered, total }

const hasEvidenceFrom = (node: Node, sources: readonly string[]): boolean =>
  node.evidence?.some((e) => sources.includes(e.source)) === true

/**
 * Most recent moment anything vouched for this node, or null.
 *
 * Uses evidence timestamps and the node's own last-modified date; the
 * newest wins, because a single fresh confirmation is enough to say the
 * model's picture is current.
 */
function lastAttestedAt(node: Node): number | null {
  const stamps: number[] = []
  const modified = node.metadata?.lastModified
  if (modified) {
    const t = Date.parse(modified)
    if (!Number.isNaN(t)) stamps.push(t)
  }
  for (const e of node.evidence ?? []) {
    if (!e.verifiedAt) continue
    const t = Date.parse(e.verifiedAt)
    if (!Number.isNaN(t)) stamps.push(t)
  }
  return stamps.length > 0 ? Math.max(...stamps) : null
}

/**
 * `subjects` is the population every ratio is measured over. `scope` is
 * the same slice including outcome nodes, which are not subjects but are
 * needed to tell which operations declare their outcomes.
 */
function measure(
  subjects: Node[],
  scope: Node[],
  journeyNodeIds: ReadonlySet<string>,
  now: string | undefined,
): DomainCoverage['dimensions'] {
  // Behaviour is only meaningful for things that DO something.
  const behavioural = subjects.filter((n) => n.altitude === 'behavior')
  const withOutcomes = new Set(
    scope.filter((n) => n.type === 'outcome').map((n) => n.id.split(':outcome:')[0]),
  )

  const dated = subjects.filter((n) => lastAttestedAt(n) !== null)
  const nowMs = now ? Date.parse(now) : Number.NaN
  const freshnessMeasurable = now !== undefined && !Number.isNaN(nowMs) && dated.length > 0
  const fresh = freshnessMeasurable
    ? dated.filter((n) => (nowMs - (lastAttestedAt(n) as number)) / DAY_MS <= STALE_AFTER_DAYS)
    : []

  return {
    // Is this node classified into the product's vocabulary at all?
    entities: score(subjects.filter((n) => Boolean(n.entity)).length, subjects.length),

    // Does any journey walk through it?
    journeys: score(subjects.filter((n) => journeyNodeIds.has(n.id)).length, subjects.length),

    // Do the things that act declare what can happen when they do?
    behavior: score(
      behavioural.filter((n) => withOutcomes.has(n.id)).length,
      behavioural.length,
    ),

    // Does anything at all vouch for this node?
    evidence: score(subjects.filter((n) => (n.evidence?.length ?? 0) > 0).length, subjects.length),

    tests: score(subjects.filter((n) => hasEvidenceFrom(n, ['test'])).length, subjects.length),

    // Rationale specifically, not documentation of any kind.
    why: score(
      subjects.filter((n) => hasEvidenceFrom(n, ['documentation', 'human'])).length,
      subjects.length,
    ),

    runtime: score(subjects.filter((n) => hasEvidenceFrom(n, ['runtime'])).length, subjects.length),

    // Measured only over nodes that carry a date at all; without a clock
    // it is not measurable and says so.
    freshness: freshnessMeasurable
      ? score(fresh.length, dated.length)
      : { value: null, covered: 0, total: 0 },
  }
}

const overallOf = (dimensions: DomainCoverage['dimensions']): number | null => {
  const applicable = COVERAGE_DIMENSIONS
    .map((d) => dimensions[d].value)
    .filter((v): v is number => v !== null)
  if (applicable.length === 0) return null
  return applicable.reduce((a, b) => a + b, 0) / applicable.length
}

/**
 * Coverage for the whole product and for each domain.
 *
 * Outcome nodes are excluded from the population being measured: they
 * are the *answer* to behaviour coverage, and counting them as subjects
 * would let a well-documented endpoint inflate its own score.
 */
export function computeCoverage(schema: Schema, opts: { now?: string } = {}): CoverageReport {
  const journeyNodeIds = new Set<string>()
  for (const j of schema.journeys ?? []) {
    for (const step of j.steps) if (step.nodeId) journeyNodeIds.add(step.nodeId)
  }

  const measurable = schema.nodes.filter((n) => n.type !== 'outcome')

  const product: DomainCoverage = {
    domain: null,
    nodeCount: measurable.length,
    dimensions: measure(measurable, schema.nodes, journeyNodeIds, opts.now),
    overall: null,
  }
  product.overall = overallOf(product.dimensions)

  const names = new Set<string>(schema.meta.domains ?? [])
  for (const n of measurable) if (n.domain) names.add(n.domain)

  const domains = [...names].sort().map((domain) => {
    // Outcomes are excluded from the population but their existence is
    // still what `behavior` measures, so the per-domain slice keeps them
    // available to `measure` via the full node list below.
    const own = schema.nodes.filter((n) => n.domain === domain)
    const subjects = own.filter((n) => n.type !== 'outcome')
    const entry: DomainCoverage = {
      domain,
      nodeCount: subjects.length,
      dimensions: measure(subjects, own, journeyNodeIds, opts.now),
      overall: null,
    }
    entry.overall = overallOf(entry.dimensions)
    return entry
  })

  return {
    product,
    domains,
    unclassifiedNodes: measurable.filter((n) => !n.domain).length,
  }
}
