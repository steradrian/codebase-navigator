// ─────────────────────────────────────────────────────────────────
// Backend language dispatcher (GE-109).
//
// Accepts a Map<path, content>, determines the dominant backend
// language by file-extension count, and delegates to the matching
// plugin. Returns a graceful result if no plugin matches.
// ─────────────────────────────────────────────────────────────────

import type { BackendPlugin, BackendPluginResult } from '@/importers/codebase/backends/types'
import { goPlugin } from '@/importers/codebase/backends/go'
import { nodejsPlugin } from '@/importers/codebase/backends/nodejs'
import { pythonPlugin } from '@/importers/codebase/backends/python'
import { rustPlugin } from '@/importers/codebase/backends/rust'

const PLUGINS: BackendPlugin[] = [
  goPlugin,
  nodejsPlugin,
  pythonPlugin,
  rustPlugin,
]

/** Build a set of all extensions across all plugins for quick lookup. */
function allExtensions(): Set<string> {
  const exts = new Set<string>()
  for (const p of PLUGINS) {
    for (const ext of p.fileExtensions) exts.add(ext)
  }
  return exts
}

function getExtension(path: string): string {
  const lastDot = path.lastIndexOf('.')
  return lastDot === -1 ? '' : path.slice(lastDot)
}

/**
 * Pick the plugin whose file extensions have the highest count in
 * the input file map. Ties go to the plugin registered first
 * (Go > Node.js > Python > Rust).
 */
function pickPlugin(files: Map<string, string>): BackendPlugin | null {
  const known = allExtensions()
  const counts = new Map<string, number>()

  for (const path of files.keys()) {
    const ext = getExtension(path)
    if (!known.has(ext)) continue
    counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }

  let best: BackendPlugin | null = null
  let bestCount = 0

  for (const plugin of PLUGINS) {
    let total = 0
    for (const ext of plugin.fileExtensions) {
      total += counts.get(ext) ?? 0
    }
    if (total > bestCount) {
      bestCount = total
      best = plugin
    }
  }

  return best
}

export function parseBackendCodebase(files: Map<string, string>): BackendPluginResult {
  if (files.size === 0) {
    return {
      ok: true,
      schema: null,
      warnings: [{ kind: 'unsupported_language', language: 'unknown' }],
      stats: { filesConsidered: 0, handlersEmitted: 0, structsEmitted: 0 },
    }
  }

  const plugin = pickPlugin(files)

  if (!plugin) {
    return {
      ok: true,
      schema: null,
      warnings: [{ kind: 'unsupported_language', language: 'unknown' }],
      stats: { filesConsidered: 0, handlersEmitted: 0, structsEmitted: 0 },
    }
  }

  return plugin.extract(files)
}

export { PLUGINS }
