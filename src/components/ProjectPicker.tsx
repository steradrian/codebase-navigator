import { useEffect, useRef, useState } from 'react'
import type { GraphSummary } from '@/api/client'

type Props = {
  projects: GraphSummary[]
  activeId: string | null
  activeName: string | null
  offline: boolean
  onSelect: (id: string) => void
  onCreate: (name: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
}

export function ProjectPicker({
  projects, activeId, activeName, offline, onSelect, onCreate, onDelete, onRename,
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as globalThis.Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const currentLabel = activeName ?? (offline ? 'Offline' : 'Loading…')

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: offline ? 'rgba(255,110,64,0.08)' : 'rgba(255,255,255,0.04)',
          border: offline ? '1px solid rgba(255,110,64,0.3)' : '1px solid rgba(255,255,255,0.08)',
          color: offline ? '#ffa080' : '#ddd',
          padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
          fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
        }}
        title={offline ? 'Server unreachable — changes won\'t persist' : 'Switch project'}
      >
        {offline && <span style={{ fontSize: 9 }}>⚠</span>}
        <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentLabel}
        </span>
        <span style={{ opacity: 0.4, fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div style={panelStyle}>
          <div style={{ padding: '8px 10px', fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#666', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            Projects {offline && '(offline)'}
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {projects.length === 0 && (
              <div style={{ padding: '10px 12px', color: '#666', fontSize: 11 }}>
                {offline ? 'Server unreachable.' : 'No projects yet.'}
              </div>
            )}
            {projects.map((p) => {
              const isActive = p.id === activeId
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 10px', cursor: 'pointer',
                    background: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
                  }}
                  onClick={() => { onSelect(p.id); setOpen(false) }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
                >
                  <div style={{ fontSize: 11, color: '#ddd', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      const next = window.prompt('Rename project:', p.name)
                      if (next && next.trim() && next.trim() !== p.name) onRename(p.id, next.trim())
                    }}
                    style={iconBtnStyle}
                    aria-label="Rename"
                    title="Rename"
                  >✎</button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`Delete project "${p.name}"? This cannot be undone.`)) onDelete(p.id)
                    }}
                    style={{ ...iconBtnStyle, color: '#ff8080' }}
                    aria-label="Delete"
                    title="Delete"
                  >✕</button>
                </div>
              )
            })}
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: 8 }}>
            <button
              disabled={offline}
              onClick={() => {
                const name = window.prompt('New project name:')
                if (name && name.trim()) { onCreate(name.trim()); setOpen(false) }
              }}
              style={{
                width: '100%',
                background: offline ? 'rgba(255,255,255,0.02)' : 'rgba(105,240,174,0.08)',
                border: offline ? '1px dashed rgba(255,255,255,0.08)' : '1px dashed rgba(105,240,174,0.3)',
                color: offline ? '#555' : '#69f0ae',
                padding: '6px 10px', borderRadius: 5, cursor: offline ? 'default' : 'pointer',
                fontSize: 11, fontWeight: 600,
              }}
            >
              + New project
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const panelStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', left: 0, marginTop: 6,
  width: 280, background: 'rgba(10,10,25,0.98)',
  border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
  backdropFilter: 'blur(16px)', overflow: 'hidden', zIndex: 50,
  fontFamily: "'Segoe UI', system-ui, sans-serif", color: '#fff',
}

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#888',
  width: 22, height: 22, borderRadius: 3, cursor: 'pointer', fontSize: 10,
}
