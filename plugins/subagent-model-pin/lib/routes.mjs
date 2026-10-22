// Role-based routing: pick a child route (and optional sandbox mode) from the
// delegation label.
//
// A role matches when the child's delegation description starts with the
// role's `match` string (case-insensitive, leading whitespace ignored). The
// first matching role wins; otherwise the configured default route applies.
// An explicit `provider`/`model` on the delegation call still overrides the
// route; the sandbox mode has no delegation-call field, so the role owns it.

/** Sandbox modes the role table may name; mirrors the host's closed union. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * Validate the configured roles, failing loud at load.
 * @param roles - raw `config.roles`.
 * @returns the same array when valid.
 */
export function validateRoles(roles) {
  if (roles === undefined) return []
  if (!Array.isArray(roles)) throw new Error('subagent-model-pin: roles must be an array')
  for (const role of roles) {
    if (typeof role?.match !== 'string' || role.match.trim() === '') {
      throw new Error('subagent-model-pin: roles[].match must be a non-empty string')
    }
    if (typeof role.provider !== 'string' || role.provider.length === 0) {
      throw new Error('subagent-model-pin: roles[].provider is required')
    }
    if (typeof role.model !== 'string' || role.model.length === 0) {
      throw new Error('subagent-model-pin: roles[].model is required')
    }
    if (role.sandbox !== undefined && !SANDBOX_MODES.includes(role.sandbox)) {
      throw new Error(`subagent-model-pin: roles[].sandbox must be one of ${SANDBOX_MODES.join(', ')}`)
    }
  }
  return roles
}

/**
 * Resolve the route for one delegation.
 * @param description - the delegation `description` (the child's label).
 * @param config - plugin config carrying `provider`/`model`/`reasoningEffort`/`roles`/`sandbox`.
 * @returns `{ provider, model, reasoningEffort, sandbox, matched }`; `matched` is true when a role won.
 */
export function resolveRoute(description, config) {
  const roles = config?.roles ?? []
  const label = typeof description === 'string' ? description.trim().toLowerCase() : ''
  if (label.length > 0) {
    for (const role of roles) {
      if (label.startsWith(role.match.trim().toLowerCase())) {
        return {
          provider: role.provider,
          model: role.model,
          reasoningEffort: role.reasoningEffort ?? config.reasoningEffort,
          sandbox: role.sandbox ?? config.sandbox,
          matched: true,
        }
      }
    }
  }
  return {
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    sandbox: config.sandbox,
    matched: false,
  }
}
