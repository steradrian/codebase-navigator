import React from 'react'
import ReactDOM from 'react-dom/client'
import GraphExplorer from '@/GraphExplorer'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <GraphExplorer />
  </React.StrictMode>,
)
