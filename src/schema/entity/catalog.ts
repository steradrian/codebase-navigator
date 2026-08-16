// ─────────────────────────────────────────────────────────────────
// Closed-vocabulary entity + domain catalog (GE-115).
//
// Produces the authoritative entity catalog for a project by walking
// an OpenAPI spec's `components.schemas` and `tags`. Filters out
// wrappers, value objects, and enums. Normalizes names. Collapses
// allOf/oneOf hierarchies. The result is a small, deliberate
// vocabulary that every node in the graph maps into — no more
// open-vocabulary extraction from filenames or path segments.
//
// Pure functions, no I/O, deterministic.
// ─────────────────────────────────────────────────────────────────

import type {
  OpenAPIRef,
  OpenAPISchemaObject,
  OpenAPISchemaOrRef,
  OpenAPISpec,
} from '@/importers/openapi/types'

// ─── helpers ─────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isRef = (v: unknown): v is OpenAPIRef =>
  isObj(v) && typeof v.$ref === 'string'

/**
 * Schema names that are universally transport primitives, not domain
 * entities, regardless of the spec they appear in. These appear in
 * practically every OpenAPI spec we parse.
 */
const TRANSPORT_PRIMITIVES = new Set<string>([
  'PageInfo',
  'PaginationSchema',
  'Error',
  'ProblemDetails',
  'CurrencyCode',
  'TokenResponse',
])

/** Wrapper-name suffixes that indicate "this is not an entity." */
const WRAPPER_SUFFIXES = [
  'Request',
  'Response',
  'Dto',
  'Params',
  'Options',
]

/** Schema names we never treat as entities — primitives, pagination, error envelopes. */
function isTransportPrimitive(name: string): boolean {
  return TRANSPORT_PRIMITIVES.has(name)
}

/** Names ending in a known wrapper suffix. */
function isWrapperName(name: string): boolean {
  return WRAPPER_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** True when the schema is a pure enum (type+enum, no other fields). */
function isPureEnum(schema: OpenAPISchemaObject): boolean {
  // OpenAPI enums: `type: "string"` + `enum: [...]`. Accept any scalar type.
  if (!('enum' in schema)) return false
  const enumVal = (schema as unknown as { enum?: unknown[] }).enum
  if (!Array.isArray(enumVal)) return false
  if (!schema.type) return false
  // If it also has properties, items, or composition, it's not pure.
  return !schema.properties && !schema.items && !schema.oneOf && !schema.anyOf && !schema.allOf
}

// ─── name normalization ─────────────────────────────────────

const SINGULARIZE_OVERRIDES: Record<string, string> = {
  analytics: 'analytics',
  news: 'news',
  status: 'status',
  series: 'series',
  species: 'species',
  data: 'data',
  media: 'media',
  metadata: 'metadata',
  people: 'person',
  children: 'child',
  // Latinate -us nouns that look inflected but aren't.
  bonus: 'bonus',
  focus: 'focus',
  virus: 'virus',
  campus: 'campus',
  corpus: 'corpus',
  genus: 'genus',
  octopus: 'octopus',
}

function singularizeToken(raw: string): string {
  const lower = raw.toLowerCase().trim()
  if (!lower) return ''
  const override = SINGULARIZE_OVERRIDES[lower]
  if (override) return override
  if (lower.endsWith('ies') && lower.length > 3) return lower.slice(0, -3) + 'y'
  if (lower.endsWith('ses') && lower.length > 3) return lower.slice(0, -2)
  if (lower.endsWith('xes') && lower.length > 3) return lower.slice(0, -2)
  // Don't strip trailing 'us' — Latinate singulars (bonus, focus, …) end
  // this way. Overrides above catch the domain-common ones; this rule
  // stops us from butchering unexpected ones.
  if (lower.endsWith('us')) return lower
  if (lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1)
  return lower
}

/**
 * Convert a PascalCase / snake_case / camelCase name to kebab-case,
 * singularizing the last token. Strips the `Admin` prefix first.
 * Strips known wrapper suffixes. Returns null if the name is a
 * filtered category (enum, primitive, wrapper).
 *
 * Examples:
 *   AdminPayment             → payment
 *   AdminBonusIssue          → bonus-issue
 *   FreespinBonus            → freespin-bonus
 *   CreateCategoryRequest    → category     (strip wrapper suffix → category)
 *   PaymentSystemCurrencyLimit → payment-system-currency-limit
 */
export function normalizeSchemaName(raw: string): string | null {
  if (!raw) return null
  if (isTransportPrimitive(raw)) return null

  // Strip Admin prefix (applies before wrapper-suffix check so
  // "AdminCreateCategoryRequest" would still be detected as a wrapper).
  let name = raw
  if (/^Admin[A-Z]/.test(name)) name = name.slice('Admin'.length)

  if (isWrapperName(name)) {
    // Strip the suffix and retry — "CreateCategoryRequest" → "CreateCategory".
    // We preserve the verb prefix here (Create/Update/Delete) which may
    // still need dropping — handled below.
    for (const suffix of WRAPPER_SUFFIXES) {
      if (name.endsWith(suffix)) {
        name = name.slice(0, -suffix.length)
        break
      }
    }
    // Drop CRUD verb prefixes so CreateCategory → Category.
    name = name.replace(/^(Create|Update|Delete|Get|List|Filter|Patch|Upsert|Bulk)/, '')
    if (!name) return null
  }

  // Split PascalCase into tokens.
  const tokens = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())

  if (tokens.length === 0) return null

  // Singularize only the last token (e.g. "freespin-bonuses" → "freespin-bonus").
  tokens[tokens.length - 1] = singularizeToken(tokens[tokens.length - 1])
  return tokens.join('-')
}

