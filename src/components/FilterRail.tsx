// GE-104 — Filter rail. Left-side collapsible sidebar with multi-select
// filters across type, domain, entity, and origin. Empty set in any
// facet means "all allowed"; populated means "only these."
//
// Domain facet added by GE-104b — coarse grouping from OpenAPI tags
// alongside the fine-grained entity facet.

import { useMemo } from 'react'
import type { Schema } from '@/types'

type Props = {
  open: boolean
  onToggleOpen: () => void
  schema: Schema

  types: string[]
  domains: string[]
  entities: string[]
  origins: string[]

  onChangeTypes: (next: string[]) => void
  onChangeDomains: (next: string[]) => void
  onChangeEntities: (next: string[]) => void
  onChangeOrigins: (next: string[]) => void
}

export function FilterRail(props: Props) {
  const { open, onToggleOpen, schema, types, domains, entities, origins,
    onChangeTypes, onChangeDomains, onChangeEntities, onChangeOrigins } = props

  // Tally node counts per facet value, memoized against the schema.
  const counts = useMemo(() => {
    const byType = new Map<string, number>()
    const byDomain = new Map<string, number>()
    const byEntity = new Map<string, number>()
    const byOrigin = new Map<string, number>()
    for (const n of schema.nodes) {
      byType.set(n.type, (byType.get(n.type) ?? 0) + 1)
      const d = n.domain ?? '__unclassified__'
      byDomain.set(d, (byDomain.get(d) ?? 0) + 1)
      const e = n.entity ?? '__unclassified__'
      byEntity.set(e, (byEntity.get(e) ?? 0) + 1)
      byOrigin.set(n.origin, (byOrigin.get(n.origin) ?? 0) + 1)
    }
    return { byType, byDomain, byEntity, byOrigin }
  }, [schema.nodes])

  const activeCount = types.length + domains.length + entities.length + origins.length

  const toggle = (current: string[], onChange: (n: string[]) => void, v: string) => {
    if (current.includes(v)) onChange(current.filter((x) => x !== v))
    else onChange([...current, v])
  }

  const clearAll = () => {
    onChangeTypes([])
    onChangeDomains([])
    onChangeEntities([])
    onChangeOrigins([])
  }

  if (!open) {
    return (
      <button
        onClick={onToggleOpen}
        style={collapsedStyle}
        title="Filters"
        aria-label="Open filter rail"
      >
        <div style={{ fontSize: 12, color: '#aaa' }}>⫶</div>
        {activeCount > 0 && (
          <div style={badgeStyle}>{activeCount}</div>
        )}
      </button>
    )
  }

  return (
    <div style={expandedStyle}>
      <div style={headerStyle}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#888' }}>
          Filters {activeCount > 0 && <span style={{ color: '#b388ff' }}>({activeCount})</span>}
        </div>
        <button onClick={onToggleOpen} style={collapseBtnStyle} aria-label="Collapse">‹</button>
      </div>

      {activeCount > 0 && (
        <button onClick={clearAll} style={clearBtnStyle}>
          Clear all
        </button>
      )}

      <FilterGroup
        title="By type"
        entries={[...counts.byType.entries()].sort(([a], [b]) => a.localeCompare(b))}
        selected={types}
        onToggle={(v) => toggle(types, onChangeTypes, v)}
        renderDot={(key) => <DotSpan color={schema.nodeTypes[key]?.color ?? '#666'} />}
      />

      <FilterGroup
        title="By domain"
        entries={[...counts.byDomain.entries()].sort(([a], [b]) => {
          if (a === '__unclassified__') return 1
          if (b === '__unclassified__') return -1
          return a.localeCompare(b)
        })}
        selected={domains}
        onToggle={(v) => toggle(domains, onChangeDomains, v)}
        renderLabel={(key) => key === '__unclassified__' ? 'unclassified' : key}
        renderDot={(key) => key === '__unclassified__'
          ? <DotSpan color="#555" />
          : <DotSpan color={entityColor(key)} />
        }
      />

      <FilterGroup
        title="By entity"
        entries={[...counts.byEntity.entries()].sort(([a], [b]) => {
          if (a === '__unclassified__') return 1
          if (b === '__unclassified__') return -1
          return a.localeCompare(b)
        })}
        selected={entities}
        onToggle={(v) => toggle(entities, onChangeEntities, v)}
        renderLabel={(key) => key === '__unclassified__' ? 'unclassified' : key}
        renderDot={(key) => key === '__unclassified__'
          ? <DotSpan color="#555" />
          : <DotSpan color={entityColor(key)} />
        }
      />

      <FilterGroup
        title="By origin"
        entries={[...counts.byOrigin.entries()].sort(([a], [b]) => a.localeCompare(b))}
        selected={origins}
        onToggle={(v) => toggle(origins, onChangeOrigins, v)}
      />
    </div>
  )
}

