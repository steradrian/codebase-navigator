import { describe, expect, it } from 'vitest'
import { goPlugin } from '@/importers/codebase/backends/go'

function extract(files: Map<string, string>) {
  return goPlugin.extract(files)
}

describe('Go plugin — handler extraction', () => {
  it('gin GET route emits an api node', () => {
    const files = new Map([
      ['handlers/admin.go', `
package handlers

func SetupRoutes(r *gin.Engine) {
  r.GET("/admin/players", listPlayers)
}
`],
    ])
    const result = extract(files)
    expect(result.ok).toBe(true)
    expect(result.stats.handlersEmitted).toBe(1)
    const node = result.schema!.nodes.find((n) => n.type === 'api')!
    expect(node.name).toBe('GET /admin/players')
    expect(node.id).toBe('codebase:go:op:GET:_admin_players')
    expect(node.origin).toBe('auto:codebase')
    expect(node.metadata?.backend).toBe('go')
    expect(node.group).toBe('go handlers')
  })

  it('gin path param :id is normalized to {id}', () => {
    const files = new Map([
      ['handlers/admin.go', `
package handlers

func SetupRoutes(r *gin.Engine) {
  r.GET("/admin/players/:id", getPlayer)
}
`],
    ])
    const result = extract(files)
    const node = result.schema!.nodes.find((n) => n.type === 'api')!
    expect(node.name).toBe('GET /admin/players/{id}')
    expect(node.id).toBe('codebase:go:op:GET:_admin_players__id')
  })

  it('gin wildcard *splat is normalized to {splat}', () => {
    const files = new Map([
      ['handlers/proxy.go', `
package handlers

func Setup(r *gin.Engine) {
  r.GET("/proxy/*filepath", proxyHandler)
}
`],
    ])
    const result = extract(files)
    const node = result.schema!.nodes.find((n) => n.type === 'api')!
    expect(node.name).toBe('GET /proxy/{filepath}')
  })

  it('chi route with path param', () => {
    const files = new Map([
      ['routes/users.go', `
package routes

func UserRoutes(r chi.Router) {
  r.Get("/users/:userId", getUser)
  r.Post("/users", createUser)
}
`],
    ])
    const result = extract(files)
    expect(result.stats.handlersEmitted).toBe(2)
    const names = result.schema!.nodes.filter((n) => n.type === 'api').map((n) => n.name).sort()
    expect(names).toEqual(['GET /users/{userId}', 'POST /users'])
  })

  it('gorilla/mux HandleFunc with .Methods("POST")', () => {
    const files = new Map([
      ['routes/api.go', `
package routes

func Setup(r *mux.Router) {
  r.HandleFunc("/api/payments", createPayment).Methods("POST")
}
`],
    ])
    const result = extract(files)
    expect(result.stats.handlersEmitted).toBe(1)
    const node = result.schema!.nodes.find((n) => n.type === 'api')!
    expect(node.name).toBe('POST /api/payments')
  })

  it('gorilla/mux HandleFunc with .Methods on next line', () => {
    const files = new Map([
      ['routes/api.go', `
package routes

func Setup(r *mux.Router) {
  r.HandleFunc("/api/orders", listOrders).
    Methods("GET")
}
`],
    ])
    const result = extract(files)
    const node = result.schema!.nodes.find((n) => n.type === 'api')!
    expect(node.name).toBe('GET /api/orders')
  })

  it('net/http HandleFunc defaults to GET', () => {
    const files = new Map([
      ['main.go', `
package main

func main() {
  http.HandleFunc("/health", healthCheck)
}
`],
    ])
    const result = extract(files)
    expect(result.stats.handlersEmitted).toBe(1)
    const node = result.schema!.nodes.find((n) => n.type === 'api')!
    expect(node.name).toBe('GET /health')
  })

  it('echo route extraction', () => {
    const files = new Map([
      ['server/routes.go', `
package server

func Setup(e *echo.Echo) {
  e.GET("/items", listItems)
  e.POST("/items", createItem)
  e.DELETE("/items/:id", deleteItem)
}
`],
    ])
    const result = extract(files)
    expect(result.stats.handlersEmitted).toBe(3)
    const names = result.schema!.nodes.filter((n) => n.type === 'api').map((n) => n.name).sort()
    expect(names).toEqual(['DELETE /items/{id}', 'GET /items', 'POST /items'])
  })

  it('multiple methods from gin in same file', () => {
    const files = new Map([
      ['handlers/crud.go', `
package handlers

func Setup(r *gin.Engine) {
  r.GET("/things", listThings)
  r.POST("/things", createThing)
  r.PUT("/things/:id", updateThing)
  r.DELETE("/things/:id", deleteThing)
  r.PATCH("/things/:id", patchThing)
}
`],
    ])
    const result = extract(files)
    expect(result.stats.handlersEmitted).toBe(5)
  })
})

