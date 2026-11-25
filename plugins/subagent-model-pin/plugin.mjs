// subagent-model-pin — default every subagent to a low-cost model route while
// keeping an escape hatch: an explicit `provider`/`model` on the delegation call
// wins, and the pin only fills in when nobody chose.
//
// Why the tool-call scan: the DSH event layer carries no record of *why* a child
// route was chosen. `resolveChildAgentOptions()` merges the parent route into the
// child options unconditionally, so at creation time a child explicitly
// delegated to the parent's own route is indistinguishable from one that merely
// inherited it. Comparing the resolved route with the parent route therefore
// cannot work for the most common upgrade case (upgrading to the model the main
// agent already runs). The delegating tool call is the only durable evidence: its
// arguments keep the model-facing `provider`/`model`/`reasoning_effort` fields
// exactly as the model wrote them, and the child's `subagent/descriptor` label
// equals that call's `description`, so concurrent sibling delegations cannot
// swap routes.
//
// 0.5.0 retired the role table and the label-prefix route tiers. A child whose
// tool pins its own route at creation (`subagent_readonly`, `subagent_spike`,
// any future tool with `agentOptions`) must never be re-selected here: it
// carries a `subagent/descriptor` label and no delegating tool call matches it,
// so the created handler keeps the creation-time route (R4' below).
//
// Why the injection instead of preset config: in the web/desktop profile the
// top-level `tool-subagent` entry is disabled and the live tool is mounted inside
// `preset-standard`, whose `plugins` list is plain config data — profile patches
// cannot target it, and a patch `config` is replaced wholesale (no deep merge),
// so `agentOptions` cannot be added there.
//
// Why created-time `agent.model.select()`: since 0.2.2 the loop fixes a step's
// model at `preStep` start (`agent.model.current()`, before tools and prompt
// assembly) and *throws* when an `agent/request` middleware proposes a different
// provider/model/effort afterwards. The old request-level rewrite therefore
// failed every child whose route was not already final at creation (workflow
// children, cold resume, an uncommitted parent `tool/call`). `agent.model` is the
// supported write path: `select()` appends a durable `model/selection` event, and
// `agent/created` is admitted serially and awaited before the child's first
// `preStep`, so one select here fixes the route for the whole session.
//
// Verified extension points (dsh app.asar, 0.2.2-rc.1):
//   - `agent/created` fires serial with { agent, source, signal? }; root-level
//     listeners receive it, and it runs before the child's first `preStep`.
//   - Per-agent behavior is registered on `agent.ctx` and disposed with it.
//   - `agent.model` is an AgentModel: `current()` (pending ?? lastUsed ?? the
//     creation-time options) and `select({ provider, model, reasoningEffort? })`,
//     which appends a durable `model/selection` event. `select()` validates no
//     allow-list, so route validity stays the plugin's responsibility.
//   - `agent/request` is a waterfall whose resolved value becomes the request
//     config, but 0.2.2 throws when it changes provider/model/effort after step
//     preparation — this plugin no longer registers on it.
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
import z from '@deepseek-ai/schemastery'
import { SANDBOX_MODES, readOptionalString, readVolatile } from './lib/routes.mjs'

/** Delegation tools whose arguments carry model-facing route fields. */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork'])

/**
 * Log path, resolved per write so tests can redirect it and the file only
 * appears once diagnostics are actually enabled.
 */
function logPath() {
  return process.env.SUBAGENT_MODEL_PIN_LOG ?? join(process.env.TEMP ?? '.', 'subagent-model-pin.log')
}

