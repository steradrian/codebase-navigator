import { useEffect, useRef, useState } from 'react'
import type { MergeConflict, Schema } from '@/types'
import { parseCodebase, type CodebaseParseWarning } from '@/importers/codebase'
import { readCodebaseFolder } from '@/importers/codebase/fileReader'
import { validate } from '@/schema/validate'
import { merge } from '@/schema/merge'
import { ProgressPane } from '@/components/ProgressPane'

type Stage =
  | { kind: 'source' }
  | { kind: 'reading'; filesRead: number; totalFiles: number }
  | { kind: 'parsing' }
  | { kind: 'error'; messages: string[] }
  | {
      kind: 'preview'
      candidate: Schema
      merged: Schema
      conflicts: MergeConflict[]
      warnings: CodebaseParseWarning[]
      diff: Diff
      stats: { filesConsidered: number; filesEmitted: number; importsResolved: number }
    }

type Diff = {
  nodesAdded: string[]
  nodesRemoved: string[]
  nodesUpdated: string[]
  linksAdded: string[]
  linksRemoved: string[]
  linksUpdated: string[]
}

type Props = {
  open: boolean
  existingSchema: Schema
  onConfirm: (mergedSchema: Schema) => void
  onCancel: () => void
}

// Declare the non-standard webkitdirectory attribute for TS.
declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string
    directory?: string
  }
}

