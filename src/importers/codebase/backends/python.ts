import type { BackendPlugin } from '@/importers/codebase/backends/types'

export const pythonPlugin: BackendPlugin = {
  language: 'python',
  fileExtensions: ['.py'],
  extract(_files) {
    return {
      ok: true,
      schema: null,
      warnings: [{ kind: 'unsupported_language', language: 'python' }],
      stats: { filesConsidered: 0, handlersEmitted: 0, structsEmitted: 0 },
    }
  },
}
