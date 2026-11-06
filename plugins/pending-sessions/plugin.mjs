// pending-sessions — Host half, intentionally empty.
//
// The whole feature lives in client.js (browser half): a floating bar listing
// sessions that wait for the user, plus best-effort OS notifications. This
// module exists for one structural reason: dsh-client-modules discovers client
// bundles per active Loader entry. `ClientModuleRegistry`
// (dsh-client-modules/lib/index.js:571 in 0.2.2-rc.1): the constructor scans
// `ctx.loader.entries()` (:615), `processOne` skips rows without a mounted
// fiber or disabled (:911), and `resolveMeta` resolves `exports["./client"]`
// from that row's manifest (:783-803). A package shipping
// only client.js is never scanned, so the bundle patch mounts this no-op Host
// plugin to create the entry the scan needs.

export const name = 'pending-sessions'
export const inject = []

/** No Host behavior: activation only makes the Loader entry exist. */
export function apply() {}
