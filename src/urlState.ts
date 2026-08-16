// ─────────────────────────────────────────────────────────────────
// Shareable deep links (GE-022).
//
// Encodes the current view state as URL query parameters so that
// copying the URL lands a recipient on the same view. Designed to
// round-trip cleanly: a parsed-then-serialized state matches the
// original, modulo numeric precision on camera angles.
//
// Omitted / malformed fields fall back to sensible defaults. The
// encoder never throws on valid input; the decoder never throws on
// invalid input (logs a console warning and returns defaults).
// ─────────────────────────────────────────────────────────────────

export type ViewState = {
  selectedId: string | null
  activePathId: string | null
  pathStep: number
  camera: {
    theta: number
    phi: number
    r: number
    targetX: number
    targetY: number
    targetZ: number
  }
  is2D: boolean
  showHulls: boolean
  pinnedClusterIds: string[]
}

const DEFAULTS: ViewState = {
  selectedId: null,
  activePathId: null,
  pathStep: 0,
  camera: { theta: 0, phi: Math.PI / 2.5, r: 220, targetX: 0, targetY: 0, targetZ: 0 },
  is2D: false,
  showHulls: true,
  pinnedClusterIds: [],
}

const num = (v: number, precision = 3): string => {
  if (!Number.isFinite(v)) return '0'
  return Number(v.toFixed(precision)).toString()
}

/** Encode view state into a URLSearchParams-compatible object. */
export function encodeViewState(state: ViewState): string {
  const p = new URLSearchParams()
  if (state.selectedId) p.set('sel', state.selectedId)
  if (state.activePathId) {
    p.set('path', state.activePathId)
    p.set('step', String(state.pathStep))
  }
  const c = state.camera
  // Pack camera into a single short param for URL brevity.
  p.set('cam', [num(c.theta), num(c.phi), num(c.r), num(c.targetX, 1), num(c.targetY, 1), num(c.targetZ, 1)].join(','))
  if (state.is2D) p.set('2d', '1')
  if (!state.showHulls) p.set('hulls', '0')
  if (state.pinnedClusterIds.length > 0) p.set('pins', state.pinnedClusterIds.join(','))
  return p.toString()
}

/** Parse a URL query string (or window.location.search) into a ViewState. Malformed input returns defaults. */
export function decodeViewState(queryString: string): ViewState {
  const state: ViewState = structuredClone(DEFAULTS)
  try {
    const s = queryString.startsWith('?') ? queryString.slice(1) : queryString
    if (!s) return state
    const p = new URLSearchParams(s)

    const sel = p.get('sel')
    if (sel) state.selectedId = sel

    const pathId = p.get('path')
    if (pathId) {
      state.activePathId = pathId
      const step = Number(p.get('step') ?? '0')
      state.pathStep = Number.isFinite(step) && step >= 0 ? Math.floor(step) : 0
    }

    const cam = p.get('cam')
    if (cam) {
      const parts = cam.split(',').map((v) => Number(v))
      if (parts.length === 6 && parts.every(Number.isFinite)) {
        state.camera = {
          theta: parts[0], phi: parts[1], r: parts[2],
          targetX: parts[3], targetY: parts[4], targetZ: parts[5],
        }
      }
    }

    state.is2D = p.get('2d') === '1'
    state.showHulls = p.get('hulls') !== '0'

    const pins = p.get('pins')
    if (pins) state.pinnedClusterIds = pins.split(',').filter(Boolean)
  } catch (err) {
    console.warn('[graph-explorer] Failed to parse URL state; using defaults.', err)
  }
  return state
}

/** Return the default view state (a fresh object you can mutate). */
export function defaultViewState(): ViewState {
  return structuredClone(DEFAULTS)
}

// ─── browser-side helpers ───────────────────────────────────

/** Update the browser URL in-place without a history entry. Throttle
 *  this at the caller for camera motion; push separately for meaningful
 *  nav events. */
export function replaceUrlWith(state: ViewState): void {
  const qs = encodeViewState(state)
  const newUrl = qs
    ? `${window.location.pathname}?${qs}`
    : window.location.pathname
  window.history.replaceState({}, '', newUrl)
}

export function pushUrlWith(state: ViewState): void {
  const qs = encodeViewState(state)
  const newUrl = qs
    ? `${window.location.pathname}?${qs}`
    : window.location.pathname
  window.history.pushState({}, '', newUrl)
}

export function copyCurrentUrl(): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(window.location.href).then(() => true).catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}
