import { describe, expect, it } from 'vitest'
import { parseBackendCodebase, PLUGINS } from '@/importers/codebase/backends'
import { nodejsPlugin } from '@/importers/codebase/backends/nodejs'
import { pythonPlugin } from '@/importers/codebase/backends/python'
import { rustPlugin } from '@/importers/codebase/backends/rust'

describe('Backend dispatcher', () => {
  it('picks Go when most files are .go', () => {
    const files = new Map([
      ['main.go', 'package main\nfunc main() {}'],
      ['handlers/api.go', 'package handlers\nfunc Setup(r *gin.Engine) { r.GET("/x", h) }'],
      ['README.md', '# readme'],
    ])
    const result = parseBackendCodebase(files)
    expect(result.ok).toBe(true)
    // Should have found the gin handler.
    expect(result.stats.handlersEmitted).toBe(1)
  })

  it('returns graceful result for empty map', () => {
    const result = parseBackendCodebase(new Map())
    expect(result.ok).toBe(true)
    expect(result.schema).toBeNull()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].kind).toBe('unsupported_language')
  })

  it('returns graceful result when no backend files are present', () => {
    const files = new Map([
      ['README.md', '# readme'],
      ['docs/notes.txt', 'notes'],
    ])
    const result = parseBackendCodebase(files)
    expect(result.ok).toBe(true)
    expect(result.schema).toBeNull()
    expect(result.warnings[0].kind).toBe('unsupported_language')
  })
})

describe('Stub plugins', () => {
  it('nodejs stub returns unsupported warning', () => {
    const result = nodejsPlugin.extract(new Map())
    expect(result.ok).toBe(true)
    expect(result.schema).toBeNull()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toEqual({ kind: 'unsupported_language', language: 'nodejs' })
  })

  it('python stub returns unsupported warning', () => {
    const result = pythonPlugin.extract(new Map())
    expect(result.ok).toBe(true)
    expect(result.schema).toBeNull()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toEqual({ kind: 'unsupported_language', language: 'python' })
  })

  it('rust stub returns unsupported warning', () => {
    const result = rustPlugin.extract(new Map())
    expect(result.ok).toBe(true)
    expect(result.schema).toBeNull()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toEqual({ kind: 'unsupported_language', language: 'rust' })
  })

  it('all plugins declare at least one file extension', () => {
    for (const plugin of PLUGINS) {
      expect(plugin.fileExtensions.length).toBeGreaterThan(0)
    }
  })
})
