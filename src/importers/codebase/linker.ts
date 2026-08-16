// ─────────────────────────────────────────────────────────────────
// Codebase ↔ OpenAPI linker (GE-026c).
//
// Given a freshly-read file tree + the current graph's API and code
// nodes, extract API call sites from the source code and emit edges
// connecting code files to the operation nodes they target.
//
// Three passes:
//   1. Direct `client.METHOD('/literal/path')` calls. openapi-fetch
//      style — 95%+ coverage on typed-client codebases.
//   2. Raw `fetch(`${ANYVAR}${path}`, ...)` — legacy / fallback code.
//      Extracts the path portion after the interpolated base URL.
//      HTTP method is detected by scanning the nearby options object
//      for `method: 'POST'` etc. (defaults to GET).
//   3. Indirect calls via imports, iterated to a fixed point: if file A
//      contains `client.GET('/x')` inside `export function fetchX` and
//      file B does `import { fetchX } from 'A'` + calls `fetchX(...)`,
//      emit an edge from B → GET /x. Each round promotes wrapper files
//      into the API layer, so component → hook → fetch-function chains
//      resolve rather than stopping at the first wrapper.
//
// Output is only NEW edges (dedup'd against existing schema links).
// Pure function, deterministic, no I/O.
// ─────────────────────────────────────────────────────────────────

import type { Link, Schema } from '@/types'
import { linkId } from '@/schema/migrate'
import { CODE_EXT, extractImports, norm, resolveImport } from '@/importers/codebase/resolve'
import { nodeIdForPath } from '@/importers/codebase'

export type LinkWarning =
  | { kind: 'unmatched_path'; file: string; method: string; path: string }
  | { kind: 'fetch_without_method'; file: string; path: string; assumedMethod: 'GET' }

export type LinkResult = {
  links: Link[]
  warnings: LinkWarning[]
  stats: {
    filesScanned: number
    directHits: number
    indirectHits: number
    matched: number
    unmatched: number
  }
}

type ApiOpLookup = Map<string, string> // "GET /admin/payments" → node id

/** Build a lookup map from the existing OpenAPI op nodes. */
function buildApiOpLookup(schema: Schema): ApiOpLookup {
  const lookup = new Map<string, string>()
  for (const n of schema.nodes) {
    if (n.origin !== 'auto:openapi') continue
    if (n.type !== 'api') continue
    // The OpenAPI parser names API nodes "METHOD /path". Key by that.
    lookup.set(n.name, n.id)
  }
  return lookup
}

/** Keyed set of codebase file-node IDs, keyed by their source path. */
function buildCodebaseFileIndex(schema: Schema): Set<string> {
  const out = new Set<string>()
  for (const n of schema.nodes) {
    if (n.origin === 'auto:codebase' && n.id.startsWith('codebase:file:')) {
      out.add(n.id.slice('codebase:file:'.length))
    }
  }
  return out
}

// Regex for direct calls. Supports single / double / backtick quotes.
const CLIENT_CALL_RE = /client\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*['"`]([^'"`]+)['"`]/g

// Raw fetch with a template literal that starts with an interpolation
// (usually `${config.API_BASE_URL}`). Captures the static path part.
const RAW_FETCH_RE = /fetch\s*\(\s*`\$\{[^}]+\}([^`]*)`([\s\S]{0,400}?)\)/g

// Inside the raw-fetch options blob, find a `method:` key.
const METHOD_PROP_RE = /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i

/**
 * Maximum wrapper layers pass 3 will see through. Chains deeper than
 * this are vanishingly rare, and the cap bounds work on cyclic imports.
 */
const MAX_INDIRECTION_HOPS = 5

// Detect function definitions for pass-3 attribution.
const EXPORT_FN_RE =/export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)|export\s+(?:const|let|var)\s+(\w+)\s*=/g

/**
 * For a single source file, find every (method, path) call site.
 * Used by pass 1 and pass 2 together.
 */
