// ─────────────────────────────────────────────────────────────────
// Go backend plugin (GE-109).
//
// Regex-based extraction of HTTP handler registrations and struct
// declarations from Go source files. Supports net/http, gorilla/mux,
// chi, gin, and echo router patterns.
//
// No AST parsing, no external dependencies.
// ─────────────────────────────────────────────────────────────────

import { linkId } from '@/schema/migrate'
import { propagateEntities } from '@/schema/entity/propagate'
import { norm } from '@/importers/codebase/resolve'
import type { Link, LinkType, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import type { BackendPlugin, BackendPluginResult, BackendWarning } from '@/importers/codebase/backends/types'

// ─── constants ──────────────────────────────────────────────────

const DEFAULT_NODE_TYPES: Record<string, { color: string; label: string; glow?: number }> = {
  domain: { color: '#ff4081', label: 'Domain', glow: 0.15 },
  database: { color: '#00e5ff', label: 'Database', glow: 0.1 },
  service: { color: '#ff6e40', label: 'Service', glow: 0.12 },
  feature: { color: '#b388ff', label: 'Feature', glow: 0.1 },
  api: { color: '#69f0ae', label: 'API', glow: 0.1 },
  ui: { color: '#ffd740', label: 'UI', glow: 0.1 },
  external: { color: '#78909c', label: 'External', glow: 0.06 },
}

const DEFAULT_LINK_TYPES: Record<string, LinkType> = {
  data_flow: { color: '#1a4a6c', label: 'Data Flow', animated: true },
  dependency: { color: '#3a2a5c', label: 'Dependency', dashed: true },
  triggers: { color: '#4a3a1c', label: 'Triggers', animated: true },
}

const GO_SKIP_PATTERNS = [
  /(^|\/)vendor\//,
  /_test\.go$/,
]

// ─── path sanitization ─────────────────────────────────────────

/** Sanitize a URL path for use in a node ID. Non-alphanumeric → `_`, trim trailing underscores. */
function sanitizePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+$/g, '')
}

/**
 * Normalize Gin/chi-style path params to OpenAPI style.
 * `:id` → `{id}`, `*splat` → `{splat}`
 */
function normalizePathParams(path: string): string {
  return path
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}')
    .replace(/\*([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}')
}

// ─── handler extraction regexes ─────────────────────────────────

type HandlerMatch = { method: string; path: string; line: number }

/**
 * net/http: http.HandleFunc("/path", handler) or mux.HandleFunc("/path", handler)
 * These don't carry an explicit method — default to GET.
 */
const NET_HTTP_RE = /\b(?:http|mux)\.HandleFunc\(\s*"([^"]+)"/g

/**
 * gorilla/mux: r.HandleFunc("/path", handler).Methods("GET")
 * The .Methods() call may be on the same line or adjacent lines.
 * We capture the path on the HandleFunc line and then look for
 * .Methods on the same or next few lines.
 */
const GORILLA_HANDLEFUNC_RE = /\.HandleFunc\(\s*"([^"]+)"/g
const GORILLA_METHODS_RE = /\.Methods\(\s*"([A-Z]+)"/

/**
 * chi: r.Get("/path", handler), r.Post("/path", handler), etc.
 * chi uses properly-capitalized method names.
 */
const CHI_RE = /\.(Get|Post|Put|Delete|Patch)\(\s*"([^"]+)"/g

/**
 * gin: r.GET("/path", handler), r.POST("/path", handler), etc.
 * gin uses all-caps method names.
 */
const GIN_RE = /\.(GET|POST|PUT|DELETE|PATCH)\(\s*"([^"]+)"/g

/**
 * echo: e.GET("/path", handler), e.POST("/path", handler), etc.
 * Same pattern as gin — all-caps.
 */
const ECHO_RE = /\.(GET|POST|PUT|DELETE|PATCH)\(\s*"([^"]+)"/g

