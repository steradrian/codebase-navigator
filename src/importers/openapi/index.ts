// ─────────────────────────────────────────────────────────────────
// OpenAPI v3 importer.
//
// Pure function: spec in, candidate v1.0 Schema out. No side effects,
// no I/O. Every emitted entity carries `origin: "auto:openapi"`. IDs
// are deterministic — re-parsing the same spec produces byte-identical
// output, which is what makes the merge engine (GE-007) trustworthy.
//
// What gets translated:
//   - `components.schemas[*]`         → database nodes
//   - `paths[*][method]`              → api nodes
//   - $ref within schema properties   → dependency links
//   - request body $ref               → data_flow (api → schema)
//   - response body $ref              → data_flow (schema → api)
//   - OpenAPI tags                    → groups on api nodes
//
// What gets skipped (with warnings):
//   - External refs (any ref not starting with "#/")
//   - Unresolvable local refs
//   - Inline request/response schemas (no $ref, no node to link to)
//
// Not supported (by design):
//   - OpenAPI v2 / Swagger
//   - x-* extensions
//   - components.parameters, components.responses, components.requestBodies
// ─────────────────────────────────────────────────────────────────

import { linkId } from '@/schema/migrate'
import type {
  Link,
  LinkType,
  Node,
  Origin,
  Schema,
} from '@/types'
import { SCHEMA_VERSION } from '@/types'
import {
  buildEntityCatalog,
  resolveOperationEntity,
} from '@/schema/entity/catalog'
import { propagateEntities } from '@/schema/entity/propagate'
import { assignAltitudes } from '@/schema/altitude'
import type {
  OpenAPIOperation,
  OpenAPIPathItem,
  OpenAPIRef,
  OpenAPISchemaOrRef,
  OpenAPISpec,
  ParseError,
  ParseResult,
  ParseWarning,
} from '@/importers/openapi/types'

const ORIGIN: Origin = 'auto:openapi'
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const

// Reuse the same visual registry v0.2 ships with so auto-imports feel
// native rather than stylistically foreign.
const DEFAULT_NODE_TYPES: Record<string, { color: string; label: string; glow?: number }> = {
  domain: { color: '#ff4081', label: 'Domain', glow: 0.15 },
  database: { color: '#00e5ff', label: 'Database', glow: 0.1 },
  service: { color: '#ff6e40', label: 'Service', glow: 0.12 },
  feature: { color: '#b388ff', label: 'Feature', glow: 0.1 },
  api: { color: '#69f0ae', label: 'API', glow: 0.1 },
  client: { color: '#26c6da', label: 'Client', glow: 0.1 },
  hook: { color: '#ce93d8', label: 'Hook', glow: 0.1 },
  component: { color: '#ffd740', label: 'Component', glow: 0.1 },
  page: { color: '#ffab40', label: 'Page', glow: 0.1 },
  layout: { color: '#ff8a65', label: 'Layout', glow: 0.08 },
  util: { color: '#90a4ae', label: 'Util', glow: 0.06 },
  ui: { color: '#ffd740', label: 'UI', glow: 0.1 },
  external: { color: '#78909c', label: 'External', glow: 0.06 },
}

const DEFAULT_LINK_TYPES: Record<string, LinkType> = {
  data_flow: { color: '#1a4a6c', label: 'Data Flow', animated: true },
  dependency: { color: '#3a2a5c', label: 'Dependency', dashed: true },
  triggers: { color: '#4a3a1c', label: 'Triggers', animated: true },
}

// ─── helpers ─────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isRef = (v: unknown): v is OpenAPIRef =>
  isObj(v) && typeof v.$ref === 'string'

/** Namespaced ID for a schema-derived node. */
const schemaNodeId = (name: string): string =>
  `openapi:schema:${name.toLowerCase()}`

/** Namespaced ID for a path×method-derived API node. Paths are sanitized. */
const apiNodeId = (method: string, path: string): string => {
  const safePath = path.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '')
  return `openapi:op:${method.toLowerCase()}:${safePath || 'root'}`
}

/** Resolve a local $ref to its schema name, or null if external / malformed. */
const refToSchemaName = (ref: string): string | null => {
  if (!ref.startsWith('#/components/schemas/')) return null
  const name = ref.slice('#/components/schemas/'.length)
  return name.length > 0 ? name : null
}

