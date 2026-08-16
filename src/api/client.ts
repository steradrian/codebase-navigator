// ─────────────────────────────────────────────────────────────────
// Client-side wrapper for the /api/graphs CRUD endpoints (GE-020).
// Thin on purpose — no caching, no retries. The component debounces
// writes; failures surface as thrown errors the caller can catch.
// ─────────────────────────────────────────────────────────────────

import type { Schema } from '@/types'

export type GraphSummary = {
  id: string
  name: string
  updatedAt: string
}

export type GraphDetail = {
  id: string
  name: string
  schema: Schema
  createdAt: string
  updatedAt: string
}

const API = '/api'

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: unknown = null
    try { detail = await res.json() } catch { /* noop */ }
    const err = new Error(`API ${res.status}`) as Error & { status: number; detail: unknown }
    err.status = res.status
    err.detail = detail
    throw err
  }
  return res.json() as Promise<T>
}

export async function listGraphs(): Promise<GraphSummary[]> {
  const res = await fetch(`${API}/graphs`)
  const body = await handle<{ graphs: GraphSummary[] }>(res)
  return body.graphs
}

export async function getGraph(id: string): Promise<GraphDetail> {
  const res = await fetch(`${API}/graphs/${id}`)
  return handle<GraphDetail>(res)
}

export async function createGraph(name: string, schema: Schema): Promise<GraphSummary> {
  const res = await fetch(`${API}/graphs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, schema }),
  })
  return handle<GraphSummary>(res)
}

export async function updateGraph(id: string, schema: Schema, name?: string): Promise<GraphSummary> {
  const res = await fetch(`${API}/graphs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema, ...(name !== undefined ? { name } : {}) }),
  })
  return handle<GraphSummary>(res)
}

export async function deleteGraph(id: string): Promise<void> {
  const res = await fetch(`${API}/graphs/${id}`, { method: 'DELETE' })
  await handle<{ ok: true }>(res)
}

// ─── annotations (GE-023) ────────────────────────────────────

export type Annotation = {
  id: string
  graphId: string
  targetType: 'node' | 'link'
  targetId: string
  author: string
  body: string
  parentId: string | null
  createdAt: string
}

export async function listAnnotations(graphId: string): Promise<Annotation[]> {
  const res = await fetch(`${API}/graphs/${graphId}/annotations`)
  const body = await handle<{ annotations: Annotation[] }>(res)
  return body.annotations
}

export async function createAnnotation(
  graphId: string,
  input: { targetType: 'node' | 'link'; targetId: string; author: string; body: string; parentId?: string | null },
): Promise<Annotation> {
  const res = await fetch(`${API}/graphs/${graphId}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return handle<Annotation>(res)
}

export async function deleteAnnotation(id: string): Promise<void> {
  const res = await fetch(`${API}/annotations/${id}`, { method: 'DELETE' })
  await handle<{ ok: true }>(res)
}

/** Quick probe — true if the API responds. Used to detect offline mode. */
export async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/graphs`, { method: 'HEAD' })
    // HEAD isn't explicitly wired; Hono returns 404 for unknown methods.
    // Either 200 or 404 proves the server is up.
    return res.status === 200 || res.status === 404 || res.status === 405
  } catch {
    return false
  }
}