function extractHandlers(source: string): HandlerMatch[] {
  const results: HandlerMatch[] = []
  const lines = source.split('\n')

  // Build a line-number lookup for character offsets.
  const lineStarts: number[] = []
  let offset = 0
  for (const line of lines) {
    lineStarts.push(offset)
    offset += line.length + 1 // +1 for the \n
  }

  function lineAt(charOffset: number): number {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= charOffset) lo = mid
      else hi = mid - 1
    }
    return lo + 1 // 1-based
  }

  // Track HandleFunc occurrences that were already matched by gorilla
  // pattern (which includes .Methods). We first try gorilla, then
  // fall back to net/http for unmatched HandleFunc calls.
  const gorillaHandleFuncOffsets = new Set<number>()

  // Pass 1: gorilla/mux — HandleFunc + .Methods on same or next lines.
  {
    GORILLA_HANDLEFUNC_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = GORILLA_HANDLEFUNC_RE.exec(source)) !== null) {
      const path = m[1]
      const matchLine = lineAt(m.index)
      // Look for .Methods on the same line or next 3 lines.
      const searchStart = matchLine - 1 // 0-based
      const searchEnd = Math.min(matchLine + 3, lines.length) // check up to 3 lines after
      let method = 'GET'
      let foundMethods = false
      for (let i = searchStart; i < searchEnd; i++) {
        const methodMatch = GORILLA_METHODS_RE.exec(lines[i])
        if (methodMatch) {
          method = methodMatch[1]
          foundMethods = true
          break
        }
      }
      if (foundMethods) {
        gorillaHandleFuncOffsets.add(m.index)
        results.push({ method, path, line: matchLine })
      }
    }
  }

  // Pass 2: net/http HandleFunc (only those not already captured by gorilla).
  {
    NET_HTTP_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = NET_HTTP_RE.exec(source)) !== null) {
      if (gorillaHandleFuncOffsets.has(m.index)) continue
      results.push({ method: 'GET', path: m[1], line: lineAt(m.index) })
    }
  }

  // Pass 3: gorilla HandleFunc WITHOUT .Methods (treat as GET).
  {
    GORILLA_HANDLEFUNC_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = GORILLA_HANDLEFUNC_RE.exec(source)) !== null) {
      if (gorillaHandleFuncOffsets.has(m.index)) continue
      // Skip if already matched by net/http regex (http.HandleFunc / mux.HandleFunc).
      // Check if the match is preceded by "http" or "mux" + ".".
      const before = source.slice(Math.max(0, m.index - 10), m.index)
      if (/(?:http|mux)$/.test(before)) continue
      results.push({ method: 'GET', path: m[1], line: lineAt(m.index) })
    }
  }

  // Pass 4: chi (capitalized first letter method names).
  {
    CHI_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CHI_RE.exec(source)) !== null) {
      results.push({ method: m[1].toUpperCase(), path: m[2], line: lineAt(m.index) })
    }
  }

  // Pass 5: gin (all-caps method names).
  // Gin and echo share the same pattern. We don't distinguish them —
  // both emit the same node shape. To avoid double-counting, we use
  // a single combined regex pass.
  {
    GIN_RE.lastIndex = 0
    const seen = new Set<number>()
    let m: RegExpExecArray | null
    while ((m = GIN_RE.exec(source)) !== null) {
      if (seen.has(m.index)) continue
      seen.add(m.index)
      results.push({ method: m[1].toUpperCase(), path: m[2], line: lineAt(m.index) })
    }
    // echo uses same pattern — no separate pass needed since GIN_RE
    // and ECHO_RE are identical. Skip ECHO_RE to avoid duplicates.
  }

  return results
}

// ─── struct extraction ──────────────────────────────────────────

type StructMatch = { name: string; line: number }

const STRUCT_RE = /^type\s+([A-Z][A-Za-z0-9_]*)\s+struct\s*\{/gm

function extractStructs(source: string): StructMatch[] {
  const results: StructMatch[] = []
  const lines = source.split('\n')

  let lineStarts: number[] = []
  let offset = 0
  for (const line of lines) {
    lineStarts.push(offset)
    offset += line.length + 1
  }

  function lineAt(charOffset: number): number {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= charOffset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  STRUCT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STRUCT_RE.exec(source)) !== null) {
    results.push({ name: m[1], line: lineAt(m.index) })
  }
  return results
}

// ─── Go import extraction ───────────────────────────────────────

/** Extract import paths from Go source. Handles both single and grouped imports. */
function extractGoImports(source: string): string[] {
  const imports: string[] = []

  // Single import: import "path"
  const singleRe = /^import\s+"([^"]+)"/gm
  let m: RegExpExecArray | null
  singleRe.lastIndex = 0
  while ((m = singleRe.exec(source)) !== null) {
    imports.push(m[1])
  }

  // Grouped import: import ( ... )
  const groupRe = /^import\s*\(([^)]*)\)/gms
  groupRe.lastIndex = 0
  while ((m = groupRe.exec(source)) !== null) {
    const block = m[1]
    const lineRe = /\s*(?:\w+\s+)?"([^"]+)"/g
    let lm: RegExpExecArray | null
    lineRe.lastIndex = 0
    while ((lm = lineRe.exec(block)) !== null) {
      imports.push(lm[1])
    }
  }

  return imports
}

/**
 * Derive Go package name from a file path.
 * "internal/handlers/payment.go" → "internal/handlers"
 */
function packageFromPath(filePath: string): string {
  const parts = norm(filePath).split('/')
  return parts.slice(0, -1).join('/')
}

/**
 * Check if a Go import path is local to the project by checking if
 * any file in the file set lives under a directory that matches the
 * tail segments of the import path.
 */
function resolveGoImport(
  importPath: string,
  fileSet: Set<string>,
): string | null {
  // Go imports look like "github.com/company/project/internal/handlers".
  // We try matching the trailing segments against directories in fileSet.
  const segments = importPath.split('/')

  // Try progressively shorter suffixes of the import path.
  for (let start = 0; start < segments.length; start++) {
    const suffix = segments.slice(start).join('/')
    for (const filePath of fileSet) {
      const dir = packageFromPath(filePath)
      if (dir === suffix || dir.endsWith('/' + suffix)) {
        return suffix
      }
    }
  }
  return null
}

