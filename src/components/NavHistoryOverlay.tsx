// GE-101 — navigation-history overlay. Floats at the bottom-center
// of the canvas. Shows back/forward controls plus breadcrumb chips
// for the last few selections. Hides when history is empty.

import type { Node } from '@/types'

type Props = {
  history: string[]
  currentIndex: number
  nodesById: Map<string, Node>
  onBack: () => void
  onForward: () => void
  onJumpTo: (index: number) => void
}

/** How many chips to show in the breadcrumb. History extends beyond this;
 *  chips just show the most recent window around the cursor. */
const MAX_CHIPS = 6

export function NavHistoryOverlay({
  history, currentIndex, nodesById, onBack, onForward, onJumpTo,
}: Props) {
  if (history.length < 2) return null

  const canBack = currentIndex > 0
  const canForward = currentIndex < history.length - 1

  // Window the chips around the current index so the overlay stays
  // compact with deep histories.
  const start = Math.max(0, currentIndex - Math.floor(MAX_CHIPS / 2))
  const end = Math.min(history.length, start + MAX_CHIPS)
  const windowed = history.slice(start, end).map((id, offset) => ({
    id,
    index: start + offset,
  }))

  return (
    <div style={rootStyle}>
      <button
        onClick={onBack}
        disabled={!canBack}
        style={{ ...btnStyle, ...(canBack ? {} : disabledBtnStyle) }}
        aria-label="Back"
        title="Back (Alt + ←)"
      >
        ◀
      </button>

      <div style={chipsStyle}>
        {start > 0 && (
          <span style={ellipsisStyle}>…</span>
        )}
        {windowed.map(({ id, index }) => {
          const node = nodesById.get(id)
          const label = node?.name ?? id
          const isCurrent = index === currentIndex
          return (
            <button
              key={`${id}-${index}`}
              onClick={() => onJumpTo(index)}
              style={{
                ...chipStyle,
                ...(isCurrent ? currentChipStyle : {}),
              }}
              title={label}
            >
              {label.length > 20 ? label.slice(0, 19) + '…' : label}
            </button>
          )
        })}
        {end < history.length && (
          <span style={ellipsisStyle}>…</span>
        )}
      </div>

      <button
        onClick={onForward}
        disabled={!canForward}
        style={{ ...btnStyle, ...(canForward ? {} : disabledBtnStyle) }}
        aria-label="Forward"
        title="Forward (Alt + →)"
      >
        ▶
      </button>
    </div>
  )
}

// ─── styles ─────────────────────────────────────────────────

const rootStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 20,
  left: '50%',
  transform: 'translateX(-50%)',
  background: 'rgba(5,5,13,0.9)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 22,
  padding: '5px 6px',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  backdropFilter: 'blur(12px)',
  zIndex: 15,
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  maxWidth: '70vw',
}

const btnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.06)',
  color: '#ccc',
  width: 30,
  height: 30,
  borderRadius: '50%',
  cursor: 'pointer',
  fontSize: 11,
  flexShrink: 0,
}

const disabledBtnStyle: React.CSSProperties = {
  color: '#444',
  cursor: 'default',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.03)',
}

const chipsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 6px',
  overflow: 'hidden',
}

const chipStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.06)',
  color: '#aaa',
  borderRadius: 14,
  padding: '4px 10px',
  fontSize: 11,
  cursor: 'pointer',
  maxWidth: 160,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const currentChipStyle: React.CSSProperties = {
  background: 'rgba(179,136,255,0.18)',
  border: '1px solid rgba(179,136,255,0.4)',
  color: '#fff',
  fontWeight: 600,
}

const ellipsisStyle: React.CSSProperties = {
  color: '#555',
  fontSize: 10,
  padding: '0 2px',
  flexShrink: 0,
}