describe('Go plugin — struct extraction', () => {
  it('extracts type X struct as a database node', () => {
    const files = new Map([
      ['models/user.go', `
package models

type User struct {
  ID   int
  Name string
}
`],
    ])
    const result = extract(files)
    expect(result.stats.structsEmitted).toBe(1)
    const node = result.schema!.nodes.find((n) => n.type === 'database')!
    expect(node.name).toBe('User')
    expect(node.id).toBe('codebase:go:struct:models.User')
    expect(node.origin).toBe('auto:codebase')
    expect(node.metadata?.backend).toBe('go')
  })

  it('extracts multiple structs from one file', () => {
    const files = new Map([
      ['models/domain.go', `
package models

type Order struct {
  ID     int
  Amount float64
}

type OrderItem struct {
  OrderID int
  Product string
}
`],
    ])
    const result = extract(files)
    expect(result.stats.structsEmitted).toBe(2)
    const names = result.schema!.nodes.filter((n) => n.type === 'database').map((n) => n.name).sort()
    expect(names).toEqual(['Order', 'OrderItem'])
  })

  it('ignores unexported struct names (lowercase)', () => {
    const files = new Map([
      ['internal/private.go', `
package internal

type internalThing struct {
  X int
}
`],
    ])
    const result = extract(files)
    // The regex requires uppercase first letter, so this should not match.
    expect(result.stats.structsEmitted).toBe(0)
  })
})

describe('Go plugin — file filtering', () => {
  it('skips _test.go files', () => {
    const files = new Map([
      ['handlers/admin.go', `
package handlers
func Setup(r *gin.Engine) { r.GET("/admin", listAdmin) }
`],
      ['handlers/admin_test.go', `
package handlers
func TestSetup(t *testing.T) { r.GET("/test", testHandler) }
`],
    ])
    const result = extract(files)
    expect(result.stats.handlersEmitted).toBe(1)
    expect(result.warnings.some((w) => w.kind === 'skipped_file' && w.path.includes('_test.go'))).toBe(true)
  })

  it('skips vendor/ directories', () => {
    const files = new Map([
      ['vendor/github.com/lib/router.go', `
package lib
func Setup(r *gin.Engine) { r.GET("/vendored", vendoredHandler) }
`],
      ['handlers/main.go', `
package handlers
func Setup(r *gin.Engine) { r.GET("/real", realHandler) }
`],
    ])
    const result = extract(files)
    expect(result.stats.handlersEmitted).toBe(1)
    const node = result.schema!.nodes.find((n) => n.type === 'api')!
    expect(node.name).toBe('GET /real')
  })

  it('skips generated files with "// Code generated" in first 5 lines', () => {
    const files = new Map([
      ['generated/proto.go', `// Code generated by protoc-gen-go. DO NOT EDIT.
package generated

type GeneratedStruct struct {
  ID int
}
`],
      ['models/real.go', `
package models

type RealStruct struct {
  ID int
}
`],
    ])
    const result = extract(files)
    expect(result.stats.structsEmitted).toBe(1)
    const node = result.schema!.nodes.find((n) => n.type === 'database')!
    expect(node.name).toBe('RealStruct')
    expect(result.warnings.some((w) => w.kind === 'skipped_file' && w.reason === 'generated file')).toBe(true)
  })
})

describe('Go plugin — determinism', () => {
  it('produces identical output on repeated runs', () => {
    const files = new Map([
      ['handlers/a.go', `
package handlers
func Setup(r *gin.Engine) {
  r.GET("/b", bHandler)
  r.POST("/a", aHandler)
}
`],
      ['models/z.go', `
package models
type Zebra struct { ID int }
type Alpha struct { ID int }
`],
    ])
    const result1 = extract(files)
    const result2 = extract(files)
    expect(result1.schema!.nodes).toEqual(result2.schema!.nodes)
    expect(result1.schema!.links).toEqual(result2.schema!.links)
    expect(result1.stats).toEqual(result2.stats)
  })
})
