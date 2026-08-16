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

import type { Schema, ValidationError, ValidationResult } from '@/types'

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

  return { ok: errors.length === 0, errors }
}
