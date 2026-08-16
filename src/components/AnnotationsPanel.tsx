import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Annotation } from '@/api/client'
import { createAnnotation, deleteAnnotation, listAnnotations } from '@/api/client'

type Props = {
  graphId: string | null
  targetType: 'node' | 'link'
  targetId: string | null
}

const AUTHOR_STORAGE = 'graph-explorer:author'

function getStoredAuthor(): string | null {
  try { return localStorage.getItem(AUTHOR_STORAGE) } catch { return null }
}
function setStoredAuthor(v: string): void {
  try { localStorage.setItem(AUTHOR_STORAGE, v) } catch { /* noop */ }
}

export function AnnotationsPanel({ graphId, targetType, targetId }: Props) {
  const [all, setAll] = useState<Annotation[]>([])
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [author, setAuthorState] = useState<string | null>(getStoredAuthor())

  const refresh = useCallback(async () => {
    if (!graphId) return
    setLoading(true)
    try {
      setAll(await listAnnotations(graphId))
    } catch {
      // Offline or server error — swallow; panel renders empty.
    } finally {
      setLoading(false)
    }
  }, [graphId])

  useEffect(() => { refresh() }, [refresh])

  // Scope the list to the currently-selected entity.
  const visible = useMemo(
    () => all.filter((a) => a.targetType === targetType && a.targetId === targetId),
    [all, targetType, targetId],
  )

  // Build a simple two-level thread tree.
  const threads = useMemo(() => {
    const byParent = new Map<string | null, Annotation[]>()
    for (const a of visible) {
      const key = a.parentId
      const arr = byParent.get(key) ?? []
      arr.push(a)
      byParent.set(key, arr)
    }
    const top = byParent.get(null) ?? []
    return top.map((parent) => ({
      parent,
      replies: byParent.get(parent.id) ?? [],
    }))
  }, [visible])

  const ensureAuthor = (): string | null => {
    if (author) return author
    const entered = window.prompt('Your name (shown with your annotations):')
    if (!entered) return null
    const trimmed = entered.trim()
    if (!trimmed) return null
    setStoredAuthor(trimmed)
    setAuthorState(trimmed)
    return trimmed
  }

  const submit = async () => {
    if (!graphId || !targetId || !draft.trim()) return
    const writer = ensureAuthor()
    if (!writer) return
    try {
      await createAnnotation(graphId, {
        targetType,
        targetId,
        author: writer,
        body: draft.trim(),
        parentId: replyTo,
      })
      setDraft('')
      setReplyTo(null)
      await refresh()
    } catch (err) {
      alert(`Could not post annotation: ${(err as Error).message}`)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('Delete this annotation?')) return
    try {
      await deleteAnnotation(id)
      await refresh()
    } catch (err) {
      alert(`Could not delete: ${(err as Error).message}`)
    }
  }

  const changeAuthor = () => {
    const entered = window.prompt('Change your display name:', author ?? '')
    if (entered === null) return
    const trimmed = entered.trim()
    if (!trimmed) return
    setStoredAuthor(trimmed)
    setAuthorState(trimmed)
  }

  if (!graphId || !targetId) return null

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', opacity: 0.35 }}>
          Annotations ({visible.length})
        </div>
        <button
          onClick={changeAuthor}
          style={{ background: 'transparent', border: 'none', color: '#555', fontSize: 9, cursor: 'pointer' }}
          title="Change your display name"
        >
          {author ? `as ${author}` : 'set name'}
        </button>
      </div>

      {loading && <div style={{ color: '#555', fontSize: 10 }}>Loading…</div>}

      {threads.length === 0 && !loading && (
        <div style={{ color: '#555', fontSize: 10, marginBottom: 8 }}>
          No annotations yet. Add one below.
        </div>
      )}

      {threads.map(({ parent, replies }) => (
        <div key={parent.id} style={{ marginBottom: 10 }}>
          <AnnotationRow
            annotation={parent}
            canDelete={parent.author === author}
            onDelete={() => remove(parent.id)}
            onReply={() => setReplyTo(replyTo === parent.id ? null : parent.id)}
            replyActive={replyTo === parent.id}
          />
          {replies.map((r) => (
            <div key={r.id} style={{ marginLeft: 18, marginTop: 4 }}>
              <AnnotationRow
                annotation={r}
                canDelete={r.author === author}
                onDelete={() => remove(r.id)}
                nested
              />
            </div>
          ))}
          {replyTo === parent.id && (
            <div style={{ marginLeft: 18, marginTop: 6 }}>
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Reply to ${parent.author}…`}
                style={textareaStyle}
              />
              <div style={{ display: 'flex', gap: 4, marginTop: 4, justifyContent: 'flex-end' }}>
                <button onClick={() => { setReplyTo(null); setDraft('') }} style={secondaryBtnStyle}>Cancel</button>
                <button disabled={!draft.trim()} onClick={submit} style={primaryBtnStyle}>Reply</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {!replyTo && (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an annotation…"
            style={textareaStyle}
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 4, justifyContent: 'flex-end' }}>
            <button disabled={!draft.trim()} onClick={submit} style={primaryBtnStyle}>Post</button>
          </div>
        </>
      )}
    </div>
  )
}

function AnnotationRow(props: {
  annotation: Annotation
  canDelete: boolean
  onDelete: () => void
  onReply?: () => void
  replyActive?: boolean
  nested?: boolean
}) {
  const { annotation, canDelete, onDelete, onReply, replyActive, nested } = props
  const when = new Date(annotation.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <div style={{
      background: nested ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.04)', borderRadius: 6, padding: '7px 9px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#ddd' }}>{annotation.author}</span>
        <span style={{ fontSize: 9, color: '#666' }}>{when}</span>
        <div style={{ flex: 1 }} />
        {onReply && (
          <button
            onClick={onReply}
            style={iconBtnStyle}
            title="Reply"
          >{replyActive ? '✕' : '↵'}</button>
        )}
        {canDelete && (
          <button onClick={onDelete} style={{ ...iconBtnStyle, color: '#ff8080' }} title="Delete">×</button>
        )}
      </div>
      <div style={{ fontSize: 11, color: '#ccc', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{annotation.body}</div>
    </div>
  )
}

const textareaStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 4, color: '#ccc', fontSize: 11, padding: 7, resize: 'vertical',
  height: 54, fontFamily: 'inherit', outline: 'none',
}

const primaryBtnStyle: React.CSSProperties = {
  background: 'rgba(105,240,174,0.12)', border: '1px solid rgba(105,240,174,0.3)',
  color: '#69f0ae', padding: '5px 12px', borderRadius: 4, cursor: 'pointer',
  fontSize: 10, fontWeight: 600,
}
const secondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#999', padding: '5px 12px', borderRadius: 4, cursor: 'pointer',
  fontSize: 10, fontWeight: 600,
}
const iconBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#666',
  width: 18, height: 18, borderRadius: 3, cursor: 'pointer', fontSize: 10,
}
