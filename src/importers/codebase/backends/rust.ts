import type { BackendPlugin } from '@/importers/codebase/backends/types'

export const rustPlugin: BackendPlugin = {
  language: 'rust',
  fileExtensions: ['.rs'],
  extract(_files) {
    return {
      ok: true,
      schema: null,
      warnings: [{ kind: 'unsupported_language', language: 'rust' }],
      stats: { filesConsidered: 0, handlersEmitted: 0, structsEmitted: 0 },
    }
  },
}
