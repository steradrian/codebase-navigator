// Custom tooltip component with 200ms hover delay and multi-line content
// support. Replaces native `title=` on interactive elements so the
// appearance is consistent with the rest of the dark-themed UI and
// the content can be longer than one line. Positions to avoid viewport
// clipping.

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

type Placement = 'top' | 'bottom'

type Props = {
  label: ReactNode
  /** Override the default 200ms show delay. */
  delayMs?: number
  /** Inline style for the wrapping span. */
  style?: React.CSSProperties
  children: ReactNode
}

export function Tooltip({ label, delayMs = 200, style, children }: Props) {
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number; placement: Placement }>({
    x: 0, y: 0, placement: 'bottom',
  })

  const show = () => {
    if (!anchorRef.current) return
    timeoutRef.current = window.setTimeout(() => {
      if (!anchorRef.current) return
      const rect = anchorRef.current.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const belowY = rect.bottom + 8
      const aboveY = rect.top - 8
      const fitsBelow = belowY + 70 < window.innerHeight
      setPos({
        x: centerX,
        y: fitsBelow ? belowY : aboveY,
        placement: fitsBelow ? 'bottom' : 'top',
      })
      setVisible(true)
    }, delayMs)
  }
  const hide = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setVisible(false)
  }

  // Clean up timeout if the tooltip unmounts during its delay window.
  useEffect(() => () => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
  }, [])

  return (
    <span
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
      style={{ display: 'inline-flex', ...style }}
    >
      {children}
      {visible && (
        <div
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            transform: pos.placement === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            background: 'rgba(10,10,25,0.97)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            padding: '7px 10px',
            backdropFilter: 'blur(8px)',
            fontSize: 11,
            color: '#ddd',
            fontFamily: "'Segoe UI', system-ui, sans-serif",
            maxWidth: 280,
            lineHeight: 1.45,
            boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
            zIndex: 200,
            whiteSpace: 'normal',
          }}
        >
          {label}
        </div>
      )}
    </span>
  )
}

/** Helper for the common "title + shortcut" tooltip shape. */
export function TooltipLines(props: { title: string; hint?: string; shortcut?: string }) {
  return (
    <>
      <div style={{ fontWeight: 600, color: '#fff', marginBottom: props.hint || props.shortcut ? 3 : 0 }}>
        {props.title}
      </div>
      {props.hint && <div style={{ color: '#bbb', fontSize: 10.5 }}>{props.hint}</div>}
      {props.shortcut && (
        <div style={{ marginTop: 4, fontSize: 10, color: '#888', fontFamily: 'ui-monospace, monospace' }}>
          {props.shortcut}
        </div>
      )}
    </>
  )
}
