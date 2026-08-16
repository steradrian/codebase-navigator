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
    configureServer(server) {
      // The API is loaded through Vite, lazily, on the first /api
      // request — never imported by this config directly.
      //
      // A direct `import('./src/server/api')` gets inlined into the
      // bundled config, where the `@/` alias does not resolve. Type-only
      // alias imports survive (TypeScript erases them), so that stayed
      // invisible until a server route pulled in real logic and then
      // killed `pnpm dev` — and every Vitest run — with an opaque
      // "Cannot find package '@/...'".
      //
      // ssrLoadModule applies the same alias and TS handling the app
      // itself gets, so server code may import however it likes. Do not
      // "simplify" this back to a direct import.
      //
      // Deferred to first request rather than done here because module
      // resolution is not fully wired up during configureServer.
      let listener: ((req: unknown, res: unknown) => unknown) | null = null

      const init = async () => {
        const [{ createApp }, { getRequestListener }] = await Promise.all([
          server.ssrLoadModule('/src/server/api.ts') as Promise<
            typeof import('./src/server/api')
          >,
          import('@hono/node-server'),
        ])
        const app = createApp()
        return getRequestListener(async (req) => app.fetch(req))
      }

      server.middlewares.use('/api', (req, res, next) => {
        // Connect strips the /api mount prefix from req.url, so Hono
        // sees e.g. "/graphs/:id" — matching the routes registered in
        // src/server/api.ts. No prefix restoration needed.
        const run = async () => {
          if (!listener) listener = (await init()) as typeof listener
          await (listener as (req: unknown, res: unknown) => unknown)(req, res)
        }
        run().catch(next)
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
