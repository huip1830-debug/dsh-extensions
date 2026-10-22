// Read-only delegation detection: the stall guard must not kill a child whose
// task is to look and report, because such a child never writes by design.

/**
 * Decide whether one delegation is exempt from the stall guard.
 * @param input - the child's descriptor label and the delegating prompt.
 * @param exempt - `{ labels, promptPatterns }` from the resolved config.
 * @returns true when the delegation is read-only by label or explicit marker.
 */
export function isReadOnlyDelegation({ label, prompt }, exempt) {
  if (typeof label === 'string' && (exempt.labels ?? []).includes(label)) return true
  if (typeof prompt !== 'string') return false
  return (exempt.promptPatterns ?? []).some(pattern => new RegExp(pattern, 'i').test(prompt))
}