/** Walk a schema value and yield every $ref string found at any level. */
function collectRefs(s: OpenAPISchemaOrRef | undefined): string[] {
  if (!s) return []
  if (isRef(s)) return [s.$ref]
  const out: string[] = []
  if (s.properties) {
    for (const prop of Object.values(s.properties)) out.push(...collectRefs(prop))
  }
  if (s.items) out.push(...collectRefs(s.items))
  if (s.oneOf) for (const b of s.oneOf) out.push(...collectRefs(b))
  if (s.anyOf) for (const b of s.anyOf) out.push(...collectRefs(b))
  if (s.allOf) for (const b of s.allOf) out.push(...collectRefs(b))
  return out
}

// ─── public entry ────────────────────────────────────────────

export function parseOpenAPI(spec: unknown): ParseResult {
  const errors: ParseError[] = []
  const warnings: ParseWarning[] = []

  if (!isObj(spec)) {
    return { ok: false, schema: null, errors: [{ kind: 'not_an_object' }], warnings: [] }
  }
  if (typeof spec.openapi !== 'string') {
    return { ok: false, schema: null, errors: [{ kind: 'missing_openapi_version' }], warnings: [] }
  }
  if (!spec.openapi.startsWith('3.')) {
    return {
      ok: false,
      schema: null,
      errors: [{ kind: 'unsupported_openapi_version', version: spec.openapi }],
      warnings: [],
    }
  }

  const typedSpec = spec as unknown as OpenAPISpec

  const nodes: Node[] = []
  const links: Link[] = []
  const seenNodeIds = new Set<string>()
  const seenLinkIds = new Set<string>()

  const addNode = (n: Node): void => {
    if (seenNodeIds.has(n.id)) return
    seenNodeIds.add(n.id)
    nodes.push(n)
  }
  const addLink = (l: Link): void => {
    if (seenLinkIds.has(l.id)) return
    seenLinkIds.add(l.id)
    links.push(l)
  }

  const schemas = typedSpec.components?.schemas ?? {}
  const schemaNames = new Set(Object.keys(schemas))

  // GE-115: build the closed-vocabulary catalog up front. Used to
  // decide which schemas become database nodes and to resolve
  // operation → entity.
  const catalog = buildEntityCatalog(typedSpec)

  // A schema is "kept" (gets a database node) iff it's in the
  // catalog — i.e. it's an entity, not a wrapper / value object / enum.
  // Multiple wrapper schemas collapse into one canonical entity node.
  const emittedByEntity = new Map<string, string>() // entity name → node id (first schema seen)
  for (const [name] of Object.entries(schemas)) {
    const entity = catalog.schemaToEntity.get(name)
    if (!entity) continue
    // Only emit a database node once per canonical entity. Prefer the
    // schema whose normalized name equals the entity (i.e. the non-
    // wrapper variant).
    if (emittedByEntity.has(entity)) continue
    emittedByEntity.set(entity, schemaNodeId(name))
  }
  // Second pass: for each canonical entity, find the "best" source schema
  // (prefer non-wrapper) and emit.
  const entityToSourceName = new Map<string, string>()
  for (const entry of catalog.entities) {
    const best = entry.sources.find((s) => !s.endsWith('Request') && !s.endsWith('Response') && !s.endsWith('Params') && !s.endsWith('Options') && !s.endsWith('Dto'))
      ?? entry.sources[0]
    entityToSourceName.set(entry.name, best)
  }

  // ── 1. canonical entity schemas → database nodes ──
  for (const entry of catalog.entities) {
    const sourceName = entityToSourceName.get(entry.name)
    if (!sourceName) continue
    const schemaDef = schemas[sourceName]
    addNode({
      id: schemaNodeId(sourceName),
      name: sourceName,
      type: 'database',
      description: schemaDef?.description || `Schema: ${sourceName}`,
      group: 'data',
      origin: ORIGIN,
      entity: entry.name,
    })
  }

  // Helper: given a schema name (possibly a wrapper), return the node
  // id of the database node that represents its canonical entity. Used
  // when creating data_flow links so wrapper refs still land at the
  // right node.
  const nodeIdForSchema = (name: string): string | null => {
    const entity = catalog.schemaToEntity.get(name)
    if (!entity) return null
    const canonicalSource = entityToSourceName.get(entity)
    return canonicalSource ? schemaNodeId(canonicalSource) : null
  }

  // ── 2. $ref relationships between schemas → dependency links ──
  for (const [name, schemaDef] of Object.entries(schemas)) {
    const from = nodeIdForSchema(name)
    if (!from) continue // filtered schema — no node, no link
    const refs = collectRefs(schemaDef)
    for (const ref of refs) {
      if (!ref.startsWith('#/')) {
        warnings.push({ kind: 'external_ref_skipped', from, ref })
        continue
      }
      const targetName = refToSchemaName(ref)
      if (!targetName || !schemaNames.has(targetName)) {
        warnings.push({ kind: 'unresolved_local_ref', from, ref })
        continue
      }
      const to = nodeIdForSchema(targetName)
      if (!to || from === to) continue // filtered target or self-ref
      addLink({
        id: linkId(from, to, 'dependency'),
        source: from,
        target: to,
        label: 'references',
        description: `${name} references ${targetName}`,
        type: 'dependency',
        origin: ORIGIN,
      })
    }
  }

  // ── 3. paths × methods → API nodes ──
  const paths = typedSpec.paths ?? {}
  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!isObj(pathItem)) continue
    const item = pathItem as OpenAPIPathItem
    for (const method of HTTP_METHODS) {
      const op = item[method]
      if (!op) continue

      const id = apiNodeId(method, pathStr)
      const tag = op.tags?.[0] ?? 'api'
      const name = `${method.toUpperCase()} ${pathStr}`
      const desc = op.summary || op.description || name

      const resolution = resolveOperationEntity(op, catalog)

      addNode({
        id,
        name,
        type: 'api',
        description: desc,
        group: tag,
        origin: ORIGIN,
        entity: resolution.entity,
        domain: resolution.domain,
      })

      // Request body → data_flow (api → schema)
      collectBodyLinks(op, id, nodeIdForSchema, 'request').forEach(addLink)
      collectBodyLinks(op, id, nodeIdForSchema, 'response').forEach(addLink)
    }
  }

  // ── 4. assemble schema ──
  // Sort for deterministic output regardless of input key order.
  nodes.sort((a, b) => a.id.localeCompare(b.id))
  links.sort((a, b) => a.id.localeCompare(b.id))

  const result: Schema = {
    meta: {
      name: typedSpec.info?.title || 'Imported from OpenAPI',
      version: SCHEMA_VERSION,
      sources: [ORIGIN],
      entities: catalog.entities.map((e) => e.name),
      domains: catalog.domains,
    },
    nodeTypes: DEFAULT_NODE_TYPES,
    linkTypes: DEFAULT_LINK_TYPES,
    nodes,
    links,
    paths: [],
    annotations: [],
  }

  // GE-115b — propagate entities through the graph so DB↔API edges
  // reinforce each other. Pure and idempotent.
  const propagated = assignAltitudes(propagateEntities(result))

  return { ok: errors.length === 0, schema: propagated, errors, warnings }
}

