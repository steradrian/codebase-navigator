/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

/**
 * Mount the Hono API app at `/api/*` during `npm run dev`.
 * Lazy-loaded so the API module's DB connection isn't established on
 * every Vite restart unless the dev server actually runs.
 */
function apiMiddleware(): Plugin {
  return {
    name: 'codebase-navigator-api',
    // Vitest starts a Vite server too, and mounting the API there would
    // open a database connection for a suite of pure-function tests and
    // fail the whole run when no database is present.
    apply: (_config, { command }) => command === 'serve' && !process.env.VITEST,
    async configureServer(server) {
      // Dynamic import so schema generation / db-less tools don't crash.
      //
      // Note for anyone extending the server: Vite inlines this module
      // and its transitive graph into the bundled config, where the `@/`
      // alias does not resolve. Type-only `@/` imports are fine — they
      // are erased — but a VALUE import via `@/` anywhere reachable from
      // src/server will break `pnpm dev` with an opaque
      // "Cannot find package '@/...'". Use relative imports in that
      // graph. See src/schema/projection/index.ts.
      const [{ createApp }, { getRequestListener }] = await Promise.all([
        import('./src/server/api'),
        import('@hono/node-server'),
      ])
      const app = createApp()
      const listener = getRequestListener(async (req) => app.fetch(req))

      server.middlewares.use('/api', (req, res, next) => {
        // Connect strips the /api mount prefix from req.url, so Hono
        // sees e.g. "/graphs/:id" — matching the routes registered in
        // src/server/api.ts. No prefix restoration needed.
        Promise.resolve(listener(req, res)).catch(next)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), apiMiddleware()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
