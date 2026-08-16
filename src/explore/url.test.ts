import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALTITUDE,
  DEFAULT_LENS,
  decodeExplorationState,
  defaultExplorationState,
  encodeExplorationState,
  withFocus,
  type ExplorationState,
} from '@/explore/url'

const state = (over: Partial<ExplorationState> = {}): ExplorationState => ({
  ...defaultExplorationState(),
  ...over,
})

describe('encodeExplorationState', () => {
  it('omits defaults so a plain link stays short', () => {
    expect(encodeExplorationState(state({ focusId: 'useSession' }))).toBe('focus=useSession')
  })

  it('includes non-default lens and altitude', () => {
    const qs = encodeExplorationState(state({ focusId: 'a', lens: 'impact', altitude: 'behavior' }))
    expect(qs).toContain('lens=impact')
    expect(qs).toContain('alt=behavior')
  })

  it('carries the trail, because a link without the path loses the thinking', () => {
    const qs = encodeExplorationState(state({ focusId: 'jwt', trail: ['auth', 'login'] }))
    expect(qs).toContain('trail=auth%2Clogin')
  })

  it('carries the question when the user arrived by asking one', () => {
    expect(encodeExplorationState(state({ question: 'what happens on 401?' })))
      .toContain('q=what+happens+on+401%3F')
  })

  it('produces an empty string for a pristine state', () => {
    expect(encodeExplorationState(defaultExplorationState())).toBe('')
  })
})

describe('decodeExplorationState', () => {
  it('round-trips a full state', () => {
    const original = state({
      focusId: 'useSession', lens: 'why', altitude: 'code',
      depth: 3, trail: ['auth', 'login'], question: 'why rate limit?',
    })
    const { state: decoded } = decodeExplorationState(encodeExplorationState(original))
    expect(decoded).toEqual(original)
  })

  it('tolerates a leading question mark', () => {
    expect(decodeExplorationState('?focus=a').state.focusId).toBe('a')
  })

  it('falls back to defaults for an empty query', () => {
    expect(decodeExplorationState('').state).toEqual(defaultExplorationState())
  })

  it('falls back and reports an unknown lens rather than throwing', () => {
    // A shared link that has aged past a rename should still open
    // something sensible, and say what it dropped.
    const { state: s, notices } = decodeExplorationState('lens=telepathy')
    expect(s.lens).toBe(DEFAULT_LENS)
    expect(notices).toContainEqual({ kind: 'unknown_lens', value: 'telepathy' })
  })

  it('falls back and reports an unknown altitude', () => {
    const { state: s, notices } = decodeExplorationState('alt=stratosphere')
    expect(s.altitude).toBe(DEFAULT_ALTITUDE)
    expect(notices).toContainEqual({ kind: 'unknown_altitude', value: 'stratosphere' })
  })

  it('rejects a nonsensical depth instead of coercing it', () => {
    const { state: s, notices } = decodeExplorationState('depth=deep')
    expect(s.depth).toBeUndefined()
    expect(notices).toContainEqual({ kind: 'invalid_depth', value: 'deep' })
  })

  it('rejects a negative depth', () => {
    expect(decodeExplorationState('depth=-2').state.depth).toBeUndefined()
  })

  it('drops empty entries from a ragged trail', () => {
    expect(decodeExplorationState('trail=a,,b,').state.trail).toEqual(['a', 'b'])
  })

  it('reports no notices for a clean link', () => {
    expect(decodeExplorationState('focus=a&lens=impact').notices).toEqual([])
  })
})

describe('withFocus', () => {
  it('appends the previous focus to the trail', () => {
    const next = withFocus(state({ focusId: 'auth' }), 'login')
    expect(next.focusId).toBe('login')
    expect(next.trail).toEqual(['auth'])
  })

  it('does not record a repeat visit twice', () => {
    const s = state({ focusId: 'login', trail: ['auth'] })
    expect(withFocus(s, 'auth').trail).toEqual(['auth', 'login'])
  })

  it('is a no-op when focusing what is already focused', () => {
    const s = state({ focusId: 'auth', trail: [] })
    expect(withFocus(s, 'auth')).toBe(s)
  })

  it('starts a trail from an empty state without recording null', () => {
    expect(withFocus(defaultExplorationState(), 'auth').trail).toEqual([])
  })
})
