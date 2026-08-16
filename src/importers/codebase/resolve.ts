// ─────────────────────────────────────────────────────────────────
// Shared path-resolution helpers for the codebase parser (GE-026)
// and the code ↔ API linker (GE-026c). Both need to:
//   - Normalize file paths to POSIX form
//   - Resolve ES-import specifiers to file keys (`./x` → `x.ts` etc.)
//   - Extract import specifiers from a source string
// ─────────────────────────────────────────────────────────────────

export const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/

/** POSIX-normalize a path so inputs from mac/linux/webkitdirectory
 *  compare equal. Strips leading slashes. */
export function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** Resolve `..` and `.` segments. */
export function normalizePath(p: string): string {
  const parts = norm(p).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return out.join('/')
}

/** Yield the first file-set key that matches `base` with TS/JS
 *  extension elision or directory/index fallback. */
export function* trySuffixes(base: string, fileSet: Set<string>): Generator<string> {
  if (fileSet.has(base)) { yield base; return }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
    if (fileSet.has(base + ext)) { yield base + ext; return }
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
    if (fileSet.has(`${base}/index${ext}`)) { yield `${base}/index${ext}`; return }
  }
}

/**
 * Resolve an import specifier from `fromPath` to an actual key in
 * `fileSet`, or return null. Handles relative imports, `@/...` alias
 * (tries both `src/...` and repo-root layouts), directory/index
 * patterns, and extension elision. Returns null for bare imports.
 */
export function resolveImport(
  spec: string,
  fromPath: string,
  fileSet: Set<string>,
): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) {
    return null
  }

  if (spec.startsWith('@/')) {
    const tail = spec.slice(2)
    for (const candidate of trySuffixes(`src/${tail}`, fileSet)) return candidate
    for (const candidate of trySuffixes(tail, fileSet)) return candidate
    return null
  }

  let baseRel: string
  if (spec.startsWith('/')) {
    baseRel = norm(spec.replace(/^\/+/, ''))
  } else {
    const fromDir = norm(fromPath).split('/').slice(0, -1).join('/')
    baseRel = normalizePath(`${fromDir}/${spec}`)
  }
  for (const candidate of trySuffixes(baseRel, fileSet)) return candidate
  return null
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*from\s*)?["']([^"']+)["']/g

/** Unique set of import specifiers found in the source. Misses
 *  `import()` and `require()` — this is line-level ES-import only. */
export function extractImports(source: string): string[] {
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  IMPORT_RE.lastIndex = 0
  while ((match = IMPORT_RE.exec(source)) !== null) seen.add(match[1])
  return [...seen]
}
