import { useEffect, useRef, useState } from 'react'
import type { Schema, Link } from '@/types'
import {
  extractCodebaseApiLinks,
  extractBackendToApiLinks,
  type LinkWarning,
  type BackendLinkWarning,
  type BackendLinkResult,
  type LinkResult,
} from '@/importers/codebase/linker'
import { readCodebaseFolder } from '@/importers/codebase/fileReader'
import { ProgressPane } from '@/components/ProgressPane'
import { propagateEntities } from '@/schema/entity/propagate'

type CombinedWarning = LinkWarning | BackendLinkWarning

type PreviewData = {
  newLinks: Link[]
  warnings: CombinedWarning[]
  feStats: LinkResult['stats']
  beStats: BackendLinkResult['stats']
}

type Stage =
  | { kind: 'source' }
  | { kind: 'reading'; filesRead: number; totalFiles: number }
  | { kind: 'extracting' }
  | { kind: 'preview'; data: PreviewData }
  | { kind: 'error'; message: string }

type Props = {
  open: boolean
  existingSchema: Schema
  onApply: (nextSchema: Schema) => void
  onCancel: () => void
}

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string
    directory?: string
  }
}

export function LinkImportsDialog({ open, existingSchema, onApply, onCancel }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'source' })
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { if (open) setStage({ kind: 'source' }) }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  // Sanity checks on the current schema.
  const hasApiNodes = existingSchema.nodes.some((n) => n.origin === 'auto:openapi' && n.type === 'api')
  const hasCodeNodes = existingSchema.nodes.some((n) => n.origin === 'auto:codebase')
  const missingPrerequisite = !hasApiNodes || !hasCodeNodes

  const handleFolder = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setStage({ kind: 'reading', filesRead: 0, totalFiles: 0 })

    const files = await readCodebaseFolder(fileList, {
      onProgress: ({ filesRead, totalFiles }) => {
        setStage({ kind: 'reading', filesRead, totalFiles })
      },
    })

    setStage({ kind: 'extracting' })
    // Let the browser paint the "extracting" state before the main thread
    // is blocked by the linker's regex passes.
    await new Promise((r) => setTimeout(r, 0))

    try {
      const feResult = extractCodebaseApiLinks(files, existingSchema)

      // Run BE linker against the schema (no file I/O needed).
      const beResult = extractBackendToApiLinks(existingSchema)

      // Dedup combined links by ID.
      const seenIds = new Set<string>()
      const combinedLinks: Link[] = []
      for (const l of [...feResult.links, ...beResult.links]) {
        if (seenIds.has(l.id)) continue
        seenIds.add(l.id)
        combinedLinks.push(l)
      }

      setStage({
        kind: 'preview',
        data: {
          newLinks: combinedLinks,
          warnings: [...feResult.warnings, ...beResult.warnings],
          feStats: feResult.stats,
          beStats: beResult.stats,
        },
      })
    } catch (err) {
      setStage({ kind: 'error', message: `Linker failed: ${(err as Error).message}` })
    }
  }

  const applyLinks = (links: Schema['links']) => {
    // Remove old auto:codebase call/implementation links that are being
    // replaced by new auto:linker links (same IDs, different origin).
    const newIds = new Set(links.map((l) => l.id))
    const cleaned = existingSchema.links.filter((l) => {
      if (l.origin !== 'auto:codebase') return true
      if (l.label !== 'calls' && l.label !== 'implemented by') return true
      return !newIds.has(l.id)
    })
    const next: Schema = { ...existingSchema, links: [...cleaned, ...links] }
    // GE-115b — propagation tags FE files via the new cross-stack edges.
    onApply(propagateEntities(next))
  }

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Link code to API endpoints</h2>
          <button onClick={onCancel} style={closeBtnStyle} aria-label="Close">✕</button>
        </div>

        <div style={bodyStyle}>
          {stage.kind === 'source' && (
            <>
              <p style={{ color: '#999', fontSize: 12, margin: '0 0 12px 0', lineHeight: 1.5 }}>
                Re-select your codebase folder. We'll scan for <code style={codeStyle}>client.GET(...)</code>,
                raw <code style={codeStyle}>fetch(...)</code> calls, and hook-to-function indirection,
                then emit edges from files to the matching API nodes in this project.
              </p>
              {missingPrerequisite && (
                <div style={warningBoxStyle}>
                  ⚠ This project doesn't have both OpenAPI and codebase nodes yet. Import an OpenAPI
                  spec AND a codebase first, then come back — the linker needs both ends to connect.
                </div>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={missingPrerequisite}
                style={missingPrerequisite ? disabledBtnStyle : primaryBtnStyle}
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
                Files stay in your browser. The linker only adds edges — it never removes or modifies
                existing nodes or links.
              </div>
            </>
          )}

          {stage.kind === 'reading' && (
            <ProgressPane
              label={stage.totalFiles === 0 ? 'Discovering files' : 'Reading files'}
              current={stage.filesRead}
              total={stage.totalFiles}
            />
          )}

          {stage.kind === 'extracting' && (
            <div style={{ color: '#b388ff', fontSize: 12, padding: '20px 0' }}>
              Extracting API calls (direct + indirect)…
            </div>
          )}

          {stage.kind === 'error' && (
            <>
              <div style={{ color: '#ff6e40', fontSize: 12, marginBottom: 8 }}>{stage.message}</div>
              <div style={footerStyle}>
                <button onClick={() => setStage({ kind: 'source' })} style={primaryBtnStyle}>Back</button>
              </div>
            </>
          )}

          {stage.kind === 'preview' && (
            <>
              <div style={statsRowStyle}>
                <Stat label="Files scanned" value={stage.data.feStats.filesScanned} color="#888" />
                <Stat label="FE direct" value={stage.data.feStats.directHits} color="#b388ff" />
                <Stat label="FE indirect" value={stage.data.feStats.indirectHits} color="#b388ff" />
                <Stat label="BE matched" value={stage.data.beStats.matched} color="#ff6e40" />
                <Stat label="New edges" value={stage.data.newLinks.length} color="#69f0ae" />
              </div>

              {stage.data.newLinks.length === 0 ? (
                <div style={{ color: '#888', fontSize: 12, padding: '10px 0' }}>
                  No new links to add. Either the files don't contain recognizable API calls,
                  none of the paths match existing API nodes, or they're already linked.
                </div>
              ) : (
                <Section title={`Edges to add (${stage.data.newLinks.length})`} accent="#69f0ae">
                  {stage.data.newLinks.slice(0, 40).map((l) => (
                    <div key={l.id} style={listItemStyle}>
                      <code style={codeStyle}>{l.description}</code>
                    </div>
                  ))}
                  {stage.data.newLinks.length > 40 && (
                    <div style={{ color: '#666', fontSize: 10, marginTop: 3 }}>
                      and {stage.data.newLinks.length - 40} more…
                    </div>
                  )}
                </Section>
              )}

              {stage.data.warnings.length > 0 && (
                <Section title={`Unmatched / warnings (${stage.data.warnings.length})`} accent="#ffd740">
                  {stage.data.warnings.slice(0, 20).map((w, i) => (
                    <div key={i} style={listItemStyle}>
                      {w.kind === 'unmatched_path' && (
                        <>
                          <span style={tagStyle}>FE</span>
                          <code style={codeStyle}>{w.method} {w.path}</code>{' '}
                          <span style={{ color: '#888' }}>in {w.file} — no matching API node</span>
                        </>
                      )}
                      {w.kind === 'fetch_without_method' && (
                        <>
                          <span style={tagStyle}>FE</span>
                          <code style={codeStyle}>fetch {w.path}</code>{' '}
                          <span style={{ color: '#888' }}>assumed GET (no method in options)</span>
                        </>
                      )}
                      {w.kind === 'unmatched_be_handler' && (
                        <>
                          <span style={{ ...tagStyle, color: '#ff6e40', borderColor: 'rgba(255,110,64,0.3)' }}>BE</span>
                          <code style={codeStyle}>{w.method} {w.path}</code>{' '}
                          <span style={{ color: '#888' }}>handler has no matching API spec</span>
                        </>
                      )}
                      {w.kind === 'unmatched_openapi_op' && (
                        <>
                          <span style={{ ...tagStyle, color: '#69f0ae', borderColor: 'rgba(105,240,174,0.3)' }}>API</span>
                          <code style={codeStyle}>{w.method} {w.path}</code>{' '}
                          <span style={{ color: '#888' }}>spec op has no matching BE handler</span>
                        </>
                      )}
                    </div>
                  ))}
                  {stage.data.warnings.length > 20 && (
                    <div style={{ color: '#666', fontSize: 10, marginTop: 3 }}>
                      and {stage.data.warnings.length - 20} more…
                    </div>
                  )}
                </Section>
              )}

              <div style={footerStyle}>
                <button onClick={() => setStage({ kind: 'source' })} style={secondaryBtnStyle}>Back</button>
                <div style={{ flex: 1 }} />
                <button onClick={onCancel} style={secondaryBtnStyle}>Cancel</button>
                <button
                  onClick={() => applyLinks(stage.data.newLinks)}
                  disabled={stage.data.newLinks.length === 0}
                  style={stage.data.newLinks.length === 0 ? disabledBtnStyle : primaryBtnStyle}
                >
                  Apply {stage.data.newLinks.length} link{stage.data.newLinks.length === 1 ? '' : 's'}
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

const Stat = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div style={{ flex: 1, textAlign: 'center', padding: '8px 4px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6 }}>
    <div style={{ color, fontSize: 18, fontWeight: 700 }}>{value}</div>
    <div style={{ color: '#888', fontSize: 8, letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 }}>{label}</div>
  </div>
)

const Section = ({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) => (
  <div style={{ marginTop: 10 }}>
    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: accent, marginBottom: 5 }}>{title}</div>
    <div style={{ maxHeight: 180, overflowY: 'auto' }}>{children}</div>
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
  width: 640, maxWidth: '92vw', maxHeight: '86vh',
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
const statsRowStyle: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 10 }
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
const disabledBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
  color: '#555', padding: '8px 16px', borderRadius: 6, cursor: 'not-allowed',
  fontSize: 12, fontWeight: 600,
}
const tagStyle: React.CSSProperties = {
  display: 'inline-block', fontSize: 8, fontWeight: 700, letterSpacing: 0.5,
  textTransform: 'uppercase', padding: '1px 4px', borderRadius: 3,
  border: '1px solid rgba(179,136,255,0.3)', color: '#b388ff', marginRight: 5,
}
const warningBoxStyle: React.CSSProperties = {
  background: 'rgba(255,215,64,0.06)', border: '1px solid rgba(255,215,64,0.25)',
  color: '#ffd740', padding: 10, borderRadius: 6, fontSize: 11, marginBottom: 12, lineHeight: 1.5,
}
