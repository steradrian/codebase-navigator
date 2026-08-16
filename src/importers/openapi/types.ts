// ─────────────────────────────────────────────────────────────────
// OpenAPI importer — internal input shapes + public result shape.
//
// The input types describe only the parts of OpenAPI v3 the importer
// actually reads. They are permissive (any unknown structural fields
// are simply ignored) and make the parser robust to real-world specs
// that omit optional OpenAPI fields.
// ─────────────────────────────────────────────────────────────────

import type { Schema } from '@/types'

// ─── minimal OpenAPI v3 input shapes ─────────────────────────

export type OpenAPIRef = { $ref: string }

export type OpenAPISchemaObject = {
  description?: string
  type?: string
  enum?: unknown[]
  properties?: Record<string, OpenAPISchemaOrRef>
  items?: OpenAPISchemaOrRef
  oneOf?: OpenAPISchemaOrRef[]
  anyOf?: OpenAPISchemaOrRef[]
  allOf?: OpenAPISchemaOrRef[]
}

export type OpenAPISchemaOrRef = OpenAPISchemaObject | OpenAPIRef

export type OpenAPIMediaType = {
  schema?: OpenAPISchemaOrRef
}

export type OpenAPIRequestBody = {
  content?: Record<string, OpenAPIMediaType>
}

export type OpenAPIResponse = {
  /** The API author's own wording for this response. */
  description?: string
  content?: Record<string, OpenAPIMediaType>
}

export type OpenAPIOperation = {
  summary?: string
  description?: string
  tags?: string[]
  operationId?: string
  requestBody?: OpenAPIRequestBody | OpenAPIRef
  responses?: Record<string, OpenAPIResponse | OpenAPIRef>
}

export type OpenAPIPathItem = Partial<Record<
  'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace',
  OpenAPIOperation
>>

export type OpenAPITag = {
  name: string
  description?: string
}

export type OpenAPISpec = {
  openapi: string
  info?: { title?: string; version?: string }
  tags?: OpenAPITag[]
  paths?: Record<string, OpenAPIPathItem>
  components?: {
    schemas?: Record<string, OpenAPISchemaObject>
  }
}

// ─── parser result ───────────────────────────────────────────

export type ParseError =
  | { kind: 'not_an_object' }
  | { kind: 'missing_openapi_version' }
  | { kind: 'unsupported_openapi_version'; version: string }

export type ParseWarning =
  | { kind: 'external_ref_skipped'; from: string; ref: string }
  | { kind: 'unresolved_local_ref'; from: string; ref: string }
  | { kind: 'inline_body_schema_ignored'; operationId: string }

export type ParseResult = {
  ok: boolean
  schema: Schema | null
  errors: ParseError[]
  warnings: ParseWarning[]
}
