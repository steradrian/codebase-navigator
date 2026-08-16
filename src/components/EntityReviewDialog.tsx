// GE-116 — Catalog curator.
//
// Two-tab review dialog for the closed-vocabulary catalog (GE-115).
// Catalog tab: domain-grouped entity list with rename / merge / delete
// / add. Unclassified tab: nodes that propagation didn't reach, with
// an assign-to-entity dropdown.

import { useEffect, useMemo, useState } from 'react'
import type { Node, Schema } from '@/types'
import { entityCounts, mergeEntity, renameEntity } from '@/schema/entity/extractor'
import {
  addEntityToCatalog,
  assignEntityToNode,
  deleteDomain,
  deleteEntityFromCatalog,
  renameDomain,
  resetAutoEntityTags,
} from '@/schema/entity/catalog'
import { propagateEntities } from '@/schema/entity/propagate'

type Props = {
  open: boolean
  schema: Schema
  onApply: (nextSchema: Schema) => void
  onClose: () => void
}

type Tab = 'catalog' | 'unclassified'

export function EntityReviewDialog({ open, schema, onApply, onClose }: Props) {
  const [workingSchema, setWorkingSchema] = useState<Schema>(schema)
  const [tab, setTab] = useState<Tab>('catalog')

  useEffect(() => { if (open) setWorkingSchema(schema) }, [open, schema])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // ─── memoized derivations ─────────────────────────────────
  const counts = useMemo(() => entityCounts(workingSchema), [workingSchema])
  const domains = useMemo(
    () => workingSchema.meta.domains ?? [],
    [workingSchema.meta.domains],
  )
  // For each domain, which entities appear on nodes carrying that domain?
  const entitiesByDomain = useMemo(() => {
    const map = new Map<string, Map<string, number>>()
    for (const n of workingSchema.nodes) {
      if (!n.domain) continue
      const inner = map.get(n.domain) ?? new Map<string, number>()
      const e = n.entity ?? '__unclassified__'
      inner.set(e, (inner.get(e) ?? 0) + 1)
      map.set(n.domain, inner)
    }
    return map
  }, [workingSchema.nodes])
  // Nodes per domain (total count for header).
  const nodesPerDomain = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of workingSchema.nodes) {
      if (!n.domain) continue
      m.set(n.domain, (m.get(n.domain) ?? 0) + 1)
    }
    return m
  }, [workingSchema.nodes])
  // Entities not in any domain bucket (shown under "No domain").
  const orphanEntities = useMemo(() => {
    const seen = new Set<string>()
    for (const inner of entitiesByDomain.values()) {
      for (const e of inner.keys()) seen.add(e)
    }
    return counts.filter((c) => !seen.has(c.entity))
  }, [counts, entitiesByDomain])
  // Unclassified non-hub nodes.
  const unclassifiedNodes = useMemo(
    () => workingSchema.nodes.filter((n) => !n.entity && !n.isHub),
    [workingSchema.nodes],
  )
  const catalogEntityNames = useMemo(
    () => Array.from(new Set(counts.map((c) => c.entity))).sort(),
    [counts],
  )

  if (!open) return null

  // ─── mutation handlers ────────────────────────────────────
  const handleRenameEntity = (from: string) => {
    const next = window.prompt(`Rename entity "${from}" to:`, from)
    if (!next || next.trim() === '' || next.trim() === from) return
    setWorkingSchema((s) => renameEntity(s, from, next.trim().toLowerCase()))
  }
  const handleMergeEntity = (from: string) => {
    const others = catalogEntityNames.filter((e) => e !== from)
    if (others.length === 0) return
    const target = window.prompt(
      `Merge "${from}" into which entity?\n\nOptions: ${others.join(', ')}`,
      others[0],
    )
    if (!target || target.trim() === '' || target.trim() === from) return
    setWorkingSchema((s) => mergeEntity(s, from, target.trim().toLowerCase()))
  }
  const handleDeleteEntity = (entity: string) => {
    const count = counts.find((c) => c.entity === entity)?.count ?? 0
    if (!window.confirm(
      `Delete entity "${entity}"?\n\n${count} node${count === 1 ? '' : 's'} will become Unclassified. ` +
      `This doesn't delete the nodes — only untags them.`,
    )) return
    setWorkingSchema((s) => deleteEntityFromCatalog(s, entity))
  }
  const handleAddEntity = () => {
    const name = window.prompt('New entity name (lowercase, kebab-case):', '')
    if (!name || !name.trim()) return
    setWorkingSchema((s) => addEntityToCatalog(s, name.trim().toLowerCase()))
  }
  const handleRenameDomain = (from: string) => {
    const next = window.prompt(`Rename domain "${from}" to:`, from)
    if (!next || next.trim() === '' || next.trim() === from) return
    setWorkingSchema((s) => renameDomain(s, from, next.trim().toLowerCase()))
  }
  const handleDeleteDomain = (domain: string) => {
    const count = nodesPerDomain.get(domain) ?? 0
    if (!window.confirm(
      `Delete domain "${domain}"?\n\n${count} node${count === 1 ? '' : 's'} will lose their domain tag. ` +
      `Entity tags remain untouched.`,
    )) return
    setWorkingSchema((s) => deleteDomain(s, domain))
  }
  const handleAssignNode = (nodeId: string, entity: string | null) => {
    setWorkingSchema((s) => assignEntityToNode(s, nodeId, entity))
  }
  const handleRetag = () => {
    setWorkingSchema((s) => propagateEntities(s))
  }
  const handleResetAuto = () => {
    const autoCount = workingSchema.nodes.filter(
      (n) => n.origin !== 'manual' && !n.manualOverrides?.includes('entity') && (n.entity || n.domain),
    ).length
    if (!window.confirm(
      `Reset auto tags?\n\n` +
      `${autoCount} auto-generated node${autoCount === 1 ? '' : 's'} will lose their entity & domain tags. ` +
      `Catalog (entities & domains) will be cleared. Manual overrides are preserved.\n\n` +
      `Use this when the catalog shows stale tags from an older extractor. ` +
      `Re-import the OpenAPI spec afterwards to seed a clean catalog.`,
    )) return
    setWorkingSchema((s) => propagateEntities(resetAutoEntityTags(s)))
  }
  const handleApply = () => {
    // Persist the dictionary + domains on apply so downstream consumers
    // can reconcile against the curated list.
    const next: Schema = {
      ...workingSchema,
      meta: {
        ...workingSchema.meta,
        entities: catalogEntityNames,
        domains: domains,
      },
    }
    onApply(next)
  }

  // ─── render ───────────────────────────────────────────────

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Review catalog</h2>
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>
        </div>

        <div style={tabBarStyle}>
          <TabButton active={tab === 'catalog'} onClick={() => setTab('catalog')}>
            Catalog ({counts.length})
          </TabButton>
          <TabButton active={tab === 'unclassified'} onClick={() => setTab('unclassified')}>
            Unclassified ({unclassifiedNodes.length})
          </TabButton>
        </div>

        <div style={bodyStyle}>
          {tab === 'catalog' && (
            <CatalogTab
              domains={domains}
              entitiesByDomain={entitiesByDomain}
              orphanEntities={orphanEntities}
              nodesPerDomain={nodesPerDomain}
              onRenameEntity={handleRenameEntity}
              onMergeEntity={handleMergeEntity}
              onDeleteEntity={handleDeleteEntity}
              onRenameDomain={handleRenameDomain}
              onDeleteDomain={handleDeleteDomain}
              onAddEntity={handleAddEntity}
            />
          )}
          {tab === 'unclassified' && (
            <UnclassifiedTab
              nodes={unclassifiedNodes}
              catalogEntities={catalogEntityNames}
              onAssign={handleAssignNode}
            />
          )}
        </div>

        <div style={footerStyle}>
          <button onClick={handleResetAuto} style={dangerBtnStyle} title="Clear stale auto tags from old extractors — preserves manual edits">
            Reset auto tags
          </button>
          <button onClick={handleRetag} style={secondaryBtnStyle} title="Re-run entity propagation">
            Re-tag nodes
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryBtnStyle}>Cancel</button>
          <button onClick={handleApply} style={primaryBtnStyle}>Save catalog</button>
        </div>
      </div>
    </div>
  )
}

