// ─────────────────────────────────────────────────────────────────
// Runtime evidence.
//
// Runtime was the last lens with no producer, and unlike the others it
// cannot be recovered from the repository — nothing in the source says
// what actually happened when the code ran. It needs an observation, so
// this reads two that a developer can obtain in a minute: a HAR export
// from browser devtools, and an OTLP span export from any OpenTelemetry
// collector.
//
// The valuable output is not "this endpoint was called". It is the
// disagreement: an operation that returned a status its specification
// never declared is the clearest possible signal that the model of the
// system and the system itself have diverged. That is what the spec
// means by "static model predicts A → B → C, runtime observed A → B →
// D", and it is only visible once real traffic is compared against
// declared outcomes.
//
// Matching observed URLs to templated operation paths is the crux:
// traffic contains `/api/player/payments/8213`, the specification
// declares `/api/player/payments/{id}`. Without that translation runtime
// evidence attaches to nothing.
//
// Pure and deterministic — parsing and application are separate, and
// neither reads the clock or the network.
// ─────────────────────────────────────────────────────────────────

import type { Evidence, Node, OutcomeKind, Schema } from '@/types'

export type RuntimeObservation = {
  method: string
  /** Path only, query string stripped. */
  path: string
  status: number
  durationMs?: number
  /** ISO 8601, when the source recorded one. */
  at?: string
}

export type RuntimeParseWarning =
  | { kind: 'malformed_entry'; index: number; reason: string }
  | { kind: 'unsupported_shape'; reason: string }

export type RuntimeParseResult = {
  observations: RuntimeObservation[]
  warnings: RuntimeParseWarning[]
}

/** An operation observed returning something it never declared. */
export type RuntimeMismatch = {
  operationId: string
  operationName: string
  observedStatus: number
  observedCount: number
  /** Statuses the specification does declare, for contrast. */
  declaredStatuses: string[]
}

export type ApplyRuntimeResult = {
  schema: Schema
  mismatches: RuntimeMismatch[]
  stats: {
    observations: number
    matchedOperations: number
    unmatchedObservations: number
  }
}

const pathOf = (rawUrl: string): string | null => {
  try {
    // Absolute URLs parse directly; relative ones need a base that is
    // then discarded.
    const url = new URL(rawUrl, 'http://placeholder.invalid')
    return url.pathname
  } catch {
    return null
  }
}

// ─── HAR ─────────────────────────────────────────────────────

type HarLike = {
  log?: {
    entries?: Array<{
      request?: { method?: unknown; url?: unknown }
      response?: { status?: unknown }
      time?: unknown
      startedDateTime?: unknown
    }>
  }
}

/** Parse a HAR export, as produced by browser devtools "Save all as HAR". */
export function parseHar(input: unknown): RuntimeParseResult {
  const observations: RuntimeObservation[] = []
  const warnings: RuntimeParseWarning[] = []

  const entries = (input as HarLike)?.log?.entries
  if (!Array.isArray(entries)) {
    return {
      observations,
      warnings: [{ kind: 'unsupported_shape', reason: 'No log.entries array — is this a HAR file?' }],
    }
  }

  entries.forEach((entry, index) => {
    const method = entry?.request?.method
    const url = entry?.request?.url
    const status = entry?.response?.status
    if (typeof method !== 'string' || typeof url !== 'string' || typeof status !== 'number') {
      warnings.push({ kind: 'malformed_entry', index, reason: 'missing method, url or status' })
      return
    }
    const path = pathOf(url)
    if (!path) {
      warnings.push({ kind: 'malformed_entry', index, reason: `unparseable url: ${url}` })
      return
    }
    observations.push({
      method: method.toUpperCase(),
      path,
      status,
      durationMs: typeof entry.time === 'number' ? entry.time : undefined,
      at: typeof entry.startedDateTime === 'string' ? entry.startedDateTime : undefined,
    })
  })

  return { observations, warnings }
}

// ─── OpenTelemetry ───────────────────────────────────────────

type OtlpAttribute = { key?: unknown; value?: { stringValue?: unknown; intValue?: unknown } }
type OtlpSpan = {
  attributes?: OtlpAttribute[]
  startTimeUnixNano?: unknown
  endTimeUnixNano?: unknown
}
type OtlpLike = {
  resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>
}