function extractCallSites(source: string, file: string): Array<{
  method: string
  path: string
  kind: 'direct' | 'raw_fetch'
  warnings?: LinkWarning[]
}> {
  const sites: Array<{ method: string; path: string; kind: 'direct' | 'raw_fetch'; warnings?: LinkWarning[] }> = []

  CLIENT_CALL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CLIENT_CALL_RE.exec(source)) !== null) {
    sites.push({ method: m[1].toUpperCase(), path: m[2], kind: 'direct' })
  }

  RAW_FETCH_RE.lastIndex = 0
  while ((m = RAW_FETCH_RE.exec(source)) !== null) {
    const path = m[1]
    const optionsBlob = m[2] ?? ''
    const methodMatch = METHOD_PROP_RE.exec(optionsBlob)
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET'
    const warnings: LinkWarning[] = methodMatch
      ? []
      : [{ kind: 'fetch_without_method', file, path, assumedMethod: 'GET' }]
    sites.push({ method, path, kind: 'raw_fetch', warnings })
  }

  return sites
}

/**
 * For each api-layer file, map each of its exported-function names to
 * the call sites that likely belong to it. Uses a forward-scan
 * heuristic: every `client.METHOD(...)` between export-N and export-(N+1)
 * is attributed to export-N. Over-connects when helpers share endpoints;
 * acceptable per the ticket.
 */
type Endpoint = { method: string; path: string }

/**
 * Approximate body ranges for every exported binding in a file.
 *
 * Each export owns the source from its declaration until the next one
 * starts. Crude, but it does not need to be exact: it only has to
 * attribute a call site to the right exported symbol.
 */
function exportRanges(source: string): Array<{ name: string; start: number; end: number }> {
  const ranges: Array<{ name: string; start: number; end: number }> = []
  EXPORT_FN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXPORT_FN_RE.exec(source)) !== null) {
    const name = m[1] ?? m[2]
    if (!name) continue
    ranges.push({ name, start: m.index, end: source.length })
  }
  for (let i = 0; i < ranges.length - 1; i++) ranges[i].end = ranges[i + 1].start
  return ranges
}

function buildApiFunctionMap(
  file: string,
  source: string,
): Map<string, Array<{ method: string; path: string }>> {
  const ranges = exportRanges(source)

  const map = new Map<string, Array<{ method: string; path: string }>>()
  for (const r of ranges) {
    const slice = source.slice(r.start, r.end)
    const sites = extractCallSites(slice, file)
    if (sites.length === 0) continue
    const list = map.get(r.name) ?? []
    for (const s of sites) list.push({ method: s.method, path: s.path })
    map.set(r.name, list)
  }
  return map
}

/**
 * For a consumer file, extract every (importedName → sourceFile) pair.
 * Only named imports are tracked — default and namespace imports are
 * out of scope for the MVP (the admin-dashboard patterns don't rely
 * on them for API layers).
 */
