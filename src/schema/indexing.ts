// ─────────────────────────────────────────────────────────────────
// Indexing pipeline status.
//
// The UI needs to show what the model has actually managed to learn
// about a repository — routes mapped, journeys inferred, runtime
// unavailable — both while an import runs and afterwards.
//
// The status is DERIVED from the schema rather than reported by the
// importer. A progress object the importer maintains says what it
// believes it did; reading the schema says what is actually there. When
// those disagree the schema is right, and it is the one the user's
// questions will be answered from.
//
// The distinction that matters most here is `unsupported` versus
// `complete` with nothing found. "No runtime source is connected" and
// "we looked and this repository has no telemetry" are different
// statements, and collapsing them into an empty progress bar tells the
// reader nothing about whether to go connect something.
//
// Pure and deterministic.
// ─────────────────────────────────────────────────────────────────

import type { Schema } from '@/types'

export type IndexingStageId =
  | 'repository'
  | 'routes'
  | 'components'
  | 'api'
  | 'database'
  | 'outcomes'
  | 'tests'
  | 'documentation'
  | 'git'
  | 'journeys'
  | 'classification'
  | 'runtime'

export type StageStatus =
  | 'queued'
  | 'running'
  /** Ran, and produced what it was able to. */
  | 'complete'
  /** Ran, but only partly — some inputs were rejected or unresolved. */
  | 'partial'
  | 'failed'
  /** Cannot run: the source it needs is not connected. */
  | 'unsupported'

export type IndexingStage = {
  id: IndexingStageId
  label: string
  status: StageStatus
  /** How many entities this stage put into the model. */
  produced: number
  /** Plain statement of what happened, shown when status is not complete. */
  detail?: string
}

export type IndexingReport = {
  stages: IndexingStage[]
  /** Worst status across the stages that could run. */
  status: 'complete' | 'partial' | 'unsupported'
  producedTotal: number
}

const STAGE_LABELS: Readonly<Record<IndexingStageId, string>> = {
  repository: 'Repository parsing',
  routes: 'Route detection',
  components: 'Component detection',
  api: 'API detection',
  database: 'Database mapping',
  outcomes: 'Behaviour extraction',
  tests: 'Test mapping',
  documentation: 'Documentation analysis',
  git: 'Git analysis',
  journeys: 'Journey inference',
  classification: 'Domain classification',
  runtime: 'Runtime evidence',
}

/**
 * What each stage counts as its output.
 *
 * Keyed off the schema's actual contents, which is why a stage cannot
 * report success for work that produced nothing.
 */
export function assessIndexing(schema: Schema): IndexingReport {
  const nodes = schema.nodes
  const countType = (...types: string[]): number =>
    nodes.filter((n) => types.includes(n.type)).length

  const codeNodes = nodes.filter((n) => n.origin === 'auto:codebase')
  const withEvidenceFrom = (source: string): number =>
    nodes.filter((n) => n.evidence?.some((e) => e.source === source)).length

  const stage = (
    id: IndexingStageId,
    produced: number,
    opts: { unsupported?: string; partial?: string } = {},
  ): IndexingStage => {
    if (opts.unsupported) {
      return { id, label: STAGE_LABELS[id], status: 'unsupported', produced: 0, detail: opts.unsupported }
    }
    if (produced === 0) {
      return {
        id,
        label: STAGE_LABELS[id],
        status: 'partial',
        produced: 0,
        // Distinct from `unsupported`: the stage could run and found
        // nothing, which is a fact about the repository.
        detail: 'Ran, but found nothing to map.',
      }
    }
    if (opts.partial) {
      return { id, label: STAGE_LABELS[id], status: 'partial', produced, detail: opts.partial }
    }
    return { id, label: STAGE_LABELS[id], status: 'complete', produced }
  }

  const gitCount = withEvidenceFrom('git')
  const testCount = withEvidenceFrom('test')
  const docCount = countType('document', 'decision')
  const runtimeCount = withEvidenceFrom('runtime')

  const unclassified = nodes.filter((n) => !n.domain).length

  const stages: IndexingStage[] = [
    stage('repository', codeNodes.length),
    stage('routes', countType('page', 'layout')),
    stage('components', countType('component', 'hook', 'client', 'ui')),
    stage('api', countType('api')),
    stage('database', countType('database')),
    stage('outcomes', countType('outcome')),
    stage('tests', testCount),
    stage('documentation', docCount),
    stage('git', gitCount),
    stage('journeys', (schema.journeys ?? []).length),
    stage(
      'classification',
      nodes.filter((n) => n.domain).length,
      unclassified > 0
        ? { partial: `${unclassified} entities are not assigned to a domain.` }
        : {},
    ),
    stage('runtime', runtimeCount, runtimeCount === 0
      ? { unsupported: 'No runtime source is connected.' }
      : {}),
  ]

  const runnable = stages.filter((s) => s.status !== 'unsupported')
  const status: IndexingReport['status'] =
    runnable.length === 0
      ? 'unsupported'
      : runnable.some((s) => s.status === 'partial' || s.status === 'failed')
        ? 'partial'
        : 'complete'

  return {
    stages,
    status,
    producedTotal: stages.reduce((a, s) => a + s.produced, 0),
  }
}
