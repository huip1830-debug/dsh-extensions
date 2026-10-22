// subagent-model-pin — default every subagent to a low-cost model route while
// keeping an escape hatch: an explicit `provider`/`model` on the delegation call
// wins, and the pin only fills in when nobody chose.
//
// Why the tool-call scan: the DSH event layer carries no record of *why* a child
// route was chosen. `resolveChildAgentOptions()` merges the parent route into the
// child options unconditionally, so at `agent/request` time a child explicitly
// delegated to the parent's own route is indistinguishable from one that merely
// inherited it. Comparing the resolved route with the parent route therefore
// cannot work for the most common upgrade case (upgrading to the model the main
// agent already runs). The delegating tool call is the only durable evidence: its
// arguments keep the model-facing `provider`/`model`/`reasoning_effort` fields
// exactly as the model wrote them, and the child's `subagent/descriptor` label
// equals that call's `description`, so concurrent sibling delegations cannot
// swap routes.
//
// Why request-level: in the web/desktop profile the top-level `tool-subagent`
// entry is disabled and the live tool is mounted inside `preset-standard`, whose
// `plugins` list is plain config data — profile patches cannot target it, and a
// patch `config` is replaced wholesale (no deep merge), so `agentOptions` cannot
// be added there.
//
// Verified extension points (dsh app.asar):
//   - `agent/created` fires serial with { agent, source, signal? }; root-level
//     listeners receive it.
//   - Per-agent behavior is registered on `agent.ctx` and disposed with it.
//   - `agent/request` is a waterfall; its resolved value becomes the request
//     config `{ provider, model, reasoningEffort, maxTokens }`.
//   - Subagents carry `session.header.origin === 'subagent'`; the delegating
//     session id is `session.header.parentSession`.
//   - `ctx.on(name, listener, options)`; a boolean third argument means
//     `{ prepend: true }`, i.e. outermost in the waterfall.
//   - `sessions` is an injectable service; `session.requestHeader()?.config`
//     exposes the route the parent actually last requested.
//   - `session.snapshotEvents()` returns committed events: the child's
//     `subagent/descriptor` (with `label`) and the parent's `tool/call` (with
//     `name` and JSON-encoded `arguments`).

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRoute, validateRoles } from './lib/routes.mjs'

const LOG = join(process.env.TEMP ?? '.', 'subagent-model-pin.log')

/** Delegation tools whose arguments carry model-facing route fields. */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork'])

/** Append one diagnostic line; never let logging break the host. */
function writeLog(message) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // logging must never break the host
  }
}

/**
 * Read the child's own descriptor label.
 * @param agent - the newly created child agent.
 * @returns the delegation `description`, or undefined when unavailable.
 */
function readChildLabel(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'subagent/descriptor' && typeof event.data?.label === 'string') return event.data.label
    }
  } catch {
    // fall through to unknown
  }
  return undefined
}

/**
 * Find the delegation call that produced this child and report whether it chose
 * a route explicitly.
 * @param parent - the delegating Session.
 * @param label - the child's descriptor label.
 * @returns true for an explicit route/effort field, false for a plain
 *   inheritance call, and undefined when no matching call can be found.
 */
function readDelegationChoice(parent, label) {
  if (label === undefined) return undefined
  try {
    const events = parent?.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type !== 'tool/call') continue
      const data = event.data ?? {}
      if (!DELEGATION_TOOLS.has(data.name)) continue
      let args
      try {
        args = JSON.parse(data.arguments)
      } catch {
        continue
      }
      if (args?.description !== label) continue
      return args.provider !== undefined || args.model !== undefined || args.reasoning_effort !== undefined
    }
  } catch {
    // fall through to unknown
  }
  return undefined
}

export const name = 'subagent-model-pin'
export const inject = ['sessions']

