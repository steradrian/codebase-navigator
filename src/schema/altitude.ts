// ─────────────────────────────────────────────────────────────────
// Semantic-zoom altitude assignment (v1.3).
//
// Assigns every node one of six tiers, coarse → fine, so the UI can
// change magnification rather than navigate pages.
//
// Two decisions are load-bearing, both taken after the naive design
// was stress-tested against what the importers actually emit:
//
//   1. Altitude is NOT derived from `parent`/`children`. That tree is
//      populated only by `wireHierarchy()` for the bundled demo data;
//      a freshly imported OpenAPI or codebase schema has an empty
//      hierarchy, so a tree walk would silently collapse every tier
//      into whichever one happened to exist.
//
//   2. `product` and `domain` are not assigned to any real node. No
//      importer emits nodes at those tiers — OpenAPI produces `api`
//      and `database`, the codebase reader produces `page`/`layout`/
//      `client`/`hook`/`component`/`util`/`ui`. Those two tiers are
//      synthesised by the projection layer from `meta.name` and
//      `meta.domains`. Materialising them here would mean registering
//      synthetic node types, re-synthesising on every merge, and
//      emitting phantom diff entries.
//
// What holds a zoom sequence together is therefore not tree position
// but the *subject key* — the propagated (domain, entity) pair that
// stays fixed while the member set changes underneath it.
//
// Pure and deterministic: no clock, no randomness, sorted outputs.
// ─────────────────────────────────────────────────────────────────

import type { Altitude, Node, Schema } from '@/types'

/** Canonical coarse → fine ordering. */
export const ALTITUDE_ORDER: readonly Altitude[] = [
  'product',
  'domain',
  'behavior',
  'system',
  'implementation',
  'code',
] as const

/**
 * Tier for each node `type` the importers and demo data actually emit.
 *
 * `behavior` means "a thing the product does": an HTTP operation, a Go
 * handler, a Next.js route. `system` means "a durable part the product
 * is built from": stores, services, and cross-cutting infrastructure.
 * `implementation` is the file level.
 */
const ALTITUDE_BY_NODE_TYPE: Readonly<Record<string, Altitude>> = {
  // demo-data / hand-authored tiers
  domain: 'domain',
  feature: 'behavior',

  // OpenAPI + backend importers
  api: 'behavior',
  database: 'system',
  service: 'system',
  external: 'system',

  // codebase importer (see classify() in importers/codebase/index.ts)
  page: 'implementation',
  layout: 'implementation',
  client: 'implementation',
  hook: 'implementation',
  component: 'implementation',
  util: 'implementation',
  ui: 'implementation',
}

/**
 * Where an unrecognised node type lands. `implementation` because an
 * unknown type is overwhelmingly likely to be a code artifact, and
 * because over-promoting unknowns would let them crowd the coarse
 * tiers where the user expects a curated handful.
 */
const FALLBACK_ALTITUDE: Altitude = 'implementation'

/**
 * Altitude for a single node, ignoring manual overrides.
 *
 * A hub outranks its type: `isHub` already asserts that three or more
 * distinct entities route through the node, which is the definition of
 * cross-cutting infrastructure. A hub util is part of the system, not
 * an implementation detail of any one feature.
 */
export function altitudeForNode(node: Node): Altitude {
  if (node.isHub) return 'system'
  return ALTITUDE_BY_NODE_TYPE[node.type] ?? FALLBACK_ALTITUDE
}

const emptyCoverage = (): Record<Altitude, number> => ({
  product: 0,
  domain: 0,
  behavior: 0,
  system: 0,
  implementation: 0,
  code: 0,
})

/**
 * Assign `altitude` to every node and record tier coverage on `meta`.
 *
 * Idempotent: running it twice produces the same schema. Nodes listing
 * `'altitude'` in `manualOverrides` keep their existing value, matching
 * how the merge engine protects every other hand-corrected field.
 */
export function assignAltitudes(schema: Schema): Schema {
  const unmapped = new Set<string>()

  const nodes = schema.nodes.map((n) => {
    if (n.manualOverrides?.includes('altitude') && n.altitude) return n

    if (!n.isHub && !(n.type in ALTITUDE_BY_NODE_TYPE)) unmapped.add(n.type)

    const altitude = altitudeForNode(n)
    return n.altitude === altitude ? n : { ...n, altitude }
  })

  const coverage = emptyCoverage()
  for (const n of nodes) coverage[n.altitude ?? FALLBACK_ALTITUDE] += 1

  // `product` and `domain` are synthesised rather than stored, so their
  // coverage reflects what the projection layer will be able to build:
  // one product node when the schema is named, and one domain node per
  // catalogued domain, unioned with any hand-authored domain nodes.
  coverage.product = schema.meta.name ? 1 : 0

  const synthesisableDomains = new Set(schema.meta.domains ?? [])
  for (const n of nodes) {
    if (n.altitude === 'domain' && n.name) synthesisableDomains.add(n.name)
  }
  coverage.domain = synthesisableDomains.size

  return {
    ...schema,
    nodes,
    meta: {
      ...schema.meta,
      altitudeCoverage: coverage,
      altitudeUnmappedTypes: unmapped.size > 0 ? [...unmapped].sort() : undefined,
    },
  }
}

/**
 * Tiers that have at least one member.
 *
 * The zoom control must disable the rest rather than quietly resolving
 * to a neighbour — an altitude selector that claims to show `code` while
 * actually showing `implementation` misrepresents the granularity of
 * everything on screen.
 */
export function populatedAltitudes(schema: Schema): Altitude[] {
  const coverage = schema.meta.altitudeCoverage
  if (!coverage) return []
  return ALTITUDE_ORDER.filter((a) => coverage[a] > 0)
}

/**
 * Nearest populated tier to `requested`, or null when none exists.
 *
 * Callers are expected to surface the substitution explicitly. Ties
 * resolve toward the finer tier, which is the safer direction: showing
 * more detail than asked is recoverable by zooming out, whereas
 * silently showing less hides the very thing the user zoomed in for.
 */
export function nearestPopulatedAltitude(
  schema: Schema,
  requested: Altitude,
): Altitude | null {
  const populated = populatedAltitudes(schema)
  if (populated.length === 0) return null
  if (populated.includes(requested)) return requested

  const target = ALTITUDE_ORDER.indexOf(requested)
  let best: Altitude | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of populated) {
    const distance = Math.abs(ALTITUDE_ORDER.indexOf(candidate) - target)
    const finer = ALTITUDE_ORDER.indexOf(candidate) > target
    if (distance < bestDistance || (distance === bestDistance && finer)) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}