// ─── catalog construction ───────────────────────────────────

export type CatalogEntry = {
  /** Canonical normalized name used as the entity value on nodes. */
  name: string
  /** Original schema names that collapse to this entry. */
  sources: string[]
}

export type EntityCatalog = {
  entities: CatalogEntry[]
  domains: string[]
  /**
   * Map from original schema name → canonical entity name, covering
   * every schema in the spec (including those that collapse via
   * allOf/oneOf). Schemas that are filtered (wrappers, value objects,
   * enums) do not appear.
   */
  schemaToEntity: Map<string, string>
}

/**
 * Walk a schema tree and yield every schema name referenced via $ref
 * at any depth, ONLY through `properties` / `items`. Composition
 * edges (allOf / oneOf / anyOf) are separately tracked elsewhere as
 * identity-inheritance, not as "nested use." If we counted them
 * here, a parent schema of an allOf hierarchy would falsely look
 * like a value object (never top-level-used, only referenced from
 * its children's allOf).
 */
function collectRefsDeep(s: OpenAPISchemaOrRef | undefined, out: string[] = []): string[] {
  if (!s) return out
  if (isRef(s)) {
    const name = refToSchemaName(s.$ref)
    if (name) out.push(name)
    return out
  }
  if (s.properties) for (const p of Object.values(s.properties)) collectRefsDeep(p, out)
  if (s.items) collectRefsDeep(s.items, out)
  return out
}

function refToSchemaName(ref: string): string | null {
  if (!ref.startsWith('#/components/schemas/')) {
    // External ref — extract the trailing schema name so we can still
    // apply the filter (PageInfo, ProblemDetails leak this way).
    const hashIdx = ref.indexOf('#/components/schemas/')
    if (hashIdx >= 0) {
      const tail = ref.slice(hashIdx + '#/components/schemas/'.length)
      return tail.length > 0 ? tail : null
    }
    return null
  }
  const name = ref.slice('#/components/schemas/'.length)
  return name.length > 0 ? name : null
}

/**
 * Walk allOf/oneOf composition to find the "root" schema name — the
 * ancestor that defines the entity identity. With a cycle guard.
 */
