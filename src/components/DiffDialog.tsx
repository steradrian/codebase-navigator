import { useEffect, useRef, useState } from 'react'
import type { Schema } from '@/types'
import { readSchemaFromFile } from '@/schema/io'
import { computeDiff, type SchemaDiff, isEmptyDiff } from '@/schema/diff'

type Props = {
  open: boolean
  currentSchema: Schema
  onApplyOverlay: (diff: SchemaDiff) => void
  onClose: () => void
}

export function DiffDialog({ open, currentSchema, onApplyOverlay, onClose }: Props) {
  const [baseline, setBaseline] = useState<Schema | null>(null)
  const [diff, setDiff] = useState<SchemaDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) {
      setBaseline(null)
      setDiff(null)
      setError(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const handleFile = async (file: File) => {
    setError(null)
    const result = await readSchemaFromFile(file)
    if (result.ok && result.schema) {
      setBaseline(result.schema)
      setDiff(computeDiff(result.schema, currentSchema))
    } else {
      setError(result.message ?? 'Could not load baseline schema.')
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Diff against baseline</h2>
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>
        </div>

        <div style={bodyStyle}>
          {!baseline && (
            <>
              <p style={{ color: '#999', fontSize: 12, margin: '0 0 12px 0' }}>
                Load a previously-saved schema JSON to compare against the current state. The diff will
                show added / removed / modified nodes, links, and paths.
              </p>
              <button onClick={() => fileInputRef.current?.click()} style={primaryBtnStyle}>
                📂 Load baseline…
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleFile(f)
                  e.target.value = ''
                }}
              />
              {error && (
                <div style={errorBoxStyle}>
                  {error}
                </div>
              )}
            </>
          )}

          {baseline && diff && (
            <>
              {isEmptyDiff(diff) ? (
                <div style={{ color: '#888', fontSize: 12, padding: '16px 0' }}>
                  No structural differences. Current schema matches the baseline.
                </div>
              ) : (
                <>
                  <div style={statsGridStyle}>
                    <StatTile label="Nodes +" value={diff.totals.nodesAdded} color="#69f0ae" />
                    <StatTile label="Nodes ~" value={diff.totals.nodesModified} color="#ffd740" />
                    <StatTile label="Nodes −" value={diff.totals.nodesRemoved} color="#ff6e40" />
                    <StatTile label="Links +" value={diff.totals.linksAdded} color="#69f0ae" />
                    <StatTile label="Links ~" value={diff.totals.linksModified} color="#ffd740" />
                    <StatTile label="Links −" value={diff.totals.linksRemoved} color="#ff6e40" />
                    <StatTile label="Paths +" value={diff.totals.pathsAdded} color="#69f0ae" />
                    <StatTile label="Paths ~" value={diff.totals.pathsModified} color="#ffd740" />
                    <StatTile label="Paths −" value={diff.totals.pathsRemoved} color="#ff6e40" />
                  </div>

                  {renderSection('Added nodes', '#69f0ae', diff.nodes.added.map((n) => `${n.id} · ${n.name}`))}
                  {renderSection('Removed nodes', '#ff6e40', diff.nodes.removed.map((n) => `${n.id} · ${n.name}`))}
                  {renderModifiedSection('Modified nodes', '#ffd740', diff.nodes.modified.map((m) => ({
                    id: m.after.id,
                    name: m.after.name,
                    changes: m.changes.map((c) => c.field),
                  })))}

                  {renderSection('Added links', '#69f0ae', diff.links.added.map((l) => l.id))}
                  {renderSection('Removed links', '#ff6e40', diff.links.removed.map((l) => l.id))}
                  {renderModifiedSection('Modified links', '#ffd740', diff.links.modified.map((m) => ({
                    id: m.after.id,
                    name: m.after.label || m.after.id,
                    changes: m.changes.map((c) => c.field),
                  })))}

                  {renderSection('Added paths', '#69f0ae', diff.paths.added.map((p) => `${p.id} · ${p.name}`))}
                  {renderSection('Removed paths', '#ff6e40', diff.paths.removed.map((p) => `${p.id} · ${p.name}`))}
                  {renderModifiedSection('Modified paths', '#ffd740', diff.paths.modified.map((m) => ({
                    id: m.after.id,
                    name: m.after.name,
                    changes: m.changes.map((c) => c.field),
                  })))}
                </>
              )}

              <div style={footerStyle}>
                <button onClick={() => setBaseline(null)} style={secondaryBtnStyle}>
                  Change baseline
                </button>
                <div style={{ flex: 1 }} />
                <button onClick={onClose} style={secondaryBtnStyle}>Close</button>
                {!isEmptyDiff(diff) && (
                  <button onClick={() => onApplyOverlay(diff)} style={primaryBtnStyle}>
                    Overlay on graph
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────

function renderSection(title: string, accent: string, items: string[]) {
  if (items.length === 0) return null
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: accent, marginBottom: 4 }}>
        {title} ({items.length})
      </div>
      <div style={{ maxHeight: 120, overflowY: 'auto' }}>
        {items.slice(0, 25).map((item) => (
          <div key={item} style={listItemStyle}>{item}</div>
        ))}
        {items.length > 25 && (
          <div style={{ fontSize: 10, color: '#555', marginTop: 3 }}>and {items.length - 25} more…</div>
        )}
      </div>
    </div>
  )
}

function renderModifiedSection(title: string, accent: string, items: { id: string; name: string; changes: string[] }[]) {
  if (items.length === 0) return null
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: accent, marginBottom: 4 }}>
        {title} ({items.length})
      </div>
      <div style={{ maxHeight: 160, overflowY: 'auto' }}>
        {items.slice(0, 25).map((item) => (
          <div key={item.id} style={listItemStyle}>
            <div>{item.name}</div>
            <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
              changed: {item.changes.join(', ')}
            </div>
          </div>
        ))}
        {items.length > 25 && (
          <div style={{ fontSize: 10, color: '#555', marginTop: 3 }}>and {items.length - 25} more…</div>
        )}
      </div>
    </div>
  )
}

