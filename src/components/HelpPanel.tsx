// GE-107 — the ? help panel. A single-column cheat sheet covering
// keyboard shortcuts, mouse/trackpad controls, top-bar button
// reference, and a "try this" demo walk-through. Opens via the
// floating "?" corner button or the `?` / `h` hotkey.

import { useEffect } from 'react'

type Props = {
  open: boolean
  onClose: () => void
}

export function HelpPanel({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Help &amp; Cheat Sheet</h2>
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>
        </div>

        <div style={bodyStyle}>
          <Section title="Keyboard shortcuts">
            <Row k="/" v="Open search" />
            <Row k="F" v="Frame the whole graph in view" />
            <Row k="?  or  H" v="This help panel" />
            <Row k="Alt + ←  /  Alt + →" v="Navigation history: back / forward" />
            <Row k="⌘ [  /  ⌘ ]" v="Alternate back / forward on macOS" />
            <Row k="← / →" v="Step through a guided path (when one is active)" />
            <Row k="Esc" v="Close search, dialogs, or clear selection" />
          </Section>

          <Section title="Mouse & trackpad">
            <Row k="Drag" v="Orbit the camera in 3D, pan in 2D" />
            <Row k="Shift + drag  or  right-click drag" v="Pan in 3D" />
            <Row k="Scroll" v="Zoom in / out (exponential)" />
            <Row k="Click a node" v="Select and focus the camera there" />
            <Row k="Hover a node" v="See its name, type, group, and entity without clicking" />
            <Row k="Click a breadcrumb chip" v="Jump directly to that spot in history" />
          </Section>

          <Section title="Top-bar buttons">
            <Row k="Project picker" v="Create, switch, rename, or delete projects" />
            <Row k="💾 Save" v="Download the current schema as JSON" />
            <Row k="📂 Load" v="Load a previously-saved schema JSON" />
            <Row k="↑ Import OpenAPI" v="Seed the graph from an OpenAPI v3 spec (JSON or YAML)" />
            <Row k="📂 Import codebase" v="Pick a repo folder — emits nodes per code file + dependency edges" />
            <Row k="↔ Link imports" v="Extract API calls from the codebase and link them to OpenAPI endpoints" />
            <Row k="✎ Edit" v="Add, rename, or delete nodes and links directly" />
            <Row k="⇄ Diff" v="Compare the current schema against a baseline JSON" />
            <Row k="◉ Hulls" v="Show or hide translucent hulls around group clusters" />
            <Row k="3D / 2D" v="Toggle between 3D orbit and flat 2D views" />
            <Row k="⊡ Frame" v="Fit the whole graph in view (same as pressing F)" />
            <Row k="🔗 Copy link" v="Copy a URL that restores this exact view for someone else" />
            <Row k="✨ Ask" v="Ask the graph a natural-language question (BYO API key)" />
            <Row k="+ Path" v="Author a new guided path by clicking nodes in order" />
          </Section>

          <Section title="Inside the node panel">
            <Row k="↓ Downstream blast" v="See what depends on this node — red cascade" />
            <Row k="↑ Upstream blast" v="See what this node depends on" />
            <Row k="✨ Suggest description" v="Claude writes a description for you (BYO API key)" />
            <Row k="Annotations" v="Leave threaded comments on any node — persist with the project" />
          </Section>

          <Section title="Try this demo walk">
            <div style={{ fontSize: 11, color: '#bbb', lineHeight: 1.6 }}>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Import a spec.</strong> Click <code style={inlineCode}>↑ Import OpenAPI</code> and paste or upload your backend's OpenAPI file.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Import a codebase.</strong> Click <code style={inlineCode}>📂 Import codebase</code> and pick a Next.js or Go project folder.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Link the two.</strong> Click <code style={inlineCode}>↔ Link imports</code> to wire frontend calls to backend endpoints.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Review entities.</strong> A purple banner appears with discovered domain entities — click Review to curate the list.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Navigate the story.</strong> Click a node, then click a connection in the sidebar. Use the breadcrumb at the bottom to retrace your path.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Ask a question.</strong> Click <code style={inlineCode}>✨ Ask</code> and type something like "what breaks if the auth service goes down".
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Trace impact.</strong> Select any node, hit <code style={inlineCode}>↓ Downstream blast</code>, and watch the red cascade.
                </li>
                <li>
                  <strong>Share.</strong> Press <code style={inlineCode}>🔗 Copy link</code> — the URL restores this exact view.
                </li>
              </ol>
            </div>
          </Section>

          <div style={{ marginTop: 20, fontSize: 10, color: '#555', textAlign: 'center' }}>
            Codebase Navigator · local-first · no telemetry
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#888', marginBottom: 8 }}>
      {title}
    </div>
    {children}
  </div>
)

const Row = ({ k, v }: { k: string; v: string }) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
    <code style={{
      fontFamily: 'ui-monospace, monospace',
      fontSize: 10,
      color: '#b388ff',
      background: 'rgba(179,136,255,0.08)',
      border: '1px solid rgba(179,136,255,0.18)',
      padding: '2px 6px',
      borderRadius: 3,
      whiteSpace: 'nowrap',
      flexShrink: 0,
      minWidth: 150,
    }}>
      {k}
    </code>
    <div style={{ fontSize: 11, color: '#ccc', flex: 1 }}>{v}</div>
  </div>
)

const inlineCode: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 10.5,
  color: '#b388ff',
  background: 'rgba(179,136,255,0.08)',
  padding: '1px 5px',
  borderRadius: 3,
}

// ─── styles ─────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 150, fontFamily: "'Segoe UI', system-ui, sans-serif", color: '#fff',
}
const modalStyle: React.CSSProperties = {
  width: 620, maxWidth: '94vw', maxHeight: '88vh',
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
const bodyStyle: React.CSSProperties = { padding: '18px 22px', overflowY: 'auto', flex: 1 }