function resolveCompositionRoot(
  name: string,
  schemas: Record<string, OpenAPISchemaObject>,
  seen: Set<string> = new Set(),
): string {
  if (seen.has(name)) return name // cycle
  seen.add(name)
  const schema = schemas[name]
  if (!schema) return name

  // allOf: if exactly one ref parent exists, walk up to it.
  if (schema.allOf && schema.allOf.length > 0) {
    const refParents = schema.allOf
      .filter(isRef)
      .map((r) => refToSchemaName(r.$ref))
      .filter((n): n is string => n !== null && n in schemas)
    if (refParents.length === 1) {
      return resolveCompositionRoot(refParents[0], schemas, seen)
    }
  }

  // oneOf: if every variant shares a common ancestor (via allOf), use
  // the ancestor. Otherwise return the first variant's name.
  if (schema.oneOf && schema.oneOf.length > 0) {
    const variantRoots = schema.oneOf
      .filter(isRef)
      .map((r) => refToSchemaName(r.$ref))
      .filter((n): n is string => n !== null && n in schemas)
      .map((n) => resolveCompositionRoot(n, schemas, new Set(seen)))
    if (variantRoots.length > 0 && variantRoots.every((r) => r === variantRoots[0])) {
      return variantRoots[0]
    }
  }

  return name
}

/**
 * Identify schemas that are only ever referenced from *inside* other
 * schemas (never as a direct request/response body). These are value
 * objects (Amount, PageInfo, UserMetadata) — nested helpers, not
 * entities.
 */
function detectValueObjects(spec: OpenAPISpec): Set<string> {
  const schemas = spec.components?.schemas ?? {}
  const schemaNames = new Set(Object.keys(schemas))

  // Refs that appear at the response/request root (or one level deep
  // under `data` / `data.items`) are considered "top-level use".
  const topLevelUses = new Set<string>()
  const anyUse = new Set<string>()

  const markTopLevelFromSchema = (s: OpenAPISchemaOrRef | undefined) => {
    if (!s) return
    if (isRef(s)) {
      const n = refToSchemaName(s.$ref)
      if (n) topLevelUses.add(n)
      return
    }
    // Unwrap { data: $ref } / { data: { items: $ref } }.
    if (s.properties?.data) {
      const data = s.properties.data
      if (isRef(data)) {
        const n = refToSchemaName(data.$ref)
        if (n) topLevelUses.add(n)
      } else if (data.items && isRef(data.items)) {
        const n = refToSchemaName(data.items.$ref)
        if (n) topLevelUses.add(n)
      }
    }
  }

  // Walk every operation.
  const paths = spec.paths ?? {}
  for (const pathItem of Object.values(paths)) {
    if (!isObj(pathItem)) continue
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const) {
      const op = (pathItem as Record<string, unknown>)[method]
      if (!isObj(op)) continue
      const typedOp = op as {
        requestBody?: { content?: Record<string, { schema?: OpenAPISchemaOrRef }> }
        responses?: Record<string, { content?: Record<string, { schema?: OpenAPISchemaOrRef }> } | OpenAPIRef>
      }
      if (typedOp.requestBody?.content) {
        for (const mt of Object.values(typedOp.requestBody.content)) {
          markTopLevelFromSchema(mt.schema)
        }
      }
      if (typedOp.responses) {
        for (const resp of Object.values(typedOp.responses)) {
          if (!isObj(resp) || isRef(resp)) continue
          const content = (resp as { content?: Record<string, { schema?: OpenAPISchemaOrRef }> }).content
          if (content) {
            for (const mt of Object.values(content)) {
              markTopLevelFromSchema(mt.schema)
            }
          }
        }
      }
    }
  }

  // Walk every schema's deep refs for "any use" tally.
  for (const [, schemaDef] of Object.entries(schemas)) {
    for (const n of collectRefsDeep(schemaDef)) {
      if (schemaNames.has(n)) anyUse.add(n)
    }
  }

  // Value object = referenced somewhere, but never at the top level.
  const valueObjects = new Set<string>()
  for (const name of schemaNames) {
    if (anyUse.has(name) && !topLevelUses.has(name)) {
      valueObjects.add(name)
    }
  }
  return valueObjects
}

/**
 * Normalize an OpenAPI tag into a canonical domain name. Tags like
 * "Types" are structural — filter them out. Returns null to skip.
 */
function normalizeTag(tag: string): string | null {
  const normalized = normalizeSchemaName(tag)
  if (!normalized) return null
  if (normalized === 'type' || normalized === 'miscellaneou' || normalized === 'misc') return null
  return normalized
}

/**
 * Build the complete entity + domain catalog for an OpenAPI spec.
 * Deterministic: same spec in, same catalog out. Pure.
 */