export function apply(ctx, config) {
  // Diagnostics are opt-in: `debug: true` writes %TEMP%\subagent-model-pin.log.
  const log = config?.debug === true ? writeLog : () => {}

  const provider = config?.provider
  const model = config?.model
  const reasoningEffort = config?.reasoningEffort
  const depth = config?.depth
  // `force: true` restores the old always-override behavior (no escape hatch).
  const force = config?.force === true

  if (typeof provider !== 'string' || provider.length === 0) throw new Error('subagent-model-pin: config.provider is required')
  if (typeof model !== 'string' || model.length === 0) throw new Error('subagent-model-pin: config.model is required')
  validateRoles(config?.roles)

  log(`apply() called with ${JSON.stringify(config ?? null)}`)

  // Fill the default route into the delegation arguments *before* the child is
  // created. `subagent/descriptor.agentModel` snapshots the creation-time
  // options and `continuation.resume()` rebuilds `agentOptions` from that
  // descriptor, so a route pinned only at `agent/request` time leaves both
  // points describing a route that was never requested. Injecting here makes
  // the descriptor, the first request and a cold resume agree. Workflow
  // children and continuations carry no delegation arguments and still fall
  // back to the request-level pin below.
  //
  // `exec.arguments` is deep-frozen by the tool registry, so the whole object
  // is replaced instead of mutated. An explicit `provider`/`model` on the call
  // is never overridden.
  if (config?.injectDelegationDefaults !== false) {
    ctx.on('tools/execute', async (exec, next) => {
      try {
        const args = exec?.arguments
        const injectable = typeof exec?.name === 'string' && DELEGATION_TOOLS.has(exec.name)
          && args !== null && typeof args === 'object' && !Array.isArray(args)
          && args.provider === undefined && args.model === undefined
        if (injectable) {
          const route = resolveRoute(args.description, config)
          exec.arguments = {
            ...args,
            provider: route.provider,
            model: route.model,
            ...(route.reasoningEffort === undefined ? {} : { reasoning_effort: route.reasoningEffort }),
          }
          log(`tools/execute inject ${route.provider}/${route.model} (role=${route.matched}) -> ${exec.name} label=${JSON.stringify(args.description)}`)
        }
      } catch (error) {
        // Injection is best-effort: never block a delegation on it.
        log(`tools/execute inject ERROR ${error?.message ?? error}`)
      }
      return next()
    }, true)
  }

  /** Route the delegating session last requested; undefined when unknown. */
  const readParentRoute = (parentId) => {
    if (typeof parentId !== 'string' || parentId.length === 0) return undefined
    try {
      const route = ctx.get('sessions')?.get?.(parentId)?.requestHeader?.()?.config
      if (route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') return undefined
      return { provider: route.provider, model: route.model }
    } catch {
      return undefined
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    const header = agent?.session?.header
    log(`agent/created id=${agent?.id} origin=${header?.origin} depth=${header?.delegationDepth}`)
    if (header?.origin !== 'subagent') return
    if (depth !== undefined && (header.delegationDepth ?? 0) !== depth) return

    const parentId = header.parentSession
    const label = readChildLabel(agent)
    const route = resolveRoute(label, config)
    const explicit = readDelegationChoice(ctx.get('sessions')?.get?.(parentId), label)
    log(`delegation label=${JSON.stringify(label)} explicit=${explicit} role=${route.matched}`)

    // prepend: true → outermost listener, so our return value is the final one.
    agent.ctx.effect(() => agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      try {
        if (!force && resolved !== undefined) {
          // An explicit choice on the delegating call always wins — even when it
          // happens to equal the parent route (the upgrade-to-parent-model case).
          if (explicit === true) {
            log(`keep explicit ${resolved.provider}/${resolved.model}`)
            return resolved
          }
          // A role route outranks the inherited-route heuristic: the label says
          // what this child is for, so it decides the model family.
          if (route.matched) {
            const { reasoningEffort: _roleInherited, ...roleRest } = resolved
            log(`pin role ${route.provider}/${route.model} over ${resolved.provider}/${resolved.model}`)
            return {
              ...roleRest,
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
            }
          }
          const parentRoute = readParentRoute(parentId)
          // Fallback only: when the delegation call cannot be found (workflow
          // children, cold resume, or an uncommitted parent event), keep the old
          // "route differs from the parent" heuristic.
          const chosen = explicit === undefined
            && parentRoute !== undefined
            && (resolved.provider !== parentRoute.provider || resolved.model !== parentRoute.model)
          if (chosen) {
            log(`keep ${resolved.provider}/${resolved.model} (parent=${parentRoute.provider}/${parentRoute.model}, no matching tool call)`)
            return resolved
          }
        }
        // Default path: also drop any effort inherited from the parent route.
        const { reasoningEffort: _inherited, ...rest } = resolved ?? {}
        log(`pin ${route.provider}/${route.model} over ${resolved?.provider}/${resolved?.model} (explicit=${explicit})`)
        return {
          ...rest,
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        }
      } catch (error) {
        log(`agent/request ${agent.id} ERROR ${error?.message ?? error}`)
        throw error
      }
    }, true))
  })
}
