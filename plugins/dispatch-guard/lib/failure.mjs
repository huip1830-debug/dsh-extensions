// Failure accounting for one child agent: how many of its model-request
// attempts failed with a code the guard cares about.

/**
 * Create a per-child failure counter.
 * @param config - `{ maxAttempts, codes }` from the resolved plugin config.
 * @returns an observer that answers `'retry'` or `'block'` for one failure.
 */
export function createFailureTracker({ maxAttempts, codes }) {
  const counted = new Set(codes)
  const attempts = new Map()

  return {
    /**
     * Record one failed model request.
     * @param childId - the child session id.
     * @param code - the failure code reported by the LLM layer.
     * @returns `'block'` once the matching attempts reach `maxAttempts`, else `'retry'`.
     */
    observe(childId, code) {
      if (!counted.has(code)) return 'retry'
      const next = (attempts.get(childId) ?? 0) + 1
      attempts.set(childId, next)
      return next >= maxAttempts ? 'block' : 'retry'
    },

    /** Matching failures seen so far for one child. */
    attemptsOf(childId) {
      return attempts.get(childId) ?? 0
    },

    /** Forget one child (fresh turn, or after a successful request). */
    clear(childId) {
      attempts.delete(childId)
    },
  }
}