// ─── sub-components ─────────────────────────────────────────

function FilterGroup<T extends string>(props: {
  title: string
  entries: Array<[T, number]>
  selected: string[]
  onToggle: (v: T) => void
  renderLabel?: (key: T) => string
  renderDot?: (key: T) => React.ReactNode
}) {
  const { title, entries, selected, onToggle, renderLabel, renderDot } = props
  if (entries.length === 0) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={groupHeaderStyle}>{title}</div>
      {entries.map(([key, count]) => {
        const isOn = selected.includes(key)
        const isDimmed = selected.length > 0 && !isOn
        return (
          <button
            key={key}
            onClick={() => onToggle(key)}
            style={{
              ...itemStyle,
              opacity: isDimmed ? 0.45 : 1,
              background: isOn ? 'rgba(179,136,255,0.12)' : 'transparent',
              border: isOn ? '1px solid rgba(179,136,255,0.3)' : '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: isOn ? '#b388ff' : 'transparent', border: '1px solid rgba(255,255,255,0.25)', flexShrink: 0 }} />
            {renderDot?.(key)}
            <span style={{ fontSize: 11, color: isOn ? '#fff' : '#bbb', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {renderLabel ? renderLabel(key) : key}
            </span>
            <span style={{ fontSize: 9, color: '#666', fontFamily: 'ui-monospace, monospace' }}>{count}</span>
          </button>
        )
      })}
    </div>
  )
}

const DotSpan = ({ color }: { color: string }) => (
  <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 4px ${color}40`, flexShrink: 0 }} />
)

// Deterministic hash palette — matches the one used in groupColor for hulls + entity-color mode.
function entityColor(key: string): string {
  const palette = ['#ff4081', '#00e5ff', '#ff6e40', '#b388ff', '#69f0ae', '#ffd740', '#8c9eff', '#ff5252']
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

// ─── styles ─────────────────────────────────────────────────

const collapsedStyle: React.CSSProperties = {
  position: 'absolute',
  top: 80,
  left: 16,
  width: 36,
  height: 36,
  borderRadius: '50%',
  background: 'rgba(5,5,13,0.88)',
  border: '1px solid rgba(255,255,255,0.08)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backdropFilter: 'blur(8px)',
  zIndex: 12,
}

const badgeStyle: React.CSSProperties = {
  position: 'absolute',
  top: -4,
  right: -4,
  background: '#b388ff',
  color: '#0a0a18',
  fontSize: 9,
  fontWeight: 700,
  minWidth: 16,
  height: 16,
  borderRadius: 8,
  padding: '0 5px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const expandedStyle: React.CSSProperties = {
  position: 'absolute',
  top: 80,
  left: 16,
  width: 240,
  maxHeight: 'calc(100vh - 180px)',
  background: 'rgba(5,5,13,0.92)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  padding: '10px 12px',
  backdropFilter: 'blur(12px)',
  zIndex: 12,
  overflowY: 'auto',
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  color: '#ddd',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
}

const collapseBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#888',
  fontSize: 14,
  cursor: 'pointer',
  padding: '2px 6px',
}

const clearBtnStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,64,64,0.08)',
  border: '1px solid rgba(255,64,64,0.25)',
  color: '#ff9aa0',
  fontSize: 10,
  padding: '5px 8px',
  borderRadius: 4,
  cursor: 'pointer',
  marginBottom: 10,
  fontWeight: 600,
}

const groupHeaderStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: '#666',
  marginBottom: 4,
  paddingLeft: 2,
}

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '5px 7px',
  borderRadius: 4,
  cursor: 'pointer',
  marginBottom: 2,
  width: '100%',
  boxSizing: 'border-box',
}
