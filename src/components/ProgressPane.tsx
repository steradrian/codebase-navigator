// Small shared progress indicator for long-running file reads.
// Shown inside the import dialogs; bar + "X / Y" text.

type Props = {
  label: string
  current: number
  total: number
  color?: string
}

export function ProgressPane({ label, current, total, color = '#b388ff' }: Props) {
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0
  return (
    <div style={{ padding: '14px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ color, fontSize: 12, fontWeight: 600 }}>
          {label}{total > 0 ? '…' : ''}
        </div>
        <div style={{ color: '#888', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
          {total > 0 ? `${current} / ${total}` : ''}
        </div>
      </div>
      <div style={{
        width: '100%', height: 6, background: 'rgba(255,255,255,0.06)',
        borderRadius: 3, overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: color,
          transition: 'width 0.15s ease',
        }} />
      </div>
    </div>
  )
}
