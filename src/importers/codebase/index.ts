// ─────────────────────────────────────────────────────────────────
// Codebase parser — Next.js App Router (GE-026).
//
// Pure function: takes a Map<relativePath, content> and produces a
// candidate v1.0 Schema with origin: "auto:codebase" on every entity.
// Designed to seed a graph from a real repository, not to be a
// compiler. We pattern-match paths and regex-match imports — accurate
// enough for the 80% case, small enough to keep the client bundle lean.
//
// What gets translated:
//   - app/**/page.{ts,tsx,js,jsx}          → ui node     "Page: /route"
//   - app/**/layout.{ts,tsx,js,jsx}        → ui node     "Layout: /route"
//   - app/**/route.{ts,js}                 → api node    "API: /route"
//   - components/**/*.{ts,tsx,js,jsx}      → ui node     "Component"
//   - other .{ts,tsx,js,jsx} files         → ui node     (filename)
//   - ES imports between parsed files      → dependency links
//
// Skipped (with stats):
//   - Bare imports (node_modules)
//   - Imports that don't resolve to a file in the input
//   - Test files, story files, config files (*.test.*, *.stories.*,
//     *.config.*)
//
// Not supported:
//   - Dynamic imports (import(), require())
//   - Runtime fetch() calls → API edges. Possible future extension —
//     would require AST parsing to handle argument resolution.
//   - Non-Next frameworks. Starting point; other conventions can be
//     added to PATH_PATTERNS.
// ─────────────────────────────────────────────────────────────────

import { linkId } from '@/schema/migrate'
import type {
  Link,
  LinkType,
  Node,
  Schema,
} from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { extractTests, isTestFile } from '@/importers/codebase/tests'
import { isDocFile, parseDocs } from '@/importers/docs'
import { CODE_EXT, extractImports, norm, resolveImport } from '@/importers/codebase/resolve'
import { propagateEntities } from '@/schema/entity/propagate'
import { assignAltitudes } from '@/schema/altitude'

export type CodebaseParseWarning =
  | { kind: 'unresolved_import'; from: string; spec: string }
  | { kind: 'bare_import_skipped'; from: string; spec: string }
  | { kind: 'skipped_file'; path: string; reason: string }

export type CodebaseParseResult = {
  ok: boolean
  schema: Schema | null
  warnings: CodebaseParseWarning[]
  stats: {
    filesConsidered: number
    filesEmitted: number
    importsFound: number
    importsResolved: number
  }
}

const DEFAULT_NODE_TYPES: Record<string, { color: string; label: string; glow?: number }> = {
  domain: { color: '#ff4081', label: 'Domain', glow: 0.15 },
  database: { color: '#00e5ff', label: 'Database', glow: 0.1 },
  service: { color: '#ff6e40', label: 'Service', glow: 0.12 },
  feature: { color: '#b388ff', label: 'Feature', glow: 0.1 },
  api: { color: '#69f0ae', label: 'API', glow: 0.1 },
  // GE sub-types for codebase UI files (replacing the catch-all 'ui').
  client: { color: '#26c6da', label: 'Client', glow: 0.1 },
  hook: { color: '#ce93d8', label: 'Hook', glow: 0.1 },
  component: { color: '#ffd740', label: 'Component', glow: 0.1 },
  page: { color: '#ffab40', label: 'Page', glow: 0.1 },
  layout: { color: '#ff8a65', label: 'Layout', glow: 0.08 },
  util: { color: '#90a4ae', label: 'Util', glow: 0.06 },
  ui: { color: '#ffd740', label: 'UI', glow: 0.1 }, // fallback for legacy data
  external: { color: '#78909c', label: 'External', glow: 0.06 },
  test: { color: '#7fd1ae', label: 'Test', glow: 0.08 },
  document: { color: '#9fa8da', label: 'Document', glow: 0.06 },
  decision: { color: '#b39ddb', label: 'Decision', glow: 0.1 },
}

const DEFAULT_LINK_TYPES: Record<string, LinkType> = {
  data_flow: { color: '#1a4a6c', label: 'Data Flow', animated: true },
  dependency: { color: '#3a2a5c', label: 'Dependency', dashed: true },
  triggers: { color: '#4a3a1c', label: 'Triggers', animated: true },
  tests: { color: '#1f4a3a', label: 'Tests', dashed: true },
  documents: { color: '#2f3a5c', label: 'Documents', dashed: true },
}