/** Append one diagnostic line; never let logging break the host. */
function writeLog(message) {
  try {
    appendFileSync(logPath(), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // logging must never break the host
  }
}

const sandboxSchema = z.union([
  z.const('read-only'),
  z.const('workspace-write'),
  z.const('danger-full-access'),
])

/**
 * The retired role-table entry shape.
 *
 * Kept in the schema on purpose (0.5.0): old profiles still carry `roles`, and a
 * load-time rejection would take the whole plugin down. The field is accepted
 * and ignored at runtime — `apply()` warns once and never reads an entry. The
 * next major version removes the field (load-time error with migration advice).
 */
const roleSchema = z.object({
  match: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  sandbox: sandboxSchema,
})

/**
 * Activation-time config schema.
 *
 * The four `.volatile()` fields are exactly the ones the Plugins-page config
 * card may write: the settings transport (`remote.settings.mutate`) refuses
 * non-volatile paths, and the Host updates volatile references in place when
 * the profile patch changes — no remount, no restart. Every read of a volatile
 * field must go through `readVolatile`/`readOptionalString` at call time.
 * `roles` (retired, ignored), `force`, `depth`, `sandbox` and
 * `injectDelegationDefaults` stay YAML-only by construction.
 */
export const Config = z.object({
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
  debug: z.boolean().default(false).volatile(),
  roles: z.array(roleSchema),
  force: z.boolean(),
  depth: z.number(),
  sandbox: sandboxSchema,
  injectDelegationDefaults: z.boolean(),
})

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
 * Whether the calling session carries a recorded subagent model-selection
 * policy (0.4.0).
 *
 * The settings plugin appends one durable `subagent/model-selection-policy`
 * event per session when the route whitelist is enabled. Injection below
 * equals an explicit route choice, and explicit choices are gated by that
 * policy: without a recorded one the delegation tool permits only the parent
 * route, so an injected pin would fail the delegation outright. The
 * created-time `select()` bypasses the whitelist, so skipping the injection
 * degrades descriptor consistency, never availability — this is what makes a
 * stock install (whitelist off by default) work without hand configuration.
 * @param agent - the calling agent on the `tools/execute` exec.
 * @returns true when a policy event is committed on the calling session.
 */
function hasModelSelectionPolicy(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    return events.some((event) => event?.type === 'subagent/model-selection-policy')
  } catch {
    return false
  }
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

/**
 * Read the top-level default route.
 *
 * The three fields are `.volatile()`, so they are re-read on every call: the
 * Plugins-page config card swaps the references in place and the next
 * delegation must see the new route without a restart.
 * @param config - plugin config.
 * @returns `{ provider, model, reasoningEffort }` with unset fields undefined.
 */
function readDefaultRoute(config) {
  return {
    provider: readOptionalString(config?.provider),
    model: readOptionalString(config?.model),
    reasoningEffort: readOptionalString(config?.reasoningEffort),
  }
}

/**
 * Narrow one child session to the top-level `sandbox` mode.
 *
 * The child's permission scope is fixed when the delegation starts and can
 * never be widened from inside; `session.append('sandbox/mode', …)` is the
 * durable write path and the last event wins, so appending here (before the
 * child's first tool call) confines it without touching the parent. The retired
 * role table no longer supplies a mode: `roles[].sandbox` is ignored.
 * @param agent - the newly created child agent.
 * @param mode - the sandbox mode to append.
 * @param log - diagnostic sink.
 */
function applyPinnedSandbox(agent, mode, log) {
  try {
    const session = agent?.session
    if (session === undefined || typeof session.append !== 'function') return
    const events = session.snapshotEvents?.() ?? []
    const current = [...events].reverse().find((event) => event?.type === 'sandbox/mode')?.data?.mode
    if (current === mode) return
    session.append('sandbox/mode', { mode })
    log(`sandbox ${mode} -> ${agent?.id} (was ${String(current)})`)
  } catch (error) {
    // Narrowing is best-effort; never break a delegation on it.
    log(`sandbox ${mode} ERROR ${error?.message ?? error}`)
  }
}

/**
 * Read the route the child's AgentModel resolves to right now.
 *
 * `current()` projects `pending ?? lastUsed` and falls back to the route the
 * agent was constructed with. On resume the descriptor route was already
 * selected during setup (before `agent/created` is announced), so this is the
 * restored route; otherwise it is the creation-time route (explicit delegation
 * choice, else the parent route merged in by `resolveChildAgentOptions()`).
 * @param agent - the newly created child agent.
 * @returns `{ provider, model }`, or undefined when no route is recorded yet.
 */
function readCurrentRoute(agent) {
  try {
    const current = agent?.model?.current?.()
    if (typeof current?.provider === 'string' && typeof current.model === 'string') {
      return { provider: current.provider, model: current.model }
    }
  } catch {
    // An unreadable model counts as "no route", so the pin still applies.
  }
  return undefined
}

/** Compare two routes by `(provider, model)` only, as the behavior matrix says. */
function sameRoute(left, right) {
  return left !== undefined && right !== undefined
    && left.provider === right.provider && left.model === right.model
}

/** Render an optional route for the diagnostic log. */
function routeText(route) {
  return route === undefined ? '-' : `${route.provider}/${route.model}`
}

/**
 * Whether the pin provider is registered with the LLM service.
 *
 * The runtime exposes no synchronous provider/model *resolution*: `listModels`,
 * `resolveModelInfo` and `resolveCallConfig` all await an adapter. `listProviders()`
 * is the only synchronous query, and it covers the provider half — it names every
 * route an adapter is currently registered for. A model id cannot be checked
 * without awaiting an adapter, so "this model exists" stays the operator's
 * assertion (see README, "路由合法性"). Never blocks: an unanswerable query
 * (no llm service, an older surface) returns undefined and the pin proceeds.
 * @param ctx - the host context.
 * @param provider - the provider id the pin wants to select.
 * @returns true/false when the runtime can answer, undefined when it cannot.
 */
function providerRegistered(ctx, provider) {
  try {
    const providers = ctx?.get?.('llm')?.listProviders?.()
    if (!Array.isArray(providers) || providers.length === 0) return undefined
    return providers.some((entry) => entry?.id === provider)
  } catch {
    return undefined
  }
}

export const name = 'subagent-model-pin'
export const inject = ['sessions']

export function apply(ctx, config) {
  // Diagnostics are opt-in and hot-switchable: the volatile `debug` field is
  // re-read on every write, so toggling it from the config card takes effect
  // without a restart.
  const log = (message) => {
    if (readVolatile(config?.debug) === true) writeLog(message)
  }

  const provider = readOptionalString(config?.provider)
  const model = readOptionalString(config?.model)
  const depth = config?.depth
  // `force: true` restores the old always-override behavior (no escape hatch).
  const force = config?.force === true
  // The only sandbox narrowing left (0.5.0): the top-level field, applied to
  // every subagent at the configured depth. YAML-only, not volatile.
  const sandbox = config?.sandbox

  if (provider === undefined) throw new Error('subagent-model-pin: config.provider is required')
  if (model === undefined) throw new Error('subagent-model-pin: config.model is required')
  if (sandbox !== undefined && !SANDBOX_MODES.includes(sandbox)) {
    throw new Error(`subagent-model-pin: config.sandbox must be one of ${SANDBOX_MODES.join(', ')}`)
  }

  // 0.5.0: the role table is retired. Old profiles keep loading (the schema
  // still accepts `roles`), but every entry is ignored at runtime. Warn once per
  // activation — a silent loss matters most for `roles[].sandbox`, whose failure
  // direction is a *widened* sandbox.
  const roles = readVolatile(config?.roles)
  if (Array.isArray(roles) && roles.length > 0) {
    try {
      ctx.logger?.warn?.('subagent-model-pin: roles 已退役——只读评审/勘察/spike 的路由与沙箱由 dispatch-protocol 的组合结构钉死；普通 subagent 角色分档删除，默认路由见顶层 provider/model；详见 README 版本历史 0.5.0')
    } catch {
      // A logger hiccup must never block activation.
    }
  }

  log(`apply() called with provider=${provider} model=${model} effort=${readOptionalString(config?.reasoningEffort) ?? '-'} roles=${Array.isArray(roles) ? roles.length : 0} (retired, ignored) force=${force}`)

  // Fill the default route into the delegation arguments *before* the child is
  // created. `subagent/descriptor.agentModel` snapshots the creation-time
  // options and `continuation.resume()` rebuilds `agentOptions` from that
  // descriptor, so a route chosen only later would leave both points describing
  // a route that was never requested. Injecting here makes the descriptor, the
  // first request and a cold resume agree. Workflow children and continuations
  // carry no delegation arguments and still fall back to the `agent/created`
  // select below.
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
          // 0.4.0: injection equals explicit selection, and explicit selection
          // is gated by the session's model-selection policy. No policy → the
          // tool would reject the injected route, so skip the injection and let
          // the created-time select() pin the route instead (it bypasses the
          // whitelist). Descriptor consistency is the only thing given up.
          if (!hasModelSelectionPolicy(exec.agent)) {
            log(`tools/execute inject skipped (no model-selection policy on the calling session) -> ${exec.name} label=${JSON.stringify(args.description)}`)
          } else {
            const route = readDefaultRoute(config)
            exec.arguments = {
              ...args,
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort === undefined ? {} : { reasoning_effort: route.reasoningEffort }),
            }
            log(`tools/execute inject ${route.provider}/${route.model} -> ${exec.name} label=${JSON.stringify(args.description)}`)
          }
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
    // R1: only subagents, and only at the configured delegation depth.
    if (header?.origin !== 'subagent') return
    if (depth !== undefined && (header.delegationDepth ?? 0) !== depth) return

    const parentId = header.parentSession
    const label = readChildLabel(agent)
    const target = readDefaultRoute(config)
    const explicit = readDelegationChoice(ctx.get('sessions')?.get?.(parentId), label)
    const cur = readCurrentRoute(agent)
    const parentRoute = readParentRoute(parentId)
    log(`delegation label=${JSON.stringify(label)} explicit=${explicit} cur=${routeText(cur)} parent=${routeText(parentRoute)} default=${routeText(target)}`)

    // Sandbox narrowing happens here, before the child's first tool call. The
    // delegation tool carries no sandbox field, so the top-level `sandbox` is
    // the only source left (the role table is retired).
    if (sandbox !== undefined) applyPinnedSandbox(agent, sandbox, log)

    // Select branch table (spec §4.2 of the 2026-11-25 structural-ownership
    // design), first hit wins:
    //   R2  force                              -> select the default route
    //   R3  explicit === true                  -> keep (the call chose)
    //   R4' label && explicit === undefined    -> keep (tool-pinned child)
    //   R5  explicit === undefined && cur ≠ parent -> keep
    //   R6' otherwise                          -> select the default route
    // `explicit` is the only evidence of a model-facing choice: the arguments of
    // the delegating tool call, matched to this child by descriptor label. Every
    // keep branch must stay silent — no `model/selection` event.
    const toolPinned = label !== undefined && explicit === undefined
    const inheritedElsewhere = explicit === undefined && parentRoute !== undefined && !sameRoute(cur, parentRoute)
    let select = false
    let reason
    if (force) {
      // R2: `force: true` restores the old always-override behavior.
      select = true
      reason = 'force'
    } else if (explicit === true) {
      // R3: an explicit choice on the delegation call always wins, even when it
      // happens to equal the parent route (the upgrade-to-parent-model case).
      reason = 'explicit'
    } else if (toolPinned) {
      // R4': a tool that pins its own route at creation (`subagent_readonly`,
      // `subagent_spike`, any future `agentOptions` tool) has a descriptor label
      // but no matching delegation call. Its creation-time route is final, and
      // R5's parent-route comparison cannot see it when the pin equals the
      // parent's route — that was the old R4 drift.
      reason = 'tool-pinned'
    } else if (inheritedElsewhere) {
      // R5: no matching delegation call but the child already carries a route
      // that differs from the parent's — keep that existing choice.
      reason = 'route-differs'
    } else if (sameRoute(cur, target)) {
      // R6': the default path, already in place.
      reason = 'already-default'
    } else {
      // R6': the default path.
      select = true
      reason = 'default'
    }

    if (!select) {
      log(`keep ${routeText(cur)} (${reason}, explicit=${explicit})`)
      return
    }
    if (typeof agent?.model?.select !== 'function') {
      log(`skip select -> ${routeText(target)} (${reason}): agent.model.select is unavailable`)
      return
    }
    // Route validity is ours: select() validates no allow-list. The provider
    // half is checkable synchronously; a provider that no adapter serves would
    // only fail later at dispatch, so skip the pin and keep the inherited route.
    if (providerRegistered(ctx, target.provider) === false) {
      log(`skip select -> ${routeText(target)} (${reason}): provider "${target.provider}" is not registered with llm`)
      return
    }

    const selection = {
      provider: target.provider,
      model: target.model,
      // No effort field → the projection carries no effort → the request sends
      // none, which matches the old middleware's "drop inherited effort" rule.
      ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
    }
    try {
      agent.model.select(selection)
      log(`select ${routeText(target)}${selection.reasoningEffort === undefined ? '' : ` effort=${selection.reasoningEffort}`} over ${routeText(cur)} (${reason}, explicit=${explicit})`)
    } catch (error) {
      // Routing is best-effort: never break a delegation on it.
      log(`agent/created select ERROR ${error?.message ?? error}`)
    }
  })
}
