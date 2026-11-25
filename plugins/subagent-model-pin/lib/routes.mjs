// Config helpers shared by the host half: sandbox-mode validation and the
// volatile-reference reads.
//
// 0.5.0 retired the role table: routes no longer derive from the delegation
// label. The label-driven `resolveRoute`/`validateRoles` pair is gone; the
// default route is read straight from the top-level `provider`/`model`/
// `reasoningEffort` fields, and the only sandbox narrowing left is the
// top-level `sandbox` field.

/** Sandbox modes the config may name; mirrors the host's closed union. */
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
