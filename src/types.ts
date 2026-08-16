// ─────────────────────────────────────────────────────────────────
// Schema v1.0 — Codebase Navigator's canonical data model.
//
// Changes vs v0.2:
//   - Links now have stable `id`s (so annotations and diffs can target them)
//   - Every node and link has an `origin` (manual / auto:openapi / auto:codebase)
//   - Nodes can declare `parent` / `children` for semantic zoom (GE-013)
//   - Per-entity `metadata` with named, typed fields (no free-form blobs)
//   - New top-level `linkTypes` registry (parallel to `nodeTypes`)
//   - `meta` tracks data origins and last-updated timestamp
//   - `annotations` reserved for GE-023 (empty in MVP consumers)
//   - `manualOverrides` reserved for GE-007 (per-field override tracking
//     on auto-generated entities; consumers set this via the merge engine)
//
// Closed unions (e.g., Origin, Health) are intentional — a new value
// belongs here, not silently in consumer code. Open registries (nodeTypes,
// linkTypes) stay user-extensible since they are project-specific.
// ─────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = '1.2' as const
export type SchemaVersion = typeof SCHEMA_VERSION

// ─── closed unions ────────────────────────────────────────────

export type Origin = 'manual' | 'auto:openapi' | 'auto:codebase' | 'auto:linker' | 'auto:figma'

export type Health = 'green' | 'yellow' | 'red'

export type PathCategory =
  | 'user_journey'
  | 'data_flow'
  | 'incident'
  | 'onboarding'
  | 'other'

export type AnnotationTarget = 'node' | 'link'

// ─── registries ──────────────────────────────────────────────

export type NodeType = {
  color: string
  label: string
  glow?: number
}

export type LinkType = {
  color: string
  label: string
  dashed?: boolean
  animated?: boolean
}

// ─── entity metadata ─────────────────────────────────────────

export type NodeMetadata = {
  lastModified?: string // ISO 8601
  health?: Health
  team?: string
  tags?: string[]
  externalUrl?: string
  backend?: string
  filePath?: string
  line?: number
}

export type LinkMetadata = {
  bidirectional?: boolean
  conditional?: string // e.g., "only when user.role === 'owner'"
}

// ─── nodes ───────────────────────────────────────────────────

export type Node = {
  id: string
  name: string
  type: string // key into Schema.nodeTypes
  description: string
  group?: string
  owner?: string

  /**
   * Fine-grained domain entity this node represents or processes
   * (e.g. "customer", "payment", "bonus"). In the closed-vocabulary
   * model (GE-115), this always matches an entry in
   * `Schema.meta.entities` — the catalog derived from the OpenAPI
   * spec's `components.schemas`. Codebase nodes inherit via
   * propagation (GE-115b). Undefined means "unclassified".
   */
  entity?: string

  /**
   * Coarse-grained domain grouping (e.g. "customer", "payment",
   * "auth"). Derived from OpenAPI `tags` on API operation nodes and
   * propagated outward along call/implementation edges (GE-115).
   * Always matches an entry in `Schema.meta.domains`.
   */
  domain?: string

  /**
   * True when GE-115b's propagation pass found that ≥ 3 distinct
   * entities route through this node. Hubs are cross-cutting
   * infrastructure (utils, client wrappers, index files) — visually
   * marked by GE-112. Recomputed on every propagation; never a user
   * decision.
   */
  isHub?: boolean

  origin: Origin
  parent?: string | null
  children?: string[]
  collapsed?: boolean
  metadata?: NodeMetadata

  // GE-007: set by the merge engine when a manual edit overrides
  // an auto-generated field. Listed fields are preserved across re-imports.
  manualOverrides?: string[]
}

// ─── links ───────────────────────────────────────────────────

export type Link = {
  id: string
  source: string
  target: string
  label: string
  description: string
  type?: string // key into Schema.linkTypes

  origin: Origin
  weight?: number
  metadata?: LinkMetadata
  manualOverrides?: string[]
}

// ─── paths ───────────────────────────────────────────────────

