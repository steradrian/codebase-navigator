import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { parseOpenAPI } from '@/importers/openapi'
import { validate } from '@/schema/validate'

describe('parseOpenAPI — YAML input via js-yaml', () => {
  it('parses a YAML OpenAPI spec after yaml.load()', () => {
    const y = `
openapi: 3.0.3
info: { title: Test API, version: '1.0' }
paths:
  /customers:
    get:
      tags: [Customer]
      summary: List customers
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/Customer'
components:
  schemas:
    Customer:
      type: object
      properties:
        id: { type: string }
        tags:
          type: array
          items:
            $ref: '#/components/schemas/Tag'
    Tag:
      type: object
      properties:
        slug: { type: string }
`
    const spec = yaml.load(y)
    const result = parseOpenAPI(spec)
    expect(result.ok).toBe(true)
    expect(result.schema).not.toBeNull()

    const nodeNames = result.schema!.nodes.map((n) => n.name).sort()
    // Customer (used at top level in /customers response) + GET /customers.
    // Tag is only referenced from Customer.tags so GE-115 classifies it
    // as a value object and filters it out.
    expect(nodeNames).toEqual(['Customer', 'GET /customers'])

    // Validator-clean
    expect(validate(result.schema!).ok).toBe(true)
  })

  it('skips external $refs with a warning (simulating real-world specs)', () => {
    const y = `
openapi: 3.0.3
info: { title: External refs test, version: '1.0' }
paths: {}
components:
  schemas:
    Customer:
      type: object
      properties:
        page_info:
          $ref: 'https://some.other.host/openapi.yaml#/components/schemas/PageInfo'
`
    const spec = yaml.load(y)
    const result = parseOpenAPI(spec)
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.kind === 'external_ref_skipped')).toBe(true)
  })
})