const SKIP_FILE_PATTERNS = [
  // `.test.` / `.spec.` are deliberately NOT here — they are routed to
  // the test extractor instead of dropped. Stories remain excluded:
  // they are a rendering harness, not a statement about behaviour.
  /\.stories\./,
  /\.d\.ts$/,
  /\.config\.[cm]?[jt]s$/,
  /\/node_modules\//,
  /\/\.next\//,
  /\/dist\//,
  /\/build\//,
  /\/coverage\//,
]

/** Valid codebase node types. */
type CodebaseNodeType = 'api' | 'client' | 'hook' | 'component' | 'page' | 'layout' | 'util' | 'ui'

/**
 * Classify a file's relative path into (nodeType, displayName).
 * Detection order matters — more specific patterns first.
 */
function classify(path: string): { type: CodebaseNodeType; name: string } {
  const p = norm(path)
  const leaf = p.split('/').pop() ?? p
  const stem = leaf.replace(CODE_EXT, '')

  // app/**/page.ext → page
  const pageMatch = p.match(/(?:^|\/)app\/((?:.*\/)?page)\.(ts|tsx|js|jsx)$/)
  if (pageMatch) {
    const route = '/' + pageMatch[1].replace(/\/?page$/, '')
    return { type: 'page', name: `Page: ${route || '/'}` }
  }
  // app/**/layout.ext → layout
  const layoutMatch = p.match(/(?:^|\/)app\/((?:.*\/)?layout)\.(ts|tsx|js|jsx)$/)
  if (layoutMatch) {
    const route = '/' + layoutMatch[1].replace(/\/?layout$/, '')
    return { type: 'layout', name: `Layout: ${route || '/'}` }
  }
  // app/**/route.ext → API route
  const routeMatch = p.match(/(?:^|\/)app\/((?:.*\/)?route)\.(ts|js)$/)
  if (routeMatch) {
    const route = '/' + routeMatch[1].replace(/\/?route$/, '')
    return { type: 'api', name: `API: ${route || '/'}` }
  }

  // API client files: lib/api/**/client.* or */api/*/client.* or
  // any file named client.ts/fetch*.ts inside an api/ folder.
  if (/(?:^|\/)(?:lib\/)?api\/.*\/client\b/.test(p) ||
      /(?:^|\/)(?:lib\/)?api\/.*\/fetch[^/]*\.(ts|tsx|js|jsx)$/.test(p)) {
    return { type: 'client', name: stem }
  }
  // Broader client pattern: files named *client* or *fetch-functions*
  // inside lib/utils or lib/ with fetch-related names.
  if (/(?:^|\/)lib\/.*(?:client|fetch)[^/]*\.(ts|tsx|js|jsx)$/.test(p)) {
    return { type: 'client', name: stem }
  }

  // Hooks: filename starts with use- or use[A-Z].
  if (/^use[-A-Z]/.test(stem) || /\/use[-A-Z]/.test(p)) {
    return { type: 'hook', name: stem }
  }
  // Hooks inside a hooks/ folder.
  if (/(?:^|\/)hooks\//.test(p)) {
    return { type: 'hook', name: stem }
  }

  // Utilities: files inside utils/, helpers/, lib/utils/, lib/helpers/
  if (/(?:^|\/)(?:utils|helpers)\//.test(p)) {
    return { type: 'util', name: stem }
  }
  // Also files named *.util.ts, *.utils.ts, *.helper.ts
  if (/\.(util|utils|helper|helpers)\.(ts|tsx|js|jsx)$/.test(p)) {
    return { type: 'util', name: stem }
  }

  // components/**/* → component
  const componentMatch = p.match(/(?:^|\/)components\/(.+?)\.(ts|tsx|js|jsx)$/)
  if (componentMatch) {
    return { type: 'component', name: componentMatch[1].split('/').pop() ?? componentMatch[1] }
  }
  // .tsx files are almost always components (React).
  if (/\.tsx$/.test(p)) {
    return { type: 'component', name: stem }
  }

  // fallback: generic UI for remaining code files.
  return { type: 'ui', name: stem }
}

export function nodeIdForPath(relPath: string): string {
  return `codebase:file:${norm(relPath)}`
}

// ─── public entry ────────────────────────────────────────────

