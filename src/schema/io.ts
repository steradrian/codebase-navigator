// ─────────────────────────────────────────────────────────────────
// Schema file I/O — serialize / deserialize v1.0 schemas as JSON.
//
// Export: produces a stable, pretty-printed JSON file the browser
// downloads. Stable key ordering matters because file-level diffs
// are the primary review tool while the server persistence story
// (GE-020) is not yet in place.
//
// Import: reads a File, parses, validates, returns a discriminated
// result. Rejects malformed input at the boundary.
// ─────────────────────────────────────────────────────────────────

import type { Schema } from '@/types'
import { validate } from '@/schema/validate'

/** Deep-sort an object's keys so JSON output is stable across runs. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (typeof value === 'object' && value !== null) {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k])
    return out
  }
  return value
}

/** Serialize a schema to pretty-printed JSON with stable key order. */
export function serialize(schema: Schema): string {
  return JSON.stringify(sortKeysDeep(schema), null, 2)
}

/** Trigger a browser download of the schema as JSON. */
export function downloadSchema(schema: Schema): void {
  const json = serialize(schema)
  const slug = (schema.meta.name || 'schema')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d+Z$/, '')
  const filename = `${slug || 'schema'}-${timestamp}.json`

  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export type ImportResult = {
  ok: boolean
  schema: Schema | null
  message: string | null
}

/** Parse + validate a File containing a v1.0 schema JSON. */
export async function readSchemaFromFile(file: File): Promise<ImportResult> {
  let text: string
  try {
    text = await file.text()
  } catch (err) {
    return { ok: false, schema: null, message: `Could not read file: ${(err as Error).message}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, schema: null, message: `File is not valid JSON: ${(err as Error).message}` }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, schema: null, message: 'File must contain a JSON object at the top level.' }
  }

  // Validate — wrap in try/catch to catch shape surprises (missing
  // arrays, wrong types) rather than crashing the caller.
  try {
    const v = validate(parsed as Schema)
    if (!v.ok) {
      const preview = v.errors.slice(0, 3).map((e) => e.kind).join(', ')
      const suffix = v.errors.length > 3 ? ` (+${v.errors.length - 3} more)` : ''
      return { ok: false, schema: null, message: `Schema failed validation: ${preview}${suffix}` }
    }
  } catch (err) {
    return { ok: false, schema: null, message: `Schema shape is invalid: ${(err as Error).message}` }
  }

  return { ok: true, schema: parsed as Schema, message: null }
}