export function buildEntityCatalog(spec: OpenAPISpec): EntityCatalog {
  const schemas = spec.components?.schemas ?? {}
  const valueObjects = detectValueObjects(spec)

  // Collect (schemaName → canonicalEntity) for every schema that
  // isn't filtered. Collapse via composition root first.
  const schemaToEntity = new Map<string, string>()
  const bySources = new Map<string, Set<string>>() // canonical → original names

  for (const name of Object.keys(schemas)) {
    const schema = schemas[name]
    if (!schema) continue

    // Filter: enums, wrappers, transport primitives, value objects.
    if (isPureEnum(schema)) continue
    if (isTransportPrimitive(name)) continue
    if (valueObjects.has(name)) continue
    // Wrappers are detected at NORMALIZATION time (since the suffix
    // indicates it). Skip entirely here — don't try to normalize
    // since it would collapse into whatever the underlying noun was,
    // which may or may not be an existing entity. Collapse later via
    // the normalize step so that "CreateCategoryRequest" maps to
    // "category" which should already exist from "Category".
    if (isWrapperName(name)) {
      const normalized = normalizeSchemaName(name)
      if (!normalized) continue
      // Record the mapping so operations referencing this wrapper
      // resolve correctly — but don't create a new catalog entry.
      // If nothing else contributed this name, drop it entirely at the
      // end.
      const compositionRoot = resolveCompositionRoot(name, schemas)
      const rootNormalized = normalizeSchemaName(compositionRoot) ?? normalized
      schemaToEntity.set(name, rootNormalized)
      continue
    }

    // Regular schema: resolve composition root, then normalize.
    const compositionRoot = resolveCompositionRoot(name, schemas)
    const rootNormalized = normalizeSchemaName(compositionRoot)
    if (!rootNormalized) continue

    schemaToEntity.set(name, rootNormalized)
    if (!bySources.has(rootNormalized)) bySources.set(rootNormalized, new Set())
    bySources.get(rootNormalized)!.add(name)
  }

  // Also record wrapper mappings as sources so the catalog entry
  // can show "CategoryRequest contributed to 'category'".
  for (const [source, canonical] of schemaToEntity.entries()) {
    if (!bySources.has(canonical)) bySources.set(canonical, new Set())
    bySources.get(canonical)!.add(source)
  }

  const entities: CatalogEntry[] = [...bySources.entries()]
    .map(([name, sources]) => ({ name, sources: [...sources].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // Domains: from `spec.tags` (preferred — explicit list with descriptions)
  // plus any tag mentioned on an operation (defensive — some specs omit
  // the top-level `tags` array).
  const domainSet = new Set<string>()
  for (const tag of spec.tags ?? []) {
    if (tag && typeof (tag as { name?: string }).name === 'string') {
      const normalized = normalizeTag((tag as { name: string }).name)
      if (normalized) domainSet.add(normalized)
    }
  }
  const paths = spec.paths ?? {}
  for (const pathItem of Object.values(paths)) {
    if (!isObj(pathItem)) continue
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const) {
      const op = (pathItem as Record<string, unknown>)[method]
      if (!isObj(op)) continue
      const tags = (op as { tags?: unknown }).tags
      if (!Array.isArray(tags)) continue
      for (const t of tags) {
        if (typeof t === 'string') {
          const normalized = normalizeTag(t)
          if (normalized) domainSet.add(normalized)
        }
      }
    }
  }
  const domains = [...domainSet].sort()

  return { entities, domains, schemaToEntity }
}

// ─── operation entity resolution ────────────────────────────

export type OperationResolution = {
  entity?: string
  domain?: string
}

/**
 * For a given operation, determine its entity (from response/request
 * body unwrap) and domain (from first tag). Uses the catalog's
 * schemaToEntity map to resolve schema refs into canonical entity
 * names.
 */
export function resolveOperationEntity(
  op: {
    tags?: string[]
    requestBody?: { content?: Record<string, { schema?: OpenAPISchemaOrRef }> } | OpenAPIRef
    responses?: Record<string, { content?: Record<string, { schema?: OpenAPISchemaOrRef }> } | OpenAPIRef>
  },
  catalog: EntityCatalog,
): OperationResolution {
  const domain = op.tags?.[0] ? normalizeTag(op.tags[0]) ?? undefined : undefined

  // Walk responses in preferred order: 200 → 201 → first 2xx.
  const responses = op.responses ?? {}
  const responseCodeOrder = ['200', '201', '202', '203', '204']
  const sortedCodes = [
    ...responseCodeOrder.filter((c) => c in responses),
    ...Object.keys(responses).filter((c) => c.startsWith('2') && !responseCodeOrder.includes(c)),
  ]

  for (const code of sortedCodes) {
    const resp = responses[code]
    if (!resp || isRef(resp)) continue
    const content = (resp as { content?: Record<string, { schema?: OpenAPISchemaOrRef }> }).content
    if (!content) continue
    // Prefer application/json; fall back to any media type.
    const media = content['application/json'] ?? Object.values(content)[0]
    if (!media?.schema) continue
    const entity = resolveSchemaToEntity(media.schema, catalog)
    if (entity) return { entity, domain }
  }

  // Fallback: request body for mutations.
  if (op.requestBody && !isRef(op.requestBody)) {
    const content = op.requestBody.content
    if (content) {
      const media = content['application/json'] ?? Object.values(content)[0]
      if (media?.schema) {
        const entity = resolveSchemaToEntity(media.schema, catalog)
        if (entity) return { entity, domain }
      }
    }
  }

  // Final fallback: use the domain as the entity (Auth operations
  // with inline schemas land here).
  return { entity: domain, domain }
}

/**
 * Apply the unwrap algorithm to a schema-or-ref and return the
 * canonical entity name (via catalog lookup). Returns undefined when
 * the schema unwraps to something filtered or unknown.
 */
function resolveSchemaToEntity(
  schema: OpenAPISchemaOrRef,
  catalog: EntityCatalog,
): string | undefined {
  // Direct $ref.
  if (isRef(schema)) {
    const name = refToSchemaName(schema.$ref)
    if (!name) return undefined
    return catalog.schemaToEntity.get(name)
  }

  // { data: $ref } or { data: { items: $ref } }.
  const props = schema.properties
  if (props?.data) {
    const data = props.data
    if (isRef(data)) {
      const name = refToSchemaName(data.$ref)
      if (name) {
        const mapped = catalog.schemaToEntity.get(name)
        if (mapped) return mapped
      }
    } else if (data.items && isRef(data.items)) {
      const name = refToSchemaName(data.items.$ref)
      if (name) {
        const mapped = catalog.schemaToEntity.get(name)
        if (mapped) return mapped
      }
    } else if (data.items && !isRef(data.items) && data.items.properties) {
      // Nested-object array — walk once more.
      return undefined
    }
  }

  // allOf-merged inline: look at the first ref inside.
  if (schema.allOf) {
    for (const part of schema.allOf) {
      if (isRef(part)) {
        const name = refToSchemaName(part.$ref)
        if (name) {
          const mapped = catalog.schemaToEntity.get(name)
          if (mapped) return mapped
        }
      }
    }
  }

  return undefined
}

// ─── mutation helpers for the catalog curator (GE-116) ─────

/**
 * Remove an entity from the catalog and untag all nodes that carry
 * it. Nodes with `manualOverrides: ['entity']` lose both the entity
 * AND the override (the user's manual choice targeted a now-deleted
 * entity, which is the destructive caller's intent per GE-116).
 */
export function deleteEntityFromCatalog(
  schema: import('@/types').Schema,
  entity: string,
): import('@/types').Schema {
  const nodes = schema.nodes.map((n) => {
    if (n.entity !== entity) return n
    const { entity: _e, ...rest } = n
    const overrides = (n.manualOverrides ?? []).filter((f) => f !== 'entity')
    return overrides.length > 0
      ? { ...rest, manualOverrides: overrides }
      : { ...rest, manualOverrides: undefined }
  })
  const entities = (schema.meta.entities ?? []).filter((e) => e !== entity)
  return { ...schema, nodes, meta: { ...schema.meta, entities } }
}

/**
 * Add a new entity to the catalog (empty — no nodes are automatically
 * assigned). Idempotent.
 */
export function addEntityToCatalog(
  schema: import('@/types').Schema,
  entity: string,
): import('@/types').Schema {
  const normalized = normalizeSchemaName(entity) ?? entity.toLowerCase()
  const existing = schema.meta.entities ?? []
  if (existing.includes(normalized)) return schema
  return {
    ...schema,
    meta: { ...schema.meta, entities: [...existing, normalized].sort() },
  }
}

/**
 * Rename a domain across the catalog and every tagged node.
 */
export function renameDomain(
  schema: import('@/types').Schema,
  from: string,
  to: string,
): import('@/types').Schema {
  const nodes = schema.nodes.map((n) =>
    n.domain === from ? { ...n, domain: to } : n,
  )
  const domains = (schema.meta.domains ?? [])
    .map((d) => (d === from ? to : d))
  const deduped = Array.from(new Set(domains)).sort()
  return { ...schema, nodes, meta: { ...schema.meta, domains: deduped } }
}

/**
 * Remove a domain from the catalog. Untags every node that carries
 * it; does not touch `entity` on those nodes.
 */
export function deleteDomain(
  schema: import('@/types').Schema,
  domain: string,
): import('@/types').Schema {
  const nodes = schema.nodes.map((n) => {
    if (n.domain !== domain) return n
    const { domain: _d, ...rest } = n
    return rest
  })
  const domains = (schema.meta.domains ?? []).filter((d) => d !== domain)
  return { ...schema, nodes, meta: { ...schema.meta, domains } }
}

/**
 * Clear `entity` and `domain` on every auto-generated node that
 * doesn't carry a manual override. Used by the v1.2 cleanup migration
 * to wipe stale heuristic tags from the old open-vocabulary extractor,
 * and by the catalog dialog's "Reset auto tags" action.
 *
 * Pure — returns a new schema. Manual overrides are preserved.
 */
export function resetAutoEntityTags(
  schema: import('@/types').Schema,
): import('@/types').Schema {
  const nodes = schema.nodes.map((n) => {
    if (n.origin === 'manual') return n
    if (n.manualOverrides?.includes('entity')) return n
    if (!n.entity && !n.domain) return n
    const { entity: _e, domain: _d, ...rest } = n
    return rest
  })
  // Reset the catalogs too — they will be repopulated by the next
  // OpenAPI import or by manual user action.
  return {
    ...schema,
    nodes,
    meta: { ...schema.meta, entities: [], domains: [] },
  }
}

/**
 * Detect whether a schema is in the post-v1.0/v1.1 "stuck state":
 * meta.entities is empty AND auto:codebase nodes carry entity values
 * (filename-derived junk like `theme`, `util`, `dayj`, `debounce`).
 *
 * Critically: auto:openapi nodes with entity tags are NOT stale —
 * those are freshly imported from the GE-115 catalog. The detection
 * only fires when CODEBASE nodes have entities without a catalog to
 * back them up, which is the hallmark of the old open-vocabulary
 * extractor.
 */
export function hasStaleAutoEntityTags(
  schema: import('@/types').Schema,
): boolean {
  const catalogEmpty = (schema.meta.entities?.length ?? 0) === 0
  if (!catalogEmpty) return false
  // Only codebase-origin nodes carrying entity without override are
  // considered stale. OpenAPI-origin nodes get their entity from the
  // importer — that's legitimate even without a populated catalog
  // (the merge engine may not have carried meta.entities over yet).
  for (const n of schema.nodes) {
    if (n.origin !== 'auto:codebase') continue
    if (n.manualOverrides?.includes('entity')) continue
    if (n.entity) return true
  }
  return false
}

/**
 * Assign an entity to a specific node and mark it as a manual
 * override so propagation won't overwrite.
 */
export function assignEntityToNode(
  schema: import('@/types').Schema,
  nodeId: string,
  entity: string | null,
): import('@/types').Schema {
  const nodes = schema.nodes.map((n) => {
    if (n.id !== nodeId) return n
    const overrides = new Set(n.manualOverrides ?? [])
    if (entity === null) {
      const { entity: _e, ...rest } = n
      overrides.delete('entity')
      const overrideArr = [...overrides]
      return overrideArr.length > 0
        ? { ...rest, manualOverrides: overrideArr }
        : { ...rest, manualOverrides: undefined }
    }
    overrides.add('entity')
    return { ...n, entity, manualOverrides: [...overrides] }
  })
  return { ...schema, nodes }
}