const attrValue = (attrs: OtlpAttribute[] | undefined, key: string): string | number | null => {
  for (const a of attrs ?? []) {
    if (a?.key !== key) continue
    if (typeof a.value?.stringValue === 'string') return a.value.stringValue
    if (typeof a.value?.intValue === 'number') return a.value.intValue
    if (typeof a.value?.intValue === 'string') {
      const n = Number.parseInt(a.value.intValue, 10)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

/**
 * Parse an OTLP span export.
 *
 * Reads both the current `http.request.method` / `url.path` attributes
 * and the older `http.method` / `http.target` names, because collectors
 * in the wild still emit either.
 */
export function parseOtel(input: unknown): RuntimeParseResult {
  const observations: RuntimeObservation[] = []
  const warnings: RuntimeParseWarning[] = []

  const resourceSpans = (input as OtlpLike)?.resourceSpans
  if (!Array.isArray(resourceSpans)) {
    return {
      observations,
      warnings: [{ kind: 'unsupported_shape', reason: 'No resourceSpans array — is this an OTLP export?' }],
    }
  }

  let index = 0
  for (const resource of resourceSpans) {
    for (const scope of resource?.scopeSpans ?? []) {
      for (const span of scope?.spans ?? []) {
        index++
        const attrs = span?.attributes
        const method = attrValue(attrs, 'http.request.method') ?? attrValue(attrs, 'http.method')
        const rawPath =
          attrValue(attrs, 'url.path') ??
          attrValue(attrs, 'http.target') ??
          attrValue(attrs, 'http.route')
        const status =
          attrValue(attrs, 'http.response.status_code') ?? attrValue(attrs, 'http.status_code')

        if (typeof method !== 'string' || typeof rawPath !== 'string' || typeof status !== 'number') {
          // Most spans in a real export are not HTTP server spans; only
          // warn when something looks like one but is incomplete.
          if (method || rawPath || status) {
            warnings.push({ kind: 'malformed_entry', index, reason: 'incomplete http attributes' })
          }
          continue
        }

        const path = pathOf(rawPath)
        if (!path) {
          warnings.push({ kind: 'malformed_entry', index, reason: `unparseable path: ${rawPath}` })
          continue
        }

        const start = Number(span.startTimeUnixNano)
        const end = Number(span.endTimeUnixNano)
        const durationMs =
          Number.isFinite(start) && Number.isFinite(end) && end > start
            ? (end - start) / 1_000_000
            : undefined

        observations.push({ method: method.toUpperCase(), path, status, durationMs })
      }
    }
  }

  return { observations, warnings }
}

// ─── matching observations to operations ─────────────────────

/**
 * Regex for a templated operation path.
 *
 * `/api/player/payments/{id}` has to match `/api/player/payments/8213`,
 * because traffic carries concrete values and specifications carry
 * placeholders. A parameter matches one path segment only, so
 * `/a/{id}` does not swallow `/a/b/c`.
 */
export function operationPathMatcher(path: string): RegExp {
  const escaped = path
    .split('/')
    .map((segment) =>
      /^\{.+\}$/.test(segment)
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${escaped}/?$`)
}

type OperationEntry = { node: Node; method: string; matcher: RegExp }

function operationIndex(schema: Schema): OperationEntry[] {
  const entries: OperationEntry[] = []
  for (const node of schema.nodes) {
    if (node.type !== 'api') continue
    // Operation nodes are named "METHOD /path" by the OpenAPI importer.
    const m = node.name.match(/^([A-Z]+)\s+(\/\S*)$/)
    if (!m) continue
    entries.push({ node, method: m[1], matcher: operationPathMatcher(m[2]) })
  }
  // Longest path first, so a concrete route wins over a templated one
  // that would also match it.
  return entries.sort((a, b) => b.node.name.length - a.node.name.length)
}

const OUTCOME_LINK_TYPE = 'outcome'

/** Statuses each operation declares, from its outcome nodes. */
function declaredStatuses(schema: Schema): Map<string, Set<string>> {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]))
  const out = new Map<string, Set<string>>()
  for (const link of schema.links) {
    if (link.type !== OUTCOME_LINK_TYPE) continue
    const outcome = byId.get(link.target)
    if (!outcome) continue
    // Outcome ids end in ":outcome:<status>".
    const status = outcome.id.split(':outcome:')[1]
    if (!status) continue
    const set = out.get(link.source) ?? new Set<string>()
    set.add(status)
    out.set(link.source, set)
  }
  return out
}

const outcomeKindForObservedStatus = (status: number): OutcomeKind =>
  status >= 500 ? 'server_error' : status >= 400 ? 'validation_error' : 'success'

/**
 * Attach runtime evidence to the operations that traffic exercised, and
 * report where reality disagreed with the specification.
 *
 * Evidence is added, never substituted: an observation confirms an
 * operation ran, it does not overwrite what static analysis established
 * about it.
 */
export function applyRuntimeEvidence(
  schema: Schema,
  observations: readonly RuntimeObservation[],
): ApplyRuntimeResult {
  const index = operationIndex(schema)
  const declared = declaredStatuses(schema)

  // operation id → observed status → count
  const observed = new Map<string, Map<number, number>>()
  let unmatched = 0

  for (const obs of observations) {
    const hit = index.find((e) => e.method === obs.method && e.matcher.test(obs.path))
    if (!hit) {
      unmatched++
      continue
    }
    const perStatus = observed.get(hit.node.id) ?? new Map<number, number>()
    perStatus.set(obs.status, (perStatus.get(obs.status) ?? 0) + 1)
    observed.set(hit.node.id, perStatus)
  }

  const mismatches: RuntimeMismatch[] = []
  const nodes = schema.nodes.map((node) => {
    const perStatus = observed.get(node.id)
    if (!perStatus) return node

    const total = [...perStatus.values()].reduce((a, b) => a + b, 0)
    const statuses = [...perStatus.keys()].sort((a, b) => a - b)

    const runtimeEvidence: Evidence = {
      source: 'runtime',
      // Observation is direct: this call was made and returned this.
      confidence: 1,
      note: `Observed ${total} call${total === 1 ? '' : 's'} returning ${statuses.join(', ')}`,
    }

    const kept = (node.evidence ?? []).filter((e) => e.source !== 'runtime')
    return { ...node, evidence: [...kept, runtimeEvidence] }
  })

  for (const [operationId, perStatus] of observed) {
    const node = schema.nodes.find((n) => n.id === operationId)
    if (!node) continue
    const declaredHere = declared.get(operationId) ?? new Set<string>()
    for (const [status, count] of [...perStatus.entries()].sort((a, b) => a[0] - b[0])) {
      if (declaredHere.has(String(status))) continue
      mismatches.push({
        operationId,
        operationName: node.name,
        observedStatus: status,
        observedCount: count,
        declaredStatuses: [...declaredHere].sort(),
      })
    }
  }

  mismatches.sort(
    (a, b) => a.operationId.localeCompare(b.operationId) || a.observedStatus - b.observedStatus,
  )

  return {
    schema: { ...schema, nodes },
    mismatches,
    stats: {
      observations: observations.length,
      matchedOperations: observed.size,
      unmatchedObservations: unmatched,
    },
  }
}

export { outcomeKindForObservedStatus }