export type PathStep = {
  nodeId: string
  annotation: string
  duration?: string // "~200ms" | "async" | "manual" | custom
}

export type GuidedPath = {
  id: string
  name: string
  description: string
  color: string
  category?: PathCategory
  steps: PathStep[]
}

// ─── annotations (reserved, GE-023) ──────────────────────────

export type Annotation = {
  id: string
  targetType: AnnotationTarget
  targetId: string
  author: string
  text: string
  createdAt: string // ISO 8601
  parentId?: string // one-level reply chain
}

// ─── schema envelope ─────────────────────────────────────────

export type SchemaMeta = {
  name: string
  version: SchemaVersion
  lastUpdated?: string // ISO 8601
  sources?: Origin[] // which importers have contributed
  /**
   * Canonical catalog of entities for this project. In the closed-
   * vocabulary model (GE-115), derived from OpenAPI
   * `components.schemas` minus wrappers/value-objects/enums. Users
   * curate via the review dialog (GE-116).
   */
  entities?: string[]

  /**
   * Canonical catalog of coarse domains. Derived from OpenAPI `tags`
   * on import (GE-115). Users curate via the review dialog.
   */
  domains?: string[]

  /**
   * ISO timestamp of the last entity-propagation pass (GE-115b).
   * Loaders check this to decide whether propagation needs to run
   * again after a schema load.
   */
  lastPropagationAt?: string
}

export type Schema = {
  meta: SchemaMeta
  nodeTypes: Record<string, NodeType>
  linkTypes: Record<string, LinkType>
  nodes: Node[]
  links: Link[]
  paths: GuidedPath[]
  annotations: Annotation[]
}

// ─── validator result ────────────────────────────────────────

export type ValidationError =
  | { kind: 'duplicate_node_id'; id: string }
  | { kind: 'duplicate_link_id'; id: string }
  | { kind: 'link_missing_source_node'; linkId: string; source: string }
  | { kind: 'link_missing_target_node'; linkId: string; target: string }
  | { kind: 'node_type_not_registered'; nodeId: string; type: string }
  | { kind: 'link_type_not_registered'; linkId: string; type: string }
  | { kind: 'node_missing_required_field'; nodeId: string; field: string }
  | { kind: 'link_missing_required_field'; linkId: string; field: string }
  | { kind: 'parent_missing'; nodeId: string; parent: string }
  | { kind: 'child_missing'; nodeId: string; child: string }
  | { kind: 'parent_child_inconsistent'; parentId: string; childId: string; reason: string }
  | { kind: 'path_step_missing_node'; pathId: string; stepIndex: number; nodeId: string }
  | { kind: 'meta_missing_field'; field: string }

export type ValidationResult = {
  ok: boolean
  errors: ValidationError[]
}

// ─── merge result (GE-007) ───────────────────────────────────

export type MergeConflict =
  | {
      kind: 'manual_override_wins'
      entityType: 'node' | 'link'
      entityId: string
      field: string
      kept: unknown
      rejected: unknown
    }
  | {
      kind: 'manual_shadows_auto_candidate'
      entityType: 'node' | 'link'
      entityId: string
    }
  | {
      kind: 'manual_blocks_auto_deletion'
      entityType: 'node'
      entityId: string
      blockedBy: { pathIds: string[]; linkIds: string[] }
    }

export type MergeResult = {
  schema: Schema
  conflicts: MergeConflict[]
}

// ─── v0.2 legacy shapes (for migrate() input only) ───────────

export type LegacyNode = {
  id: string
  name: string
  type: string
  description: string
  group?: string
  owner?: string
}

export type LegacyLink = {
  source: string
  target: string
  label: string
  description: string
  type?: string
}

export type LegacyGuidedPath = {
  id: string
  name: string
  description: string
  color: string
  steps: { nodeId: string; annotation: string }[]
}

export type LegacySchema = {
  meta: { name: string; version: string }
  nodeTypes: Record<string, NodeType>
  nodes: LegacyNode[]
  links: LegacyLink[]
  paths: LegacyGuidedPath[]
}
