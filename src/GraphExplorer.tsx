import { useState, useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import INITIAL_SCHEMA from '@/schema'
import { ForceSim3D, type SimulatedNode } from '@/ForceSim3D'
import type { GuidedPath, Node, PathCategory, PathStep, Schema } from '@/types'
import { ImportDialog } from '@/components/ImportDialog'
import { EditorPanel } from '@/components/EditorPanel'
import { downloadSchema, readSchemaFromFile } from '@/schema/io'
import { computeBlastRadius, severityColor, type BlastImpact, type Direction as BlastDirection } from '@/schema/impact'
import type { SchemaDiff } from '@/schema/diff'
import { DiffDialog } from '@/components/DiffDialog'
import { getStoredApiKey, setStoredApiKey, suggestDescription } from '@/ai/describe'
import { runQuery, type QueryAction } from '@/ai/query'
import { copyCurrentUrl, decodeViewState, replaceUrlWith, type ViewState } from '@/urlState'
import { apiReachable, createGraph, deleteGraph, getGraph, listGraphs, updateGraph, type GraphSummary } from '@/api/client'
import { ProjectPicker } from '@/components/ProjectPicker'
import { AnnotationsPanel } from '@/components/AnnotationsPanel'
import { EntityReviewDialog } from '@/components/EntityReviewDialog'
import { NavHistoryOverlay } from '@/components/NavHistoryOverlay'
import { HelpPanel } from '@/components/HelpPanel'
import { Tooltip, TooltipLines } from '@/components/Tooltip'
import { FilterRail } from '@/components/FilterRail'
import { entityCounts } from '@/schema/entity/extractor'
import { peerEntityChips, globalEntitySubgraph } from '@/schema/entity/lens'
import { propagateEntities } from '@/schema/entity/propagate'
import { upgradeLoadedSchema } from '@/schema/migrate'
import { CodebaseImportDialog } from '@/components/CodebaseImportDialog'
import { LinkImportsDialog } from '@/components/LinkImportsDialog'

// ─── CONSTANTS ─────────────────────────────────────────────────
const LINK_TYPE_COLORS: Record<string, number> = {
  data_flow: 0x1a4a6c,
  dependency: 0x3a2a5c,
  triggers: 0x4a3a1c,
}
const LINK_TYPE_LABELS: Record<string, string> = {
  data_flow: 'Data Flow',
  dependency: 'Dependency',
  triggers: 'Triggers',
}
const BG_COLOR = 0x05050d

// Deterministic group color palette — hashed by group name.
const GROUP_PALETTE = ['#ff4081', '#00e5ff', '#ff6e40', '#b388ff', '#69f0ae', '#ffd740', '#8c9eff', '#ff5252']
const groupColor = (name: string): string => {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return GROUP_PALETTE[Math.abs(hash) % GROUP_PALETTE.length]
}

// ─── TOP BAR SHARED STYLE ─────────────────────────────────────
const topBarBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  padding: '7px 14px',
  cursor: 'pointer',
  fontSize: 12,
  color: '#ccc',
  fontWeight: 600,
}

const blastBtnStyle: React.CSSProperties = {
  flex: 1,
  background: 'rgba(255,64,64,0.08)',
  border: '1px solid rgba(255,64,64,0.25)',
  color: '#ff8080',
  borderRadius: 6,
  padding: '7px 10px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}

const blastDirBtnStyle: React.CSSProperties = {
  flex: 1,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: '#999',
  borderRadius: 5,
  padding: '5px 8px',
  fontSize: 10,
  fontWeight: 600,
  cursor: 'pointer',
}

const blastDirBtnActiveStyle: React.CSSProperties = {
  background: 'rgba(255,64,64,0.12)',
  border: '1px solid rgba(255,64,64,0.3)',
  color: '#ff8080',
}

const primaryBtnStyle: React.CSSProperties = {
  background: '#69f0ae22', border: '1px solid #69f0ae55', color: '#69f0ae',
  padding: '7px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
}

const secondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#ccc', padding: '7px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
}

const reorderBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: 'none', color: '#888',
  width: 22, height: 22, borderRadius: 4, cursor: 'pointer', fontSize: 11,
}

const infoBoxStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6, padding: 10, fontSize: 11, marginBottom: 12,
}

const errorBoxInlineStyle: React.CSSProperties = {
  background: 'rgba(255,110,64,0.08)', border: '1px solid rgba(255,110,64,0.25)',
  color: '#ffa080', padding: 10, borderRadius: 6, fontSize: 11, marginBottom: 12,
}

const queryPanelStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', right: 0, marginTop: 6,
  width: 380, background: 'rgba(10,10,25,0.98)',
  border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
  backdropFilter: 'blur(16px)', overflow: 'hidden', zIndex: 50,
}
const queryInputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 4, color: '#ddd', fontSize: 12, padding: 8,
  resize: 'vertical', height: 56, fontFamily: 'inherit', outline: 'none',
}
const queryPrimaryBtnStyle: React.CSSProperties = {
  background: 'rgba(179,136,255,0.15)', border: '1px solid rgba(179,136,255,0.4)',
  color: '#b388ff', padding: '5px 14px', borderRadius: 4, cursor: 'pointer',
  fontSize: 11, fontWeight: 600,
}
const querySecondaryBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
  color: '#999', padding: '5px 10px', borderRadius: 4, cursor: 'pointer',
  fontSize: 11, fontWeight: 600,
}

// ─── TYPES ─────────────────────────────────────────────────────
type Connection = {
  node: SimulatedNode
  label: string
  description: string
  direction: 'in' | 'out'
  type?: string
}

type CameraState = {
  theta: number
  phi: number
  r: number
  targetX: number
  targetY: number
  targetZ: number
  autoRotate: boolean
}

type MouseState = {
  x: number
  y: number
  down: boolean
  prevX: number
  prevY: number
  moved: boolean
}

type PathHighlight = {
  nodeIds: Set<string>
  linkKeys: Set<string>
  color?: string
}

type PanelTab = 'info' | 'path'

// GE-015 — authoring draft shape. Mirrors GuidedPath plus an
// `isNew` discriminant for save UX.
type DraftPath = {
  id: string
  name: string
  description: string
  color: string
  category: PathCategory
  steps: PathStep[]
  isNew: boolean
}

const PATH_COLORS = ['#ff4081', '#00e5ff', '#b388ff', '#ffd740', '#69f0ae', '#ff6e40'] as const
const PATH_CATEGORIES: PathCategory[] = ['user_journey', 'data_flow', 'incident', 'onboarding', 'other']

