// ─────────────────────────────────────────────────────────────────
// Entry point.
//
// The 3D force-directed explorer that used to live here has been
// removed — it was the paradigm this product explicitly moved away
// from. The replacement is designed first and built after, so this is
// deliberately a placeholder rather than a partial interface.
//
// It renders a status page against the real API so the dev server has
// something honest to serve and the backend stays exercised end to end
// while the design work happens.
// ─────────────────────────────────────────────────────────────────

import React from 'react'
import { createRoot } from 'react-dom/client'
import { Placeholder } from '@/explore/Placeholder'

const container = document.getElementById('root')
if (!container) throw new Error('No #root element in index.html')

createRoot(container).render(
  <React.StrictMode>
    <Placeholder />
  </React.StrictMode>,
)
