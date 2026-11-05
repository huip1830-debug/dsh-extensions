// pending-sessions — Host half, intentionally empty.
//
// The whole feature lives in client.js (browser half): a floating bar listing
// sessions that wait for the user, plus best-effort OS notifications. This
// module exists for one structural reason: dsh-client-modules discovers client
// bundles per active Loader entry. It walks `ctx.loader.entries()`, skips rows
// whose fiber is missing or disabled, and resolves the package's
// `exports["./client"]` from that row's manifest
// (dsh-client-modules/lib/index.js:854-889 plus 720-750). A package shipping
// only client.js is never scanned, so the bundle patch mounts this no-op Host
// plugin to create the entry the scan needs.

export const name = 'pending-sessions'
export const inject = []

/** No Host behavior: activation only makes the Loader entry exist. */
export function apply() {}
