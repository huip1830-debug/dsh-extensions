// No-progress detection for one child agent: consecutive steps that never
// touched a file. A read-only or shell-only stretch is the signature of a child
// wandering (environment spelunking) rather than doing the delegated work.

/**
 * Decide whether one tool call counts as progress for the stall guard.
 * @param exec - the dispatched call (`{ name, arguments }`).
 * @param stall - the resolved `stall` config section.
 * @returns true when the call writes files or runs a writing shell command.
 */
export function isWriteActivity(exec, stall) {
  const tool = exec?.name
  if (typeof tool !== 'string') return false
  if ((stall.writeTools ?? []).includes(tool)) return true
  if (tool === 'pwsh' || tool === 'bash') {
    const command = String(exec?.arguments?.command ?? '')
    return (stall.writeCommandPatterns ?? []).some(pattern => new RegExp(pattern, 'i').test(command))
  }
  return false
}

/**
 * Create a per-child step counter that measures distance from the last write.
 * @param config - `{ nudgeAfterSteps, blockAfterSteps }` from the resolved config.
 * @returns a tracker whose `beginStep` answers `'ok'`, `'nudge'`, or `'block'`.
 */
export function createStallTracker({ nudgeAfterSteps, blockAfterSteps }) {
  const state = new Map()
  const stateOf = (childId) => {
    const existing = state.get(childId)
    if (existing !== undefined) return existing
    const fresh = { sinceWrite: 0, nudged: false, writes: 0 }
    state.set(childId, fresh)
    return fresh
  }

  return {
    /**
     * Account for one admitted step and report what the guard should do.
     * @param childId - the child session id.
     * @returns `'block'` at the hard threshold, `'nudge'` once at the soft one.
     */
    beginStep(childId) {
      const current = stateOf(childId)
      current.sinceWrite += 1
      if (current.sinceWrite >= blockAfterSteps) return 'block'
      if (current.sinceWrite >= nudgeAfterSteps && !current.nudged) {
        current.nudged = true
        return 'nudge'
      }
      return 'ok'
    },

    /**
     * Record tool activity; a write resets the stall run.
     * @param childId - the child session id.
     * @param isWrite - whether the call counted as a write.
     */
    recordActivity(childId, isWrite) {
      const current = stateOf(childId)
      if (!isWrite) return
      current.sinceWrite = 0
      current.nudged = false
      current.writes += 1
    },

    /** Steps since the last write. */
    stepsWithoutWrite(childId) {
      return stateOf(childId).sinceWrite
    },

    /** Write calls recorded for one child. */
    writesOf(childId) {
      return stateOf(childId).writes
    },
  }
}
