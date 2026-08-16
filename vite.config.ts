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
    name: 'graph-explorer-api',
    async configureServer(server) {
      // Dynamic import so schema generation / db-less tools don't crash.
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
