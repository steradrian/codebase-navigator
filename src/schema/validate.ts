// ─────────────────────────────────────────────────────────────────
// v1.0 schema validator.
//
// Checks structural invariants that, if violated, would cause silent
// corruption downstream (duplicate IDs, dangling references,
// inconsistent parent/child links). Returns a discriminated result —
// consumers pattern-match on `ok`.
//
// This is the gatekeeper for every data source: importers, merge
// engine, file imports, editor saves. If the validator accepts the
// schema, every other module can trust the shape.
// ─────────────────────────────────────────────────────────────────

import type { Evidence, Schema, ValidationError, ValidationResult } from '@/types'

export function validate(schema: Schema): ValidationResult {
  const errors: ValidationError[] = []

  // ── meta ──
  if (!schema.meta?.name) errors.push({ kind: 'meta_missing_field', field: 'name' })
  if (!schema.meta?.version) errors.push({ kind: 'meta_missing_field', field: 'version' })

  // ── node IDs: uniqueness + required fields + type registry ──
  const nodeIds = new Set<string>()
  for (const n of schema.nodes) {
    if (!n.id) {
      errors.push({ kind: 'node_missing_required_field', nodeId: '<unknown>', field: 'id' })
      continue
    }
    if (nodeIds.has(n.id)) {
      errors.push({ kind: 'duplicate_node_id', id: n.id })
      continue
    }
    nodeIds.add(n.id)

    if (!n.name) errors.push({ kind: 'node_missing_required_field', nodeId: n.id, field: 'name' })
    if (!n.type) errors.push({ kind: 'node_missing_required_field', nodeId: n.id, field: 'type' })
    if (n.description === undefined || n.description === null) {
      errors.push({ kind: 'node_missing_required_field', nodeId: n.id, field: 'description' })
    }
    if (!n.origin) errors.push({ kind: 'node_missing_required_field', nodeId: n.id, field: 'origin' })

    if (n.type && !schema.nodeTypes[n.type]) {
      errors.push({ kind: 'node_type_not_registered', nodeId: n.id, type: n.type })
    }
  }

  // ── link IDs: uniqueness + required fields + refs + type registry ──
  const linkIds = new Set<string>()
  for (const l of schema.links) {
    if (!l.id) {
      errors.push({ kind: 'link_missing_required_field', linkId: '<unknown>', field: 'id' })
      continue
    }
    if (linkIds.has(l.id)) {
      errors.push({ kind: 'duplicate_link_id', id: l.id })
      continue
    }
    linkIds.add(l.id)

    if (!l.source) errors.push({ kind: 'link_missing_required_field', linkId: l.id, field: 'source' })
    if (!l.target) errors.push({ kind: 'link_missing_required_field', linkId: l.id, field: 'target' })
    if (!l.origin) errors.push({ kind: 'link_missing_required_field', linkId: l.id, field: 'origin' })

    if (l.source && !nodeIds.has(l.source)) {
      errors.push({ kind: 'link_missing_source_node', linkId: l.id, source: l.source })
    }
    if (l.target && !nodeIds.has(l.target)) {
      errors.push({ kind: 'link_missing_target_node', linkId: l.id, target: l.target })
    }
    if (l.type && !schema.linkTypes[l.type]) {
      errors.push({ kind: 'link_type_not_registered', linkId: l.id, type: l.type })
    }
  }

  // ── parent/child bidirectional consistency ──
  const nodeById = new Map(schema.nodes.map((n) => [n.id, n]))
  for (const n of schema.nodes) {
    if (n.parent) {
      const parent = nodeById.get(n.parent)
      if (!parent) {
        errors.push({ kind: 'parent_missing', nodeId: n.id, parent: n.parent })
      } else if (!parent.children?.includes(n.id)) {
        errors.push({
          kind: 'parent_child_inconsistent',
          parentId: parent.id,
          childId: n.id,
          reason: `node "${n.id}" names "${parent.id}" as parent but is not listed in parent.children`,
        })
      }
    }
    if (n.children) {
      for (const childId of n.children) {
        const child = nodeById.get(childId)
        if (!child) {
          errors.push({ kind: 'child_missing', nodeId: n.id, child: childId })
        } else if (child.parent !== n.id) {
          errors.push({
            kind: 'parent_child_inconsistent',
            parentId: n.id,
            childId,
            reason: `node "${n.id}" lists "${childId}" as a child but child.parent is ${JSON.stringify(child.parent)}`,
          })
        }
      }
    }
  }

  // ── paths: step refs must resolve to nodes ──
  for (const p of schema.paths) {
    p.steps.forEach((step, i) => {
      if (!nodeIds.has(step.nodeId)) {
        errors.push({ kind: 'path_step_missing_node', pathId: p.id, stepIndex: i, nodeId: step.nodeId })
      }
    })
  }

  // ── journeys (v1.3) ──
  const journeyIds = new Set<string>()
  for (const j of schema.journeys ?? []) {
    if (journeyIds.has(j.id)) {
      errors.push({ kind: 'duplicate_journey_id', id: j.id })
      continue
    }
    journeyIds.add(j.id)

    // Step ids must be unique *within* the journey — transitions
    // address steps by bare id, so a duplicate makes every transition
    // touching it ambiguous.
    const stepIds = new Set<string>()
    for (const step of j.steps) {
      if (stepIds.has(step.id)) {
        errors.push({ kind: 'journey_duplicate_step_id', journeyId: j.id, stepId: step.id })
        continue
      }
      stepIds.add(step.id)

      if (step.nodeId && !nodeIds.has(step.nodeId)) {
        errors.push({
          kind: 'journey_step_missing_node',
          journeyId: j.id,
          stepId: step.id,
          nodeId: step.nodeId,
        })
      }

      // `outcome` is only meaningful on outcome steps, and an outcome
      // step without one is unanswerable for "show every outcome".
      if (step.outcome && step.kind !== 'outcome') {
        errors.push({ kind: 'journey_outcome_on_non_outcome_step', journeyId: j.id, stepId: step.id })
      }
      if (step.kind === 'outcome' && !step.outcome) {
        errors.push({ kind: 'journey_outcome_step_missing_outcome', journeyId: j.id, stepId: step.id })
      }

      checkEvidence(step.evidence, 'journey_step', step.id, errors)
    }

    for (const t of j.transitions) {
      if (!stepIds.has(t.from)) {
        errors.push({
          kind: 'journey_transition_missing_step',
          journeyId: j.id,
          transitionId: t.id,
          stepId: t.from,
        })
      }
      if (!stepIds.has(t.to)) {
        errors.push({
          kind: 'journey_transition_missing_step',
          journeyId: j.id,
          transitionId: t.id,
          stepId: t.to,
        })
      }
      checkEvidence(t.evidence, 'journey_transition', t.id, errors)
    }

    for (const entryId of j.entryStepIds ?? []) {
      if (!stepIds.has(entryId)) {
        errors.push({ kind: 'journey_entry_step_missing', journeyId: j.id, stepId: entryId })
      }
    }
  }

  // ── evidence confidence bounds (v1.3) ──
  for (const n of schema.nodes) checkEvidence(n.evidence, 'node', n.id, errors)
  for (const l of schema.links) checkEvidence(l.evidence, 'link', l.id, errors)

  return { ok: errors.length === 0, errors }
}

/**
 * Confidence is a probability, and downstream ranking multiplies by it.
 * An out-of-range value silently distorts every projection it touches,
 * so it is rejected at the gate rather than clamped quietly.
 *
 * `undefined` confidence is legal and means "unscored" — deliberately
 * distinct from 0, which means "we believe this is false".
 */
function checkEvidence(
  evidence: Evidence[] | undefined,
  entityType: 'node' | 'link' | 'journey_step' | 'journey_transition',
  entityId: string,
  errors: ValidationError[],
): void {
  for (const e of evidence ?? []) {
    if (e.confidence === undefined) continue
    if (!Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) {
      errors.push({
        kind: 'evidence_confidence_out_of_range',
        entityType,
        entityId,
        confidence: e.confidence,
      })
    }
  }
}
