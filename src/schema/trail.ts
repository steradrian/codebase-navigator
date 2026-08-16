// ─────────────────────────────────────────────────────────────────
// Exploration trails.
//
// A trail is the path by which someone came to understand something —
// not browser history. Each step records what they were focused on, which
// lens they were using, at what altitude, and the question they were
// chasing. That is what makes a trail replayable by someone else, and
// what makes "follow my trail" a substitute for writing onboarding docs.
//
// Trails go stale, and saying so is the point. A trail recorded against
// last month's code may walk through entities that no longer exist or
// have changed underneath it. Replaying such a trail silently would
// teach a new engineer something that is no longer true, so freshness is
// assessed per step and reported rather than assumed.
//
// Pure and deterministic: ids and timestamps are supplied by the caller
// so a trail can be reconstructed exactly in tests and in replay.
// ─────────────────────────────────────────────────────────────────

import type { Altitude, Schema } from '@/types'
import type { Lens } from '@/schema/projection'

export type TrailStep = {
  id: string
  /** Entity the explorer was focused on. */
  focusId: string
  lens: Lens
  altitude: Altitude
  /** The question being pursued, when the step came from asking one. */
  question?: string
  /** The explorer's own annotation. */
  note?: string
  /** ISO 8601, supplied by the caller. */
  at: string
}

/** Who can see a trail. Separate from whether it is finished. */
export type TrailVisibility = 'personal' | 'shared' | 'recommended'

/** Whether the explorer considers the trail finished. */
export type TrailState = 'in_progress' | 'complete'

export type Trail = {
  id: string
  name: string
  description?: string
  author: string
  visibility: TrailVisibility
  state: TrailState
  steps: TrailStep[]
  tags?: string[]
  /** Set when this trail was branched from another. */
  forkedFrom?: { trailId: string; stepId: string }
  createdAt: string
  updatedAt: string
}

/** Why a step may no longer reflect the code. */
export type StepFreshness = 'ok' | 'missing' | 'changed'

export type StepAssessment = {
  stepId: string
  focusId: string
  freshness: StepFreshness
  /** Present for `changed`: when the entity was last touched. */
  changedAt?: string
}

/**
 * Trail-level freshness.
 *
 * `stale` outranks `changed`: an entity that has vanished breaks the
 * trail's thread outright, whereas one that merely moved on can still be
 * followed with a caveat.
 */
export type TrailFreshness = 'fresh' | 'changed' | 'stale'

export type TrailAssessment = {
  freshness: TrailFreshness
  steps: StepAssessment[]
  missingCount: number
  changedCount: number
}

export function appendStep(trail: Trail, step: TrailStep): Trail {
  return { ...trail, steps: [...trail.steps, step], updatedAt: step.at }
}

/**
 * Branch a trail at one of its steps.
 *
 * The fork keeps everything up to and including that step, because the
 * point of branching is to take a different turn from a shared starting
 * position — dropping the shared prefix would lose the context that made
 * the branch make sense.
 */
export function forkTrail(
  trail: Trail,
  atStepId: string,
  input: { id: string; name: string; author: string; at: string },
): Trail | null {
  const index = trail.steps.findIndex((s) => s.id === atStepId)
  if (index === -1) return null

  return {
    id: input.id,
    name: input.name,
    description: trail.description,
    author: input.author,
    // A fork starts private regardless of the original's visibility;
    // inheriting "recommended" would let anyone silently publish under
    // someone else's endorsement.
    visibility: 'personal',
    state: 'in_progress',
    steps: trail.steps.slice(0, index + 1),
    tags: trail.tags,
    forkedFrom: { trailId: trail.id, stepId: atStepId },
    createdAt: input.at,
    updatedAt: input.at,
  }
}

/**
 * Check a trail against the current model.
 *
 * A step is `missing` when its focus no longer exists, and `changed` when
 * the entity has been touched since the step was recorded. Both are
 * reported rather than repaired: rewriting someone's recorded path to fit
 * today's code would destroy the record of how they actually understood
 * it.
 */
export function assessTrail(trail: Trail, schema: Schema): TrailAssessment {
  const byId = new Map(schema.nodes.map((n) => [n.id, n]))

  const steps: StepAssessment[] = trail.steps.map((step) => {
    const node = byId.get(step.focusId)
    if (!node) {
      return { stepId: step.id, focusId: step.focusId, freshness: 'missing' as const }
    }

    const modified = node.metadata?.lastModified
    if (modified) {
      const modifiedMs = Date.parse(modified)
      const stepMs = Date.parse(step.at)
      if (!Number.isNaN(modifiedMs) && !Number.isNaN(stepMs) && modifiedMs > stepMs) {
        return {
          stepId: step.id,
          focusId: step.focusId,
          freshness: 'changed' as const,
          changedAt: modified,
        }
      }
    }
    return { stepId: step.id, focusId: step.focusId, freshness: 'ok' as const }
  })

  const missingCount = steps.filter((s) => s.freshness === 'missing').length
  const changedCount = steps.filter((s) => s.freshness === 'changed').length

  return {
    freshness: missingCount > 0 ? 'stale' : changedCount > 0 ? 'changed' : 'fresh',
    steps,
    missingCount,
    changedCount,
  }
}

/**
 * The entity ids a trail visited, oldest first and deduplicated.
 *
 * This is the shape `ExplorationQuery.trail` expects, so a saved trail
 * can seed a live projection and continue where its author left off.
 */
export function trailFocusIds(trail: Trail): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const step of trail.steps) {
    if (seen.has(step.focusId)) continue
    seen.add(step.focusId)
    ids.push(step.focusId)
  }
  return ids
}
