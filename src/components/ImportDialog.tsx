import { useEffect, useRef, useState } from 'react'
import yaml from 'js-yaml'
import type { Schema, MergeConflict } from '@/types'
import type { ParseWarning } from '@/importers/openapi/types'
import { parseOpenAPI } from '@/importers/openapi'
import { validate } from '@/schema/validate'
import { merge } from '@/schema/merge'

// ─── types ──────────────────────────────────────────────────

type Stage =
  | { kind: 'source' }
  | { kind: 'error'; messages: string[] }
  | {
      kind: 'preview'
      candidate: Schema
      merged: Schema
      conflicts: MergeConflict[]
      warnings: ParseWarning[]
      diff: Diff
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

// ─── component ──────────────────────────────────────────────

export function ImportDialog({ open, existingSchema, onConfirm, onCancel }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'source' })
  const [pasted, setPasted] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Reset local state every time the dialog opens fresh.
  useEffect(() => {
    if (open) {
      setStage({ kind: 'source' })
      setPasted('')
    }
  }, [open])

  // Escape closes the dialog.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const processText = (text: string) => {
    // Friendly error for a common mistake: pasting generated TypeScript
    // types (openapi-typescript output) instead of the raw spec.
    const trimmed = text.trim()
    if (
      /\bexport\s+(type|interface)\b/.test(trimmed) ||
      /\bdeclare\s+module\b/.test(trimmed) ||
      trimmed.startsWith('/**')
    ) {
      setStage({
        kind: 'error',
        messages: [
          'This looks like TypeScript type declarations, not an OpenAPI spec.',
          'If you generated types with `openapi-typescript` or similar, we need the ORIGINAL source YAML/JSON instead — typically `openapi.yaml` or the URL served at `/openapi.json` on your backend.',
        ],
      })
      return
    }

    // Auto-detect JSON vs YAML. JSON starts with "{" or "["; anything
    // else falls through to the YAML parser (which also accepts JSON
    // as a strict subset, but JSON.parse is faster + gives better
    // errors when the input really is JSON).
    let parsed: unknown
    const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')
    if (looksLikeJson) {
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        setStage({ kind: 'error', messages: [`Could not parse input as JSON: ${(err as Error).message}`] })
        return
      }
    } else {
      try {
        parsed = yaml.load(text)
      } catch (err) {
        setStage({ kind: 'error', messages: [`Could not parse input as YAML: ${(err as Error).message}`] })
        return
      }
    }
    const parsedJson = parsed

    const parse = parseOpenAPI(parsedJson)
    if (!parse.ok || !parse.schema) {
      setStage({
        kind: 'error',
        messages: parse.errors.map(formatParseError),
      })
      return
    }

    const v = validate(parse.schema)
    if (!v.ok) {
      setStage({
        kind: 'error',
        messages: v.errors.slice(0, 10).map((e) => `${e.kind}: ${JSON.stringify(e)}`),
      })
      return
    }

    const mergeResult = merge(existingSchema, parse.schema)
    const diff = computeDiff(existingSchema, mergeResult.schema)

    setStage({
      kind: 'preview',
      candidate: parse.schema,
      merged: mergeResult.schema,
      conflicts: mergeResult.conflicts,
      warnings: parse.warnings,
      diff,
    })
  }

  const handleFile = async (file: File) => {
    const text = await file.text()
    processText(text)
  }

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Import OpenAPI Spec</h2>
          <button onClick={onCancel} style={closeBtnStyle} aria-label="Close">✕</button>
        </div>

        <div style={bodyStyle}>
          {stage.kind === 'source' && (
            <SourceStage
              pasted={pasted}
              setPasted={setPasted}
              onSubmitText={() => processText(pasted)}
              fileInputRef={fileInputRef}
              onFileChange={(f) => f && handleFile(f)}
            />
          )}

          {stage.kind === 'error' && (
            <ErrorStage
              messages={stage.messages}
              onBack={() => setStage({ kind: 'source' })}
            />
          )}

          {stage.kind === 'preview' && (
            <PreviewStage
              diff={stage.diff}
              conflicts={stage.conflicts}
              warnings={stage.warnings}
              onBack={() => setStage({ kind: 'source' })}
              onConfirm={() => onConfirm(stage.merged)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── stages ─────────────────────────────────────────────────

function SourceStage(props: {
  pasted: string
  setPasted: (v: string) => void
  onSubmitText: () => void
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onFileChange: (file: File | null) => void
}) {
  return (
    <>
      <p style={{ color: '#999', fontSize: 12, margin: '0 0 12px 0', lineHeight: 1.5 }}>
        Upload or paste an <strong>OpenAPI v3 spec</strong> as either JSON or YAML — the
        original source file, not generated <code style={codeStyle}>.d.ts</code> types.
      </p>

      <button onClick={() => props.fileInputRef.current?.click()} style={secondaryBtnStyle}>
        📄 Choose file…
      </button>
      <input
        ref={props.fileInputRef}
        type="file"
        accept=".json,.yaml,.yml,application/json,text/yaml,application/x-yaml"
        style={{ display: 'none' }}
        onChange={(e) => props.onFileChange(e.target.files?.[0] ?? null)}
      />

      <div style={{ margin: '14px 0 6px 0', fontSize: 10, color: '#666', letterSpacing: 1, textTransform: 'uppercase' }}>
        Or paste JSON
      </div>
      <textarea
        value={props.pasted}
        onChange={(e) => props.setPasted(e.target.value)}
        placeholder={'{\n  "openapi": "3.0.0",\n  "info": { ... },\n  ...\n}'}
        style={textareaStyle}
      />

      <div style={footerStyle}>
        <button
          disabled={!props.pasted.trim()}
          onClick={props.onSubmitText}
          style={primaryBtnStyle}
        >
          Parse
        </button>
      </div>
    </>
  )
}

function ErrorStage(props: { messages: string[]; onBack: () => void }) {
  return (
    <>
      <div style={{ color: '#ff6e40', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        Could not import this spec
      </div>
      <ul style={{ color: '#ccc', fontSize: 12, paddingLeft: 20, margin: 0, lineHeight: 1.6 }}>
        {props.messages.map((m, i) => <li key={i}>{m}</li>)}
      </ul>
      <div style={footerStyle}>
        <button onClick={props.onBack} style={primaryBtnStyle}>Back</button>
      </div>
    </>
  )
}

function PreviewStage(props: {
  diff: Diff
  conflicts: MergeConflict[]
  warnings: ParseWarning[]
  onBack: () => void
  onConfirm: () => void
}) {
  const { diff, conflicts, warnings } = props
  const hasConflicts = conflicts.length > 0

  return (
    <>
      <div style={statsRowStyle}>
        <Stat label="Nodes added" value={diff.nodesAdded.length} color="#69f0ae" />
        <Stat label="Nodes removed" value={diff.nodesRemoved.length} color="#ff6e40" />
        <Stat label="Nodes updated" value={diff.nodesUpdated.length} color="#ffd740" />
        <Stat label="Conflicts" value={conflicts.length} color={hasConflicts ? '#ff4081' : '#555'} />
      </div>

      <div style={statsRowStyle}>
        <Stat label="Links added" value={diff.linksAdded.length} color="#69f0ae" />
        <Stat label="Links removed" value={diff.linksRemoved.length} color="#ff6e40" />
        <Stat label="Links updated" value={diff.linksUpdated.length} color="#ffd740" />
        <Stat label="Warnings" value={warnings.length} color={warnings.length ? '#ffd740' : '#555'} />
      </div>

      {hasConflicts && (
        <Section title={`Conflicts (${conflicts.length})`} accent="#ff4081">
          {conflicts.map((c, i) => <ConflictRow key={i} conflict={c} />)}
        </Section>
      )}

      {warnings.length > 0 && (
        <Section title={`Warnings (${warnings.length})`} accent="#ffd740">
          {warnings.slice(0, 10).map((w, i) => (
            <div key={i} style={listItemStyle}>
              <code style={codeStyle}>{w.kind}</code>{' '}
              <span style={{ color: '#999' }}>
                {'ref' in w ? w.ref : 'operationId' in w ? w.operationId : ''}
              </span>
            </div>
          ))}
          {warnings.length > 10 && (
            <div style={{ color: '#666', fontSize: 11, marginTop: 4 }}>
              and {warnings.length - 10} more…
            </div>
          )}
        </Section>
      )}

      {diff.nodesAdded.length > 0 && (
        <Section title={`Added nodes (${diff.nodesAdded.length})`} accent="#69f0ae">
          <IdList ids={diff.nodesAdded} />
        </Section>
      )}

      {diff.nodesRemoved.length > 0 && (
        <Section title={`Removed nodes (${diff.nodesRemoved.length})`} accent="#ff6e40">
          <IdList ids={diff.nodesRemoved} />
        </Section>
      )}

      {diff.nodesUpdated.length > 0 && (
        <Section title={`Updated nodes (${diff.nodesUpdated.length})`} accent="#ffd740">
          <IdList ids={diff.nodesUpdated} />
        </Section>
      )}

      <div style={footerStyle}>
        <button onClick={props.onBack} style={secondaryBtnStyle}>Back</button>
        <button onClick={props.onConfirm} style={primaryBtnStyle} autoFocus>
          {hasConflicts ? `Confirm (${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} acknowledged)` : 'Confirm'}
        </button>
      </div>
    </>
  )
}

// ─── helpers ────────────────────────────────────────────────

function computeDiff(before: Schema, after: Schema): Diff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]))
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]))
  const beforeLinks = new Map(before.links.map((l) => [l.id, l]))
  const afterLinks = new Map(after.links.map((l) => [l.id, l]))

  const nodesAdded: string[] = []
  const nodesRemoved: string[] = []
  const nodesUpdated: string[] = []
  for (const [id, n] of afterNodes) {
    const prev = beforeNodes.get(id)
    if (!prev) nodesAdded.push(id)
    else if (JSON.stringify(prev) !== JSON.stringify(n)) nodesUpdated.push(id)
  }
  for (const id of beforeNodes.keys()) if (!afterNodes.has(id)) nodesRemoved.push(id)

  const linksAdded: string[] = []
  const linksRemoved: string[] = []
  const linksUpdated: string[] = []
  for (const [id, l] of afterLinks) {
    const prev = beforeLinks.get(id)
    if (!prev) linksAdded.push(id)
    else if (JSON.stringify(prev) !== JSON.stringify(l)) linksUpdated.push(id)
  }
  for (const id of beforeLinks.keys()) if (!afterLinks.has(id)) linksRemoved.push(id)

  return { nodesAdded, nodesRemoved, nodesUpdated, linksAdded, linksRemoved, linksUpdated }
}

