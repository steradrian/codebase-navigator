// ─────────────────────────────────────────────────────────────────
// Shareable exploration state.
//
// The existing `urlState.ts` encodes the retired 3D graph's camera,
// selection, hulls and pins — none of which the new interaction model
// has. What has to survive a link now is the exploration itself: what
// you were focused on, through which lens, at what altitude, and how you
// got there.
//
// That last part is why the trail is in the URL rather than only in the
// database. A link that restores focus but drops the path is a different
// artefact: the reader arrives at a conclusion without the thinking that
// led to it, which is precisely what a saved trail exists to convey.
//
// Encoding is deliberately readable. Someone should be able to look at
// `?focus=useSession&lens=impact&alt=implementation` and understand it,
// and edit it by hand while debugging.
//
// Unknown or malformed values fall back to defaults rather than
// throwing: a shared link that has aged past a rename should still open
// something sensible, and it reports what it dropped so the UI can say
// so instead of silently showing a different view than the sender saw.
// ─────────────────────────────────────────────────────────────────

import type { Altitude } from '@/types'
import { ALTITUDE_ORDER } from '@/schema/altitude'
import { LENS_PROFILES, type Lens } from '@/schema/projection'

export type ExplorationState = {
  focusId: string | null
  lens: Lens
  altitude: Altitude
  /** Absent means "use the altitude's default". */
  depth?: number
  /** Oldest first, matching ExplorationQuery. */
  trail: string[]
  /** The question being pursued, when the user arrived by asking one. */
  question?: string
}

/** What a decode had to discard, so the UI can be honest about it. */
export type DecodeNotice =
  | { kind: 'unknown_lens'; value: string }
  | { kind: 'unknown_altitude'; value: string }
  | { kind: 'invalid_depth'; value: string }

export type DecodeResult = {
  state: ExplorationState
  notices: DecodeNotice[]
}

const LENSES = Object.keys(LENS_PROFILES) as Lens[]

const isLens = (v: string): v is Lens => (LENSES as string[]).includes(v)
const isAltitude = (v: string): v is Altitude =>
  (ALTITUDE_ORDER as readonly string[]).includes(v)

export const DEFAULT_LENS: Lens = 'overview'
export const DEFAULT_ALTITUDE: Altitude = 'implementation'

export function defaultExplorationState(): ExplorationState {
  return { focusId: null, lens: DEFAULT_LENS, altitude: DEFAULT_ALTITUDE, trail: [] }
}

/**
 * Encode state as a query string.
 *
 * Defaults are omitted so a plain link stays short and the parameters
 * that ARE present are the ones the sender actually chose.
 */
export function encodeExplorationState(state: ExplorationState): string {
  const params = new URLSearchParams()
  if (state.focusId) params.set('focus', state.focusId)
  if (state.lens !== DEFAULT_LENS) params.set('lens', state.lens)
  if (state.altitude !== DEFAULT_ALTITUDE) params.set('alt', state.altitude)
  if (state.depth !== undefined) params.set('depth', String(state.depth))
  if (state.question) params.set('q', state.question)
  if (state.trail.length > 0) params.set('trail', state.trail.join(','))
  return params.toString()
}

export function decodeExplorationState(queryString: string): DecodeResult {
  const notices: DecodeNotice[] = []
  const state = defaultExplorationState()

  let params: URLSearchParams
  try {
    params = new URLSearchParams(queryString.replace(/^\?/, ''))
  } catch {
    return { state, notices }
  }

  const focus = params.get('focus')
  if (focus) state.focusId = focus

  const lens = params.get('lens')
  if (lens) {
    if (isLens(lens)) state.lens = lens
    else notices.push({ kind: 'unknown_lens', value: lens })
  }

  const altitude = params.get('alt')
  if (altitude) {
    if (isAltitude(altitude)) state.altitude = altitude
    else notices.push({ kind: 'unknown_altitude', value: altitude })
  }

  const depth = params.get('depth')
  if (depth !== null && depth !== '') {
    const n = Number.parseInt(depth, 10)
    if (Number.isFinite(n) && n >= 0) state.depth = n
    else notices.push({ kind: 'invalid_depth', value: depth })
  }

  const question = params.get('q')
  if (question) state.question = question

  const trail = params.get('trail')
  if (trail) {
    state.trail = trail.split(',').map((s) => s.trim()).filter(Boolean)
  }

  return { state, notices }
}

/** Replace the current history entry — for changes that are not navigation. */
export function replaceUrlWith(state: ExplorationState): void {
  if (typeof window === 'undefined') return
  const qs = encodeExplorationState(state)
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  window.history.replaceState(null, '', url)
}

/**
 * Push a new history entry.
 *
 * Used when focus changes, so the browser's back button retraces the
 * exploration step by step — the same sequence the trail records.
 */
export function pushUrlWith(state: ExplorationState): void {
  if (typeof window === 'undefined') return
  const qs = encodeExplorationState(state)
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  window.history.pushState(null, '', url)
}

/**
 * State after focusing something new.
 *
 * The previous focus is appended to the trail, deduplicated, so a link
 * carries the path that led here and not just the destination.
 */
export function withFocus(state: ExplorationState, focusId: string): ExplorationState {
  if (state.focusId === focusId) return state
  const trail = state.focusId && !state.trail.includes(state.focusId)
    ? [...state.trail, state.focusId]
    : state.trail
  return { ...state, focusId, trail }
}
