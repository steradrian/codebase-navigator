import { useEffect, useMemo, useState } from 'react'
import type { Link, Node, Schema } from '@/types'
import { linkId } from '@/schema/migrate'
import { validate } from '@/schema/validate'

// ─── types ──────────────────────────────────────────────────

type Tab = 'nodes' | 'links'

type Props = {
  open: boolean
  schema: Schema
  onApply: (nextSchema: Schema) => void
  onClose: () => void
}

// ─── component ──────────────────────────────────────────────

export function EditorPanel({ open, schema, onApply, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('nodes')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [draft, setDraft] = useState<Node | Link | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  // Close via Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Reset local state when the dialog opens.
  useEffect(() => {
    if (open) {
      setTab('nodes')
      setSelectedId(null)
      setIsCreating(false)
      setDraft(null)
      setErrors([])
    }
  }, [open])

  if (!open) return null

  // ── selection behavior ──
  const selectExisting = (id: string) => {
    const entity = tab === 'nodes'
      ? schema.nodes.find((n) => n.id === id)
      : schema.links.find((l) => l.id === id)
    setSelectedId(id)
    setIsCreating(false)
    setDraft(entity ? { ...entity } : null)
    setErrors([])
  }

  const startCreate = () => {
    setSelectedId(null)
    setIsCreating(true)
    setErrors([])
    if (tab === 'nodes') {
      setDraft({
        id: '',
        name: '',
        type: Object.keys(schema.nodeTypes)[0] ?? 'service',
        description: '',
        origin: 'manual',
      } satisfies Node)
    } else {
      setDraft({
        id: '',
        source: schema.nodes[0]?.id ?? '',
        target: schema.nodes[0]?.id ?? '',
        label: '',
        description: '',
        type: Object.keys(schema.linkTypes)[0],
        origin: 'manual',
      } satisfies Link)
    }
  }

  const switchTab = (next: Tab) => {
    setTab(next)
    setSelectedId(null)
    setIsCreating(false)
    setDraft(null)
    setErrors([])
  }

  // ── save ──
  const handleSave = () => {
    if (!draft) return

    let nextSchema: Schema
    if (tab === 'nodes') {
      const node = draft as Node
      nextSchema = upsertNode(schema, node, isCreating)
    } else {
      const link = draft as Link
      // For links, id is computed from source+target+type. Recompute on save.
      const computedId = linkId(link.source, link.target, link.type)
      const withId: Link = { ...link, id: computedId }
      nextSchema = upsertLink(schema, withId, isCreating)
    }

    const v = validate(nextSchema)
    if (!v.ok) {
      setErrors(v.errors.map((e) => `${e.kind}: ${JSON.stringify(e)}`))
      return
    }

    onApply(nextSchema)
    setIsCreating(false)
    setErrors([])
    if (tab === 'links') {
      // link id may have changed if source/target/type changed
      setSelectedId(linkId((draft as Link).source, (draft as Link).target, (draft as Link).type))
    }
  }

  // ── delete ──
  const handleDelete = () => {
    if (!selectedId || isCreating) return
    if (tab === 'nodes') {
      const block = findNodeDeleteBlockers(schema, selectedId)
      if (block.length > 0) {
        setErrors([`Cannot delete node — referenced by: ${block.join(', ')}. Remove those first.`])
        return
      }
      if (!confirm(`Delete node "${selectedId}"?`)) return
      const nextSchema: Schema = {
        ...schema,
        nodes: schema.nodes.filter((n) => n.id !== selectedId),
        // orphaned auto links get pruned by merge engine, but manual
        // editing doesn't go through merge. Drop any links now orphaned.
        links: schema.links.filter((l) => l.source !== selectedId && l.target !== selectedId),
      }
      onApply(nextSchema)
      setSelectedId(null)
      setDraft(null)
    } else {
      if (!confirm(`Delete link "${selectedId}"?`)) return
      const nextSchema: Schema = {
        ...schema,
        links: schema.links.filter((l) => l.id !== selectedId),
      }
      onApply(nextSchema)
      setSelectedId(null)
      setDraft(null)
    }
  }

  // ── list filtering ──
  const nodeTypes = Object.keys(schema.nodeTypes)
  const linkTypes = Object.keys(schema.linkTypes)
  // Entity autocomplete: union of the canonical dictionary + whatever
  // entities already appear on nodes (so users can see what exists
  // even if the dictionary isn't yet curated).
  const entityOptions = Array.from(new Set([
    ...(schema.meta.entities ?? []),
    ...schema.nodes.map((n) => n.entity).filter((e): e is string => !!e),
  ])).sort()

  const list = tab === 'nodes' ? schema.nodes : schema.links

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Schema Editor</h2>
          <div style={{ display: 'flex', gap: 4 }}>
            <TabBtn active={tab === 'nodes'} onClick={() => switchTab('nodes')}>Nodes ({schema.nodes.length})</TabBtn>
            <TabBtn active={tab === 'links'} onClick={() => switchTab('links')}>Links ({schema.links.length})</TabBtn>
          </div>
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>
        </div>

        {/* Two-column body */}
        <div style={bodyStyle}>
          {/* List */}
          <div style={listColumnStyle}>
            <button onClick={startCreate} style={{ ...primaryBtnStyle, width: '100%', marginBottom: 10 }}>
              + New {tab === 'nodes' ? 'node' : 'link'}
            </button>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#666', marginBottom: 6 }}>
              {list.length} {tab}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {list.map((entity) => {
                const isSelected = selectedId === entity.id && !isCreating
                const isAuto = entity.origin.startsWith('auto:')
                return (
                  <div
                    key={entity.id}
                    onClick={() => selectExisting(entity.id)}
                    style={{
                      padding: '7px 9px',
                      marginBottom: 2,
                      borderRadius: 5,
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(255,255,255,0.08)' : 'transparent',
                      border: `1px solid ${isSelected ? 'rgba(255,255,255,0.12)' : 'transparent'}`,
                      fontSize: 11,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: '#ddd', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tab === 'nodes' ? (entity as Node).name : (entity as Link).label || entity.id}
                      </span>
                      {isAuto && (
                        <span style={originTagStyle} title={entity.origin}>auto</span>
                      )}
                    </div>
                    <div style={{ color: '#666', fontSize: 10, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entity.id}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Form */}
          <div style={formColumnStyle}>
            {!draft && (
              <div style={{ color: '#666', fontSize: 12, textAlign: 'center', marginTop: 40 }}>
                Select an entity or create a new one.
              </div>
            )}

            {draft && tab === 'nodes' && (
              <NodeForm
                draft={draft as Node}
                isCreating={isCreating}
                nodeTypes={nodeTypes}
                entityOptions={entityOptions}
                onChange={(next) => setDraft(next)}
              />
            )}

            {draft && tab === 'links' && (
              <LinkForm
                draft={draft as Link}
                isCreating={isCreating}
                schema={schema}
                linkTypes={linkTypes}
                onChange={(next) => setDraft(next)}
              />
            )}

            {draft && errors.length > 0 && (
              <div style={errorBoxStyle}>
                {errors.map((m, i) => <div key={i} style={{ marginBottom: 2 }}>{m}</div>)}
              </div>
            )}

            {draft && (
              <div style={footerStyle}>
                {!isCreating && (
                  <button onClick={handleDelete} style={dangerBtnStyle}>Delete</button>
                )}
                <div style={{ flex: 1 }} />
                <button onClick={handleSave} style={primaryBtnStyle}>
                  {isCreating ? 'Create' : 'Save'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── sub-forms ──────────────────────────────────────────────

function NodeForm({
  draft, isCreating, nodeTypes, entityOptions, onChange,
}: { draft: Node; isCreating: boolean; nodeTypes: string[]; entityOptions: string[]; onChange: (n: Node) => void }) {
  return (
    <>
      <datalist id="entity-autocomplete">
        {entityOptions.map((e) => <option key={e} value={e} />)}
      </datalist>
      {isCreating && (
        <FormField label="ID">
          <input
            type="text"
            value={draft.id}
            onChange={(e) => onChange({ ...draft, id: e.target.value })}
            placeholder="unique identifier (lowercase, no spaces)"
            style={inputStyle}
          />
        </FormField>
      )}
      {!isCreating && (
        <FormField label="ID" sub="readonly">
          <code style={codeStyle}>{draft.id}</code>
        </FormField>
      )}
      <FormField label="Name">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          style={inputStyle}
        />
      </FormField>
      <FormField label="Type">
        <select
          value={draft.type}
          onChange={(e) => onChange({ ...draft, type: e.target.value })}
          style={inputStyle}
        >
          {nodeTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </FormField>
      <FormField label="Description">
        <textarea
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          style={{ ...inputStyle, height: 80, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </FormField>
      <FormField label="Group" sub="optional — clustering">
        <input
          type="text"
          value={draft.group ?? ''}
          onChange={(e) => onChange({ ...draft, group: e.target.value || undefined })}
          style={inputStyle}
        />
      </FormField>
      <FormField label="Owner" sub="optional — team / person">
        <input
          type="text"
          value={draft.owner ?? ''}
          onChange={(e) => onChange({ ...draft, owner: e.target.value || undefined })}
          style={inputStyle}
        />
      </FormField>
      <FormField label="Entity" sub="domain (customer, payment, bonus…)">
        <input
          type="text"
          list="entity-autocomplete"
          value={draft.entity ?? ''}
          onChange={(e) => onChange({ ...draft, entity: e.target.value.trim().toLowerCase() || undefined })}
          placeholder="e.g. customer"
          style={inputStyle}
        />
      </FormField>
      {draft.origin !== 'manual' && (
        <div style={infoBoxStyle}>
          <strong>Auto entity.</strong> Fields you change will be flagged
          as manual overrides and preserved across re-imports.
        </div>
      )}
    </>
  )
}

function LinkForm({
  draft, isCreating, schema, linkTypes, onChange,
}: { draft: Link; isCreating: boolean; schema: Schema; linkTypes: string[]; onChange: (l: Link) => void }) {
  const nodeOptions = useMemo(
    () => schema.nodes.map((n) => ({ id: n.id, name: n.name })),
    [schema.nodes],
  )

  const computedId = linkId(draft.source, draft.target, draft.type)

  return (
    <>
      <FormField label="ID" sub={isCreating ? 'auto-generated from source, target, type' : 'readonly'}>
        <code style={codeStyle}>{computedId}</code>
      </FormField>
      <FormField label="Source">
        <select
          value={draft.source}
          onChange={(e) => onChange({ ...draft, source: e.target.value })}
          style={inputStyle}
        >
          {nodeOptions.map((n) => <option key={n.id} value={n.id}>{n.name} ({n.id})</option>)}
        </select>
      </FormField>
      <FormField label="Target">
        <select
          value={draft.target}
          onChange={(e) => onChange({ ...draft, target: e.target.value })}
          style={inputStyle}
        >
          {nodeOptions.map((n) => <option key={n.id} value={n.id}>{n.name} ({n.id})</option>)}
        </select>
      </FormField>
      <FormField label="Type" sub="visual + semantic category">
        <select
          value={draft.type ?? ''}
          onChange={(e) => onChange({ ...draft, type: e.target.value || undefined })}
          style={inputStyle}
        >
          <option value="">(none)</option>
          {linkTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </FormField>
      <FormField label="Label" sub="short relationship name">
        <input
          type="text"
          value={draft.label}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
          placeholder="e.g. reads, triggers"
          style={inputStyle}
        />
      </FormField>
      <FormField label="Description">
        <textarea
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          style={{ ...inputStyle, height: 80, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </FormField>
      {draft.origin !== 'manual' && (
        <div style={infoBoxStyle}>
          <strong>Auto entity.</strong> Fields you change will be flagged
          as manual overrides and preserved across re-imports.
        </div>
      )}
    </>
  )
}

// ─── upsert helpers (with override tracking) ────────────────

function upsertNode(schema: Schema, draft: Node, isCreating: boolean): Schema {
  const TRACKED_FIELDS = ['name', 'description', 'type', 'group', 'owner', 'entity'] as const
  if (isCreating) {
    return { ...schema, nodes: [...schema.nodes, draft] }
  }
  const existing = schema.nodes.find((n) => n.id === draft.id)
  let nextOverrides = draft.manualOverrides ?? existing?.manualOverrides
  if (existing && existing.origin !== 'manual') {
    // Record which tracked fields changed.
    const overrides = new Set(nextOverrides ?? [])
    for (const f of TRACKED_FIELDS) {
      if (JSON.stringify(existing[f]) !== JSON.stringify(draft[f])) overrides.add(f)
    }
    nextOverrides = overrides.size > 0 ? [...overrides].sort() : undefined
  }
  const merged: Node = { ...draft, manualOverrides: nextOverrides }
  return {
    ...schema,
    nodes: schema.nodes.map((n) => (n.id === draft.id ? merged : n)),
  }
}

function upsertLink(schema: Schema, draft: Link, isCreating: boolean): Schema {
  const TRACKED_FIELDS = ['label', 'description', 'type'] as const
  if (isCreating) {
    return { ...schema, links: [...schema.links, draft] }
  }
  const existing = schema.links.find((l) => l.id === draft.id)
  let nextOverrides = draft.manualOverrides ?? existing?.manualOverrides
  if (existing && existing.origin !== 'manual') {
    const overrides = new Set(nextOverrides ?? [])
    for (const f of TRACKED_FIELDS) {
      if (JSON.stringify(existing[f]) !== JSON.stringify(draft[f])) overrides.add(f)
    }
    nextOverrides = overrides.size > 0 ? [...overrides].sort() : undefined
  }
  const merged: Link = { ...draft, manualOverrides: nextOverrides }
  // If ID changed (because source/target/type changed), also remove the old.
  const filtered = schema.links.filter((l) => l.id !== draft.id && l.id !== existing?.id)
  return { ...schema, links: [...filtered, merged] }
}

function findNodeDeleteBlockers(schema: Schema, nodeId: string): string[] {
  const blockers: string[] = []
  for (const p of schema.paths) {
    if (p.steps.some((s) => s.nodeId === nodeId)) blockers.push(`path "${p.name}"`)
  }
  for (const l of schema.links) {
    if (l.origin !== 'manual') continue
    if (l.source === nodeId || l.target === nodeId) blockers.push(`manual link ${l.id}`)
  }
  return blockers
}

// ─── tiny components ────────────────────────────────────────

const FormField = ({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#888', marginBottom: 3 }}>
      {label}{sub && <span style={{ color: '#555', fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>— {sub}</span>}
    </div>
    {children}
  </div>
)

const TabBtn = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button
    onClick={onClick}
    style={{
      background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
      border: `1px solid ${active ? 'rgba(255,255,255,0.12)' : 'transparent'}`,
      color: active ? '#fff' : '#888',
      padding: '5px 12px',
      borderRadius: 5,
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
    }}
  >
    {children}
  </button>
)

// ─── styles ─────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100, fontFamily: "'Segoe UI', system-ui, sans-serif", color: '#fff',
}

const modalStyle: React.CSSProperties = {
  width: 780, maxWidth: '94vw', height: 600, maxHeight: '88vh',
  background: 'rgba(10,10,25,0.98)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column',
}

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', gap: 16,
}

const closeBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', border: 'none', color: '#888',
  borderRadius: 6, width: 26, height: 26, cursor: 'pointer', fontSize: 12,
}

const bodyStyle: React.CSSProperties = {
  display: 'flex', flex: 1, overflow: 'hidden',
}

const listColumnStyle: React.CSSProperties = {
  width: 280, borderRight: '1px solid rgba(255,255,255,0.06)',
  padding: '12px', display: 'flex', flexDirection: 'column', flexShrink: 0,
}

const formColumnStyle: React.CSSProperties = {
  flex: 1, padding: '14px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column',
}

const footerStyle: React.CSSProperties = {
  display: 'flex', gap: 8, marginTop: 18, paddingTop: 14,
  borderTop: '1px solid rgba(255,255,255,0.06)',
}

const primaryBtnStyle: React.CSSProperties = {
  background: '#69f0ae22', border: '1px solid #69f0ae55', color: '#69f0ae',
  padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}

const dangerBtnStyle: React.CSSProperties = {
  background: '#ff408122', border: '1px solid #ff408155', color: '#ff4081',
  padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 4, color: '#ddd', fontSize: 12, padding: '6px 8px', outline: 'none',
}

const errorBoxStyle: React.CSSProperties = {
  background: 'rgba(255,64,129,0.08)', border: '1px solid rgba(255,64,129,0.25)',
  color: '#ff9cbd', padding: 10, borderRadius: 6, fontSize: 11, marginTop: 10,
  fontFamily: 'ui-monospace, monospace',
}

const infoBoxStyle: React.CSSProperties = {
  background: 'rgba(105,240,174,0.06)', border: '1px solid rgba(105,240,174,0.2)',
  color: '#aaffcc', padding: 10, borderRadius: 6, fontSize: 11, marginTop: 10,
  lineHeight: 1.5,
}

const originTagStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', color: '#888', fontSize: 8, fontWeight: 700,
  letterSpacing: 1, textTransform: 'uppercase', padding: '2px 5px', borderRadius: 3,
}

const codeStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', padding: '3px 6px', borderRadius: 3,
  fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#ccc',
  wordBreak: 'break-all',
}