function formatParseError(e: { kind: string; [k: string]: unknown }): string {
  switch (e.kind) {
    case 'not_an_object':
      return 'Input is not a JSON object.'
    case 'missing_openapi_version':
      return 'Spec is missing the top-level "openapi" version field. Is this really an OpenAPI v3 document?'
    case 'unsupported_openapi_version':
      return `Unsupported OpenAPI version "${String(e.version)}". Only v3.x is supported.`
    default:
      return e.kind
  }
}

// ─── mini-components & styles ───────────────────────────────

const Stat = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div style={{ flex: 1, textAlign: 'center', padding: '8px 4px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6 }}>
    <div style={{ color, fontSize: 20, fontWeight: 700 }}>{value}</div>
    <div style={{ color: '#888', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 }}>{label}</div>
  </div>
)

const Section = ({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) => (
  <div style={{ marginTop: 12 }}>
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: accent, marginBottom: 6 }}>{title}</div>
    <div style={{ maxHeight: 140, overflowY: 'auto', paddingRight: 4 }}>{children}</div>
  </div>
)

const IdList = ({ ids }: { ids: string[] }) => (
  <>
    {ids.slice(0, 20).map((id) => (
      <div key={id} style={listItemStyle}>
        <code style={codeStyle}>{id}</code>
      </div>
    ))}
    {ids.length > 20 && (
      <div style={{ color: '#666', fontSize: 11, marginTop: 4 }}>and {ids.length - 20} more…</div>
    )}
  </>
)