// ─── Catalog tab ────────────────────────────────────────────

function CatalogTab(props: {
  domains: string[]
  entitiesByDomain: Map<string, Map<string, number>>
  orphanEntities: Array<{ entity: string; count: number }>
  nodesPerDomain: Map<string, number>
  onRenameEntity: (e: string) => void
  onMergeEntity: (e: string) => void
  onDeleteEntity: (e: string) => void
  onRenameDomain: (d: string) => void
  onDeleteDomain: (d: string) => void
  onAddEntity: () => void
}) {
  const { domains, entitiesByDomain, orphanEntities, nodesPerDomain,
    onRenameEntity, onMergeEntity, onDeleteEntity, onRenameDomain,
    onDeleteDomain, onAddEntity } = props

  if (domains.length === 0 && orphanEntities.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <p>No entities in the catalog yet. Import an OpenAPI spec to seed it.</p>
        <button onClick={onAddEntity} style={primaryBtnStyle}>+ Add entity manually</button>
      </div>
    )
  }

  return (
    <>
      {domains.map((domain) => {
        const inner = entitiesByDomain.get(domain)
        const nodeCount = nodesPerDomain.get(domain) ?? 0
        return (
          <div key={domain} style={{ marginBottom: 14 }}>
            <div style={domainHeaderStyle}>
              <span style={{ flex: 1 }}>{domain}</span>
              <span style={{ fontSize: 10, color: '#666', fontFamily: 'ui-monospace, monospace' }}>
                {nodeCount} node{nodeCount === 1 ? '' : 's'}
              </span>
              <button onClick={() => onRenameDomain(domain)} style={iconBtnStyle} title="Rename domain">✎</button>
              <button onClick={() => onDeleteDomain(domain)} style={iconBtnStyle} title="Delete domain">✕</button>
            </div>
            {inner && [...inner.entries()]
              .filter(([e]) => e !== '__unclassified__')
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([entity, count]) => (
                <EntityRow
                  key={entity}
                  entity={entity}
                  count={count}
                  onRename={() => onRenameEntity(entity)}
                  onMerge={() => onMergeEntity(entity)}
                  onDelete={() => onDeleteEntity(entity)}
                />
              ))}
          </div>
        )
      })}

      {orphanEntities.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={domainHeaderStyle}>
            <span style={{ flex: 1 }}>No domain</span>
          </div>
          {orphanEntities.map(({ entity, count }) => (
            <EntityRow
              key={entity}
              entity={entity}
              count={count}
              onRename={() => onRenameEntity(entity)}
              onMerge={() => onMergeEntity(entity)}
              onDelete={() => onDeleteEntity(entity)}
            />
          ))}
        </div>
      )}

      <button onClick={onAddEntity} style={addBtnStyle}>+ Add entity</button>
    </>
  )
}

