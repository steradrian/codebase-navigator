// ─────────────────────────────────────────────────────────────────
// GRAPH SCHEMA — Edit this file to define your system's graph.
//
// This is the ONLY file you need to touch to map a different project.
// Everything else (rendering, physics, UI) adapts automatically.
//
// DATA SOURCE STRATEGY:
//   1. Auto-generate nodes/links from OpenAPI spec (endpoints → API nodes,
//      schemas → DB nodes, $ref → links)
//   2. Manually add: paths, business logic annotations, ownership, features
//   3. Eventually: parse FE routes + component imports for UI layer
//
// Authored in the legacy minimal shape for ergonomics (no id/origin
// boilerplate per entry), then lifted to v1.0 via migrate() on load.
// Every downstream consumer sees the full v1.0 shape from the default export.
// Types live in `@/types`.
// ─────────────────────────────────────────────────────────────────

import type { LegacySchema, Schema } from '@/types'
import { migrate } from '@/schema/migrate'

/**
 * Post-migration pass that wires `parent` / `children` based on a
 * caller-supplied mapping of group → parent-node-ID. Domain-level nodes
 * thus become structural parents of their group-mates, which unlocks
 * semantic zoom (GE-013) without complicating `migrate()` itself.
 *
 * Determinism: children arrays are sorted by node id so the output is
 * byte-stable across runs.
 */
function wireHierarchy(
  schema: Schema,
  parentByGroup: Record<string, string>,
): Schema {
  // Collect children per parent.
  const childIdsByParent = new Map<string, string[]>()
  for (const n of schema.nodes) {
    if (!n.group) continue
    const parentId = parentByGroup[n.group]
    if (!parentId || parentId === n.id) continue
    const arr = childIdsByParent.get(parentId) ?? []
    arr.push(n.id)
    childIdsByParent.set(parentId, arr)
  }

  // Produce new node array with parent / children populated.
  const nodes = schema.nodes.map((n) => {
    const parent =
      n.group && parentByGroup[n.group] && parentByGroup[n.group] !== n.id
        ? parentByGroup[n.group]
        : undefined
    const children = childIdsByParent.get(n.id)
    return {
      ...n,
      parent,
      children: children ? [...children].sort() : undefined,
    }
  })

  return { ...schema, nodes }
}