export function CodebaseImportDialog({ open, existingSchema, onConfirm, onCancel }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'source' })
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) setStage({ kind: 'source' })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const handleFolder = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setStage({ kind: 'reading', filesRead: 0, totalFiles: 0 })

    const files = await readCodebaseFolder(fileList, {
      onProgress: ({ filesRead, totalFiles }) => {
        setStage({ kind: 'reading', filesRead, totalFiles })
      },
    })

    setStage({ kind: 'parsing' })
    // Yield to the browser so the parsing-state render actually paints
    // before we block the event loop in parseCodebase.
    await new Promise((r) => setTimeout(r, 0))

    const result = parseCodebase(files)
    if (!result.ok || !result.schema) {
      setStage({ kind: 'error', messages: ['Parser failed. Check console.'] })
      return
    }
    const v = validate(result.schema)
    if (!v.ok) {
      setStage({ kind: 'error', messages: v.errors.slice(0, 10).map((e) => `${e.kind}: ${JSON.stringify(e)}`) })
      return
    }
    const mergeResult = merge(existingSchema, result.schema)
    const diff = computeDiff(existingSchema, mergeResult.schema)
    setStage({
      kind: 'preview',
      candidate: result.schema,
      merged: mergeResult.schema,
      conflicts: mergeResult.conflicts,
      warnings: result.warnings,
      diff,
      stats: {
        filesConsidered: result.stats.filesConsidered,
        filesEmitted: result.stats.filesEmitted,
        importsResolved: result.stats.importsResolved,
      },
    })
  }

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Import from codebase</h2>
          <button onClick={onCancel} style={closeBtnStyle} aria-label="Close">✕</button>
        </div>

        <div style={bodyStyle}>
          {stage.kind === 'source' && (
            <>
              <p style={{ color: '#999', fontSize: 12, margin: '0 0 12px 0', lineHeight: 1.5 }}>
                Point at a Next.js App Router repo. We'll seed nodes for every page,
                layout, route handler, and component — and wire dependency edges from
                each file's imports. Large files (&gt;256KB), tests, stories,
                and build artifacts are skipped.
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                style={primaryBtnStyle}
              >
                📂 Choose project folder…
              </button>
              <input
                ref={fileInputRef}
                type="file"
                webkitdirectory=""
                directory=""
                multiple
                style={{ display: 'none' }}
                onChange={(e) => handleFolder(e.target.files)}
              />
              <div style={{ marginTop: 10, fontSize: 10, color: '#666', lineHeight: 1.5 }}>
                Your files never leave the browser. Parsing happens entirely client-side.
              </div>
            </>
          )}

          {stage.kind === 'reading' && (
            <ProgressPane
              label={stage.totalFiles === 0 ? 'Discovering files…' : 'Reading files'}
              current={stage.filesRead}
              total={stage.totalFiles}
            />
          )}

          {stage.kind === 'parsing' && (
            <div style={{ color: '#b388ff', fontSize: 12, padding: '20px 0' }}>
              Parsing imports and classifying files…
            </div>
          )}

          {stage.kind === 'error' && (
            <>
              <div style={{ color: '#ff6e40', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                Could not import this codebase
              </div>
              <ul style={{ color: '#ccc', fontSize: 11, paddingLeft: 20, margin: 0, lineHeight: 1.6 }}>
                {stage.messages.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
              <div style={footerStyle}>
                <button onClick={() => setStage({ kind: 'source' })} style={primaryBtnStyle}>Back</button>
              </div>
            </>
          )}

          {stage.kind === 'preview' && (
            <>
              <div style={statsRowStyle}>
                <Stat label="Files seen" value={stage.stats.filesConsidered} color="#b388ff" />
                <Stat label="Nodes from import" value={stage.stats.filesEmitted} color="#b388ff" />
                <Stat label="Imports resolved" value={stage.stats.importsResolved} color="#69f0ae" />
                <Stat label="Conflicts" value={stage.conflicts.length} color={stage.conflicts.length ? '#ff4081' : '#555'} />
              </div>

              <div style={statsRowStyle}>
                <Stat label="Nodes +" value={stage.diff.nodesAdded.length} color="#69f0ae" />
                <Stat label="Nodes ~" value={stage.diff.nodesUpdated.length} color="#ffd740" />
                <Stat label="Nodes −" value={stage.diff.nodesRemoved.length} color="#ff6e40" />
                <Stat label="Warnings" value={stage.warnings.length} color="#ffd740" />
              </div>

              {stage.conflicts.length > 0 && (
                <Section title={`Conflicts (${stage.conflicts.length})`} accent="#ff4081">
                  {stage.conflicts.map((c, i) => (
                    <div key={i} style={listItemStyle}>
                      <code style={codeStyle}>{c.kind}</code>{' '}
                      <span style={{ color: '#ccc' }}>{'entityId' in c ? c.entityId : ''}</span>
                    </div>
                  ))}
                </Section>
              )}

              {stage.warnings.length > 0 && (
                <Section title={`Warnings (${stage.warnings.length})`} accent="#ffd740">
                  {stage.warnings.slice(0, 10).map((w, i) => (
                    <div key={i} style={listItemStyle}>
                      <code style={codeStyle}>{w.kind}</code>{' '}
                      <span style={{ color: '#999' }}>
                        {'spec' in w ? w.spec : 'path' in w ? w.path : ''}
                      </span>
                    </div>
                  ))}
                  {stage.warnings.length > 10 && (
                    <div style={{ color: '#666', fontSize: 10, marginTop: 3 }}>and {stage.warnings.length - 10} more…</div>
                  )}
                </Section>
              )}

              <div style={footerStyle}>
                <button onClick={() => setStage({ kind: 'source' })} style={secondaryBtnStyle}>Back</button>
                <div style={{ flex: 1 }} />
                <button onClick={onCancel} style={secondaryBtnStyle}>Cancel</button>
                <button onClick={() => onConfirm(stage.merged)} style={primaryBtnStyle}>
                  Apply import
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────

function computeDiff(before: Schema, after: Schema): Diff {
  const bN = new Map(before.nodes.map((n) => [n.id, n]))
  const aN = new Map(after.nodes.map((n) => [n.id, n]))
  const bL = new Map(before.links.map((l) => [l.id, l]))
  const aL = new Map(after.links.map((l) => [l.id, l]))
  const nodesAdded: string[] = [], nodesRemoved: string[] = [], nodesUpdated: string[] = []
  for (const [id, n] of aN) {
    const prev = bN.get(id)
    if (!prev) nodesAdded.push(id)
    else if (JSON.stringify(prev) !== JSON.stringify(n)) nodesUpdated.push(id)
  }
  for (const id of bN.keys()) if (!aN.has(id)) nodesRemoved.push(id)
  const linksAdded: string[] = [], linksRemoved: string[] = [], linksUpdated: string[] = []
  for (const [id, l] of aL) {
    const prev = bL.get(id)
    if (!prev) linksAdded.push(id)
    else if (JSON.stringify(prev) !== JSON.stringify(l)) linksUpdated.push(id)
  }
  for (const id of bL.keys()) if (!aL.has(id)) linksRemoved.push(id)
  return { nodesAdded, nodesRemoved, nodesUpdated, linksAdded, linksRemoved, linksUpdated }
}

const Stat = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div style={{ flex: 1, textAlign: 'center', padding: '8px 4px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6 }}>
    <div style={{ color, fontSize: 18, fontWeight: 700 }}>{value}</div>
    <div style={{ color: '#888', fontSize: 8, letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 }}>{label}</div>
  </div>
)

const Section = ({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) => (
  <div style={{ marginTop: 10 }}>
    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: accent, marginBottom: 5 }}>{title}</div>
    <div style={{ maxHeight: 140, overflowY: 'auto' }}>{children}</div>
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
const bodyStyle: React.CSSProperties = { padding: '16px 18px', overflowY: 'auto', flex: 1 }
const footerStyle: React.CSSProperties = {
  display: 'flex', gap: 8, marginTop: 14, paddingTop: 12,
  borderTop: '1px solid rgba(255,255,255,0.06)',
}
const statsRowStyle: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 8 }
const listItemStyle: React.CSSProperties = { padding: '4px 0', fontSize: 11 }
const codeStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3,
  fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: '#ccc',
}
const primaryBtnStyle: React.CSSProperties = {
  background: '#69f0ae22', border: '1px solid #69f0ae55', color: '#69f0ae',
  padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
const secondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#ccc', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