function EntityRow(props: {
  entity: string
  count: number
  onRename: () => void
  onMerge: () => void
  onDelete: () => void
}) {
  const { entity, count, onRename, onMerge, onDelete } = props
  return (
    <div style={rowStyle}>
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: entityColor(entity), flexShrink: 0 }} />
      <div style={{ flex: 1, fontSize: 12, color: '#ddd', fontWeight: 600 }}>{entity}</div>
      <div style={{ fontSize: 10, color: '#888', fontFamily: 'ui-monospace, monospace' }}>
        {count} node{count === 1 ? '' : 's'}
      </div>
      <button onClick={onRename} style={iconBtnStyle} title="Rename">✎</button>
      <button onClick={onMerge} style={iconBtnStyle} title="Merge">⇢</button>
      <button onClick={onDelete} style={iconBtnStyle} title="Delete">✕</button>
    </div>
  )
}

// ─── Unclassified tab ───────────────────────────────────────

function UnclassifiedTab(props: {
  nodes: Node[]
  catalogEntities: string[]
  onAssign: (nodeId: string, entity: string | null) => void
}) {
  const { nodes, catalogEntities, onAssign } = props
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return nodes
    const q = query.toLowerCase()
    return nodes.filter((n) =>
      n.name.toLowerCase().includes(q) || (n.description?.toLowerCase() ?? '').includes(q),
    )
  }, [nodes, query])

  if (nodes.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <p>Nothing unclassified. Every non-hub node has an entity tag.</p>
      </div>
    )
  }

  return (
    <>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by name or path…"
        style={searchInputStyle}
      />
      <div style={{ fontSize: 10, color: '#666', marginBottom: 10 }}>
        {filtered.length} of {nodes.length} unclassified nodes
      </div>
      {filtered.slice(0, 200).map((n) => (
        <div key={n.id} style={rowStyle}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#555', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#ddd', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {n.name}
            </div>
            <div style={{ fontSize: 10, color: '#777', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {n.description || n.type}
            </div>
          </div>
          <select
            value=""
            onChange={(e) => e.target.value && onAssign(n.id, e.target.value)}
            style={selectStyle}
          >
            <option value="">Assign…</option>
            {catalogEntities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
      ))}
      {filtered.length > 200 && (
        <div style={{ fontSize: 10, color: '#666', textAlign: 'center', padding: '8px 0' }}>
          Showing first 200. Use the filter to narrow down.
        </div>
      )}
    </>
  )
}

// ─── shared helpers ─────────────────────────────────────────

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        ...tabButtonStyle,
        color: props.active ? '#fff' : '#888',
        borderBottom: props.active ? '2px solid #69f0ae' : '2px solid transparent',
      }}
    >
      {props.children}
    </button>
  )
}