const NAMED_IMPORT_RE = /import\s*(?:type\s+)?\{\s*([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g

function extractNamedImports(source: string): Array<{ name: string; from: string }> {
  const out: Array<{ name: string; from: string }> = []
  NAMED_IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NAMED_IMPORT_RE.exec(source)) !== null) {
    const names = m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(Boolean)
    const from = m[2]
    for (const name of names) out.push({ name, from })
  }
  return out
}

/** Is `name` called (as a function, JSX tag, etc.) anywhere in source? */
function isCalled(source: string, name: string): boolean {
  // Word boundary + open paren OR JSX open. Restrictive enough to
  // avoid false positives from string constants containing the name.
  const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\(`)
  return pattern.test(source)
}

// ─── public entry ────────────────────────────────────────────

export function extractCodebaseApiLinks(
  files: Map<string, string>,
  schema: Schema,
): LinkResult {
  const warnings: LinkWarning[] = []
  const opLookup = buildApiOpLookup(schema)
  const codebasePaths = buildCodebaseFileIndex(schema)
  // Bookkeeping for stats / dedup. Only skip links that already exist
  // with `auto:linker` origin. Old links from `auto:codebase` (pre-fix)
  // get replaced — they have the same ID but the wrong origin.
  const existingLinkerIds = new Set(
    schema.links.filter((l) => l.origin === 'auto:linker').map((l) => l.id),
  )
  const newLinks = new Map<string, Link>() // id → Link (dedup within a single run)

  const emit = (fromPath: string, method: string, path: string): void => {
    const opKey = `${method.toUpperCase()} ${path}`
    const opNodeId = opLookup.get(opKey)
    if (!opNodeId) {
      warnings.push({ kind: 'unmatched_path', file: fromPath, method: method.toUpperCase(), path })
      stats.unmatched++
      return
    }
    const sourceId = nodeIdForPath(fromPath)
    // Only emit if the source file is actually a known codebase node.
    if (!codebasePaths.has(norm(fromPath))) return
    const id = linkId(sourceId, opNodeId, 'data_flow')
    if (existingLinkerIds.has(id) || newLinks.has(id)) return
    newLinks.set(id, {
      id,
      source: sourceId,
      target: opNodeId,
      label: 'calls',
      description: `${fromPath} → ${opKey}`,
      type: 'data_flow',
      origin: 'auto:linker',
    })
    stats.matched++
  }

  // Stats mutable through emit().
  const stats = { filesScanned: 0, directHits: 0, indirectHits: 0, matched: 0, unmatched: 0 }

  // Normalize keys + filter to code files only.
  const effective = new Map<string, string>()
  for (const [k, v] of files) {
    if (CODE_EXT.test(k)) effective.set(norm(k), v)
  }
  const fileSet = new Set(effective.keys())

  // Pass 1 + Pass 2: direct call sites in every file.
  // Pass 3 prep: per-api-file function → endpoints map, built as we go.
  const apiFileFunctionMap = new Map<string, Map<string, Array<{ method: string; path: string }>>>()

  for (const [path, source] of effective) {
    stats.filesScanned++
    const sites = extractCallSites(source, path)
    if (sites.length > 0) {
      stats.directHits += sites.length
      for (const s of sites) {
        if (s.warnings) warnings.push(...s.warnings)
        emit(path, s.method, s.path)
      }
      // This file is an API-layer file (contains direct calls). Build its
      // function → endpoints map for pass 3.
      apiFileFunctionMap.set(path, buildApiFunctionMap(path, source))
    }
  }

  // Pass 3: import-indirection, iterated to a fixed point.
  //
  // A single hop only reaches files that import the API layer directly.
  // Real apps wrap it: a component imports a hook, the hook calls a
  // fetch function, and only that fetch function names the endpoint.
  // Stopping at one hop leaves every component unlinked, which in turn
  // strands entity propagation — measured on casino-frontend, one hop
  // linked 70 files out of 731.
  //
  // Each round promotes wrapper files into `apiFileFunctionMap`, so the
  // next round can see through them. Converges when no file learns a
  // new endpoint; the cap is a backstop against pathological cycles.
  for (let hop = 0; hop < MAX_INDIRECTION_HOPS; hop++) {
    let learned = false

    for (const [path, source] of effective) {
      const namedImports = extractNamedImports(source)
      if (namedImports.length === 0) continue

      // Imported symbols in this file that are known to reach endpoints.
      const reachable = new Map<string, Endpoint[]>()
      for (const { name, from } of namedImports) {
        const resolved = resolveImport(from, path, fileSet)
        if (!resolved) continue
        const endpoints = apiFileFunctionMap.get(resolved)?.get(name)
        if (!endpoints || endpoints.length === 0) continue
        // Importing without calling is not a data-flow relationship.
        if (!isCalled(source, name)) continue
        reachable.set(name, endpoints)
      }
      if (reachable.size === 0) continue

      for (const endpoints of reachable.values()) {
        for (const ep of endpoints) {
          const before = newLinks.size
          emit(path, ep.method, ep.path)
          // Count a hit only when an edge was actually created, so
          // repeated rounds cannot inflate the statistic.
          if (newLinks.size > before) stats.indirectHits++
        }
      }

      // Promote: any exported binding here that calls a reaching symbol
      // now reaches those endpoints too, making this file part of the
      // API layer for subsequent rounds.
      const own = apiFileFunctionMap.get(path) ?? new Map<string, Endpoint[]>()
      let promoted = false
      for (const range of exportRanges(source)) {
        const slice = source.slice(range.start, range.end)
        for (const [symbol, endpoints] of reachable) {
          if (!isCalled(slice, symbol)) continue
          const list = own.get(range.name) ?? []
          for (const ep of endpoints) {
            if (list.some((e) => e.method === ep.method && e.path === ep.path)) continue
            list.push(ep)
            promoted = true
          }
          own.set(range.name, list)
        }
      }
      if (promoted) {
        apiFileFunctionMap.set(path, own)
        learned = true
      }
    }

    if (!learned) break
  }

  const links = [...newLinks.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { links, warnings, stats }
}

// ─── BE handler → OpenAPI operation linker (GE-110) ─────────

export type BackendLinkWarning =
  | { kind: 'unmatched_be_handler'; nodeId: string; method: string; path: string }
  | { kind: 'unmatched_openapi_op'; nodeId: string; method: string; path: string }

export type BackendLinkResult = {
  links: Link[]
  warnings: BackendLinkWarning[]
  stats: { beHandlersSeen: number; matched: number; unmatchedBe: number; unmatchedOpenapi: number }
}

/** Regex to identify BE handler node IDs emitted by backend plugins. */
const BE_HANDLER_ID_RE = /^codebase:\w+:op:/

/** Check if a node is a backend handler emitted by a GE-109 plugin. */
function isBeHandlerNode(n: { id: string; origin: string; metadata?: { backend?: string } }): boolean {
  return n.origin === 'auto:codebase' && BE_HANDLER_ID_RE.test(n.id) && !!n.metadata?.backend
}

/**
 * Parse a "METHOD /path" name into its two parts.
 * Returns null if the name doesn't match the expected format.
 */
function parseOpName(name: string): { method: string; path: string } | null {
  const idx = name.indexOf(' ')
  if (idx === -1) return null
  return { method: name.slice(0, idx), path: name.slice(idx + 1) }
}

/**
 * Link backend handler nodes to their matching OpenAPI operation nodes.
 *
 * Runs purely against schema data — no file I/O needed. Both sides
 * use the same "METHOD /path" name format, so matching is a simple
 * lookup by `node.name`.
 */
export function extractBackendToApiLinks(schema: Schema): BackendLinkResult {
  const warnings: BackendLinkWarning[] = []
  const existingLinkerIds = new Set(
    schema.links.filter((l) => l.origin === 'auto:linker').map((l) => l.id),
  )
  const newLinks = new Map<string, Link>()

  // Build OpenAPI op lookup: "METHOD /path" → nodeId
  const opLookup = buildApiOpLookup(schema)

  // Collect BE handler nodes.
  const beHandlers: Array<{ id: string; name: string }> = []
  for (const n of schema.nodes) {
    if (isBeHandlerNode(n)) {
      beHandlers.push({ id: n.id, name: n.name })
    }
  }

  // Track which OpenAPI ops got matched (for unmatched-openapi warnings).
  const matchedOpKeys = new Set<string>()

  let matched = 0

  for (const handler of beHandlers) {
    const opNodeId = opLookup.get(handler.name)
    if (!opNodeId) {
      const parsed = parseOpName(handler.name)
      warnings.push({
        kind: 'unmatched_be_handler',
        nodeId: handler.id,
        method: parsed?.method ?? 'UNKNOWN',
        path: parsed?.path ?? handler.name,
      })
      continue
    }

    matchedOpKeys.add(handler.name)

    const id = linkId(opNodeId, handler.id, 'data_flow')
    if (existingLinkerIds.has(id) || newLinks.has(id)) continue

    newLinks.set(id, {
      id,
      source: opNodeId,
      target: handler.id,
      label: 'implemented by',
      description: `${handler.name} — API spec → BE handler`,
      type: 'data_flow',
      origin: 'auto:linker',
    })
    matched++
  }

  // Emit warnings for OpenAPI ops with no matching BE handler.
  for (const [opKey, opNodeId] of opLookup) {
    if (matchedOpKeys.has(opKey)) continue
    const parsed = parseOpName(opKey)
    warnings.push({
      kind: 'unmatched_openapi_op',
      nodeId: opNodeId,
      method: parsed?.method ?? 'UNKNOWN',
      path: parsed?.path ?? opKey,
    })
  }

  const unmatchedBe = beHandlers.length - matched
  const unmatchedOpenapi = opLookup.size - matchedOpKeys.size

  const links = [...newLinks.values()].sort((a, b) => a.id.localeCompare(b.id))
  return {
    links,
    warnings,
    stats: {
      beHandlersSeen: beHandlers.length,
      matched,
      unmatchedBe,
      unmatchedOpenapi,
    },
  }
}
