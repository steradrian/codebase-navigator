// ─────────────────────────────────────────────────────────────────
// Development placeholder.
//
// Not the product, and deliberately not a partial version of it — the
// interface is being designed before it is built, and a half-built
// exploration surface would anchor those designs to whatever happened
// to exist first.
//
// What it does do is exercise the API for real: it lists the graphs the
// server actually holds and reports what the model knows about the one
// you pick. That keeps the backend honest during design work, and gives
// an immediate signal if a route breaks.
//
// This file is expected to be deleted when the real UI lands.
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import type { CoverageReport } from '@/schema/coverage'
import type { IndexingReport } from '@/schema/indexing'

type GraphSummary = { id: string; name: string; updatedAt: string }

type Status =
  | { kind: 'loading' }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'ready'; graphs: GraphSummary[] }

const styles = {
  page: {
    height: '100%',
    overflow: 'auto',
    background: '#0B0E14',
    color: '#EEF1F7',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontSize: 15,
    lineHeight: 1.6,
    padding: '3rem 1.5rem 5rem',
  },
  wrap: { maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '2rem' },
  eyebrow: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: '#767F91',
  },
  h1: { fontSize: '1.9rem', lineHeight: 1.15, letterSpacing: '-0.02em', fontWeight: 620, margin: 0 },
  muted: { color: '#AAB2C0', margin: 0 },
  card: {
    background: '#141824',
    border: '1px solid #252B38',
    borderRadius: 10,
    padding: '1rem 1.15rem',
  },
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12.5,
    color: '#AAB2C0',
    whiteSpace: 'pre-wrap' as const,
    margin: 0,
  },
  button: {
    background: '#211D3E',
    border: '1px solid #8B7CFF',
    color: '#EEF1F7',
    borderRadius: 8,
    padding: '0.4rem 0.8rem',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
  },
} as const

const pct = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`)

export function Placeholder() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<CoverageReport | null>(null)
  const [indexing, setIndexing] = useState<IndexingReport | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/graphs')
      .then(async (r) => {
        if (!r.ok) throw new Error(`server responded ${r.status}`)
        return r.json() as Promise<{ graphs: GraphSummary[] }>
      })
      .then((body) => {
        if (!cancelled) setStatus({ kind: 'ready', graphs: body.graphs })
      })
      .catch((err: Error) => {
        if (!cancelled) setStatus({ kind: 'unreachable', detail: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    const now = new Date().toISOString()
    Promise.all([
      fetch(`/api/graphs/${selected}/coverage?now=${now}`).then((r) => r.json()),
      fetch(`/api/graphs/${selected}/indexing`).then((r) => r.json()),
    ])
      .then(([c, i]) => {
        if (cancelled) return
        setCoverage(c.data as CoverageReport)
        setIndexing(i.data as IndexingReport)
      })
      .catch(() => {
        if (!cancelled) {
          setCoverage(null)
          setIndexing(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        <div>
          <p style={styles.eyebrow}>codebase-navigator</p>
          <h1 style={styles.h1}>Backend ready. Interface pending design.</h1>
        </div>

        <p style={styles.muted}>
          The 3D graph explorer that used to run here has been removed. The new interface is being
          designed before it is built, so this page is a placeholder — it talks to the real API so
          the backend stays exercised while that happens.
        </p>

        {status.kind === 'loading' && <p style={styles.muted}>Checking the API…</p>}

        {status.kind === 'unreachable' && (
          <div style={styles.card}>
            <p style={{ ...styles.muted, color: '#F3B85B' }}>
              The API did not respond ({status.detail}).
            </p>
            <p style={{ ...styles.muted, marginTop: '0.5rem' }}>
              Postgres is probably not running. Start it with <code>pnpm db:up</code>, then apply
              migrations with <code>pnpm db:migrate</code>.
            </p>
          </div>
        )}

        {status.kind === 'ready' && status.graphs.length === 0 && (
          <div style={styles.card}>
            <p style={styles.muted}>
              The API is up and holds no graphs yet. Import one to see what the model extracts.
            </p>
          </div>
        )}

        {status.kind === 'ready' && status.graphs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            <p style={styles.eyebrow}>graphs on this server</p>
            {status.graphs.map((g) => (
              <div key={g.id} style={{ ...styles.card, display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 560 }}>{g.name}</div>
                  <div style={{ ...styles.mono, fontSize: 11.5 }}>
                    updated {new Date(g.updatedAt).toLocaleString()}
                  </div>
                </div>
                <button type="button" style={styles.button} onClick={() => setSelected(g.id)}>
                  Inspect
                </button>
              </div>
            ))}
          </div>
        )}

        {coverage && indexing && (
          <div style={styles.card}>
            <p style={styles.eyebrow}>what the model knows</p>
            <pre style={styles.mono}>
{`understanding coverage
  entities   ${pct(coverage.product.dimensions.entities.value)}
  journeys   ${pct(coverage.product.dimensions.journeys.value)}
  behavior   ${pct(coverage.product.dimensions.behavior.value)}
  evidence   ${pct(coverage.product.dimensions.evidence.value)}
  tests      ${pct(coverage.product.dimensions.tests.value)}
  why        ${pct(coverage.product.dimensions.why.value)}
  runtime    ${pct(coverage.product.dimensions.runtime.value)}
  freshness  ${pct(coverage.product.dimensions.freshness.value)}
  overall    ${pct(coverage.product.overall)}

indexing (${indexing.status})
${indexing.stages.map((s) => `  ${s.status.padEnd(12)}${String(s.produced).padStart(5)}  ${s.label}`).join('\n')}`}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
