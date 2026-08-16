// ─────────────────────────────────────────────────────────────────
// Backend plugin interface (GE-109).
//
// Each language plugin exports a BackendPlugin object. The dispatcher
// picks the plugin whose fileExtensions match the majority of files,
// then calls extract().
// ─────────────────────────────────────────────────────────────────

import type { Schema } from '@/types'

export type BackendPluginResult = {
  ok: boolean
  schema: Schema | null
  warnings: BackendWarning[]
  stats: { filesConsidered: number; handlersEmitted: number; structsEmitted: number }
}

export type BackendWarning =
  | { kind: 'unsupported_language'; language: string }
  | { kind: 'skipped_file'; path: string; reason: string }
  | { kind: 'unresolved_import'; from: string; spec: string }

export type BackendPlugin = {
  language: string
  fileExtensions: string[] // e.g. ['.go']
  extract(files: Map<string, string>): BackendPluginResult
}
