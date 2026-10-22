// Dispatch-guard configuration: defaults, validation, and the resolved shape
// the plugin wires its listeners with.

/** Defaults shipped in cordis.patch.yml; a profile may override any field. */
export const DEFAULTS = {
  failure: {
    maxAttempts: 2,
    codes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    notifyParent: true,
  },
  stall: {
    enabled: true,
    nudgeAfterSteps: 12,
    blockAfterSteps: 20,
    writeTools: ['write', 'edit', 'str_replace_editor'],
    writeCommandPatterns: ['New-Item', 'Set-Content', 'Out-File', 'Remove-Item', 'git\\s+commit', 'git\\s+add'],
    // A read-only delegation never writes by design; blocking it would kill
    // legitimate survey work. `不要修改` alone is deliberately NOT a marker:
    // write tasks use it as "do not touch unrelated code".
    exempt: {
      labels: [],
      promptPatterns: ['【只读】', 'read-only', '不要写', '不得写', '禁止写', 'do not write', 'mode\\s*:\\s*explore'],
    },
  },
  debug: false,
}

/**
 * Merge user configuration over the defaults and reject values that would
 * silently disable a guard (fail loud at load, like the other guards).
 * @param config - raw plugin config from the profile patch layer.
 * @returns the resolved configuration.
 */
export function resolveConfig(config = {}) {
  const source = config ?? {}
  const failure = { ...DEFAULTS.failure, ...(source.failure ?? {}) }
  const stall = { ...DEFAULTS.stall, ...(source.stall ?? {}) }
  stall.exempt = { ...DEFAULTS.stall.exempt, ...(source.stall?.exempt ?? {}) }

  if (!Number.isInteger(failure.maxAttempts) || failure.maxAttempts < 1) {
    throw new Error('dispatch-guard: failure.maxAttempts must be a positive integer')
  }
  if (!Array.isArray(failure.codes) || failure.codes.length === 0) {
    throw new Error('dispatch-guard: failure.codes must be a non-empty array')
  }
  if (!Number.isInteger(stall.nudgeAfterSteps) || stall.nudgeAfterSteps < 1) {
    throw new Error('dispatch-guard: stall.nudgeAfterSteps must be a positive integer')
  }
  if (!Number.isInteger(stall.blockAfterSteps) || stall.blockAfterSteps <= stall.nudgeAfterSteps) {
    throw new Error('dispatch-guard: stall.nudgeAfterSteps must be lower than stall.blockAfterSteps')
  }
  if (stall.enabled !== true && stall.enabled !== false) {
    throw new Error('dispatch-guard: stall.enabled must be a boolean')
  }
  if (!Array.isArray(stall.exempt.labels) || !Array.isArray(stall.exempt.promptPatterns)) {
    throw new Error('dispatch-guard: stall.exempt.labels and stall.exempt.promptPatterns must be arrays')
  }

  return { failure, stall, debug: source.debug === true }
}
