// ─────────────────────────────────────────────────────────────────
// Human verification.
//
// The spec requires that a person can confirm what the model claims, and
// that doing so durably raises confidence. `human` already outranks every
// other evidence source in SOURCE_TRUST; what was missing was a way to
// record the act and a guarantee it survives the next import.
//
// Verification is additive. It never edits or deletes what an extractor
// found — a human saying "yes, this is right" is a separate claim from
// the static analysis it agrees with, and collapsing the two would lose
// the ability to tell a confirmed fact from an unexamined one.
//
// Pure and deterministic: the timestamp is supplied by the caller rather
// than read from the clock.
// ─────────────────────────────────────────────────────────────────

import type { Evidence, EvidenceAttribution, Node, Schema } from '@/types'

export type VerificationInput = {
  /** Who is confirming. Recorded so a claim can be traced to a person. */
  author: string
  /**
   * Defaults to `self_reported`. Only an authenticated caller may pass
   * `authenticated`, and nothing authenticates callers yet.
   */
  attribution?: EvidenceAttribution
  /** ISO 8601. Passed in so verification stays reproducible in tests. */
  at: string
  /** Optional free-text justification. */
  note?: string
}

/** True when a person has confirmed this entity. */
export const isHumanVerified = (node: Node): boolean =>
  node.evidence?.some((e) => e.source === 'human') === true

/**
 * Record that a person confirmed an entity.
 *
 * Re-verifying replaces that author's previous confirmation rather than
 * appending a duplicate, so repeatedly clicking "verify" cannot inflate
 * the evidence count and make an entity look better-supported than it is.
 */
export function verifyNode(schema: Schema, nodeId: string, input: VerificationInput): Schema {
  const entry: Evidence = {
    source: 'human',
    // Self-reported until an identity system exists. Nothing
    // authenticates anyone today, so this is a claim that someone
    // checked, not proof of it — and `human` is the highest-trust source
    // in the system. Marking it keeps an unaccountable textbox from
    // outranking static analysis and tests. See `trustForEvidence`.
    attribution: input.attribution ?? 'self_reported',
    confidence: 1,
    note: input.note ? `${input.author}: ${input.note}` : `Verified by ${input.author}`,
    verifiedAt: input.at,
  }

  let found = false
  const nodes = schema.nodes.map((n) => {
    if (n.id !== nodeId) return n
    found = true
    const others = (n.evidence ?? []).filter(
      (e) => !(e.source === 'human' && e.note?.startsWith(`${input.author}:`)) &&
             !(e.source === 'human' && e.note === `Verified by ${input.author}`),
    )
    return { ...n, evidence: [...others, entry] }
  })

  return found ? { ...schema, nodes } : schema
}

/** Remove a person's confirmation, e.g. when they change their mind. */
export function unverifyNode(schema: Schema, nodeId: string, author: string): Schema {
  const nodes = schema.nodes.map((n) => {
    if (n.id !== nodeId) return n
    const remaining = (n.evidence ?? []).filter(
      (e) => !(e.source === 'human' &&
        (e.note?.startsWith(`${author}:`) || e.note === `Verified by ${author}`)),
    )
    return { ...n, evidence: remaining.length > 0 ? remaining : undefined }
  })
  return { ...schema, nodes }
}

/**
 * Human evidence carried by a node.
 *
 * Used by the merge engine to preserve confirmations across re-imports:
 * an importer knows nothing about who verified what, and letting its
 * output overwrite the evidence array would silently discard the most
 * valuable knowledge in the system.
 */
export const humanEvidenceOf = (node: Node): Evidence[] =>
  (node.evidence ?? []).filter((e) => e.source === 'human')
