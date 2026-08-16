import { describe, expect, it } from 'vitest'
import { decodeViewState, defaultViewState, encodeViewState, type ViewState } from '@/urlState'

describe('urlState encode/decode round-trip', () => {
  it('defaults round-trip with minimal params', () => {
    const s = defaultViewState()
    const qs = encodeViewState(s)
    const back = decodeViewState(qs)
    // Camera angles round to precision — compare with tolerance.
    expect(back.selectedId).toBe(s.selectedId)
    expect(back.activePathId).toBe(s.activePathId)
    expect(back.is2D).toBe(s.is2D)
    expect(back.showHulls).toBe(s.showHulls)
    expect(back.camera.theta).toBeCloseTo(s.camera.theta, 2)
    expect(back.camera.phi).toBeCloseTo(s.camera.phi, 2)
  })

  it('round-trips a rich state', () => {
    const s: ViewState = {
      selectedId: 'node_auth',
      activePathId: 'p1',
      pathStep: 3,
      camera: { theta: 1.25, phi: 0.9, r: 180, targetX: 10.5, targetY: -4.2, targetZ: 33.7 },
      is2D: true,
      showHulls: false,
      pinnedClusterIds: ['d_auth', 'd_content'],
    }
    const back = decodeViewState(encodeViewState(s))
    expect(back.selectedId).toBe('node_auth')
    expect(back.activePathId).toBe('p1')
    expect(back.pathStep).toBe(3)
    expect(back.is2D).toBe(true)
    expect(back.showHulls).toBe(false)
    expect(back.pinnedClusterIds).toEqual(['d_auth', 'd_content'])
    expect(back.camera.theta).toBeCloseTo(1.25, 2)
    expect(back.camera.r).toBeCloseTo(180, 2)
  })
})

describe('decodeViewState edge cases', () => {
  it('empty / missing query string → defaults', () => {
    expect(decodeViewState('').selectedId).toBeNull()
    expect(decodeViewState('?').activePathId).toBeNull()
  })

  it('invalid camera param is ignored, other fields preserved', () => {
    const back = decodeViewState('sel=x&cam=garbage')
    expect(back.selectedId).toBe('x')
    const d = defaultViewState()
    expect(back.camera.theta).toBeCloseTo(d.camera.theta, 2)
  })

  it('malformed path step defaults to 0', () => {
    const back = decodeViewState('path=p1&step=notanumber')
    expect(back.activePathId).toBe('p1')
    expect(back.pathStep).toBe(0)
  })
})