// ─── COMPONENT ─────────────────────────────────────────────────
export default function GraphExplorer() {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const simRef = useRef<ForceSim3D | null>(null)
  const cameraState = useRef<CameraState>({
    theta: 0, phi: Math.PI / 2.5, r: 220,
    targetX: 0, targetY: 0, targetZ: 0,
    autoRotate: true,
  })
  const mouseRef = useRef<MouseState>({ x: 0, y: 0, down: false, prevX: 0, prevY: 0, moved: false })
  const selectedRef = useRef<string | null>(null)
  const connectedRef = useRef<Set<string>>(new Set())
  const pathHighlightRef = useRef<PathHighlight>({ nodeIds: new Set(), linkKeys: new Set() })
  const showHullsRef = useRef<boolean>(true)
  // Cluster pins — parent IDs the user has explicitly opened. When pinned,
  // the cluster ignores camera-distance collapse logic.
  const pinsOpenRef = useRef<Set<string>>(new Set())
  // Blast radius (GE-014) — map of nodeId → impact when active, null otherwise.
  const blastImpactsRef = useRef<Map<string, BlastImpact> | null>(null)
  // Navigation history (GE-101) — stack of node IDs + current index.
  // `historyVersion` is a React-state counter used to trigger re-renders
  // of the overlay; the actual stack lives in the ref so we don't pay
  // a re-render tax on every selection.
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  // Hover tooltip (GE-102).
  const hoverTooltipRef = useRef<HTMLDivElement | null>(null)
  // Path authoring (GE-015) — ref mirrors boolean for click-handler fast path.
  const authoringRef = useRef<boolean>(false)
  // Diff overlay (GE-016) — per-id change kind lookup.
  const diffOverlayRef = useRef<{
    nodeKinds: Map<string, 'added' | 'modified'>
    linkKinds: Map<string, 'added' | 'modified'>
  } | null>(null)
  // Query highlight (GE-029) — set of node IDs that satisfy a NL query.
  const queryHighlightRef = useRef<Set<string> | null>(null)

  // URL state restoration (GE-022) — read once on mount so initial
  // React state reflects shared-link parameters.
  const [initialUrlState] = useState(() =>
    typeof window !== 'undefined' ? decodeViewState(window.location.search) : null,
  )
  const [schema, setSchema] = useState<Schema>(INITIAL_SCHEMA)
  const [selected, setSelected] = useState<SimulatedNode | null>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [activePath, setActivePath] = useState<GuidedPath | null>(null)
  const [pathStep, setPathStep] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Node[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showCodebaseImport, setShowCodebaseImport] = useState(false)
  const [showLinkImports, setShowLinkImports] = useState(false)
  const [showEntityReview, setShowEntityReview] = useState(false)
  const [entityBannerDismissed, setEntityBannerDismissed] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [showHulls, setShowHulls] = useState<boolean>(initialUrlState?.showHulls ?? true)
  const [is2D, setIs2D] = useState<boolean>(initialUrlState?.is2D ?? false)
  const [colorMode, setColorMode] = useState<'type' | 'entity'>('type')
  const colorModeRef = useRef<'type' | 'entity'>('type')
  // Filters (GE-104). Empty set means "all allowed" for that facet.
  // Stored as Sets in refs for animation-loop reads, mirrored to
  // arrays in state for UI. The refs are the truth.
  const filterTypesRef = useRef<Set<string>>(new Set())
  const filterDomainsRef = useRef<Set<string>>(new Set())
  const filterEntitiesRef = useRef<Set<string>>(new Set())
  const filterOriginsRef = useRef<Set<string>>(new Set())
  const [filterTypes, setFilterTypes] = useState<string[]>([])
  const [filterDomains, setFilterDomains] = useState<string[]>([])
  const [filterEntities, setFilterEntities] = useState<string[]>([])
  const [filterOrigins, setFilterOrigins] = useState<string[]>([])
  const [filterRailOpen, setFilterRailOpen] = useState(false)
  // GE-113 entity lens. When active, dims everything outside the
  // lens subgraph (a BFS from the selected node through nodes
  // matching the lens entity). Ref for animation-loop reads.
  const [entityLens, setEntityLens] = useState<string | null>(null)
  const entityLensRef = useRef<Set<string> | null>(null)
  const [blastImpacts, setBlastImpacts] = useState<BlastImpact[] | null>(null)
  const [blastDirection, setBlastDirection] = useState<BlastDirection>('downstream')
  const [blastStartId, setBlastStartId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftPath | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [diffActive, setDiffActive] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [queryText, setQueryText] = useState('')
  const [queryOpen, setQueryOpen] = useState(false)
  const [queryBusy, setQueryBusy] = useState(false)
  const [queryResult, setQueryResult] = useState<QueryAction | null>(null)
  const [queryHighlightCount, setQueryHighlightCount] = useState(0) // mirror for React re-render
  const [projects, setProjects] = useState<GraphSummary[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const loadInputRef = useRef<HTMLInputElement | null>(null)
  // Throttles to coordinate schema persistence without fighting the debounced save.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressSaveRef = useRef(false) // set true while loading a project so effect doesn't save it back
  const is2DRef = useRef(false)

  // Keep the ref in sync for the animation loop.
  useEffect(() => { showHullsRef.current = showHulls }, [showHulls])
  useEffect(() => { colorModeRef.current = colorMode }, [colorMode])
  useEffect(() => { filterTypesRef.current = new Set(filterTypes) }, [filterTypes])
  useEffect(() => { filterDomainsRef.current = new Set(filterDomains) }, [filterDomains])
  useEffect(() => { filterEntitiesRef.current = new Set(filterEntities) }, [filterEntities])
  useEffect(() => { filterOriginsRef.current = new Set(filterOrigins) }, [filterOrigins])

  // GE-113: compute global entity subgraph when lens entity changes.
  // The subgraph is the FULL set of nodes tagged with this entity
  // (plus their immediate neighbors for boundary context). It stays
  // stable as the user clicks through nodes — no re-anchoring.
  useEffect(() => {
    if (!entityLens) {
      entityLensRef.current = null
      return
    }
    const sub = globalEntitySubgraph(schema, entityLens)
    entityLensRef.current = sub
  }, [entityLens, schema])

  // 2D mode: push into the simulation and flag the camera.
  useEffect(() => {
    is2DRef.current = is2D
    const sim = simRef.current
    if (sim) sim.setMode2D(is2D)
    if (is2D) {
      // snap camera to near top-down, kill autorotate
      cameraState.current.phi = 0.12
      cameraState.current.autoRotate = false
    }
  }, [is2D])
  const [, setPanelTab] = useState<PanelTab>('info')

  // Inline helpers — close over the current working schema.
  const typeColor = (t?: string): string => (t && schema.nodeTypes[t]?.color) || '#888'
  const typeLabel = (t?: string): string => (t && schema.nodeTypes[t]?.label) || t || ''

  // ─── ACTIONS ─────────────────────────────────────────────────
  const getConnectionDetails = useCallback((nodeId: string): Connection[] => {
    const sim = simRef.current
    if (!sim) return []
    const result: Connection[] = []
    for (const l of sim.links) {
      if (l.source !== nodeId && l.target !== nodeId) continue
      const otherId = l.source === nodeId ? l.target : l.source
      const other = sim.nodes.find((n) => n.id === otherId)
      if (!other) continue
      result.push({
        node: other,
        label: l.label,
        description: l.description,
        direction: l.source === nodeId ? 'out' : 'in',
        type: l.type,
      })
    }
    return result
  }, [])

  // ─── NAVIGATION HISTORY (GE-101) ─────────────────────────────
  /**
   * Commit a selection + optionally record it in the navigation
   * history. Every user-initiated selection should go through this
   * via `selectNode`. Internal programmatic selections (path step,
   * URL restoration, path auto-expand) use `selectNodeSilent` to
   * avoid polluting the history stack.
   */
  const applySelection = useCallback((nodeId: string): boolean => {
    const sim = simRef.current
    if (!sim) return false
    const node = sim.getNode(nodeId)
    if (!node) return false
    const conns = getConnectionDetails(nodeId)
    const ids = sim.getConnectedIds(nodeId)
    selectedRef.current = nodeId
    connectedRef.current = ids
    setSelected(node)
    setConnections(conns)
    setPanelTab('info')
    cameraState.current.targetX = node.x
    cameraState.current.targetY = node.y
    cameraState.current.targetZ = node.z
    cameraState.current.autoRotate = false
    return true
  }, [getConnectionDetails])

  const pushHistory = useCallback((nodeId: string) => {
    const history = historyRef.current
    const idx = historyIndexRef.current
    // Collapse consecutive duplicates — repeated selection of the
    // same node shouldn't inflate the stack.
    if (history[idx] === nodeId) return
    // Discard any forward-history beyond the current index (browser
    // semantics — navigating anew after "back" drops the forward stack).
    history.splice(idx + 1)
    history.push(nodeId)
    historyIndexRef.current = history.length - 1
    setHistoryVersion((v) => v + 1)
  }, [])

  const selectNode = useCallback((nodeId: string) => {
    if (applySelection(nodeId)) pushHistory(nodeId)
  }, [applySelection, pushHistory])

  /** Silent variant — updates selection state without touching history.
   *  Used by path mode, URL restoration, and other programmatic
   *  selections the user didn't explicitly trigger. */
  const selectNodeSilent = useCallback((nodeId: string) => {
    applySelection(nodeId)
  }, [applySelection])

  const navigateBack = useCallback(() => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current--
    const nodeId = historyRef.current[historyIndexRef.current]
    applySelection(nodeId)
    setHistoryVersion((v) => v + 1)
  }, [applySelection])

  const navigateForward = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    historyIndexRef.current++
    const nodeId = historyRef.current[historyIndexRef.current]
    applySelection(nodeId)
    setHistoryVersion((v) => v + 1)
  }, [applySelection])

  const navigateToHistoryIndex = useCallback((target: number) => {
    const history = historyRef.current
    if (target < 0 || target >= history.length) return
    historyIndexRef.current = target
    applySelection(history[target])
    setHistoryVersion((v) => v + 1)
  }, [applySelection])

  const resetHistory = useCallback(() => {
    historyRef.current = []
    historyIndexRef.current = -1
    setHistoryVersion((v) => v + 1)
  }, [])

  const clearSelection = useCallback(() => {
    selectedRef.current = null
    connectedRef.current = new Set()
    setSelected(null)
    setConnections([])
    // Only clear lens on full deselection (clicking empty space).
    // Navigating between nodes within the flow keeps the lens active.
    setEntityLens(null)
    entityLensRef.current = null
    cameraState.current.targetX = 0
    cameraState.current.targetY = 0
    cameraState.current.targetZ = 0
  }, [])

  const startPath = useCallback((pathId: string) => {
    const path = schema.paths.find((p) => p.id === pathId)
    if (!path) return
    setActivePath(path)
    setPathStep(0)
    setPanelTab('path')

    const nodeIds = new Set<string>(path.steps.map((s) => s.nodeId))
    const linkKeys = new Set<string>()
    for (let i = 0; i < path.steps.length - 1; i++) {
      const a = path.steps[i].nodeId
      const b = path.steps[i + 1].nodeId
      linkKeys.add(`${a}->${b}`)
      linkKeys.add(`${b}->${a}`)
    }
    pathHighlightRef.current = { nodeIds, linkKeys, color: path.color }

    const sim = simRef.current
    const firstNode = sim?.getNode(path.steps[0].nodeId)
    if (firstNode) {
      selectedRef.current = path.steps[0].nodeId
      connectedRef.current = nodeIds
      cameraState.current.targetX = firstNode.x
      cameraState.current.targetY = firstNode.y
      cameraState.current.targetZ = firstNode.z
      cameraState.current.autoRotate = false
      setSelected(firstNode)
    }
  }, [schema])

  const goToPathStep = useCallback((step: number) => {
    if (!activePath || step < 0 || step >= activePath.steps.length) return
    setPathStep(step)
    const sim = simRef.current
    const node = sim?.getNode(activePath.steps[step].nodeId)
    if (node) {
      selectedRef.current = node.id
      cameraState.current.targetX = node.x
      cameraState.current.targetY = node.y
      cameraState.current.targetZ = node.z
      setSelected(node)
    }
  }, [activePath])

  const exitPath = useCallback(() => {
    setActivePath(null)
    setPathStep(0)
    pathHighlightRef.current = { nodeIds: new Set(), linkKeys: new Set() }
    clearSelection()
  }, [clearSelection])

  // ─── BLAST RADIUS (GE-014) ───────────────────────────────────
  const startBlast = useCallback((nodeId: string, direction: BlastDirection = 'downstream') => {
    const impacts = computeBlastRadius(schema, nodeId, direction)
    blastImpactsRef.current = new Map(impacts.map((i) => [i.nodeId, i]))
    setBlastImpacts(impacts)
    setBlastDirection(direction)
    setBlastStartId(nodeId)
    const node = simRef.current?.getNode(nodeId)
    if (node) {
      selectedRef.current = nodeId
      cameraState.current.targetX = node.x
      cameraState.current.targetY = node.y
      cameraState.current.targetZ = node.z
      cameraState.current.autoRotate = false
      setSelected(node)
    }
  }, [schema])

  const exitBlast = useCallback(() => {
    blastImpactsRef.current = null
    setBlastImpacts(null)
    setBlastStartId(null)
  }, [])

  const jumpToImpact = useCallback((nodeId: string) => {
    const node = simRef.current?.getNode(nodeId)
    if (!node) return
    selectedRef.current = nodeId
    cameraState.current.targetX = node.x
    cameraState.current.targetY = node.y
    cameraState.current.targetZ = node.z
    setSelected(node)
    // Jumping inside blast mode is still a user-initiated selection —
    // feed it into the nav history (GE-101).
    pushHistory(nodeId)
  }, [pushHistory])

  // ─── PATH AUTHORING (GE-015) ────────────────────────────────
  const startNewPath = useCallback(() => {
    if (draft && draft.steps.length > 0) {
      if (!confirm('Discard your unsaved path draft?')) return
    }
    if (activePath) setActivePath(null)
    setDraft({
      id: `path_${Date.now().toString(36)}`,
      name: '',
      description: '',
      color: PATH_COLORS[0],
      category: 'user_journey',
      steps: [],
      isNew: true,
    })
  }, [draft, activePath])

  const editExistingPath = useCallback((path: GuidedPath) => {
    if (draft && draft.steps.length > 0) {
      if (!confirm('Discard your unsaved path draft?')) return
    }
    if (activePath) setActivePath(null)
    setDraft({
      id: path.id,
      name: path.name,
      description: path.description,
      color: path.color,
      category: path.category ?? 'other',
      steps: path.steps.map((s) => ({ ...s })),
      isNew: false,
    })
  }, [draft, activePath])

  const cancelAuthoring = useCallback(() => {
    if (draft && draft.steps.length > 0) {
      if (!confirm('Discard your unsaved path draft?')) return
    }
    setDraft(null)
  }, [draft])

  const saveDraft = useCallback(() => {
    if (!draft) return
    if (!draft.name.trim()) { alert('Path name is required.'); return }
    if (draft.steps.length === 0) { alert('Path must contain at least one step.'); return }
    const finalPath: GuidedPath = {
      id: draft.id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      color: draft.color,
      category: draft.category,
      steps: draft.steps,
    }
    setSchema((prev) => {
      const idx = prev.paths.findIndex((p) => p.id === draft.id)
      const nextPaths = idx >= 0
        ? prev.paths.map((p, i) => (i === idx ? finalPath : p))
        : [...prev.paths, finalPath]
      return { ...prev, paths: nextPaths }
    })
    setDraft(null)
  }, [draft])

  const deleteDraftOrExistingPath = useCallback(() => {
    if (!draft) return
    if (!confirm(`Delete path "${draft.name || draft.id}"?`)) return
    setSchema((prev) => ({ ...prev, paths: prev.paths.filter((p) => p.id !== draft.id) }))
    setDraft(null)
  }, [draft])

  const appendStep = useCallback((nodeId: string) => {
    setDraft((prev) => prev ? { ...prev, steps: [...prev.steps, { nodeId, annotation: '' }] } : prev)
  }, [])

  const removeStep = useCallback((index: number) => {
    setDraft((prev) => prev ? { ...prev, steps: prev.steps.filter((_, i) => i !== index) } : prev)
  }, [])

  const moveStep = useCallback((index: number, delta: -1 | 1) => {
    setDraft((prev) => {
      if (!prev) return prev
      const target = index + delta
      if (target < 0 || target >= prev.steps.length) return prev
      const steps = [...prev.steps]
      const [moved] = steps.splice(index, 1)
      steps.splice(target, 0, moved)
      return { ...prev, steps }
    })
  }, [])

  const updateStepAnnotation = useCallback((index: number, annotation: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const steps = prev.steps.map((s, i) => (i === index ? { ...s, annotation } : s))
      return { ...prev, steps }
    })
  }, [])

  const updateDraftMeta = useCallback((patch: Partial<DraftPath>) => {
    setDraft((prev) => prev ? { ...prev, ...patch } : prev)
  }, [])

  // Sync authoring state to ref (read by click handler inside the useEffect scope).
  useEffect(() => { authoringRef.current = draft !== null }, [draft])

  // Drive the path-highlight visual while authoring. Mirrors startPath logic.
  useEffect(() => {
    if (!draft) return
    const nodeIds = new Set<string>(draft.steps.map((s) => s.nodeId))
    const linkKeys = new Set<string>()
    for (let i = 0; i < draft.steps.length - 1; i++) {
      const a = draft.steps[i].nodeId
      const b = draft.steps[i + 1].nodeId
      linkKeys.add(`${a}->${b}`)
      linkKeys.add(`${b}->${a}`)
    }
    pathHighlightRef.current = { nodeIds, linkKeys, color: draft.color }
  }, [draft])

  // When draft closes AND no active path, clear highlight.
  useEffect(() => {
    if (!draft && !activePath) {
      pathHighlightRef.current = { nodeIds: new Set(), linkKeys: new Set() }
    }
  }, [draft, activePath])

  // ─── DIFF OVERLAY (GE-016) ───────────────────────────────────
  const applyDiffOverlay = useCallback((diff: SchemaDiff) => {
    const nodeKinds = new Map<string, 'added' | 'modified'>()
    const linkKinds = new Map<string, 'added' | 'modified'>()
    for (const n of diff.nodes.added) nodeKinds.set(n.id, 'added')
    for (const m of diff.nodes.modified) nodeKinds.set(m.after.id, 'modified')
    for (const l of diff.links.added) linkKinds.set(l.id, 'added')
    for (const m of diff.links.modified) linkKinds.set(m.after.id, 'modified')
    diffOverlayRef.current = { nodeKinds, linkKinds }
    setDiffActive(true)
    setShowDiff(false)
    // Diff is a whole-graph annotation; other modes would fight for colors.
    clearSelection()
    if (activePath) exitPath()
    if (blastImpactsRef.current) exitBlast()
  }, [activePath, clearSelection, exitPath, exitBlast])

  const exitDiffOverlay = useCallback(() => {
    diffOverlayRef.current = null
    setDiffActive(false)
  }, [])

  // ─── NATURAL LANGUAGE QUERY (GE-029) ─────────────────────────
  const exitQueryHighlight = useCallback(() => {
    queryHighlightRef.current = null
    setQueryHighlightCount(0)
    setQueryResult(null)
  }, [])

  const runAiQuery = useCallback(async () => {
    const text = queryText.trim()
    if (!text) return
    let apiKey = getStoredApiKey()
    if (!apiKey) {
      const entered = window.prompt('Anthropic API key (stored in this browser only):')
      if (!entered) return
      setStoredApiKey(entered)
      apiKey = entered
    }
    setQueryBusy(true)
    setQueryResult(null)
    try {
      const action = await runQuery(schema, text, apiKey)
      setQueryResult(action)
      switch (action.kind) {
        case 'highlight': {
          queryHighlightRef.current = new Set(action.nodeIds)
          setQueryHighlightCount(action.nodeIds.length)
          // Clear conflicting modes.
          clearSelection()
          if (activePath) exitPath()
          if (blastImpactsRef.current) exitBlast()
          if (diffOverlayRef.current) exitDiffOverlay()
          // Camera: pull to the first highlighted node for context.
          const first = simRef.current?.getNode(action.nodeIds[0])
          if (first) {
            cameraState.current.targetX = first.x
            cameraState.current.targetY = first.y
            cameraState.current.targetZ = first.z
            cameraState.current.autoRotate = false
          }
          break
        }
        case 'start_path':
          exitQueryHighlight()
          startPath(action.pathId)
          break
        case 'blast':
          exitQueryHighlight()
          startBlast(action.nodeId, action.direction)
          break
        case 'clarify':
        case 'error':
          // Result panel renders the message; no visual change.
          break
      }
    } catch (err) {
      setQueryResult({ kind: 'error', message: (err as Error).message })
    } finally {
      setQueryBusy(false)
    }
  }, [queryText, schema, clearSelection, activePath, exitPath, exitBlast, exitDiffOverlay, startPath, startBlast, exitQueryHighlight])

  // ─── AI DESCRIPTION (GE-017) ────────────────────────────────
  const requestAiDescription = useCallback(async () => {
    if (!selected) return
    setAiError(null)
    setAiSuggestion(null)

    let apiKey = getStoredApiKey()
    if (!apiKey) {
      const entered = prompt(
        'Anthropic API key (stored in this browser only, never sent to us):',
      )
      if (!entered) return
      setStoredApiKey(entered)
      apiKey = entered
    }

    setAiLoading(true)
    const result = await suggestDescription(schema, selected.id, apiKey)
    setAiLoading(false)
    if (result.ok && result.text) {
      setAiSuggestion(result.text)
    } else {
      setAiError(result.message ?? 'Unknown error')
    }
  }, [selected, schema])

  const acceptAiSuggestion = useCallback(() => {
    if (!selected || !aiSuggestion) return
    const AI_TRACKED_FIELD = 'description'
    setSchema((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => {
        if (n.id !== selected.id) return n
        const next = { ...n, description: aiSuggestion }
        // If the entity is auto-generated, flag description as a manual
        // override so it survives future re-imports.
        if (n.origin !== 'manual') {
          const overrides = new Set(n.manualOverrides ?? [])
          overrides.add(AI_TRACKED_FIELD)
          next.manualOverrides = [...overrides].sort()
        }
        return next
      }),
    }))
    // Refresh the displayed selection with the new description.
    setSelected((prev) => (prev ? { ...prev, description: aiSuggestion } : prev))
    setAiSuggestion(null)
    setAiError(null)
  }, [selected, aiSuggestion])

  const discardAiSuggestion = useCallback(() => {
    setAiSuggestion(null)
    setAiError(null)
  }, [])

  // Clear AI state when selection changes.
  useEffect(() => {
    setAiSuggestion(null)
    setAiError(null)
    setAiLoading(false)
  }, [selected?.id])

  // ─── URL STATE (GE-022) ──────────────────────────────────────
  // One-time restoration on mount: seed refs + defer sim-dependent
  // restoration (selection, active path) until the scene is built.
  useEffect(() => {
    if (!initialUrlState) return
    // Camera: preserve autoRotate=false since we're landing on a shared view.
    cameraState.current = {
      ...cameraState.current,
      theta: initialUrlState.camera.theta,
      phi: initialUrlState.camera.phi,
      r: initialUrlState.camera.r,
      targetX: initialUrlState.camera.targetX,
      targetY: initialUrlState.camera.targetY,
      targetZ: initialUrlState.camera.targetZ,
      autoRotate: initialUrlState.selectedId || initialUrlState.activePathId ? false : cameraState.current.autoRotate,
    }
    // Cluster pins.
    for (const id of initialUrlState.pinnedClusterIds) pinsOpenRef.current.add(id)

    // Sim-dependent restoration: retry until simRef is populated.
    let cancelled = false
    const applyWhenReady = () => {
      if (cancelled) return
      if (!simRef.current) {
        requestAnimationFrame(applyWhenReady)
        return
      }
      if (initialUrlState.activePathId) {
        startPath(initialUrlState.activePathId)
        if (initialUrlState.pathStep > 0) {
          // Defer one frame so startPath's state flush completes first.
          requestAnimationFrame(() => {
            if (!cancelled) goToPathStep(initialUrlState.pathStep)
          })
        }
      } else if (initialUrlState.selectedId) {
        // Silent: URL-state restoration isn't a user action, so it
        // shouldn't start populating the history stack with a
        // phantom entry.
        selectNodeSilent(initialUrlState.selectedId)
      }
    }
    applyWhenReady()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced URL sync on discrete state changes. Camera + pins are
  // snapshotted at the moment of each tracked change, which is good
  // enough for sharing-intent (user tweaks, then copies). Continuous
  // camera sync is deliberately omitted — replaceState per rAF would
  // thrash the browser URL bar.
  useEffect(() => {
    const timer = setTimeout(() => {
      replaceUrlWith({
        selectedId: selected?.id ?? null,
        activePathId: activePath?.id ?? null,
        pathStep,
        camera: { ...cameraState.current },
        is2D,
        showHulls,
        pinnedClusterIds: [...pinsOpenRef.current],
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [selected?.id, activePath?.id, pathStep, is2D, showHulls])

  // ─── PROJECT PERSISTENCE (GE-020) ────────────────────────────
  const loadProject = useCallback(async (id: string) => {
    try {
      suppressSaveRef.current = true
      const detail = await getGraph(id)
      // GE-114: backfill entities + bump version when loading a pre-v1.1
      // schema. Idempotent — same-version schemas pass through unchanged.
      const upgraded = upgradeLoadedSchema(detail.schema)
      setSchema(upgraded)
      setActiveProjectId(detail.id)
      setActiveProjectName(detail.name)
      // Loading a new project invalidates any in-flight mode.
      clearSelection()
      if (activePath) exitPath()
      // Navigation history is scoped to a single project (GE-101).
      resetHistory()
      // Let the debounce window pass before re-enabling saves.
      setTimeout(() => { suppressSaveRef.current = false }, 600)
    } catch (err) {
      console.error('[graph-explorer] Failed to load project', id, err)
    }
  }, [activePath, clearSelection, exitPath, resetHistory])

  const refreshProjects = useCallback(async (): Promise<GraphSummary[]> => {
    try {
      const list = await listGraphs()
      setProjects(list)
      setOffline(false)
      return list
    } catch {
      setOffline(true)
      return []
    }
  }, [])

  const createProject = useCallback(async (name: string) => {
    try {
      const seed: Schema = INITIAL_SCHEMA // clone happens in setSchema
      const summary = await createGraph(name, seed)
      await refreshProjects()
      await loadProject(summary.id)
    } catch (err) {
      console.error('[graph-explorer] Failed to create project', err)
      alert('Could not create project. Is the server running?')
    }
  }, [refreshProjects, loadProject])

  const deleteProject = useCallback(async (id: string) => {
    try {
      await deleteGraph(id)
      const list = await refreshProjects()
      if (id === activeProjectId) {
        const next = list[0]
        if (next) await loadProject(next.id)
        else {
          // No projects left — drop back to the seed schema, unsaved.
          suppressSaveRef.current = true
          setSchema(INITIAL_SCHEMA)
          setActiveProjectId(null)
          setActiveProjectName(null)
          setTimeout(() => { suppressSaveRef.current = false }, 600)
        }
      }
    } catch (err) {
      console.error('[graph-explorer] Failed to delete project', err)
    }
  }, [activeProjectId, loadProject, refreshProjects])

  const renameProject = useCallback(async (id: string, name: string) => {
    try {
      // PUT with only the name changed; send the current schema for the active one,
      // or re-fetch for a non-active one.
      let schemaForRename: Schema
      if (id === activeProjectId) {
        schemaForRename = schema
      } else {
        schemaForRename = (await getGraph(id)).schema
      }
      await updateGraph(id, schemaForRename, name)
      if (id === activeProjectId) setActiveProjectName(name)
      await refreshProjects()
    } catch (err) {
      console.error('[graph-explorer] Failed to rename project', err)
    }
  }, [activeProjectId, schema, refreshProjects])

  // Bootstrap: list projects, pick active (URL param preferred), else most-recent, else create.
  useEffect(() => {
    let cancelled = false
    const bootstrap = async () => {
      const reachable = await apiReachable()
      if (cancelled) return
      if (!reachable) {
        setOffline(true)
        return
      }
      const list = await refreshProjects()
      if (cancelled) return
      const urlParams = new URLSearchParams(window.location.search)
      const fromUrl = urlParams.get('project')
      const activeId = fromUrl && list.some((p) => p.id === fromUrl)
        ? fromUrl
        : list[0]?.id
      if (activeId) {
        await loadProject(activeId)
      } else {
        // No projects yet — seed one with the demo schema so there's something to see.
        await createProject('My First Project')
      }
    }
    bootstrap()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced save: any schema mutation (edit, AI accept, import, etc.) persists.
  useEffect(() => {
    if (suppressSaveRef.current) return
    if (!activeProjectId) return
    if (offline) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      updateGraph(activeProjectId, schema).catch((err) => {
        console.error('[graph-explorer] Save failed', err)
        setOffline(true)
      })
    }, 500)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [schema, activeProjectId, offline])

  // Keep ?project=<id> in the URL so refreshes / shared links land in the right project.
  useEffect(() => {
    if (!activeProjectId) return
    const url = new URL(window.location.href)
    url.searchParams.set('project', activeProjectId)
    window.history.replaceState({}, '', url.toString())
  }, [activeProjectId])

  const frameAll = useCallback(() => {
    const sim = simRef.current
    if (!sim || sim.nodes.length === 0) return
    // Centroid of all nodes.
    let cx = 0, cy = 0, cz = 0
    for (const n of sim.nodes) { cx += n.x; cy += n.y; cz += n.z }
    cx /= sim.nodes.length
    cy /= sim.nodes.length
    cz /= sim.nodes.length
    // Largest distance from centroid — this is the bounding-sphere radius.
    let maxDistSq = 0
    for (const n of sim.nodes) {
      const dx = n.x - cx, dy = n.y - cy, dz = n.z - cz
      const d = dx * dx + dy * dy + dz * dz
      if (d > maxDistSq) maxDistSq = d
    }
    const radius = Math.sqrt(maxDistSq)
    cameraState.current.targetX = cx
    cameraState.current.targetY = cy
    cameraState.current.targetZ = cz
    // Factor of 2.2 leaves a little breathing room beyond the outermost nodes.
    // Clamped to the zoom range so tiny graphs don't become telescopes.
    cameraState.current.r = Math.max(120, Math.min(4000, radius * 2.2 + 40))
    cameraState.current.autoRotate = false
  }, [])

  const handleCopyLink = useCallback(async () => {
    // Flush the latest camera + pins into the URL before copying.
    const state: ViewState = {
      selectedId: selected?.id ?? null,
      activePathId: activePath?.id ?? null,
      pathStep,
      camera: { ...cameraState.current },
      is2D,
      showHulls,
      pinnedClusterIds: [...pinsOpenRef.current],
    }
    replaceUrlWith(state)
    const ok = await copyCurrentUrl()
    if (!ok) alert('Could not copy. URL is in the address bar.')
  }, [selected?.id, activePath?.id, pathStep, is2D, showHulls])

  // ─── SEARCH ──────────────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return }
    const q = searchQuery.toLowerCase()
    setSearchResults(
      schema.nodes
        .filter((n) => n.name.toLowerCase().includes(q) || n.description.toLowerCase().includes(q) || n.type.toLowerCase().includes(q))
        .slice(0, 8),
    )
  }, [searchQuery, schema])

  // ─── THREE.JS SETUP & RENDER LOOP ───────────────────────────
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const W = el.clientWidth
    const H = el.clientHeight

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(BG_COLOR)
    scene.fog = new THREE.FogExp2(BG_COLOR, 0.002)

    const camera = new THREE.PerspectiveCamera(55, W / H, 1, 2000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(W, H)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)

    // Background particles
    const starsGeo = new THREE.BufferGeometry()
    const starsPos = new Float32Array(800 * 3)
    for (let i = 0; i < starsPos.length; i++) starsPos[i] = (Math.random() - 0.5) * 900
    starsGeo.setAttribute('position', new THREE.BufferAttribute(starsPos, 3))
    scene.add(new THREE.Points(starsGeo, new THREE.PointsMaterial({ color: 0x182040, size: 0.6, transparent: true, opacity: 0.5 })))

    // Init simulation
    const sim = new ForceSim3D(schema.nodes, schema.links)
    simRef.current = sim

    const raycaster = new THREE.Raycaster()

    // ── Build node meshes ──
    const nodeMeshes: THREE.Mesh[] = []
    const labelSprites: THREE.Sprite[] = []

    for (const node of sim.nodes) {
      const col = schema.nodeTypes[node.type]?.color || '#fff'
      const isDomain = node.type === 'domain'
      const r = isDomain ? 4.5 : 2.5

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, isDomain ? 32 : 20, isDomain ? 32 : 20),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(col), transparent: true, opacity: 0.92 }),
      )
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(r * 2.5, 12, 12),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(col), transparent: true, opacity: schema.nodeTypes[node.type]?.glow || 0.08 }),
      )
      mesh.add(glow)
      // GE-112: hub visual marker — ring around hub nodes.
      if (node.isHub) {
        const ringGeo = new THREE.RingGeometry(r * 1.6, r * 2.0, 32)
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.25,
          side: THREE.DoubleSide, depthTest: false,
        })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.userData = { hubRing: true }
        mesh.add(ring)
      }
      mesh.userData = { nodeId: node.id }
      scene.add(mesh)
      nodeMeshes.push(mesh)

      // Label sprite
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      canvas.width = 512
      canvas.height = 64
      ctx.font = `${isDomain ? 'bold 26px' : '600 22px'} 'Segoe UI', sans-serif`
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(node.name, 256, 32)
      const tex = new THREE.CanvasTexture(canvas)
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.7, depthTest: false }))
      sprite.scale.set(isDomain ? 36 : 26, isDomain ? 9 : 6.5, 1)
      sprite.userData = { nodeId: node.id }
      scene.add(sprite)
      labelSprites.push(sprite)
    }

    // ── Build link lines ──
    const linkLines: THREE.Line[] = []
    for (const link of sim.links) {
      const geo = new THREE.BufferGeometry()
      const pos = new Float32Array(6)
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const mat = new THREE.LineBasicMaterial({
        color: (link.type && LINK_TYPE_COLORS[link.type]) || 0x1a3a5c,
        transparent: true,
        opacity: 0.3,
      })
      const line = new THREE.Line(geo, mat)
      line.userData = { source: link.source, target: link.target, type: link.type }
      scene.add(line)
      linkLines.push(line)
    }

    // ── Build group hulls (GE-011) ──
    // One translucent sphere per group that has 2+ members. Centroid +
    // radius are recomputed on a throttled cadence in the animation loop.
    type HullEntry = {
      group: string
      members: SimulatedNode[]
      mesh: THREE.Mesh
      labelSprite: THREE.Sprite
    }
    const hullEntries: HullEntry[] = []
    {
      const membersByGroup = new Map<string, SimulatedNode[]>()
      for (const n of sim.nodes) {
        if (!n.group) continue
        const arr = membersByGroup.get(n.group) ?? []
        arr.push(n)
        membersByGroup.set(n.group, arr)
      }

      for (const [groupName, members] of membersByGroup) {
        if (members.length < 2) continue

        const color = groupColor(groupName)
        const hullMesh = new THREE.Mesh(
          new THREE.SphereGeometry(1, 20, 16),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(color),
            transparent: true,
            opacity: 0.09,
            depthWrite: false, // don't occlude nodes inside
          }),
        )
        hullMesh.renderOrder = -1 // draw before nodes/links
        scene.add(hullMesh)

        // Group label sprite — uppercase, subtle.
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (ctx) {
          canvas.width = 512
          canvas.height = 48
          ctx.font = "700 18px 'Segoe UI', sans-serif"
          ctx.fillStyle = color
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(groupName.toUpperCase(), 256, 24)
        }
        const tex = new THREE.CanvasTexture(canvas)
        const labelSprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55, depthTest: false }),
        )
        labelSprite.scale.set(32, 3, 1)
        scene.add(labelSprite)

        hullEntries.push({ group: groupName, members, mesh: hullMesh, labelSprite })
      }
    }

    // ── Hierarchy index + cluster count badges (GE-013) ──
    const parentIds = new Set<string>()
    const childToParent = new Map<string, string>()
    for (const n of schema.nodes) {
      if (n.children && n.children.length > 0) parentIds.add(n.id)
      if (n.parent) childToParent.set(n.id, n.parent)
    }
    const childCountById = new Map<string, number>()
    for (const n of schema.nodes) {
      if (n.children?.length) childCountById.set(n.id, n.children.length)
    }
    // One badge sprite per parent; visible only when the cluster is collapsed.
    const badgeByParent = new Map<string, THREE.Sprite>()
    for (const parentId of parentIds) {
      const count = childCountById.get(parentId) ?? 0
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      canvas.width = 128
      canvas.height = 128
      // filled circle + count text
      ctx.beginPath()
      ctx.arc(64, 64, 50, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.fill()
      ctx.fillStyle = '#0a0a18'
      ctx.font = 'bold 48px "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(count), 64, 66)
      const tex = new THREE.CanvasTexture(canvas)
      const badge = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.95, depthTest: false }),
      )
      badge.scale.set(4, 4, 1)
      badge.visible = false
      scene.add(badge)
      badgeByParent.set(parentId, badge)
    }

    /** Resolve a node's visible ancestor. Returns the nearest ancestor
     *  that is expanded, or the node's own ID if no collapse applies. */
    const effectiveNodeId = (nodeId: string, expanded: Set<string>): string => {
      let current = nodeId
      // Walk up while current's parent is not expanded (i.e. collapsed cluster).
      while (true) {
        const parent = childToParent.get(current)
        if (!parent) return current
        if (expanded.has(parent)) return current
        current = parent
      }
    }

    // ── Input handlers ──
    const cs = cameraState.current
    const ms = mouseRef.current

    const handleClick = (cx: number, cy: number) => {
      const rect = el.getBoundingClientRect()
      const mx = ((cx - rect.left) / rect.width) * 2 - 1
      const my = -((cy - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(new THREE.Vector2(mx, my), camera)
      // Only hit-test meshes that are currently visible — a collapsed
      // cluster's children shouldn't be clickable through the parent.
      const visibleMeshes = nodeMeshes.filter((m) => m.visible)
      const hits = raycaster.intersectObjects(visibleMeshes)
      if (hits.length > 0) {
        // The raycaster recurses into children (the glow halo), which
        // don't carry nodeId. Walk up until we find the ancestor that
        // owns the nodeId userData. This is why the glow makes the
        // click target feel larger without breaking selection.
        let hitObj: THREE.Object3D | null = hits[0].object
        while (hitObj && !hitObj.userData.nodeId) hitObj = hitObj.parent
        if (!hitObj) return
        const nodeId = hitObj.userData.nodeId as string

        // Path authoring (GE-015): click appends a step. Authoring also
        // selects the node so the user can read its details while authoring.
        if (authoringRef.current) {
          appendStep(nodeId)
          selectNode(nodeId)
          return
        }

        // Cluster pin toggle (GE-013): clicking a parent toggles its pin.
        if (parentIds.has(nodeId)) {
          if (pinsOpenRef.current.has(nodeId)) {
            pinsOpenRef.current.delete(nodeId)
          } else {
            pinsOpenRef.current.add(nodeId)
          }
        }

        // Path mode or normal selection — both go through selectNode
        // so the click feeds into the nav history (GE-101). Path-mode
        // rendering still works because connections state isn't read
        // while activePath is set.
        selectNode(nodeId)
      } else if (pathHighlightRef.current.nodeIds.size === 0) {
        clearSelection()
      }
    }

    // Modifier-aware mouse drag:
    //   plain drag  → orbit in 3D, pan in 2D
    //   shift+drag  → pan in 3D (translates the camera target along
    //                 the current view-right / view-up axes)
    //   right-click drag → pan in 3D too (same behavior, convention
    //                 match for users coming from 3D tooling)
    const onMD = (e: MouseEvent) => {
      ms.down = true
      ms.prevX = e.clientX
      ms.prevY = e.clientY
      ms.moved = false
    }
    // Hover detection (GE-102) — raycasts against visible meshes when
    // the mouse moves without being pressed. Throttled via rAF so we
    // never do more than one raycast per frame.
    let hoverRafPending = false
    let lastHoverCoords = { x: 0, y: 0 }
    let lastHoveredId: string | null = null

    const runHoverRaycast = () => {
      hoverRafPending = false
      if (!el) return
      const rect = el.getBoundingClientRect()
      const mx = ((lastHoverCoords.x - rect.left) / rect.width) * 2 - 1
      const my = -((lastHoverCoords.y - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(new THREE.Vector2(mx, my), camera)
      const hits = raycaster.intersectObjects(nodeMeshes.filter((m) => m.visible))
      let hoveredId: string | null = null
      if (hits.length > 0) {
        let hitObj: THREE.Object3D | null = hits[0].object
        while (hitObj && !hitObj.userData.nodeId) hitObj = hitObj.parent
        if (hitObj) hoveredId = hitObj.userData.nodeId as string
      }
      // Update tooltip position imperatively — 60fps updates via React
      // state would be wasteful.
      if (hoverTooltipRef.current) {
        hoverTooltipRef.current.style.left = `${lastHoverCoords.x + 16}px`
        hoverTooltipRef.current.style.top = `${lastHoverCoords.y + 16}px`
      }
      // Update cursor feedback.
      el.style.cursor = hoveredId ? 'pointer' : (ms.down ? 'grabbing' : 'grab')
      // React state update only when the hovered NODE changes.
      if (hoveredId !== lastHoveredId) {
        lastHoveredId = hoveredId
        setHoveredNodeId(hoveredId)
      }
    }

    const onMM = (e: MouseEvent) => {
      // Always update hover coords; the rAF callback reads latest.
      lastHoverCoords = { x: e.clientX, y: e.clientY }
      if (!ms.down) {
        if (!hoverRafPending) {
          hoverRafPending = true
          requestAnimationFrame(runHoverRaycast)
        }
        return
      }
      // Dragging — suppress hover tooltip.
      if (lastHoveredId !== null) {
        lastHoveredId = null
        setHoveredNodeId(null)
      }
      const dx = e.clientX - ms.prevX
      const dy = e.clientY - ms.prevY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) ms.moved = true

      // Detect pan intent: shift-key OR right-button-held (buttons bit 2).
      const panMode = e.shiftKey || (e.buttons & 2) !== 0
      if (is2DRef.current || panMode) {
        // Pan in screen-aligned world space. We derive view-right and
        // view-up from the current spherical camera orientation so the
        // pan always feels "along the screen" regardless of angle.
        const panScale = cs.r * 0.0015
        const sinTheta = Math.sin(cs.theta)
        const cosTheta = Math.cos(cs.theta)
        const cosPhi = Math.cos(cs.phi)
        // view-right in world space (no Y component since theta orbits around Y)
        const rightX = sinTheta
        const rightZ = -cosTheta
        // view-up in world space (camera up, accounting for phi tilt)
        const upX = -cosPhi * cosTheta
        const upY = Math.sin(cs.phi)
        const upZ = -cosPhi * sinTheta
        cs.targetX -= (dx * rightX + dy * upX) * panScale
        cs.targetY -= dy * upY * panScale
        cs.targetZ -= (dx * rightZ + dy * upZ) * panScale
        cs.autoRotate = false
      } else {
        cs.theta -= dx * 0.005
        cs.phi = Math.max(0.15, Math.min(Math.PI - 0.15, cs.phi - dy * 0.005))
        cs.autoRotate = false
      }
      ms.prevX = e.clientX
      ms.prevY = e.clientY
    }
    const onMU = (e: MouseEvent) => { if (!ms.moved) handleClick(e.clientX, e.clientY); ms.down = false }
    const onWh = (e: WheelEvent) => {
      // Exponential zoom — each wheel delta scales r by a fixed factor
      // rather than adding a constant. This gives even feel whether
      // you're up close (r = 50) or far out (r = 2000). The clamp is
      // generous enough to frame very large graphs.
      const factor = Math.exp(e.deltaY * 0.001)
      cs.r = Math.max(30, Math.min(4000, cs.r * factor))
    }

    // Touch
    const onTS = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const t = e.touches[0]
        ms.down = true
        ms.prevX = t.clientX
        ms.prevY = t.clientY
        ms.moved = false
      }
    }
    const onTM = (e: TouchEvent) => {
      if (e.touches.length === 1 && ms.down) {
        const t = e.touches[0]
        const dx = t.clientX - ms.prevX
        const dy = t.clientY - ms.prevY
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) ms.moved = true
        if (is2DRef.current) {
          const panScale = cs.r * 0.0015
          cs.targetX -= dx * panScale
          cs.targetZ -= dy * panScale
        } else {
          cs.theta -= dx * 0.005
          cs.phi = Math.max(0.15, Math.min(Math.PI - 0.15, cs.phi - dy * 0.005))
          cs.autoRotate = false
        }
        ms.prevX = t.clientX
        ms.prevY = t.clientY
      }
    }
    const onTE = (e: TouchEvent) => {
      if (!ms.moved && e.changedTouches.length) {
        const t = e.changedTouches[0]
        handleClick(t.clientX, t.clientY)
      }
      ms.down = false
    }

    // Suppress the native context menu so right-click can be used for panning.
    const onContextMenu = (e: MouseEvent) => { e.preventDefault() }
    const onMouseLeave = () => {
      if (lastHoveredId !== null) {
        lastHoveredId = null
        setHoveredNodeId(null)
      }
    }

    el.addEventListener('mousedown', onMD)
    el.addEventListener('mousemove', onMM)
    el.addEventListener('mouseup', onMU)
    el.addEventListener('wheel', onWh)
    el.addEventListener('contextmenu', onContextMenu)
    el.addEventListener('mouseleave', onMouseLeave)
    el.addEventListener('touchstart', onTS)
    el.addEventListener('touchmove', onTM)
    el.addEventListener('touchend', onTE)

    // ── Animation loop ──
    let frame: number
    let tickCount = 0
    const HULL_UPDATE_INTERVAL = 15 // recompute hull math every N frames
    const HULL_RADIUS_PADDING = 9
    const camTarget = new THREE.Vector3()
    const camSmooth = new THREE.Vector3()

    const animate = () => {
      frame = requestAnimationFrame(animate)
      sim.tick()
      tickCount++

      if (cs.autoRotate) cs.theta += 0.0015

      // Smooth camera
      camTarget.set(cs.targetX, cs.targetY, cs.targetZ)
      camSmooth.lerp(camTarget, 0.04)
      camera.position.x = camSmooth.x + cs.r * Math.sin(cs.phi) * Math.cos(cs.theta)
      camera.position.y = camSmooth.y + cs.r * Math.cos(cs.phi)
      camera.position.z = camSmooth.z + cs.r * Math.sin(cs.phi) * Math.sin(cs.theta)
      camera.lookAt(camSmooth)

      // State refs for fast access
      const sel = selectedRef.current
      const connIds = connectedRef.current
      const hasSel = sel !== null
      const pHL = pathHighlightRef.current
      const inPath = pHL.nodeIds.size > 0
      const blast = blastImpactsRef.current
      const inBlast = blast !== null
      const diffOv = diffOverlayRef.current
      const inDiff = diffOv !== null
      const queryHL = queryHighlightRef.current
      const inQuery = queryHL !== null && queryHL.size > 0
      // Filters (GE-104) — pulled once per frame so both the node and
      // link loops can share them.
      const fTypes = filterTypesRef.current
      const fDomains = filterDomainsRef.current
      const fEntities = filterEntitiesRef.current
      const fOrigins = filterOriginsRef.current
      const anyFilter = fTypes.size > 0 || fDomains.size > 0 || fEntities.size > 0 || fOrigins.size > 0
      // GE-113 entity lens
      const lensSubgraph = entityLensRef.current
      const inLens = lensSubgraph !== null && lensSubgraph.size > 0

      // ── Cluster expand/collapse state (GE-013) ──
      // A parent is "expanded" when pinned open, OR the camera is close
      // enough that detail is useful, OR selection / active path needs a
      // descendant visible. Otherwise the cluster collapses to its parent.
      const COLLAPSE_THRESHOLD = 260
      const expandedParents = new Set<string>()
      for (const pid of parentIds) {
        if (pinsOpenRef.current.has(pid)) expandedParents.add(pid)
        else if (cs.r < COLLAPSE_THRESHOLD) expandedParents.add(pid)
      }
      // Force-expand any ancestor chain needed to see the selected node.
      const forceOpenChain = (nodeId: string | null) => {
        if (!nodeId) return
        let p = childToParent.get(nodeId)
        while (p) {
          expandedParents.add(p)
          p = childToParent.get(p)
        }
      }
      if (hasSel) forceOpenChain(sel)
      if (inPath) for (const id of pHL.nodeIds) forceOpenChain(id)
      if (inBlast && blast) for (const id of blast.keys()) forceOpenChain(id)
      if (inQuery && queryHL) for (const id of queryHL) forceOpenChain(id)

      const clusterPulse = 1 + Math.sin(tickCount * 0.08) * 0.07

      // ── Update nodes ──
      for (let i = 0; i < sim.nodes.length; i++) {
        const nd = sim.nodes[i]
        const mesh = nodeMeshes[i]
        mesh.position.set(nd.x, nd.y, nd.z)

        // Node base color — type in the default mode, entity-hash palette
        // in "entity" mode (GE-106). Unclassified nodes (no entity set)
        // render in a muted gray so they're visible but demoted.
        let bc: string
        if (colorModeRef.current === 'entity') {
          bc = nd.entity ? groupColor(nd.entity) : '#555a6b'
        } else {
          bc = schema.nodeTypes[nd.type]?.color || '#fff'
        }
        const isSel = nd.id === sel
        const isConn = connIds.has(nd.id)
        const isOnPath = inPath && pHL.nodeIds.has(nd.id)

        // Cluster state: child hidden if its parent is collapsed;
        // parent enlarged + pulsing if collapsed itself.
        const parentOfN = childToParent.get(nd.id)
        const isHiddenChild = parentOfN !== undefined && !expandedParents.has(parentOfN)
        const isParent = parentIds.has(nd.id)
        const isCollapsedParent = isParent && !expandedParents.has(nd.id)

        const material = mesh.material as THREE.MeshBasicMaterial
        mesh.visible = !isHiddenChild

        // Filter check (GE-104) — if any facet filter is active and this
        // node is not allowed by it, render dim + skip mode-specific
        // styling. Filter wins as the outer layer.
        let filteredOut = false
        if (anyFilter) {
          if (fTypes.size > 0 && !fTypes.has(nd.type)) filteredOut = true
          if (!filteredOut && fDomains.size > 0) {
            const domainKey = nd.domain ?? '__unclassified__'
            if (!fDomains.has(domainKey)) filteredOut = true
          }
          if (!filteredOut && fEntities.size > 0) {
            const entityKey = nd.entity ?? '__unclassified__'
            if (!fEntities.has(entityKey)) filteredOut = true
          }
          if (!filteredOut && fOrigins.size > 0 && !fOrigins.has(nd.origin)) filteredOut = true
        }

        if (filteredOut) {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          material.color.set(colorModeRef.current === 'entity' && nd.entity ? groupColor(nd.entity) : (schema.nodeTypes[nd.type]?.color || '#444'))
          material.opacity = 0.06
          mesh.scale.setScalar(0.6)
          const spr = labelSprites[i]
          spr.position.set(nd.x, nd.y + (nd.type === 'domain' ? 8 : 5.5), nd.z)
          ;(spr.material as THREE.SpriteMaterial).opacity = 0.02
          spr.visible = !isHiddenChild
          continue
        }

        // GE-113 entity lens — dim nodes outside the lens subgraph.
        // Applied after filter so an already-filtered node stays filtered.
        if (inLens && !lensSubgraph.has(nd.id)) {
          material.color.set(0x334455)
          material.opacity = 0.08
          mesh.scale.setScalar(0.6)
          const spr = labelSprites[i]
          spr.position.set(nd.x, nd.y + (nd.type === 'domain' ? 8 : 5.5), nd.z)
          ;(spr.material as THREE.SpriteMaterial).opacity = 0.03
          spr.visible = !isHiddenChild
          continue
        }

        if (inDiff && diffOv) {
          const kind = diffOv.nodeKinds.get(nd.id)
          if (kind === 'added') {
            material.color.set('#69f0ae')
            material.opacity = 0.95
            mesh.scale.setScalar(1.2 + Math.sin(tickCount * 0.12) * 0.08)
          } else if (kind === 'modified') {
            material.color.set('#ffd740')
            material.opacity = 0.95
            mesh.scale.setScalar(1.1)
          } else {
            material.color.set(bc)
            material.opacity = 0.08
            mesh.scale.setScalar(0.7)
          }
        } else if (inQuery && queryHL) {
          const hit = queryHL.has(nd.id)
          if (hit) {
            material.color.set('#b388ff')
            material.opacity = 0.95
            mesh.scale.setScalar(1.2 + Math.sin(tickCount * 0.09) * 0.06)
          } else {
            material.color.set(bc)
            material.opacity = 0.06
            mesh.scale.setScalar(0.7)
          }
        } else if (inBlast && blast) {
          const impact = blast.get(nd.id)
          if (impact) {
            const isStart = impact.severity >= 1
            material.color.set(isStart ? '#ffffff' : severityColor(impact.severity))
            material.opacity = Math.max(0.35, impact.severity)
            mesh.scale.setScalar(isStart ? 1.5 : 1 + impact.severity * 0.3)
          } else {
            material.color.set(bc)
            material.opacity = 0.04
            mesh.scale.setScalar(0.6)
          }
        } else if (inPath) {
          material.color.set(isSel ? '#ffffff' : bc)
          material.opacity = isSel ? 1 : isOnPath ? 0.95 : 0.04
          mesh.scale.setScalar(isSel ? 1.5 : isOnPath ? 1.1 : 0.7)
        } else if (hasSel) {
          material.color.set(isSel ? '#ffffff' : bc)
          material.opacity = isSel ? 1 : isConn ? 1 : 0.06
          mesh.scale.setScalar(isSel ? 1.4 : isConn ? 1.1 : 0.7)
        } else if (isCollapsedParent) {
          material.color.set(bc)
          material.opacity = 0.95
          mesh.scale.setScalar(1.8 * clusterPulse)
        } else {
          material.color.set(bc)
          material.opacity = 0.92
          mesh.scale.setScalar(1)
        }

        // Label
        const spr = labelSprites[i]
        spr.position.set(nd.x, nd.y + (nd.type === 'domain' ? 8 : 5.5), nd.z)
        const spriteMat = spr.material as THREE.SpriteMaterial
        spr.visible = !isHiddenChild
        let baseOpacity = 0.6
        if (inDiff && diffOv) {
          const kind = diffOv.nodeKinds.get(nd.id)
          baseOpacity = kind ? 0.9 : 0.04
        } else if (inQuery && queryHL) {
          baseOpacity = queryHL.has(nd.id) ? 0.9 : 0.04
        } else if (inBlast && blast) {
          const impact = blast.get(nd.id)
          baseOpacity = impact ? Math.max(0.45, impact.severity * 0.9) : 0.03
        } else if (inPath) baseOpacity = isOnPath || isSel ? 0.9 : 0.03
        else if (hasSel) baseOpacity = isSel || isConn ? 0.85 : 0.04
        else if (isCollapsedParent) baseOpacity = 0.9

        // GE-019 LOD: fade label with distance from camera unless this
        // node is "interesting" (selected, on-path, impacted, etc.).
        // Interesting nodes should remain readable at any zoom level.
        const isInteresting = isSel || isConn || isOnPath || isCollapsedParent ||
          (inBlast && !!blast?.get(nd.id)) ||
          (inDiff && !!diffOv?.nodeKinds.get(nd.id)) ||
          (inQuery && !!queryHL?.has(nd.id))
        if (!isInteresting) {
          const ddx = nd.x - camera.position.x
          const ddy = nd.y - camera.position.y
          const ddz = nd.z - camera.position.z
          const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
          const LABEL_FADE_START = 250
          const LABEL_FADE_END = 450
          if (dist > LABEL_FADE_END) {
            spr.visible = false
          } else if (dist > LABEL_FADE_START) {
            const falloff = 1 - (dist - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START)
            baseOpacity *= falloff
          }
        }
        spriteMat.opacity = baseOpacity

        // Count badge: shown only when the parent is collapsed
        if (isParent) {
          const badge = badgeByParent.get(nd.id)
          if (badge) {
            badge.visible = isCollapsedParent
            if (isCollapsedParent) {
              // Offset slightly to the upper-right of the parent.
              badge.position.set(nd.x + 4, nd.y + 6, nd.z)
            }
          }
        }
      }

      // ── Update links ──
      for (const line of linkLines) {
        // Effective endpoints (GE-013): when an endpoint sits inside a
        // collapsed cluster, hoist to the cluster's parent. Hide the line
        // when both endpoints hoist to the same ancestor (intra-cluster).
        const srcId = line.userData.source as string
        const tgtId = line.userData.target as string
        const effSrcId = effectiveNodeId(srcId, expandedParents)
        const effTgtId = effectiveNodeId(tgtId, expandedParents)
        if (effSrcId === effTgtId) {
          line.visible = false
          continue
        }
        line.visible = true

        const sn = sim.nodes.find((n) => n.id === effSrcId)
        const tn = sim.nodes.find((n) => n.id === effTgtId)
        if (!sn || !tn) {
          line.visible = false
          continue
        }
        const posAttr = line.geometry.attributes.position as THREE.BufferAttribute
        const p = posAttr.array as Float32Array
        p[0] = sn.x; p[1] = sn.y; p[2] = sn.z
        p[3] = tn.x; p[4] = tn.y; p[5] = tn.z
        posAttr.needsUpdate = true

        const lk = `${srcId}->${tgtId}`
        const lkR = `${tgtId}->${srcId}`

        const lineMat = line.material as THREE.LineBasicMaterial

        // Filter check (GE-104) — dim edges whose endpoints don't pass
        // the current filter set. Checked against original endpoints,
        // not the hoisted ones.
        if (anyFilter) {
          const passes = (nodeId: string) => {
            const n = sim.nodes.find((x) => x.id === nodeId)
            if (!n) return false
            if (fTypes.size > 0 && !fTypes.has(n.type)) return false
            if (fDomains.size > 0) {
              const d = n.domain ?? '__unclassified__'
              if (!fDomains.has(d)) return false
            }
            if (fEntities.size > 0) {
              const k = n.entity ?? '__unclassified__'
              if (!fEntities.has(k)) return false
            }
            if (fOrigins.size > 0 && !fOrigins.has(n.origin)) return false
            return true
          }
          if (!passes(srcId) || !passes(tgtId)) {
            lineMat.color.set(0x1a3a5c)
            lineMat.opacity = 0.02
            continue
          }
        }

        // GE-113 entity lens — dim edges whose endpoints aren't both in the lens.
        if (inLens && (!lensSubgraph.has(srcId) || !lensSubgraph.has(tgtId))) {
          lineMat.color.set(0x1a3a5c)
          lineMat.opacity = 0.02
          continue
        }

        const linkId = `${srcId}__${line.userData.type ?? 'none'}__${tgtId}`
        if (inQuery && queryHL) {
          const bothHit = queryHL.has(srcId) && queryHL.has(tgtId)
          lineMat.color.set(bothHit ? 0xb388ff : 0x1a3a5c)
          lineMat.opacity = bothHit ? 0.6 : 0.03
        } else if (inDiff && diffOv) {
          const kind = diffOv.linkKinds.get(linkId)
          if (kind === 'added') {
            lineMat.color.set(0x69f0ae)
            lineMat.opacity = 0.75
          } else if (kind === 'modified') {
            lineMat.color.set(0xffd740)
            lineMat.opacity = 0.75
          } else {
            lineMat.color.set(0x1a3a5c)
            lineMat.opacity = 0.04
          }
        } else if (inBlast && blast) {
          const srcImpact = blast.get(srcId)
          const tgtImpact = blast.get(tgtId)
          // The edge "participates" only if it leads from an impacted
          // node to another impacted node (in the same direction as the
          // blast was computed). We approximate with: both impacted AND
          // tgt.distance > src.distance (downstream) — but since direction
          // can reverse, just color both-impacted edges by the greater
          // severity. It's cheap and reads well visually.
          if (srcImpact && tgtImpact) {
            const sev = Math.min(srcImpact.severity, tgtImpact.severity)
            lineMat.color.set(severityColor(sev))
            lineMat.opacity = Math.max(0.35, sev)
          } else {
            lineMat.color.set(0x1a3a5c)
            lineMat.opacity = 0.02
          }
        } else if (inPath) {
          const onPath = pHL.linkKeys.has(lk) || pHL.linkKeys.has(lkR)
          lineMat.color.set(onPath ? (pHL.color || '#fff') : 0x1a3a5c)
          lineMat.opacity = onPath ? 0.65 : 0.02
        } else if (hasSel) {
          const linked = connIds.has(srcId) && connIds.has(tgtId)
            && (srcId === sel || tgtId === sel)
          if (linked) {
            const otherNode = sim.nodes.find((n) => n.id === (srcId === sel ? tgtId : srcId))
            lineMat.color.set((otherNode && schema.nodeTypes[otherNode.type]?.color) || '#4488cc')
            lineMat.opacity = 0.65
          } else {
            lineMat.color.set(0x1a3a5c)
            lineMat.opacity = 0.03
          }
        } else {
          lineMat.color.set((line.userData.type && LINK_TYPE_COLORS[line.userData.type as string]) || 0x1a3a5c)
          // Hoisted edges get slightly more opacity since they represent N real edges.
          const isHoisted = effSrcId !== srcId || effTgtId !== tgtId
          lineMat.opacity = isHoisted ? 0.45 : 0.3
        }
      }

      // ── Update group hulls (throttled) ──
      const hullsVisible = showHullsRef.current && !inPath && !hasSel
      const recomputeHullGeom = tickCount % HULL_UPDATE_INTERVAL === 0
      for (const h of hullEntries) {
        h.mesh.visible = hullsVisible
        h.labelSprite.visible = hullsVisible
        if (!hullsVisible || !recomputeHullGeom) continue

        // centroid
        let cx = 0, cy = 0, cz = 0
        for (const m of h.members) { cx += m.x; cy += m.y; cz += m.z }
        cx /= h.members.length
        cy /= h.members.length
        cz /= h.members.length
        // bounding radius
        let maxSq = 0
        for (const m of h.members) {
          const dx = m.x - cx, dy = m.y - cy, dz = m.z - cz
          const d = dx * dx + dy * dy + dz * dz
          if (d > maxSq) maxSq = d
        }
        const radius = Math.sqrt(maxSq) + HULL_RADIUS_PADDING
        h.mesh.position.set(cx, cy, cz)
        h.mesh.scale.setScalar(radius)
        h.labelSprite.position.set(cx, cy + radius + 4, cz)
      }

      renderer.render(scene, camera)
    }
    animate()

    // Resize
    const onResize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      el.removeEventListener('mousedown', onMD)
      el.removeEventListener('mousemove', onMM)
      el.removeEventListener('mouseup', onMU)
      el.removeEventListener('wheel', onWh)
      el.removeEventListener('contextmenu', onContextMenu)
      el.removeEventListener('mouseleave', onMouseLeave)
      el.removeEventListener('touchstart', onTS)
      el.removeEventListener('touchmove', onTM)
      el.removeEventListener('touchend', onTE)
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
    // NOTE: activePath is intentionally NOT in this dep array — see GE-004.
    // Rebuilding the Three.js scene on every path enter/exit is expensive and
    // was latent at this scale. Path visuals read from `pathHighlightRef` which
    // is updated synchronously in startPath/exitPath. Adding `activePath` back
    // would reintroduce the bug.
    //
    // `schema` IS a dep: replacing the working schema (e.g., after an import)
    // is a fundamental data change and requires a full scene rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectNode, clearSelection, schema])

  // ─── KEYBOARD ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in inputs / textareas / contenteditable.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable
      if (inEditable) return

      if (e.key === '/' && !showSearch) { e.preventDefault(); setShowSearch(true) }
      if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchResults([]) }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); frameAll() }
      if (e.key === '?' || e.key === 'h' || e.key === 'H') { e.preventDefault(); setShowHelp(true) }
      // GE-101: nav history shortcuts. Alt+arrows are the standard
      // browser back/forward equivalents; Cmd+[ / Cmd+] as an extra
      // for macOS users.
      if ((e.altKey && e.key === 'ArrowLeft') || (e.metaKey && e.key === '[')) {
        e.preventDefault()
        navigateBack()
      }
      if ((e.altKey && e.key === 'ArrowRight') || (e.metaKey && e.key === ']')) {
        e.preventDefault()
        navigateForward()
      }
      if (activePath) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goToPathStep(pathStep + 1)
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goToPathStep(pathStep - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSearch, activePath, pathStep, goToPathStep, frameAll, navigateBack, navigateForward])

  const hasPanel = selected || activePath || draft

  // ─── RENDER ──────────────────────────────────────────────────
  return (
    <div style={{ width: '100%', height: '100vh', position: 'relative', background: '#05050d', fontFamily: "'Segoe UI', system-ui, sans-serif", overflow: 'hidden', color: '#fff' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, cursor: 'grab' }} />

      {/* ─── TOP BAR ─── */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', zIndex: 20, background: 'linear-gradient(to bottom, rgba(5,5,13,0.9) 60%, transparent)' }}>
        {/* Project picker */}
        <ProjectPicker
          projects={projects}
          activeId={activeProjectId}
          activeName={activeProjectName}
          offline={offline}
          onSelect={(id) => loadProject(id)}
          onCreate={(name) => createProject(name)}
          onDelete={(id) => deleteProject(id)}
          onRename={(id, name) => renameProject(id, name)}
        />

        {/* Search */}
        <div style={{ position: 'relative', flex: '0 0 auto' }}>
          <button onClick={() => setShowSearch(!showSearch)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#888', padding: '7px 14px', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 14 }}>⌕</span> Search
            <span style={{ opacity: 0.4, fontSize: 10, marginLeft: 4, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 3, padding: '1px 4px' }}>/</span>
          </button>
          {showSearch && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, width: 320, background: 'rgba(10,10,25,0.96)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, backdropFilter: 'blur(16px)', overflow: 'hidden' }}>
              <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search nodes..."
                style={{ width: '100%', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.06)', color: '#fff', padding: '10px 14px', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              {searchResults.map((n) => (
                <div key={n.id} onClick={() => { selectNode(n.id); setShowSearch(false); setSearchQuery('') }}
                  style={{ padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: typeColor(n.type), flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{n.name}</div>
                    <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>{typeLabel(n.type)}</div>
                  </div>
                </div>
              ))}
              {searchQuery && searchResults.length === 0 && <div style={{ padding: '12px 14px', color: '#555', fontSize: 12 }}>No results</div>}
            </div>
          )}
        </div>

        {/* Save schema to JSON file */}
        <button
          onClick={() => downloadSchema(schema)}
          style={topBarBtnStyle}
          title="Download this schema as a JSON file"
        >
          💾 Save
        </button>

        {/* Load schema from JSON file */}
        <button
          onClick={() => loadInputRef.current?.click()}
          style={topBarBtnStyle}
          title="Load a previously-saved schema JSON"
        >
          📂 Load
        </button>
        <input
          ref={loadInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            if (schema.nodes.length > 0) {
              if (!confirm('Loading a file will replace the current schema. Continue?')) {
                e.target.value = ''
                return
              }
            }
            const result = await readSchemaFromFile(file)
            e.target.value = ''
            if (result.ok && result.schema) {
              setSchema(result.schema)
              clearSelection()
              if (activePath) exitPath()
            } else {
              alert(result.message ?? 'Could not load schema.')
            }
          }}
        />

        {/* Import OpenAPI */}
        <button
          onClick={() => setShowImport(true)}
          style={topBarBtnStyle}
          title="Import an OpenAPI spec"
        >
          ↑ Import OpenAPI
        </button>

        {/* Import codebase */}
        <button
          onClick={() => setShowCodebaseImport(true)}
          style={topBarBtnStyle}
          title="Import a Next.js codebase folder"
        >
          📂 Import codebase
        </button>

        {/* Link code ↔ API endpoints */}
        <button
          onClick={() => setShowLinkImports(true)}
          style={topBarBtnStyle}
          title="Extract API calls from the codebase and link them to OpenAPI endpoints"
        >
          ↔ Link imports
        </button>

        {/* Edit button */}
        <button
          onClick={() => setShowEditor(true)}
          style={topBarBtnStyle}
          title="Edit nodes and links"
        >
          ✎ Edit
        </button>

        {/* Diff button */}
        <button
          onClick={() => diffActive ? exitDiffOverlay() : setShowDiff(true)}
          style={{
            ...topBarBtnStyle,
            background: diffActive ? 'rgba(255,215,64,0.12)' : 'rgba(255,255,255,0.04)',
            border: diffActive ? '1px solid rgba(255,215,64,0.3)' : '1px solid rgba(255,255,255,0.08)',
            color: diffActive ? '#ffd740' : '#ccc',
          }}
          title={diffActive ? 'Exit diff overlay' : 'Compare against a baseline schema'}
        >
          {diffActive ? '✕ Diff' : '⇄ Diff'}
        </button>

        {/* Hulls toggle */}
        <button
          onClick={() => setShowHulls((v) => !v)}
          style={{
            ...topBarBtnStyle,
            color: showHulls ? '#ddd' : '#777',
            background: showHulls ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
          }}
          title="Show / hide translucent hulls around node groups"
        >
          {showHulls ? '◉' : '○'} Hulls
        </button>

        {/* 2D / 3D toggle */}
        <button
          onClick={() => setIs2D((v) => !v)}
          style={{
            ...topBarBtnStyle,
            color: is2D ? '#ddd' : '#aaa',
            background: is2D ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
          }}
          title={is2D ? 'Switch to 3D view' : 'Switch to 2D view'}
        >
          {is2D ? '2D' : '3D'}
        </button>

        {/* Color mode: type vs entity (GE-106) */}
        <button
          onClick={() => setColorMode((m) => m === 'type' ? 'entity' : 'type')}
          style={{
            ...topBarBtnStyle,
            color: colorMode === 'entity' ? '#b388ff' : '#aaa',
            background: colorMode === 'entity' ? 'rgba(179,136,255,0.12)' : 'rgba(255,255,255,0.04)',
            border: colorMode === 'entity' ? '1px solid rgba(179,136,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
          }}
          title={colorMode === 'entity'
            ? 'Color nodes by type (click to switch)'
            : 'Color nodes by entity (customer, payment, …)'}
        >
          {colorMode === 'entity' ? '◐ Entity' : '● Type'}
        </button>

        {/* Frame all — fit the entire graph in view */}
        <button
          onClick={frameAll}
          style={topBarBtnStyle}
          title="Fit the whole graph in view (F)"
        >
          ⊡ Frame
        </button>

        {/* Copy shareable link */}
        <button
          onClick={handleCopyLink}
          style={topBarBtnStyle}
          title="Copy a link that restores this exact view"
        >
          🔗 Copy link
        </button>

        {/* AI natural-language query (GE-029) */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setQueryOpen((v) => !v)}
            style={{
              ...topBarBtnStyle,
              color: queryHighlightCount > 0 ? '#b388ff' : '#ccc',
              background: queryHighlightCount > 0 ? 'rgba(179,136,255,0.12)' : 'rgba(255,255,255,0.04)',
              border: queryHighlightCount > 0 ? '1px solid rgba(179,136,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
            }}
            title="Ask a question in plain English"
          >
            ✨ Ask{queryHighlightCount > 0 ? ` (${queryHighlightCount})` : ''}
          </button>
          {queryOpen && (
            <div style={queryPanelStyle}>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#b388ff', marginBottom: 6 }}>
                  Ask the graph
                </div>
                <textarea
                  autoFocus
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !queryBusy) {
                      e.preventDefault()
                      runAiQuery()
                    }
                  }}
                  placeholder="e.g. what touches payments? · show the auth flow · what breaks if the search service goes down?"
                  style={queryInputStyle}
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 6, justifyContent: 'flex-end' }}>
                  {queryHighlightCount > 0 && (
                    <button onClick={exitQueryHighlight} style={querySecondaryBtnStyle}>Clear highlight</button>
                  )}
                  <button disabled={queryBusy || !queryText.trim()} onClick={runAiQuery} style={queryPrimaryBtnStyle}>
                    {queryBusy ? 'Thinking…' : 'Ask'}
                  </button>
                </div>
              </div>
              {queryResult && (
                <div style={{ padding: '8px 12px', fontSize: 11 }}>
                  {queryResult.kind === 'highlight' && (
                    <div style={{ color: '#b388ff' }}>
                      Highlighted {queryResult.nodeIds.length} node{queryResult.nodeIds.length === 1 ? '' : 's'}.
                      <div style={{ color: '#999', marginTop: 3, fontSize: 10 }}>{queryResult.reason}</div>
                    </div>
                  )}
                  {queryResult.kind === 'start_path' && (
                    <div style={{ color: '#69f0ae' }}>Started path. {queryResult.reason && <span style={{ color: '#999' }}>{queryResult.reason}</span>}</div>
                  )}
                  {queryResult.kind === 'blast' && (
                    <div style={{ color: '#ff8080' }}>Blast radius ({queryResult.direction}). {queryResult.reason && <span style={{ color: '#999' }}>{queryResult.reason}</span>}</div>
                  )}
                  {queryResult.kind === 'clarify' && (
                    <div style={{ color: '#ffd740' }}>{queryResult.message}</div>
                  )}
                  {queryResult.kind === 'error' && (
                    <div style={{ color: '#ff6e40' }}>⚠ {queryResult.message}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Path buttons */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {schema.paths.map((p) => (
            <button key={p.id} onClick={() => activePath?.id === p.id ? exitPath() : startPath(p.id)}
              style={{
                background: activePath?.id === p.id ? `${p.color}20` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${activePath?.id === p.id ? p.color + '50' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                color: activePath?.id === p.id ? p.color : '#999', transition: 'all 0.2s',
              }}>
              {activePath?.id === p.id ? '✕ ' : '◈ '}{p.name}
            </button>
          ))}
          <button
            onClick={startNewPath}
            style={{
              background: draft ? 'rgba(105,240,174,0.12)' : 'rgba(255,255,255,0.04)',
              border: draft ? '1px dashed rgba(105,240,174,0.4)' : '1px dashed rgba(255,255,255,0.15)',
              borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              color: draft ? '#69f0ae' : '#888',
            }}
            title="Author a new guided path"
          >
            + Path
          </button>
        </div>
      </div>

      {/* ─── HELP BUTTON (GE-107) ─── */}
      <Tooltip label={<TooltipLines title="Help & cheat sheet" hint="Keyboard shortcuts and a demo walk-through" shortcut="? or H" />}>
        <button
          onClick={() => setShowHelp(true)}
          style={{
            position: 'absolute',
            top: 14,
            right: 16,
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#aaa',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            zIndex: 30,
          }}
          aria-label="Help"
        >
          ?
        </button>
      </Tooltip>

      {/* ─── HELP PANEL (GE-107) ─── */}
      <HelpPanel open={showHelp} onClose={() => setShowHelp(false)} />

      {/* ─── FILTER RAIL (GE-104) ─── */}
      <FilterRail
        open={filterRailOpen}
        onToggleOpen={() => setFilterRailOpen((v) => !v)}
        schema={schema}
        types={filterTypes}
        domains={filterDomains}
        entities={filterEntities}
        origins={filterOrigins}
        onChangeTypes={setFilterTypes}
        onChangeDomains={setFilterDomains}
        onChangeEntities={setFilterEntities}
        onChangeOrigins={setFilterOrigins}
      />

      {/* ─── ENTITY REVIEW BANNER (GE-116) ─── */}
      {(() => {
        const detected = entityCounts(schema)
        const unclassifiedCount = schema.nodes.filter((n) => !n.entity && !n.isHub).length
        const shouldShow =
          (detected.length > 0 || unclassifiedCount > 0) && !entityBannerDismissed
        if (!shouldShow) return null
        return (
          <div
            style={{
              position: 'absolute',
              top: 70,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(179,136,255,0.1)',
              border: '1px solid rgba(179,136,255,0.35)',
              borderRadius: 8,
              padding: '9px 14px',
              backdropFilter: 'blur(12px)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              zIndex: 25,
              fontFamily: "'Segoe UI', system-ui, sans-serif",
            }}
          >
            <div style={{ fontSize: 12, color: '#b388ff' }}>
              <strong>{detected.length} entit{detected.length === 1 ? 'y' : 'ies'}</strong>
              {unclassifiedCount > 0 && (
                <> · <strong>{unclassifiedCount} unclassified</strong></>
              )}
              {' — '}
              <span style={{ color: '#aaa' }}>
                {detected.slice(0, 5).map((c) => c.entity).join(', ')}
                {detected.length > 5 ? `, +${detected.length - 5} more` : ''}
              </span>
            </div>
            <button
              onClick={() => {
                setShowEntityReview(true)
                setEntityBannerDismissed(true)
              }}
              style={{
                background: 'rgba(179,136,255,0.2)',
                border: '1px solid rgba(179,136,255,0.4)',
                color: '#b388ff',
                padding: '5px 12px',
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Review
            </button>
            <button
              onClick={() => setEntityBannerDismissed(true)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#888',
                width: 22,
                height: 22,
                cursor: 'pointer',
                fontSize: 11,
              }}
              title="Dismiss (won't show again this session)"
            >
              ✕
            </button>
          </div>
        )
      })()}

      {/* ─── HOVER TOOLTIP (GE-102) ─── */}
      {(() => {
        const node = hoveredNodeId ? schema.nodes.find((n) => n.id === hoveredNodeId) : null
        // Always render the container so we can imperatively set its
        // position without waiting for a re-render. Visibility is
        // controlled by display: none when there's nothing to show.
        return (
          <div
            ref={hoverTooltipRef}
            style={{
              position: 'fixed',
              zIndex: 40,
              pointerEvents: 'none',
              display: node ? 'block' : 'none',
              background: 'rgba(10,10,25,0.95)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 6,
              padding: '7px 10px',
              backdropFilter: 'blur(8px)',
              fontFamily: "'Segoe UI', system-ui, sans-serif",
              maxWidth: 280,
              boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
            }}
          >
            {node && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: typeColor(node.type),
                    boxShadow: `0 0 6px ${typeColor(node.type)}60`,
                  }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{node.name}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: `${typeColor(node.type)}15`, color: typeColor(node.type), fontWeight: 600 }}>
                    {typeLabel(node.type)}
                  </span>
                  {node.group && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.05)', color: '#888' }}>
                      {node.group}
                    </span>
                  )}
                  {node.entity && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(179,136,255,0.12)', color: '#b388ff', fontWeight: 600 }}>
                      {node.entity}
                    </span>
                  )}
                  {node.origin !== 'manual' && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.03)', color: '#666', fontFamily: 'ui-monospace, monospace' }}>
                      {node.origin}
                    </span>
                  )}
                  {node.isHub && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(255,176,0,0.12)', color: '#ffb300', fontWeight: 600 }}>
                      hub · {schema.links.filter((l) => l.source === node.id || l.target === node.id).length} connections
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )
      })()}

      {/* ─── NAV HISTORY OVERLAY (GE-101) ─── */}
      {(() => {
        // historyVersion in closure forces re-render when ref changes
        void historyVersion
        const nodesById = new Map(schema.nodes.map((n) => [n.id, n]))
        return (
          <NavHistoryOverlay
            history={historyRef.current}
            currentIndex={historyIndexRef.current}
            nodesById={nodesById}
            onBack={navigateBack}
            onForward={navigateForward}
            onJumpTo={navigateToHistoryIndex}
          />
        )
      })()}

      {/* ─── LEGEND (GE-108: counts + click-to-filter) ─── */}
      {(() => {
        // Compute per-type counts from the current schema.
        const typeCounts = new Map<string, number>()
        for (const n of schema.nodes) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1)
        const handleTypeClick = (k: string, shiftKey: boolean) => {
          if (shiftKey) {
            setFilterTypes((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k])
          } else {
            // Plain click: replace filter with just this type, or clear
            // it if it's the only currently-selected type.
            setFilterTypes((prev) => (prev.length === 1 && prev[0] === k) ? [] : [k])
          }
        }
        return (
          <div style={{ position: 'absolute', bottom: 16, left: 16, background: 'rgba(5,5,13,0.85)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '10px 14px', backdropFilter: 'blur(12px)', zIndex: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 12 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', opacity: 0.35 }}>Nodes</div>
              {filterTypes.length > 0 && (
                <button
                  onClick={() => setFilterTypes([])}
                  style={{ background: 'transparent', border: 'none', color: '#888', fontSize: 9, cursor: 'pointer', fontWeight: 600 }}
                  title="Clear type filter"
                >
                  reset
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {Object.entries(schema.nodeTypes).map(([k, v]) => {
                const count = typeCounts.get(k) ?? 0
                if (count === 0) return null
                const isOn = filterTypes.includes(k)
                const dimmed = filterTypes.length > 0 && !isOn
                return (
                  <button
                    key={k}
                    onClick={(e) => handleTypeClick(k, e.shiftKey)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      background: isOn ? 'rgba(179,136,255,0.12)' : 'transparent',
                      border: isOn ? '1px solid rgba(179,136,255,0.3)' : '1px solid transparent',
                      borderRadius: 4,
                      padding: '2px 6px',
                      opacity: dimmed ? 0.45 : 1,
                      cursor: 'pointer',
                    }}
                    title={`${v.label} (${count})${filterTypes.length > 0 ? ' — click to replace, shift-click to add' : ' — click to filter'}`}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: v.color, boxShadow: `0 0 6px ${v.color}40` }} />
                    <span style={{ color: isOn ? '#fff' : '#aaa', fontSize: 10 }}>{v.label}</span>
                    <span style={{ color: '#666', fontSize: 9, fontFamily: 'ui-monospace, monospace' }}>{count}</span>
                  </button>
                )
              })}
            </div>
            <div style={{ fontSize: 9, color: '#444', marginTop: 6 }}>Drag orbit · Shift/right-drag pan · Scroll zoom · Click explore · F frame all · / search · ? help</div>
          </div>
        )
      })()}

      {/* ─── SIDE PANEL ─── */}
      <div style={{
        position: 'absolute', top: 0, right: 0, width: hasPanel ? 360 : 0, height: '100%',
        background: 'rgba(5,5,13,0.94)', borderLeft: hasPanel ? '1px solid rgba(255,255,255,0.06)' : 'none',
        backdropFilter: 'blur(20px)', transition: 'width 0.3s ease', overflow: 'hidden', zIndex: 15,
      }}>
        {hasPanel && (
          <div style={{ padding: '20px', height: '100%', overflowY: 'auto', width: 360, boxSizing: 'border-box' }}>
            <button onClick={() => {
              if (draft) cancelAuthoring()
              else if (activePath) exitPath()
              else clearSelection()
            }}
              style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(255,255,255,0.05)', border: 'none', color: '#666', borderRadius: 6, width: 26, height: 26, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>

            {/* ── AUTHORING MODE (GE-015) ── */}
            {draft && (
              <div>
                <div style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10, background: `${draft.color}15`, color: draft.color, border: `1px solid ${draft.color}25` }}>
                  {draft.isNew ? 'New Path' : 'Edit Path'}
                </div>

                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => updateDraftMeta({ name: e.target.value })}
                  placeholder="Path name"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: 18, fontWeight: 700, padding: '4px 0', outline: 'none', marginBottom: 10 }}
                />

                <textarea
                  value={draft.description}
                  onChange={(e) => updateDraftMeta({ description: e.target.value })}
                  placeholder="What does this path demonstrate?"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 5, color: '#ccc', fontSize: 11, padding: 8, marginBottom: 12, resize: 'vertical', height: 56, fontFamily: 'inherit', outline: 'none' }}
                />

                <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#666', marginBottom: 4 }}>Color</div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {PATH_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => updateDraftMeta({ color: c })}
                          style={{ width: 22, height: 22, borderRadius: '50%', border: draft.color === c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.12)', background: c, cursor: 'pointer', padding: 0 }}
                          aria-label={`Color ${c}`}
                        />
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#666', marginBottom: 4 }}>Category</div>
                    <select
                      value={draft.category}
                      onChange={(e) => updateDraftMeta({ category: e.target.value as PathCategory })}
                      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)', color: '#ccc', fontSize: 11, padding: '4px 6px', borderRadius: 4, outline: 'none' }}
                    >
                      {PATH_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: draft.color, marginBottom: 6 }}>
                  Steps ({draft.steps.length})
                </div>
                {draft.steps.length === 0 && (
                  <div style={{ fontSize: 11, color: '#666', padding: '10px 0 14px 0', lineHeight: 1.5 }}>
                    Click nodes in the graph to add them as steps. Steps appear here in click order.
                  </div>
                )}
                {draft.steps.map((step, i) => {
                  const node = schema.nodes.find((n) => n.id === step.nodeId)
                  return (
                    <div key={i} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6, padding: 8, marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <div style={{ width: 18, height: 18, borderRadius: '50%', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: `${draft.color}20`, color: draft.color }}>
                          {i + 1}
                        </div>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: typeColor(node?.type), flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: '#ddd', flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {node?.name ?? `(missing: ${step.nodeId})`}
                        </span>
                        <button onClick={() => moveStep(i, -1)} disabled={i === 0} style={reorderBtnStyle}>↑</button>
                        <button onClick={() => moveStep(i, 1)} disabled={i === draft.steps.length - 1} style={reorderBtnStyle}>↓</button>
                        <button onClick={() => removeStep(i)} style={{ ...reorderBtnStyle, color: '#ff6e80' }}>✕</button>
                      </div>
                      <textarea
                        value={step.annotation}
                        onChange={(e) => updateStepAnnotation(i, e.target.value)}
                        placeholder="What happens at this step?"
                        style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, color: '#ccc', fontSize: 11, padding: 6, resize: 'vertical', height: 50, fontFamily: 'inherit', outline: 'none' }}
                      />
                    </div>
                  )
                })}

                <div style={{ display: 'flex', gap: 6, marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {!draft.isNew && (
                    <button onClick={deleteDraftOrExistingPath} style={{ ...secondaryBtnStyle, color: '#ff6e80', border: '1px solid rgba(255,110,128,0.25)', background: 'rgba(255,110,128,0.05)' }}>
                      Delete
                    </button>
                  )}
                  <div style={{ flex: 1 }} />
                  <button onClick={cancelAuthoring} style={secondaryBtnStyle}>Cancel</button>
                  <button onClick={saveDraft} style={{ ...primaryBtnStyle, background: `${draft.color}22`, border: `1px solid ${draft.color}55`, color: draft.color }}>
                    Save
                  </button>
                </div>
              </div>
            )}

            {/* ── PATH MODE ── */}
            {!draft && activePath && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', background: `${activePath.color}15`, color: activePath.color, border: `1px solid ${activePath.color}25` }}>
                    Guided Path
                  </div>
                  <button
                    onClick={() => editExistingPath(activePath)}
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#999', fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer' }}
                    title="Edit this path"
                  >
                    ✎ Edit
                  </button>
                </div>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px 0' }}>{activePath.name}</h2>
                <p style={{ color: '#777', fontSize: 12, lineHeight: 1.5, margin: '0 0 16px 0' }}>{activePath.description}</p>

                {/* Progress bar */}
                <div style={{ display: 'flex', gap: 3, marginBottom: 16 }}>
                  {activePath.steps.map((_, i) => (
                    <div key={i} onClick={() => goToPathStep(i)} style={{
                      flex: 1, height: 4, borderRadius: 2, cursor: 'pointer', transition: 'background 0.3s',
                      background: i <= pathStep ? activePath.color : 'rgba(255,255,255,0.08)',
                    }} />
                  ))}
                </div>

                {/* Current step card */}
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 14, border: '1px solid rgba(255,255,255,0.05)', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: `${activePath.color}20`, color: activePath.color, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: `1px solid ${activePath.color}30` }}>
                      {pathStep + 1}
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{selected?.name}</div>
                      <div style={{ fontSize: 10, color: typeColor(selected?.type), fontWeight: 600 }}>{typeLabel(selected?.type)}</div>
                    </div>
                  </div>
                  <p style={{ color: '#ccc', fontSize: 12, lineHeight: 1.6, margin: 0 }}>
                    {activePath.steps[pathStep]?.annotation}
                  </p>
                </div>

                {/* Nav buttons */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button disabled={pathStep === 0} onClick={() => goToPathStep(pathStep - 1)}
                    style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', color: pathStep === 0 ? '#333' : '#ccc', cursor: pathStep === 0 ? 'default' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                    ← Previous
                  </button>
                  <button disabled={pathStep >= activePath.steps.length - 1} onClick={() => goToPathStep(pathStep + 1)}
                    style={{ flex: 1, padding: '8px', borderRadius: 8, border: `1px solid ${activePath.color}30`, background: `${activePath.color}12`, color: pathStep >= activePath.steps.length - 1 ? '#333' : activePath.color, cursor: pathStep >= activePath.steps.length - 1 ? 'default' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                    Next →
                  </button>
                </div>

                {/* All steps list */}
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8, opacity: 0.35 }}>All Steps</div>
                  {activePath.steps.map((step, i) => {
                    const sn = schema.nodes.find((n) => n.id === step.nodeId)
                    return (
                      <div key={i} onClick={() => goToPathStep(i)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', marginBottom: 2, transition: 'background 0.2s', background: i === pathStep ? 'rgba(255,255,255,0.06)' : 'transparent' }}
                        onMouseEnter={(e) => { if (i !== pathStep) e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
                        onMouseLeave={(e) => { if (i !== pathStep) e.currentTarget.style.background = 'transparent' }}>
                        <div style={{ width: 18, height: 18, borderRadius: '50%', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: i <= pathStep ? `${activePath.color}20` : 'rgba(255,255,255,0.05)', color: i <= pathStep ? activePath.color : '#555' }}>
                          {i + 1}
                        </div>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: typeColor(sn?.type), flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: i === pathStep ? '#fff' : '#888', fontWeight: i === pathStep ? 600 : 400 }}>{sn?.name}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── INFO MODE ── */}
            {!draft && !activePath && selected && (
              <div>
                <div style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10, background: `${typeColor(selected.type)}15`, color: typeColor(selected.type), border: `1px solid ${typeColor(selected.type)}25` }}>
                  {typeLabel(selected.type)}
                </div>
                {selected.entity && (
                  <div style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10, marginLeft: 6, background: 'rgba(179,136,255,0.12)', color: '#b388ff', border: '1px solid rgba(179,136,255,0.3)' }}>
                    {selected.entity}
                  </div>
                )}
                {selected.owner && (
                  <div style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 9, fontWeight: 600, marginBottom: 10, marginLeft: 6, background: 'rgba(255,255,255,0.04)', color: '#888', border: '1px solid rgba(255,255,255,0.06)' }}>
                    {selected.owner}
                  </div>
                )}
                <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px 0', lineHeight: 1.2 }}>{selected.name}</h2>
                <p style={{ color: '#999', fontSize: 12, lineHeight: 1.6, margin: '0 0 20px 0' }}>{selected.description}</p>

                {/* AI description suggestion (GE-017) */}
                {!aiSuggestion && !aiLoading && (
                  <button
                    onClick={requestAiDescription}
                    style={{ ...secondaryBtnStyle, width: '100%', marginBottom: 10, background: 'rgba(179,136,255,0.08)', border: '1px solid rgba(179,136,255,0.25)', color: '#b388ff' }}
                    title="Generate a description using Claude (BYO API key, stored locally)"
                  >
                    ✨ Suggest description
                  </button>
                )}
                {aiLoading && (
                  <div style={{ ...infoBoxStyle, color: '#b388ff', borderColor: 'rgba(179,136,255,0.25)', background: 'rgba(179,136,255,0.06)' }}>
                    Generating…
                  </div>
                )}
                {aiError && (
                  <div style={errorBoxInlineStyle}>
                    {aiError}
                    <button onClick={discardAiSuggestion} style={{ background: 'transparent', border: 'none', color: '#ffa080', cursor: 'pointer', fontSize: 10, marginLeft: 6 }}>
                      dismiss
                    </button>
                  </div>
                )}
                {aiSuggestion && (
                  <div style={{ background: 'rgba(179,136,255,0.06)', border: '1px solid rgba(179,136,255,0.25)', borderRadius: 6, padding: 10, marginBottom: 12 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#b388ff', marginBottom: 6 }}>
                      Suggested description
                    </div>
                    <textarea
                      value={aiSuggestion}
                      onChange={(e) => setAiSuggestion(e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, color: '#ddd', fontSize: 11, padding: 8, resize: 'vertical', height: 80, fontFamily: 'inherit', outline: 'none' }}
                    />
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button onClick={discardAiSuggestion} style={secondaryBtnStyle}>Discard</button>
                      <div style={{ flex: 1 }} />
                      <button onClick={acceptAiSuggestion} style={{ ...primaryBtnStyle, background: 'rgba(179,136,255,0.12)', border: '1px solid rgba(179,136,255,0.4)', color: '#b388ff' }}>
                        Accept
                      </button>
                    </div>
                  </div>
                )}

                {/* GE-113 — Entity lens chips. Show entities of
                    direct peers; clicking one scopes the graph. */}
                {(() => {
                  const chips = peerEntityChips(schema, selected.id)
                  if (chips.length === 0) return null
                  return (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: '#666', marginBottom: 6 }}>
                        Entity lens
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {chips.map(({ entity: e, count }) => {
                          const active = entityLens === e
                          return (
                            <button
                              key={e}
                              onClick={() => setEntityLens(active ? null : e)}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                padding: '4px 10px', borderRadius: 14, fontSize: 10, fontWeight: 600,
                                cursor: 'pointer', transition: 'all 0.15s',
                                background: active ? 'rgba(105,240,174,0.15)' : 'rgba(255,255,255,0.04)',
                                border: active ? '1px solid rgba(105,240,174,0.45)' : '1px solid rgba(255,255,255,0.08)',
                                color: active ? '#69f0ae' : '#bbb',
                              }}
                            >
                              <span style={{ width: 7, height: 7, borderRadius: '50%', background: groupColor(e) }} />
                              {e}
                              <span style={{ fontSize: 9, color: active ? '#69f0ae' : '#666', fontFamily: 'ui-monospace, monospace' }}>
                                {count}
                              </span>
                            </button>
                          )
                        })}
                        {entityLens && (
                          <button
                            onClick={() => setEntityLens(null)}
                            style={{
                              padding: '4px 10px', borderRadius: 14, fontSize: 10, fontWeight: 600,
                              cursor: 'pointer', background: 'rgba(255,64,64,0.08)',
                              border: '1px solid rgba(255,64,64,0.25)', color: '#ff9aa0',
                            }}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Blast-radius controls (GE-014) */}
                {!blastImpacts && (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
                    <button
                      onClick={() => startBlast(selected.id, 'downstream')}
                      style={blastBtnStyle}
                      title="What breaks if this goes down?"
                    >
                      ↓ Downstream blast
                    </button>
                    <button
                      onClick={() => startBlast(selected.id, 'upstream')}
                      style={blastBtnStyle}
                      title="What must work for this to function?"
                    >
                      ↑ Upstream blast
                    </button>
                  </div>
                )}

                {blastImpacts && (
                  <div style={{ marginBottom: 18, background: 'rgba(255,64,64,0.05)', border: '1px solid rgba(255,64,64,0.2)', borderRadius: 8, padding: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#ff8080' }}>
                        Blast radius · {blastDirection}
                      </div>
                      <button onClick={exitBlast} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#999', borderRadius: 4, fontSize: 10, padding: '3px 8px', cursor: 'pointer' }}>
                        Exit
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                      <button
                        onClick={() => blastStartId && startBlast(blastStartId, 'downstream')}
                        style={{ ...blastDirBtnStyle, ...(blastDirection === 'downstream' ? blastDirBtnActiveStyle : {}) }}
                      >↓ Down</button>
                      <button
                        onClick={() => blastStartId && startBlast(blastStartId, 'upstream')}
                        style={{ ...blastDirBtnStyle, ...(blastDirection === 'upstream' ? blastDirBtnActiveStyle : {}) }}
                      >↑ Up</button>
                    </div>
                    <div style={{ fontSize: 10, color: '#aaa', marginBottom: 6 }}>
                      {blastImpacts.length - 1} affected node{blastImpacts.length === 2 ? '' : 's'}
                    </div>
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                      {blastImpacts.filter((i) => i.severity < 1).map((i) => {
                        const n = schema.nodes.find((x) => x.id === i.nodeId)
                        if (!n) return null
                        return (
                          <div
                            key={i.nodeId}
                            onClick={() => jumpToImpact(i.nodeId)}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 5, cursor: 'pointer', marginBottom: 2, borderLeft: `3px solid ${severityColor(i.severity)}` }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                          >
                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: typeColor(n.type), flexShrink: 0 }} />
                            <span style={{ fontSize: 11, color: '#ddd', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                            <span style={{ fontSize: 9, color: '#888' }}>{(i.severity * 100).toFixed(0)}%</span>
                            <span style={{ fontSize: 9, color: '#555' }}>{i.distance} hop</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Connection sections (GE-105) — grouped by semantic
                    category so each row reads as a short sentence.
                    Sections with zero items are omitted. */}
                {(() => {
                  // GE-113: when entity lens is active, filter connections
                  // to only show peers that carry the lens entity. This
                  // is stricter than the 3D subgraph (which includes
                  // neighbors for visual context) — the panel shows ONLY
                  // entity-flow nodes so the user can follow the chain
                  // without noise from shared UI primitives.
                  const activeLens = entityLens
                  const visibleConns = activeLens
                    ? connections.filter((c) => c.node.entity === activeLens)
                    : connections

                  const buckets = {
                    importedBy: [] as Connection[],
                    imports: [] as Connection[],
                    apiCallsOut: [] as Connection[],
                    calledBy: [] as Connection[],
                    readsWrites: [] as Connection[],
                    triggers: [] as Connection[],
                    other: [] as Connection[],
                  }
                  for (const c of visibleConns) {
                    if (c.type === 'dependency' && c.direction === 'in') buckets.importedBy.push(c)
                    else if (c.type === 'dependency' && c.direction === 'out') buckets.imports.push(c)
                    else if (c.type === 'data_flow' && c.node.type === 'database') buckets.readsWrites.push(c)
                    else if (c.type === 'data_flow' && c.direction === 'out' && c.node.type === 'api') buckets.apiCallsOut.push(c)
                    else if (c.type === 'data_flow' && c.direction === 'in' && selected.type === 'api') buckets.calledBy.push(c)
                    else if (c.type === 'triggers') buckets.triggers.push(c)
                    else buckets.other.push(c)
                  }
                  const sections: Array<{ title: string; accent: string; icon: string; items: Connection[] }> = [
                    { title: 'Imported by', accent: '#00bcd4', icon: '📄', items: buckets.importedBy },
                    { title: 'Imports', accent: '#00bcd4', icon: '📄', items: buckets.imports },
                    { title: 'API calls out', accent: '#69f0ae', icon: '🌐', items: buckets.apiCallsOut },
                    { title: 'Called by', accent: '#69f0ae', icon: '📄', items: buckets.calledBy },
                    { title: 'Reads / writes', accent: '#00e5ff', icon: '🗄', items: buckets.readsWrites },
                    { title: 'Triggers', accent: '#ffd740', icon: '⚡', items: buckets.triggers },
                    { title: 'Other', accent: '#888', icon: '•', items: buckets.other },
                  ].filter((s) => s.items.length > 0)

                  if (sections.length === 0) {
                    return (
                      <div style={{ fontSize: 11, color: '#555', padding: '12px 0' }}>
                        No connections from this node yet.
                      </div>
                    )
                  }

                  // GE-111: entity sub-grouping helper.
                  const renderConnectionRow = (conn: Connection, key: string) => (
                    <div key={key} onClick={() => selectNode(conn.node.id)}
                      style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 6, padding: '7px 10px', marginBottom: 4, border: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', transition: 'background 0.2s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: typeColor(conn.node.type), boxShadow: `0 0 5px ${typeColor(conn.node.type)}40`, flexShrink: 0 }} />
                        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {conn.node.name}
                        </span>
                        {conn.node.entity && (
                          <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'rgba(179,136,255,0.12)', color: '#b388ff', fontWeight: 600 }}>
                            {conn.node.entity}
                          </span>
                        )}
                      </div>
                      <div style={{ color: '#888', fontSize: 10, lineHeight: 1.45 }}>
                        {conn.label}
                        {conn.description && conn.description !== conn.label && (
                          <span style={{ color: '#555' }}> — {conn.description}</span>
                        )}
                      </div>
                    </div>
                  )

                  // GE-111: group items by entity if the section is large enough.
                  const renderSection = (section: { title: string; accent: string; icon: string; items: Connection[] }) => {
                    const entities = new Set(section.items.map((c) => c.node.entity ?? '__none__'))
                    const shouldGroup = section.items.length >= 10 || entities.size >= 4

                    return (
                      <div key={section.title} style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: section.accent, marginBottom: 5 }}>
                          <span>{section.icon}</span>
                          <span>{section.title}</span>
                          <span style={{ color: '#666', fontFamily: 'ui-monospace, monospace', fontWeight: 400, letterSpacing: 0 }}>
                            ({section.items.length})
                          </span>
                        </div>
                        {shouldGroup ? (() => {
                          // Group by entity, sorted by count desc.
                          const groups = new Map<string, Connection[]>()
                          for (const c of section.items) {
                            const e = c.node.entity ?? '__unclassified__'
                            const arr = groups.get(e) ?? []
                            arr.push(c)
                            groups.set(e, arr)
                          }
                          const sorted = [...groups.entries()]
                            .sort(([a, aItems], [b, bItems]) => {
                              if (a === '__unclassified__') return 1
                              if (b === '__unclassified__') return -1
                              return bItems.length - aItems.length || a.localeCompare(b)
                            })
                          return sorted.map(([entity, items]) => (
                            <div key={entity} style={{ marginBottom: 8 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px', marginBottom: 3 }}>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: entity === '__unclassified__' ? '#555' : groupColor(entity) }} />
                                <span style={{ fontSize: 10, fontWeight: 600, color: entity === '__unclassified__' ? '#666' : '#bbb', flex: 1 }}>
                                  {entity === '__unclassified__' ? 'Unclassified' : entity}
                                </span>
                                <span style={{ fontSize: 9, color: '#555', fontFamily: 'ui-monospace, monospace' }}>
                                  {items.length}
                                </span>
                              </div>
                              {items.map((c, i) => renderConnectionRow(c, `${section.title}-${entity}-${i}`))}
                            </div>
                          ))
                        })() : section.items.map((conn, i) => renderConnectionRow(conn, `${section.title}-${i}`))}
                      </div>
                    )
                  }

                  return sections.map(renderSection)
                })()}

                {/* Related paths */}
                {schema.paths.filter((p) => p.steps.some((s) => s.nodeId === selected.id)).length > 0 && (
                  <>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 16, marginBottom: 8, opacity: 0.35 }}>Appears in Paths</div>
                    {schema.paths.filter((p) => p.steps.some((s) => s.nodeId === selected.id)).map((p) => (
                      <button key={p.id} onClick={() => startPath(p.id)}
                        style={{ display: 'block', width: '100%', textAlign: 'left', background: `${p.color}08`, border: `1px solid ${p.color}18`, borderRadius: 8, padding: '8px 10px', marginBottom: 4, cursor: 'pointer', color: p.color, fontSize: 11, fontWeight: 600 }}>
                        ◈ {p.name}
                      </button>
                    ))}
                  </>
                )}

                {/* Annotations (GE-023) — persisted via server */}
                <AnnotationsPanel
                  graphId={activeProjectId}
                  targetType="node"
                  targetId={selected.id}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── IMPORT DIALOG ─── */}
      <ImportDialog
        open={showImport}
        existingSchema={schema}
        onCancel={() => setShowImport(false)}
        onConfirm={(merged) => {
          // GE-115b: run propagation on the merged schema so entity
          // tags from the import flow through existing cross-stack edges.
          setSchema(propagateEntities(merged))
          setShowImport(false)
          clearSelection()
          if (activePath) exitPath()
        }}
      />

      {/* ─── CODEBASE IMPORT DIALOG ─── */}
      <CodebaseImportDialog
        open={showCodebaseImport}
        existingSchema={schema}
        onCancel={() => setShowCodebaseImport(false)}
        onConfirm={(merged) => {
          setSchema(propagateEntities(merged))
          setShowCodebaseImport(false)
          clearSelection()
          if (activePath) exitPath()
        }}
      />

      {/* ─── ENTITY REVIEW DIALOG (GE-103) ─── */}
      <EntityReviewDialog
        open={showEntityReview}
        schema={schema}
        onClose={() => setShowEntityReview(false)}
        onApply={(next) => {
          setSchema(next)
          setShowEntityReview(false)
          setEntityBannerDismissed(true)
        }}
      />

      {/* ─── LINK IMPORTS DIALOG ─── */}
      <LinkImportsDialog
        open={showLinkImports}
        existingSchema={schema}
        onCancel={() => setShowLinkImports(false)}
        onApply={(next) => {
          setSchema(next)
          setShowLinkImports(false)
        }}
      />

      {/* ─── DIFF DIALOG ─── */}
      <DiffDialog
        open={showDiff}
        currentSchema={schema}
        onApplyOverlay={applyDiffOverlay}
        onClose={() => setShowDiff(false)}
      />

      {/* ─── EDITOR PANEL ─── */}
      <EditorPanel
        open={showEditor}
        schema={schema}
        onClose={() => setShowEditor(false)}
        onApply={(next) => {
          setSchema(next)
          // Deleting a node could leave the selection stale.
          if (selectedRef.current && !next.nodes.find((n) => n.id === selectedRef.current)) {
            clearSelection()
          }
        }}
      />
    </div>
  )
}