export function parseCodebase(files: Map<string, string>): CodebaseParseResult {
  const warnings: CodebaseParseWarning[] = []

  // Normalize keys, then split into product code and tests. Tests are
  // no longer discarded: they are the most reliable statement a codebase
  // makes about its own behaviour, and the Tests lens needs them.
  const effective = new Map<string, string>()
  const testFiles = new Map<string, string>()
  const docFiles = new Map<string, string>()
  let filesConsidered = 0
  for (const [k, v] of files) {
    filesConsidered++
    const p = norm(k)
    if (isDocFile(p)) {
      // Handled by the documentation importer, not skipped.
      docFiles.set(p, v)
      continue
    }
    if (!CODE_EXT.test(p)) {
      warnings.push({ kind: 'skipped_file', path: p, reason: 'non-code file' })
      continue
    }
    if (SKIP_FILE_PATTERNS.some((re) => re.test(`/${p}`))) {
      warnings.push({ kind: 'skipped_file', path: p, reason: 'test / config / build artifact' })
      continue
    }
    if (isTestFile(p)) {
      testFiles.set(p, v)
      continue
    }
    effective.set(p, v)
  }

  const fileSet = new Set(effective.keys())
  const nodes: Node[] = []
  const links: Link[] = []
  const seenNodes = new Set<string>()
  const seenLinks = new Set<string>()

  // Pass 1: node per file.
  // Tests are resolved first so each product file can be created already
  // carrying the evidence its tests provide.
  const testResult = extractTests(testFiles, fileSet)
  const docResult = parseDocs(docFiles, fileSet)

  for (const [path] of effective) {
    const classified = classify(path)
    const id = nodeIdForPath(path)
    if (seenNodes.has(id)) continue
    seenNodes.add(id)
    const gathered = [
      ...(testResult.evidenceBySubject.get(path) ?? []),
      ...(docResult.evidenceBySubject.get(path) ?? []),
    ]
    const testEvidence = gathered.length > 0 ? gathered : undefined
    nodes.push({
      id,
      name: classified.name,
      type: classified.type,
      description: path,
      origin: 'auto:codebase',
      group: classified.type === 'api' ? 'api' : 'ui',
      evidence: testEvidence,
    })
  }

  for (const node of [...testResult.nodes, ...docResult.nodes]) {
    if (seenNodes.has(node.id)) continue
    seenNodes.add(node.id)
    nodes.push(node)
  }
  for (const link of [...testResult.links, ...docResult.links]) {
    if (seenLinks.has(link.id)) continue
    seenLinks.add(link.id)
    links.push(link)
  }

  // Pass 2: imports → dependency links.
  let importsFound = 0
  let importsResolved = 0
  for (const [path, source] of effective) {
    const specs = extractImports(source)
    importsFound += specs.length
    for (const spec of specs) {
      if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) {
        warnings.push({ kind: 'bare_import_skipped', from: path, spec })
        continue
      }
      const target = resolveImport(spec, path, fileSet)
      if (!target) {
        warnings.push({ kind: 'unresolved_import', from: path, spec })
        continue
      }
      if (target === path) continue // self-reference, skip

      importsResolved++
      const fromId = nodeIdForPath(path)
      const toId = nodeIdForPath(target)
      const id = linkId(fromId, toId, 'dependency')
      if (seenLinks.has(id)) continue
      seenLinks.add(id)
      links.push({
        id,
        source: fromId,
        target: toId,
        label: 'imports',
        description: `${path} → ${target}`,
        type: 'dependency',
        origin: 'auto:codebase',
      })
    }
  }

  // Sort for deterministic output.
  nodes.sort((a, b) => a.id.localeCompare(b.id))
  links.sort((a, b) => a.id.localeCompare(b.id))

  const schema: Schema = {
    meta: {
      name: 'Imported from codebase',
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

  // GE-115b — propagate entities from seeded nodes (none here,
  // since codebase import alone has no entity seeds). Real
  // propagation happens after the linker runs against an existing
  // graph that already has API ops tagged from GE-115.
  const withEntities = assignAltitudes(propagateEntities(schema))

  return {
    ok: true,
    schema: withEntities,
    warnings,
    stats: {
      filesConsidered,
      filesEmitted: nodes.length,
      importsFound,
      importsResolved,
    },
  }
}
