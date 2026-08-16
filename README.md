# Graph Explorer

Interactive 3D force-directed graph visualization for mapping system architecture, database relationships, user journeys, and organizational knowledge.

## Quick Start

```bash
# 1. Start the database (Docker required)
pnpm db:up

# 2. Apply migrations (first run only; re-run after pulling schema changes)
pnpm db:migrate

# 3. Start the app (API + frontend together via Vite middleware)
pnpm dev
```

Open `http://localhost:5173`. Your work auto-saves to local Postgres; refreshes preserve state.

### Database commands

| Command | What it does |
|---|---|
| `pnpm db:up` | Start Postgres in Docker (port 5433 on host) |
| `pnpm db:down` | Stop the container |
| `pnpm db:reset` | **Destroy** the volume and start fresh |
| `pnpm db:generate` | Generate a new migration after editing `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Open Drizzle Studio (visual DB browser) |

### Offline mode

If Docker isn't running, the app still boots with an in-memory demo schema. The top bar shows an "Offline" indicator and changes won't persist.

## Project Structure

```
src/
├── main.jsx            # Entry point
├── schema.js           # ⭐ YOUR DATA — edit this file to map your system
├── ForceSim3D.js       # Physics engine (force-directed layout)
└── GraphExplorer.jsx   # Main React component (3D rendering + UI)
```

## How to Use

### 1. Define Your Schema (`src/schema.js`)

This is the only file you need to edit. The schema has 4 sections:

- **`nodeTypes`** — Categories with colors (e.g., database, service, feature)
- **`nodes`** — Individual system components
- **`links`** — Relationships between nodes
- **`paths`** — Guided walkthroughs (user journeys, data flows)

### 2. Interact

- **Drag** to orbit the camera
- **Scroll** to zoom in/out
- **Click** a node to highlight its connections
- **Press `/`** to search nodes
- **Click path buttons** at the top to trace guided journeys
- **Arrow keys** to step through paths

## Schema Reference

```js
{
  nodeTypes: {
    [key: string]: {
      color: string,    // Hex color
      label: string,    // Display name
      glow?: number,    // Glow intensity 0-1
    }
  },
  nodes: [{
    id: string,          // Unique ID
    name: string,        // Display name
    type: string,        // Must match a nodeTypes key
    description: string, // Detailed description
    group?: string,      // Clustering group
    owner?: string,      // Team/person responsible
  }],
  links: [{
    source: string,      // Source node ID
    target: string,      // Target node ID
    label: string,       // Short relationship label
    description: string, // Detailed explanation
    type?: string,       // "data_flow" | "dependency" | "triggers"
  }],
  paths: [{
    id: string,
    name: string,
    description: string,
    color: string,       // Hex color for path highlighting
    steps: [{
      nodeId: string,    // Which node this step focuses on
      annotation: string // What happens at this step
    }]
  }]
}
```

## Roadmap

- [ ] OpenAPI schema auto-import
- [ ] 2D toggle view
- [ ] Semantic zoom (domain → service → component)
- [ ] Impact analysis (blast radius highlighting)
- [ ] AI-generated node descriptions
- [ ] Shareable deep links
- [ ] Diff view (what changed since last version)

## Tech Stack

- React 18 + TypeScript
- Three.js (3D rendering)
- Vite (build tool)
- Vitest (unit tests)
- Custom force-directed physics engine

## Tests

Vitest runs pure-logic tests that live next to their source (`*.test.ts`).

```bash
npm test          # single run
npm run test:watch  # watch mode
```

Reserved for pure modules (parsers, validators, simulation math). UI / Three.js renderer are not covered — add E2E post-MVP if needed.
