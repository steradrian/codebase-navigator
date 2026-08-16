// ─────────────────────────────────────────────────────────────────
// AI-generated node descriptions (GE-017).
//
// Calls the Anthropic Messages API directly from the browser with a
// user-supplied API key stored in localStorage. BYO (bring-your-own)
// key model: no server involvement, no keys in our bundle. Suitable
// for local dev / single-user use. Production deployments should
// proxy this through a server — see the "Security" note on GE-017.
// ─────────────────────────────────────────────────────────────────

import type { Schema } from '@/types'

const KEY_STORAGE = 'graph-explorer:anthropic-key'
const MODEL = 'claude-haiku-4-5-20251001'
const API_URL = 'https://api.anthropic.com/v1/messages'

export function getStoredApiKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE)
  } catch {
    return null
  }
}

export function setStoredApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    // localStorage disabled — silently skip; caller will re-prompt next time.
  }
}

export function clearStoredApiKey(): void {
  try { localStorage.removeItem(KEY_STORAGE) } catch { /* noop */ }
}

type NeighborContext = {
  name: string
  type: string
  linkLabel: string
  direction: 'out' | 'in'
}

function gatherNeighbors(schema: Schema, nodeId: string): NeighborContext[] {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]))
  const out: NeighborContext[] = []
  for (const l of schema.links) {
    if (l.source === nodeId) {
      const other = byId.get(l.target)
      if (other) out.push({ name: other.name, type: other.type, linkLabel: l.label, direction: 'out' })
    } else if (l.target === nodeId) {
      const other = byId.get(l.source)
      if (other) out.push({ name: other.name, type: other.type, linkLabel: l.label, direction: 'in' })
    }
  }
  return out
}

function buildPrompt(schema: Schema, nodeId: string): { system: string; user: string } {
  const node = schema.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error(`Unknown node: ${nodeId}`)
  const neighbors = gatherNeighbors(schema, nodeId)
  const neighborLines = neighbors.length
    ? neighbors.map((n) => `- ${n.direction === 'out' ? '→' : '←'} ${n.name} (${n.type}) [${n.linkLabel}]`).join('\n')
    : '- (no direct connections)'

  const system = [
    'You write concise, technical descriptions of system components for an architecture diagram.',
    'Output 2-3 sentences focused on purpose and role in the system. Plain text, no markdown, no quotes, no preamble.',
  ].join(' ')

  const user = [
    'Write a description for this node.',
    '',
    'NODE',
    `- Name: ${node.name}`,
    `- Type: ${node.type}`,
    node.group ? `- Group: ${node.group}` : null,
    node.owner ? `- Owner: ${node.owner}` : null,
    `- Existing description: ${node.description || '(none)'}`,
    '',
    'DIRECT CONNECTIONS',
    neighborLines,
    '',
    'Return ONLY the new description text.',
  ].filter(Boolean).join('\n')

  return { system, user }
}

export type SuggestResult = {
  ok: boolean
  text: string | null
  message: string | null
}

export async function suggestDescription(
  schema: Schema,
  nodeId: string,
  apiKey: string,
): Promise<SuggestResult> {
  const { system, user } = buildPrompt(schema, nodeId)

  let response: Response
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    })
  } catch (err) {
    return { ok: false, text: null, message: `Network error: ${(err as Error).message}` }
  }

  if (!response.ok) {
    let msg = `API returned ${response.status}`
    try {
      const body = await response.json()
      if (body?.error?.message) msg = `${msg} — ${body.error.message}`
    } catch { /* swallow */ }
    return { ok: false, text: null, message: msg }
  }

  let data: { content?: { type: string; text: string }[] } | null = null
  try {
    data = await response.json()
  } catch {
    return { ok: false, text: null, message: 'Could not parse API response.' }
  }
  const text = data?.content?.find((c) => c.type === 'text')?.text?.trim()
  if (!text) return { ok: false, text: null, message: 'API returned no text content.' }

  return { ok: true, text, message: null }
}
