// ─────────────────────────────────────────────────────────────────
// OpenAPI response codes → behavioural outcomes.
//
// The Behavior lens promises "show me every possible outcome" — success,
// validation failure, permission denied, rate limited, and the rest.
// Until now nothing produced that data and `OutcomeKind` had no
// producers at all.
//
// It turns out a large part of the answer is already declared in the
// spec we parse. Entity resolution reads only 2xx codes, because all it
// needs is the success payload's shape; every 4xx and 5xx the API author
// wrote down was dropped on the floor. On one real spec that is 56
// declared error responses across 50 operations.
//
// This module turns each declared response into an addressable outcome
// node hanging off its operation. The mapping is a translation of what
// the author already stated, not an inference: an operation that
// declares 401 genuinely can deny permission. Nothing is invented — a
// status code with no clear meaning is reported as unmapped rather than
// guessed at.
//
// Pure and deterministic.
// ─────────────────────────────────────────────────────────────────

import type { Link, Node, OutcomeKind } from '@/types'
import type { OpenAPIOperation, OpenAPIResponse, OpenAPIRef } from './types'

export type OutcomeWarning = { kind: 'unmapped_status'; operation: string; status: string }

export type OutcomeResult = {
  nodes: Node[]
  links: Link[]
  warnings: OutcomeWarning[]
}

/** Link type connecting an operation to one of its declared outcomes. */
export const OUTCOME_LINK_TYPE = 'outcome'

/**
 * HTTP status → outcome vocabulary.
 *
 * Exact codes only. Ranges are handled below for the cases where the
 * class genuinely determines the meaning (2xx succeeds, 5xx is a server
 * fault); everything else must be listed explicitly, because guessing at
 * a code's intent is exactly the kind of invented certainty this product
 * is supposed to refuse.
 */
const KIND_BY_STATUS: Readonly<Record<string, OutcomeKind>> = {
  '400': 'validation_error',
  '401': 'permission_denied',
  '403': 'permission_denied',
  '404': 'not_found',
  '405': 'validation_error',
  '408': 'timeout',
  '409': 'conflict',
  '410': 'not_found',
  '412': 'conflict',
  '415': 'validation_error',
  '422': 'validation_error',
  '423': 'conflict',
  '428': 'conflict',
  '429': 'rate_limited',
  '499': 'cancelled',
  '504': 'timeout',
}

/** Human label per outcome, used when the spec supplies no description. */
const LABEL_BY_KIND: Readonly<Record<OutcomeKind, string>> = {
  success: 'Success',
  validation_error: 'Validation failed',
  permission_denied: 'Permission denied',
  not_found: 'Not found',
  conflict: 'Conflict',
  rate_limited: 'Rate limited',
  timeout: 'Timed out',
  server_error: 'Server error',
  cancelled: 'Cancelled',
  partial: 'Partial success',
}

/**
 * The outcome a status code represents, or null when its meaning is not
 * determinable. `default` returns null on purpose: OpenAPI defines it as
 * "any response not otherwise listed", which is not a specific outcome.
 */
export function outcomeKindForStatus(status: string): OutcomeKind | null {
  const code = status.trim()
  const exact = KIND_BY_STATUS[code]
  if (exact) return exact

  const numeric = Number.parseInt(code, 10)
  if (!Number.isFinite(numeric)) return null
  if (numeric >= 200 && numeric < 300) return 'success'
  if (numeric >= 500 && numeric < 600) return 'server_error'
  // Remaining 4xx codes carry no single agreed meaning; do not guess.
  return null
}

export function outcomeNodeId(operationNodeId: string, status: string): string {
  return `${operationNodeId}:outcome:${status}`
}

const responseDescription = (response: OpenAPIResponse | OpenAPIRef | undefined): string | null => {
  if (!response || typeof response !== 'object') return null
  const described = response as { description?: unknown }
  return typeof described.description === 'string' && described.description.trim() !== ''
    ? described.description.trim()
    : null
}

/**
 * Emit an outcome node per declared response, plus the edge tying it to
 * its operation.
 *
 * `entity` and `domain` are inherited from the operation so an outcome
 * participates in the same subject key its operation belongs to, and
 * therefore survives entity-scoped filtering and semantic zoom.
 */
export function extractOutcomes(
  operation: OpenAPIOperation,
  operationNodeId: string,
  operationName: string,
  inherited: { entity?: string; domain?: string; group?: string },
): OutcomeResult {
  const nodes: Node[] = []
  const links: Link[] = []
  const warnings: OutcomeWarning[] = []

  const responses = operation.responses
  if (!responses) return { nodes, links, warnings }

  // Sorted so output does not depend on key order in the source document.
  for (const status of Object.keys(responses).sort()) {
    const kind = outcomeKindForStatus(status)
    if (!kind) {
      warnings.push({ kind: 'unmapped_status', operation: operationName, status })
      continue
    }

    const id = outcomeNodeId(operationNodeId, status)
    const described = responseDescription(responses[status])

    nodes.push({
      id,
      name: `${status} ${LABEL_BY_KIND[kind]}`,
      type: 'outcome',
      // Prefer the API author's own wording; fall back to a plain
      // statement of what the code means rather than inventing detail.
      description: described ?? `${operationName} can return ${status}.`,
      origin: 'auto:openapi',
      group: inherited.group,
      entity: inherited.entity,
      domain: inherited.domain,
      metadata: { outcomeKind: kind },
      evidence: [
        {
          source: 'static_analysis',
          // The response is literally declared in the specification.
          confidence: 1,
          note: `Declared as response ${status} of ${operationName}`,
        },
      ],
    })

    links.push({
      id: `${operationNodeId}__${OUTCOME_LINK_TYPE}__${id}`,
      source: operationNodeId,
      target: id,
      label: 'can result in',
      description: `${operationName} can result in ${status} ${LABEL_BY_KIND[kind]}.`,
      type: OUTCOME_LINK_TYPE,
      origin: 'auto:openapi',
      evidence: [
        {
          source: 'static_analysis',
          confidence: 1,
          note: `Declared as response ${status} of ${operationName}`,
        },
      ],
    })
  }

  return { nodes, links, warnings }
}
