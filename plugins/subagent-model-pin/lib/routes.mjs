// Role-based routing: pick a child route from the delegation label.
//
// A role matches when the child's delegation description starts with the
// role's `match` string (case-insensitive, leading whitespace ignored). The
// first matching role wins; otherwise the configured default route applies.
// An explicit `provider`/`model` on the delegation call still overrides both.

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
  }
  return roles
}

/**
 * Resolve the route for one delegation.
 * @param description - the delegation `description` (the child's label).
 * @param config - plugin config carrying `provider`/`model`/`reasoningEffort`/`roles`.
 * @returns `{ provider, model, reasoningEffort, matched }`; `matched` is true when a role won.
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
          matched: true,
        }
      }
    }
  }
  return {
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    matched: false,
  }
}
