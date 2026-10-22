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
 * Read a config field that may be a schemastery Volatile reference.
 *
 * When the plugin is activated by cordis with a `Config` schema, every
 * `.volatile()` field arrives as a frozen `{ get() }` reference whose value the
 * Host swaps in place when the settings document changes. Reading must go
 * through `get()` at call time — never cache the unwrapped value. Plain values
 * (unit tests, or a host that ignored the schema) pass through unchanged.
 * @param value - a volatile reference or a plain value.
 * @returns the current unwrapped value; undefined when the ref cannot be read.
 */
export function readVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** Normalize an optional string field: '' (the volatile default) means unset. */
export function readOptionalString(value) {
  const unwrapped = readVolatile(value)
  return typeof unwrapped === 'string' && unwrapped.length > 0 ? unwrapped : undefined
}

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
 * @param config - plugin config carrying `provider`/`model`/`reasoningEffort`/`roles`/`sandbox`;
 *   the three route fields may be volatile references and are read per call.
 * @returns `{ provider, model, reasoningEffort, sandbox, matched }`; `matched` is true when a role won.
 */
export function resolveRoute(description, config) {
  const roles = config?.roles ?? []
  const fallback = {
    provider: readOptionalString(config?.provider),
    model: readOptionalString(config?.model),
    reasoningEffort: readOptionalString(config?.reasoningEffort),
    sandbox: config?.sandbox,
  }
  const label = typeof description === 'string' ? description.trim().toLowerCase() : ''
  if (label.length > 0) {
    for (const role of roles) {
      if (label.startsWith(role.match.trim().toLowerCase())) {
        return {
          provider: role.provider,
          model: role.model,
          reasoningEffort: role.reasoningEffort ?? fallback.reasoningEffort,
          sandbox: role.sandbox ?? fallback.sandbox,
          matched: true,
        }
      }
    }
  }
  return { ...fallback, matched: false }
}