const ConflictRow = ({ conflict }: { conflict: MergeConflict }) => {
  const summary = (() => {
    switch (conflict.kind) {
      case 'manual_override_wins':
        return `Field "${conflict.field}" on ${conflict.entityType} ${conflict.entityId} is manually overridden. Keeping existing value.`
      case 'manual_shadows_auto_candidate':
        return `Imported ${conflict.entityType} ${conflict.entityId} conflicts with a manual entity of the same id. Keeping manual.`
      case 'manual_blocks_auto_deletion':
        return `Cannot drop node ${conflict.entityId} — referenced by manual ${[
          conflict.blockedBy.pathIds.length && `path(s) ${conflict.blockedBy.pathIds.join(', ')}`,
          conflict.blockedBy.linkIds.length && `link(s) ${conflict.blockedBy.linkIds.join(', ')}`,
        ].filter(Boolean).join(' and ')}.`
    }
  })()
  return (
    <div style={{ ...listItemStyle, borderLeft: '2px solid #ff4081', paddingLeft: 8 }}>
      <div style={{ color: '#ff4081', fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 }}>
        {conflict.kind.replace(/_/g, ' ')}
      </div>
      <div style={{ color: '#ccc', fontSize: 11 }}>{summary}</div>
    </div>
  )
}

// ─── styles ─────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100, fontFamily: "'Segoe UI', system-ui, sans-serif", color: '#fff',
}

const modalStyle: React.CSSProperties = {
  width: 620, maxWidth: '90vw', maxHeight: '85vh',
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
  display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16,
}

const primaryBtnStyle: React.CSSProperties = {
  background: '#69f0ae22', border: '1px solid #69f0ae55', color: '#69f0ae',
  padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}

const secondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#ccc', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}

const textareaStyle: React.CSSProperties = {
  width: '100%', height: 180, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6, color: '#ccc', fontFamily: 'ui-monospace, monospace', fontSize: 11,
  padding: 10, boxSizing: 'border-box', resize: 'vertical', outline: 'none',
}

const statsRowStyle: React.CSSProperties = {
  display: 'flex', gap: 6, marginBottom: 8,
}

const listItemStyle: React.CSSProperties = {
  padding: '4px 0', fontSize: 11,
}

const codeStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3,
  fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: '#ccc',
}