const DEMO = {
  meta: {
    name: "Project Architecture",
    version: "1.0",
  },

  // ─── NODE TYPES ─────────────────────────────────────────────
  // Define categories. Each node must have a type that matches one of these keys.
  nodeTypes: {
    domain:   { color: "#ff4081", label: "Domain",    glow: 0.15 },
    database: { color: "#00e5ff", label: "Database",  glow: 0.10 },
    service:  { color: "#ff6e40", label: "Service",   glow: 0.12 },
    feature:  { color: "#b388ff", label: "Feature",   glow: 0.10 },
    api:      { color: "#69f0ae", label: "API",       glow: 0.10 },
    ui:       { color: "#ffd740", label: "UI",        glow: 0.10 },
    external: { color: "#78909c", label: "External",  glow: 0.06 },
  },

  // ─── NODES ──────────────────────────────────────────────────
  nodes: [
    // ── Domains (top-level grouping) ──
    { id: "d_auth",      name: "Authentication",  type: "domain",   description: "Identity, access control, and session management domain.", group: "auth" },
    { id: "d_content",   name: "Content",         type: "domain",   description: "All content entities — items, reviews, media, and search.", group: "content" },
    { id: "d_platform",  name: "Platform",        type: "domain",   description: "Core platform services — analytics, notifications, AI.", group: "platform" },
    { id: "d_interface", name: "Interfaces",       type: "domain",   description: "All user-facing surfaces — admin, public app, onboarding.", group: "interface" },

    // ── Services ──
    { id: "auth",   name: "Auth Service",   type: "service",  description: "JWT tokens, OAuth flows, RBAC, session management. Middleware on every protected route.", group: "auth",     owner: "Backend Team" },
    { id: "search", name: "Search Engine",  type: "service",  description: "Full-text + filtered search. Elasticsearch under the hood, indexes items and reviews.",    group: "content",  owner: "Backend Team" },
    { id: "core",   name: "App Core",       type: "service",  description: "Central orchestrator — routes requests, applies business logic, coordinates services.",    group: "platform", owner: "Backend Team" },

    // ── Database ──
    { id: "db_users",    name: "users",    type: "database", description: "PK: id. Stores accounts, hashed passwords, roles, preferences. FK → none (root table).",           group: "auth",    owner: "Backend Team" },
    { id: "db_sessions", name: "sessions", type: "database", description: "Active sessions table. FK → users.id. Tracks device, IP, expiry.",                                 group: "auth",    owner: "Backend Team" },
    { id: "db_items",    name: "items",    type: "database", description: "Main entity table. PK: id. Name, description, location, category, status, owner_id FK → users.id.", group: "content", owner: "Backend Team" },
    { id: "db_reviews",  name: "reviews",  type: "database", description: "User reviews. FK → users.id, FK → items.id. Rating, text, created_at.",                            group: "content", owner: "Backend Team" },
    { id: "db_media",    name: "media",    type: "database", description: "Polymorphic media table. FK → items.id OR reviews.id. CDN URL, type, dimensions.",                 group: "content", owner: "Backend Team" },

    // ── Features ──
    { id: "ai_import",     name: "AI Import",      type: "feature", description: "AI-powered data ingestion. Parses menus/documents via LLM, outputs structured item data.", group: "platform", owner: "AI Team" },
    { id: "analytics",     name: "Analytics",       type: "feature", description: "Event tracking, funnels, retention. Feeds into dashboard charts.",                         group: "platform", owner: "Data Team" },
    { id: "notifications", name: "Notifications",   type: "feature", description: "Push, email, in-app alerts. Triggered by events: new review, import complete, etc.",       group: "platform", owner: "Backend Team" },

    // ── APIs ──
    { id: "api_rest",    name: "REST API", type: "api", description: "Public endpoints. GET/POST/PUT/DELETE for items, reviews, users. Rate limited, versioned.", group: "platform", owner: "Backend Team" },
    { id: "api_webhook", name: "Webhooks", type: "api", description: "Outbound event hooks. Fires on item.created, review.posted, import.complete.",             group: "platform", owner: "Backend Team" },

    // ── UI ──
    { id: "dashboard",  name: "Admin Dashboard", type: "ui", description: "Owner portal. Next.js + ShadCN. Manage items, view analytics, trigger imports.", group: "interface", owner: "Frontend Team" },
    { id: "public_app", name: "Public App",      type: "ui", description: "Consumer PWA. Browse, search, filter, review. Mobile-first responsive.",         group: "interface", owner: "Frontend Team" },
    { id: "onboarding", name: "Onboarding",      type: "ui", description: "Multi-step wizard. Account creation → profile setup → first item import → dashboard.", group: "interface", owner: "Frontend Team" },

    // ── External ──
    { id: "ext_cdn",   name: "CDN",            type: "external", description: "CloudFlare/S3 — serves media assets. Media table stores CDN URLs.",                        group: "content" },
    { id: "ext_email", name: "Email Provider",  type: "external", description: "Transactional email service (Resend/SendGrid). Notification service dispatches through here.", group: "platform" },
  ],

  // ─── LINKS ──────────────────────────────────────────────────
  // type: "data_flow" = data moves between nodes
  //       "dependency" = one node depends on / references another
  //       "triggers"   = one node causes an action in another
  links: [
    // Auth domain
    { source: "auth",        target: "db_users",    label: "validates against",   description: "Checks credentials, loads user roles and permissions.",                type: "data_flow" },
    { source: "auth",        target: "db_sessions", label: "creates/validates",   description: "Issues new sessions on login, validates on each request.",             type: "data_flow" },
    { source: "db_sessions", target: "db_users",    label: "FK → users.id",       description: "Each session belongs to exactly one user.",                            type: "dependency" },

    // Core
    { source: "core", target: "auth",     label: "authenticates via", description: "All protected routes pass through auth middleware first.",                  type: "dependency" },
    { source: "core", target: "db_items", label: "CRUD",             description: "Create, read, update, soft-delete items through business logic layer.",     type: "data_flow" },
    { source: "core", target: "db_users", label: "manages",          description: "User lifecycle — registration, profile updates, deactivation.",              type: "data_flow" },
    { source: "core", target: "api_rest", label: "exposes via",      description: "Core logic is accessible through versioned REST endpoints.",                type: "dependency" },

    // Content relationships
    { source: "db_reviews", target: "db_users",   label: "FK → users.id", description: "Each review has an author. Cascade: soft-delete reviews if user deactivates.", type: "dependency" },
    { source: "db_reviews", target: "db_items",   label: "FK → items.id", description: "Each review targets one item. Cascade: delete reviews if item is removed.",    type: "dependency" },
    { source: "db_media",   target: "db_items",   label: "FK → items.id", description: "Item photos/videos. Polymorphic: media_type + media_id.",                      type: "dependency" },
    { source: "db_media",   target: "db_reviews", label: "FK → reviews.id", description: "Review attachments. Optional — users can add photos to reviews.",            type: "dependency" },
    { source: "db_media",   target: "ext_cdn",    label: "stored on",     description: "Actual files live on CDN. DB stores URL, dimensions, mime type.",               type: "data_flow" },

    // Search
    { source: "search", target: "db_items",   label: "indexes", description: "Maintains full-text index. Re-indexes on item create/update.", type: "data_flow" },
    { source: "search", target: "db_reviews", label: "indexes", description: "Reviews searchable by text content and rating range.",          type: "data_flow" },

    // Features
    { source: "ai_import",     target: "db_items",    label: "creates items",  description: "Parsed data written as new item records. Validates before insert.",                  type: "data_flow" },
    { source: "ai_import",     target: "db_media",    label: "extracts media", description: "AI can pull images from documents and store as media records.",                       type: "data_flow" },
    { source: "analytics",     target: "core",        label: "hooks into",     description: "Event listeners on core actions — page views, searches, conversions.",                type: "triggers" },
    { source: "notifications", target: "db_users",    label: "targets",        description: "Reads user preferences to determine channel (push/email/in-app).",                   type: "data_flow" },
    { source: "notifications", target: "api_webhook", label: "fires",          description: "Certain events (review posted, import done) trigger outbound webhooks.",              type: "triggers" },
    { source: "notifications", target: "ext_email",   label: "sends via",      description: "Email notifications dispatched through transactional email provider.",                type: "data_flow" },

    // UI → API
    { source: "dashboard",  target: "api_rest",   label: "consumes",     description: "All dashboard data fetched through REST. Token in Authorization header.", type: "data_flow" },
    { source: "dashboard",  target: "analytics",  label: "renders",      description: "Dashboard displays analytics data as charts, tables, KPIs.",              type: "data_flow" },
    { source: "dashboard",  target: "ai_import",  label: "triggers",     description: "Owner clicks 'Import' → kicks off AI parsing pipeline.",                  type: "triggers" },
    { source: "public_app", target: "api_rest",   label: "consumes",     description: "Public app reads items, reviews. Writes reviews if authenticated.",       type: "data_flow" },
    { source: "public_app", target: "search",     label: "queries",      description: "Search bar hits search engine for instant filtered results.",             type: "data_flow" },
    { source: "onboarding", target: "auth",       label: "registers via", description: "Step 1: create owner account through auth service.",                     type: "triggers" },
    { source: "onboarding", target: "dashboard",  label: "redirects to", description: "Final step drops user into their new dashboard.",                         type: "triggers" },
    { source: "onboarding", target: "ai_import",  label: "offers",       description: "Step 3: optionally trigger first AI import during onboarding.",           type: "triggers" },
  ],

  // ─── GUIDED PATHS ──────────────────────────────────────────
  // These are the human-authored "stories" that walk someone through the system.
  // This is the semantic layer that can't be auto-generated from code.
  paths: [
    {
      id: "user_registration",
      name: "New Owner Registration",
      description: "Follow the journey of a new business owner signing up and setting up their account.",
      color: "#ff4081",
      steps: [
        { nodeId: "onboarding",   annotation: "Owner lands on the onboarding wizard. Multi-step form collects business info." },
        { nodeId: "auth",         annotation: "Account is created — email/password hashed, JWT issued, session started." },
        { nodeId: "db_users",     annotation: "New user record written. Role set to 'owner'. Preferences initialized with defaults." },
        { nodeId: "db_sessions",  annotation: "Active session created. Tracks device, IP, and token expiry." },
        { nodeId: "ai_import",    annotation: "Onboarding offers an optional first import — upload a menu or document." },
        { nodeId: "db_items",     annotation: "If import triggered, AI-parsed items are written to the items table." },
        { nodeId: "dashboard",    annotation: "Owner lands in their dashboard. First-time view shows setup progress." },
      ],
    },
    {
      id: "content_discovery",
      name: "Content Discovery Flow",
      description: "How an end user finds and interacts with content in the public app.",
      color: "#00e5ff",
      steps: [
        { nodeId: "public_app",    annotation: "User opens the public app. Homepage shows featured and nearby items." },
        { nodeId: "search",        annotation: "User types a query — search engine returns ranked, filtered results instantly." },
        { nodeId: "db_items",      annotation: "Search results pull from items table. Each result shows name, rating, photo." },
        { nodeId: "db_media",      annotation: "Item photos loaded from media table. CDN URLs resolve to optimized images." },
        { nodeId: "ext_cdn",       annotation: "Images served from edge CDN — fast load times regardless of user location." },
        { nodeId: "db_reviews",    annotation: "User taps an item → sees review feed. Sorted by recency and helpfulness." },
        { nodeId: "api_rest",      annotation: "User submits their own review via POST /reviews. Auth token required." },
        { nodeId: "notifications", annotation: "Item owner gets notified: 'New review on your listing!' via push + email." },
      ],
    },
    {
      id: "ai_pipeline",
      name: "AI Import Pipeline",
      description: "How AI-powered content import works from trigger to stored data.",
      color: "#b388ff",
      steps: [
        { nodeId: "dashboard",     annotation: "Owner clicks 'Import' and uploads a document (PDF menu, spreadsheet, etc.)." },
        { nodeId: "ai_import",     annotation: "AI service receives the document. LLM extracts structured data: names, prices, descriptions, categories." },
        { nodeId: "db_items",      annotation: "Parsed items validated against schema, then batch-inserted into items table." },
        { nodeId: "db_media",      annotation: "Any images found in the document are extracted, uploaded to CDN, and linked." },
        { nodeId: "ext_cdn",       annotation: "Extracted images uploaded to CDN. Thumbnails generated at multiple resolutions." },
        { nodeId: "search",        annotation: "Search index updated with new items. Available for discovery within seconds." },
        { nodeId: "notifications", annotation: "Owner receives confirmation: 'Import complete — 23 items added.' Links to review." },
        { nodeId: "api_webhook",   annotation: "If configured, webhook fires with import summary payload to external systems." },
      ],
    },
    {
      id: "review_lifecycle",
      name: "Review Lifecycle",
      description: "End-to-end flow of a review — from submission to visibility and notifications.",
      color: "#ffd740",
      steps: [
        { nodeId: "public_app",    annotation: "Authenticated user taps 'Write Review' on an item page." },
        { nodeId: "api_rest",      annotation: "POST /reviews with rating, text, optional photos. Validated server-side." },
        { nodeId: "core",          annotation: "Business logic checks: user hasn't already reviewed this item, content moderation passes." },
        { nodeId: "db_reviews",    annotation: "Review record created. FK links to user and item. Timestamps set." },
        { nodeId: "db_media",      annotation: "If photos attached, media records created and linked to review." },
        { nodeId: "analytics",     annotation: "Event tracked: review.created. Feeds into conversion funnels and engagement metrics." },
        { nodeId: "notifications", annotation: "Item owner notified. If webhook configured, external systems notified too." },
        { nodeId: "search",        annotation: "Search index updated — review text now searchable, item rating recalculated." },
      ],
    },
  ],
} satisfies LegacySchema

// Demo-specific mapping: each semantic group is anchored to its domain
// node. Projects that import their schema from OpenAPI or hand-edit
// this file will need their own mapping — or none, if they don't want
// hierarchy.
const DEMO_PARENT_BY_GROUP: Record<string, string> = {
  auth: 'd_auth',
  content: 'd_content',
  platform: 'd_platform',
  interface: 'd_interface',
}

const SCHEMA = wireHierarchy(migrate(DEMO), DEMO_PARENT_BY_GROUP)

export default SCHEMA
