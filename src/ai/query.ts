// ─────────────────────────────────────────────────────────────────
// Natural-language graph queries (GE-029).
//
// User types a question in natural language; an LLM translates it
// into a structured `QueryAction` the client knows how to execute
// (multi-select, start path, blast radius, or ask-clarification).
// BYO-key model shared with GE-017 (AI descriptions) — same storage,
// same security caveats.
// ─────────────────────────────────────────────────────────────────

import { getStoredApiKey } from '@/ai/describe'
import type { Schema } from '@/types'

const MODEL = 'claude-haiku-4-5-20251001'
const API_URL = 'https://api.anthropic.com/v1/messages'

export type QueryAction =
  | { kind: 'highlight'; nodeIds: string[]; reason: string }
  | { kind: 'start_path'; pathId: string; reason: string }
  | { kind: 'blast'; nodeId: string; direction: 'downstream' | 'upstream'; reason: string }
  | { kind: 'clarify'; message: string }
  | { kind: 'error'; message: string }

export function getApiKey(): string | null {
  return getStoredApiKey()
}

function buildPrompt(schema: Schema, query: string): { system: string; user: string } {
  // Compact list of node IDs + names + types so the model can reference them.
  const nodeLines = schema.nodes.slice(0, 400).map((n) => {
    const owner = n.owner ? ` (owner: ${n.owner})` : ''
    const group = n.group ? ` [${n.group}]` : ''
    return `- ${n.id} · ${n.name} · type=${n.type}${group}${owner}`
  }).join('\n')
  const pathLines = schema.paths.map((p) => `- ${p.id} · ${p.name} · ${p.description}`).join('\n') || '(none)'

  const system = [
    'You translate natural-language questions about a system architecture graph into a single structured action.',
    'Return ONLY a JSON object matching one of the action shapes — no preamble, no markdown fences, no commentary.',
    '',
    'Action shapes:',
    '  { "kind": "highlight", "nodeIds": string[], "reason": string }',
    '    — Multi-select nodes relevant to the question. Use for "show me X", "what touches Y", "which services use Z".',
    '  { "kind": "start_path", "pathId": string, "reason": string }',
    '    — Activate an existing guided path. Use only when the question clearly asks to "walk through" or "show me the flow of" something AND an existing path matches.',
    '  { "kind": "blast", "nodeId": string, "direction": "downstream" | "upstream", "reason": string }',
    '    — Show blast radius from a node. Use for "what breaks if X fails" (downstream) or "what does Y depend on" (upstream).',
    '  { "kind": "clarify", "message": string }',
    '    — When the question is ambiguous or nothing in the graph matches. Keep the message short and actionable.',
    '',
    'Rules:',
    '- All nodeIds and pathIds MUST exist verbatim in the provided lists. Never invent identifiers.',
    '- If multiple candidates match, prefer a focused set — max ~15 nodes for highlight.',
    '- `reason` should be one short sentence explaining the selection.',
  ].join('\n')

  const user = [
    'GRAPH NODES:',
    nodeLines,
    '',
    'GUIDED PATHS:',
    pathLines,
    '',
    'QUESTION:',
    query,
  ].join('\n')

  return { system, user }
}

export async function runQuery(schema: Schema, query: string, apiKey: string): Promise<QueryAction> {
  const { system, user } = buildPrompt(schema, query)

  let res: Response
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    })
  } catch (err) {
    return { kind: 'error', message: `Network error: ${(err as Error).message}` }
  }

  if (!res.ok) {
    let msg = `API returned ${res.status}`
    try {
      const body = await res.json()
      if (body?.error?.message) msg = `${msg} — ${body.error.message}`
    } catch { /* swallow */ }
    return { kind: 'error', message: msg }
  }

  let data: { content?: { type: string; text: string }[] } | null = null
  try {
    data = await res.json()
  } catch {
    return { kind: 'error', message: 'Could not parse API response.' }
  }
  const raw = data?.content?.find((c) => c.type === 'text')?.text?.trim()
  if (!raw) return { kind: 'error', message: 'Empty response from model.' }

  // Strip accidental code fences / preamble — robust against model drift.
  const jsonStart = raw.indexOf('{')
  const jsonEnd = raw.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) {
    return { kind: 'error', message: `Model did not return JSON. Got: ${raw.slice(0, 120)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1))
  } catch {
    return { kind: 'error', message: 'Model response was not valid JSON.' }
  }

  // Validate shape.
  if (!parsed || typeof parsed !== 'object') return { kind: 'error', message: 'Malformed action.' }
  const action = parsed as Partial<QueryAction> & { kind?: string }
  const validKinds = ['highlight', 'start_path', 'blast', 'clarify'] as const
  if (!action.kind || !validKinds.includes(action.kind as typeof validKinds[number])) {
    return { kind: 'error', message: `Unknown action kind: ${String(action.kind)}` }
  }

  // Guard against hallucinated IDs.
  if (action.kind === 'highlight') {
    const nodeIds = Array.isArray(action.nodeIds) ? action.nodeIds.filter((id): id is string => typeof id === 'string') : []
    const validIds = new Set(schema.nodes.map((n) => n.id))
    const safe = nodeIds.filter((id) => validIds.has(id))
    if (safe.length === 0) {
      return { kind: 'clarify', message: action.reason || 'No matching nodes in the graph.' }
    }
    return { kind: 'highlight', nodeIds: safe, reason: action.reason || 'Matching nodes' }
  }
  if (action.kind === 'start_path') {
    if (typeof action.pathId !== 'string' || !schema.paths.find((p) => p.id === action.pathId)) {
      return { kind: 'clarify', message: 'No matching path in this graph.' }
    }
    return { kind: 'start_path', pathId: action.pathId, reason: action.reason || '' }
  }
  if (action.kind === 'blast') {
    if (typeof action.nodeId !== 'string' || !schema.nodes.find((n) => n.id === action.nodeId)) {
      return { kind: 'clarify', message: 'No matching start node for blast radius.' }
    }
    const dir = action.direction === 'upstream' ? 'upstream' : 'downstream'
    return { kind: 'blast', nodeId: action.nodeId, direction: dir, reason: action.reason || '' }
  }
  if (action.kind === 'clarify') {
    return { kind: 'clarify', message: typeof action.message === 'string' ? action.message : 'Could not interpret the question.' }
  }
  return { kind: 'error', message: 'Unreachable.' }
}