function entityColor(entity: string): string {
  const palette = ['#ff4081', '#00e5ff', '#ff6e40', '#b388ff', '#69f0ae', '#ffd740', '#8c9eff', '#ff5252', '#a7ffeb', '#ffcc80']
  let hash = 0
  for (let i = 0; i < entity.length; i++) hash = (hash * 31 + entity.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

// ─── styles ─────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100, fontFamily: "'Segoe UI', system-ui, sans-serif", color: '#fff',
}
const modalStyle: React.CSSProperties = {
  width: 720, maxWidth: '92vw', maxHeight: '86vh',
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
const tabBarStyle: React.CSSProperties = {
  display: 'flex', gap: 4, padding: '0 18px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
}
const tabButtonStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: '10px 14px',
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
  fontFamily: "'Segoe UI', system-ui, sans-serif",
}
const bodyStyle: React.CSSProperties = { padding: '16px 18px', overflowY: 'auto', flex: 1 }
const domainHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase',
  color: '#888', marginBottom: 6, paddingLeft: 4, paddingBottom: 4,
  borderBottom: '1px solid rgba(255,255,255,0.04)',
}
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '7px 10px', borderRadius: 5, background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.04)', marginBottom: 3,
}
const footerStyle: React.CSSProperties = {
  display: 'flex', gap: 8, padding: '12px 18px',
  borderTop: '1px solid rgba(255,255,255,0.06)',
}
const iconBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#aaa',
  width: 24, height: 24, borderRadius: 4, cursor: 'pointer', fontSize: 11,
}
const primaryBtnStyle: React.CSSProperties = {
  background: '#69f0ae22', border: '1px solid #69f0ae55', color: '#69f0ae',
  padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
const secondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#ccc', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
const dangerBtnStyle: React.CSSProperties = {
  background: 'rgba(255,64,64,0.08)', border: '1px solid rgba(255,64,64,0.25)',
  color: '#ff9aa0', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
const addBtnStyle: React.CSSProperties = {
  background: 'rgba(179,136,255,0.1)', border: '1px dashed rgba(179,136,255,0.3)',
  color: '#b388ff', padding: '8px 16px', borderRadius: 6, cursor: 'pointer',
  fontSize: 12, fontWeight: 600, width: '100%', marginTop: 8,
}
const searchInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
  color: '#ddd', fontSize: 12, marginBottom: 6, boxSizing: 'border-box',
  fontFamily: "'Segoe UI', system-ui, sans-serif",
}
const selectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#ddd', fontSize: 11, padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
}
const emptyStateStyle: React.CSSProperties = {
  textAlign: 'center', padding: '40px 20px', color: '#888', fontSize: 12,
}