// ─── helpers for body-link extraction ────────────────────────

type BodyDirection = 'request' | 'response'

function collectBodyLinks(
  op: OpenAPIOperation,
  apiId: string,
  nodeIdForSchema: (name: string) => string | null,
  direction: BodyDirection,
): Link[] {
  const out: Link[] = []
  const seen = new Set<string>() // dedupe: same canonical target reached via multiple wrappers

  const addFromMediaMap = (media: Record<string, { schema?: OpenAPISchemaOrRef }> | undefined): void => {
    if (!media) return
    for (const mt of Object.values(media)) {
      const refs = collectRefs(mt.schema)
      for (const ref of refs) {
        const schemaName = refToSchemaName(ref)
        if (!schemaName) continue
        const schemaId = nodeIdForSchema(schemaName)
        if (!schemaId) continue
        const source = direction === 'request' ? apiId : schemaId
        const target = direction === 'request' ? schemaId : apiId
        const id = linkId(source, target, 'data_flow')
        if (seen.has(id)) continue
        seen.add(id)
        out.push({
          id,
          source,
          target,
          label: direction === 'request' ? 'accepts' : 'returns',
          description: direction === 'request'
            ? `Request body references ${schemaName}`
            : `Response body references ${schemaName}`,
          type: 'data_flow',
          origin: ORIGIN,
        })
      }
    }
  }

  if (direction === 'request') {
    const body = op.requestBody
    if (body && !isRef(body)) addFromMediaMap(body.content)
  } else {
    const responses = op.responses ?? {}
    for (const resp of Object.values(responses)) {
      if (resp && !isRef(resp)) addFromMediaMap(resp.content)
    }
  }

  return out
}