const StatTile = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 5, padding: '6px 4px', textAlign: 'center' }}>
    <div style={{ color, fontSize: 16, fontWeight: 700 }}>{value}</div>
    <div style={{ color: '#888', fontSize: 8, letterSpacing: 1, textTransform: 'uppercase', marginTop: 1 }}>{label}</div>
  </div>
)

// ─── styles ─────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100, fontFamily: "'Segoe UI', system-ui, sans-serif", color: '#fff',
}

const modalStyle: React.CSSProperties = {
  width: 620, maxWidth: '92vw', maxHeight: '86vh',
  background: 'rgba(10,10,25,0.98)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column',
}

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)',
}

const closeBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', border: 'none', color: '#888',
  borderRadius: 6, width: 26, height: 26, cursor: 'pointer', fontSize: 12,
}

const bodyStyle: React.CSSProperties = {
  padding: '16px 18px', overflowY: 'auto', flex: 1,
}

const footerStyle: React.CSSProperties = {
  display: 'flex', gap: 8, marginTop: 16, paddingTop: 14,
  borderTop: '1px solid rgba(255,255,255,0.06)',
}

const statsGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14,
}

const listItemStyle: React.CSSProperties = {
  fontSize: 11, color: '#ccc', padding: '5px 8px', borderRadius: 4,
  marginBottom: 3, background: 'rgba(255,255,255,0.02)',
  fontFamily: 'ui-monospace, monospace',
}

const primaryBtnStyle: React.CSSProperties = {
  background: '#69f0ae22', border: '1px solid #69f0ae55', color: '#69f0ae',
  padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}

const secondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#ccc', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}

const errorBoxStyle: React.CSSProperties = {
  background: 'rgba(255,110,64,0.08)', border: '1px solid rgba(255,110,64,0.25)',
  color: '#ffa080', padding: 10, borderRadius: 6, fontSize: 11, marginTop: 10,
}
