import type { BackendPlugin } from '@/importers/codebase/backends/types'

export const nodejsPlugin: BackendPlugin = {
  language: 'nodejs',
  fileExtensions: ['.js', '.mjs', '.cjs', '.ts'],
  extract(_files) {
    return {
      ok: true,
      schema: null,
      warnings: [{ kind: 'unsupported_language', language: 'nodejs' }],
      stats: { filesConsidered: 0, handlersEmitted: 0, structsEmitted: 0 },
    }
  },
}