// ─── file filtering ─────────────────────────────────────────────

function isGeneratedFile(content: string): boolean {
  // Check first 5 lines for "// Code generated"
  const lines = content.split('\n', 5)
  return lines.some((l) => l.includes('// Code generated'))
}

function shouldSkipGoFile(path: string): boolean {
  return GO_SKIP_PATTERNS.some((re) => re.test(path))
}

// ─── main extract ───────────────────────────────────────────────

function extract(files: Map<string, string>): BackendPluginResult {
  const warnings: BackendWarning[] = []
  const nodes: Node[] = []
  const links: Link[] = []
  const seenNodeIds = new Set<string>()
  const seenLinkIds = new Set<string>()

  let filesConsidered = 0
  let handlersEmitted = 0
  let structsEmitted = 0

  // Filter to .go files only.
  const goFiles = new Map<string, string>()
  for (const [path, content] of files) {
    const p = norm(path)
    if (!p.endsWith('.go')) continue
    filesConsidered++

    if (shouldSkipGoFile(p)) {
      warnings.push({ kind: 'skipped_file', path: p, reason: 'test or vendor file' })
      continue
    }
    if (isGeneratedFile(content)) {
      warnings.push({ kind: 'skipped_file', path: p, reason: 'generated file' })
      continue
    }
    goFiles.set(p, content)
  }

  const fileSet = new Set(goFiles.keys())

  // Pass 1: extract handlers and structs from each file.
  for (const [path, content] of goFiles) {
    const pkg = packageFromPath(path)

    // Handlers
    const handlers = extractHandlers(content)
    for (const h of handlers) {
      const normalizedPath = normalizePathParams(h.path)
      const method = h.method.toUpperCase()
      const id = `codebase:go:op:${method}:${sanitizePath(normalizedPath)}`

      if (seenNodeIds.has(id)) continue
      seenNodeIds.add(id)
      handlersEmitted++

      nodes.push({
        id,
        name: `${method} ${normalizedPath}`,
        type: 'api',
        description: `${path}:${h.line}`,
        group: 'go handlers',
        origin: 'auto:codebase',
        metadata: { backend: 'go', filePath: path, line: h.line },
      })
    }

    // Structs
    const structs = extractStructs(content)
    for (const s of structs) {
      const id = `codebase:go:struct:${pkg}.${s.name}`

      if (seenNodeIds.has(id)) continue
      seenNodeIds.add(id)
      structsEmitted++

      nodes.push({
        id,
        name: s.name,
        type: 'database',
        description: `${path}:${s.line}`,
        group: 'go structs',
        origin: 'auto:codebase',
        metadata: { backend: 'go', filePath: path, line: s.line },
      })
    }
  }

  // Pass 2: dependency edges from Go imports.
  for (const [path, content] of goFiles) {
    const imports = extractGoImports(content)
    const fromId = `codebase:go:file:${path}`

    for (const spec of imports) {
      const resolved = resolveGoImport(spec, fileSet)
      if (!resolved) {
        // Only warn for imports that look local (not stdlib).
        if (spec.includes('.') || spec.includes('/')) {
          // Could be external — don't warn for obvious stdlib imports.
          const isStdlib = !spec.includes('.')
          if (!isStdlib) {
            warnings.push({ kind: 'unresolved_import', from: path, spec })
          }
        }
        continue
      }

      // Find a representative file in the resolved package.
      const targetFile = [...fileSet].find((f) => {
        const dir = packageFromPath(f)
        return dir === resolved || dir.endsWith('/' + resolved)
      })
      if (!targetFile) continue

      const toId = `codebase:go:file:${targetFile}`
      const id = linkId(fromId, toId, 'dependency')
      if (seenLinkIds.has(id)) continue
      seenLinkIds.add(id)

      links.push({
        id,
        source: fromId,
        target: toId,
        label: 'imports',
        description: `${path} → ${spec}`,
        type: 'dependency',
        origin: 'auto:codebase',
      })
    }
  }

  // Sort for deterministic output.
  nodes.sort((a, b) => a.id.localeCompare(b.id))
  links.sort((a, b) => a.id.localeCompare(b.id))

  if (nodes.length === 0 && links.length === 0) {
    return {
      ok: true,
      schema: null,
      warnings,
      stats: { filesConsidered, handlersEmitted, structsEmitted },
    }
  }

  const schema: Schema = {
    meta: {
      name: 'Imported from codebase (Go)',
      version: SCHEMA_VERSION,
      sources: ['auto:codebase'],
    },
    nodeTypes: DEFAULT_NODE_TYPES,
    linkTypes: DEFAULT_LINK_TYPES,
    nodes,
    links,
    paths: [],
    annotations: [],
  }

  const withEntities = propagateEntities(schema)

  return {
    ok: true,
    schema: withEntities,
    warnings,
    stats: { filesConsidered, handlersEmitted, structsEmitted },
  }
}

export const goPlugin: BackendPlugin = {
  language: 'go',
  fileExtensions: ['.go'],
  extract,
}
