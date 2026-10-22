// dispatch-guard — runtime guardrails for delegated child agents.
//
// Phase 1 has two jobs, both enforced by the harness instead of by prompt text:
//   1. A child whose model requests keep failing is stopped early (the retry
//      policy is short-circuited) and its parent receives one actionable notice.
//   2. A child that runs many consecutive steps without writing anything is
//      nudged once, then blocked, and its parent is told why.
//
// Deliberately NOT here: automatic route fallback (a failing child is blocked
// and reported, never silently re-routed) and any fixed step budget.
//
// Extension points (installed dsh 0.2.1-rc.2):
//   - root `agent/created({ agent })` — observed for every agent; only
//     `session.header.origin === 'subagent'` children are guarded.
//   - per-agent `agent/request-error(payload, next)` — waterfall; returning a
//     value without calling `next()` ends the attempt and skips later listeners
//     (the retry policy), so the child's turn closes with the failure.
//   - per-agent `tools/post-execute(exec, result, next)` — observes writes.
//   - per-agent `agent/pre-step(payload, next)` — returns `{ kind: 'reject' }`
//     to block the proposed step.
//   - root `subagent/end(info)` — settlement; deliver the parent notice here.
import { randomUUID } from 'node:crypto'
import { resolveConfig } from './lib/config.mjs'
import { createFailureTracker } from './lib/failure.mjs'
import { createStallTracker, isWriteActivity } from './lib/stall.mjs'
import { renderNudge, renderNotice } from './lib/notice.mjs'
import { isReadOnlyDelegation } from './lib/exempt.mjs'

export const name = 'dispatch-guard'
export const inject = ['agents']

/**
 * Read the child's own descriptor label (the delegation `description`).
 * @param agent - the child agent.
 * @returns the label, or undefined when unavailable.
 */
function readLabel(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'subagent/descriptor' && typeof event.data?.label === 'string') return event.data.label
    }
  } catch {
    // label is presentation data only
  }
  return undefined
}

/**
 * Build a complete user-role message. `Agent.inject/steer/followup` take a
 * `UserMessage`, not a bare `{ content }`: the provider rejects a message that
 * is missing `role` ("missing field `role`"), which is what poisoned earlier
 * runs. Message identity mirrors `createUserMessage` (fresh uuid, `user` source).
 * @param text - the message text.
 * @returns a frozen-shape user message the session layer accepts.
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Deliver one model-facing message to an agent, preferring live steering.
 * @param agent - the target agent.
 * @param text - the message text.
 * @param mode - `'steer'` for a running child, `'followup'` for a parent turn.
 */
function sendText(agent, text, mode) {
  const message = userMessage(text)
  if (mode === 'steer') {
    if (typeof agent?.inject === 'function') return agent.inject(message)
    if (typeof agent?.steer === 'function') return agent.steer(message)
    return undefined
  }
  if (typeof agent?.followup === 'function') return agent.followup(message)
  if (typeof agent?.steer === 'function') return agent.steer(message)
  return undefined
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const failures = createFailureTracker(config.failure)
  const stalls = createStallTracker(config.stall)

  /** childId → evidence the settlement notice needs. */
  const children = new Map()
  /** childIds already reported to their parent. */
  const reported = new Set()
  /** `parentId\0description` → delegating prompts not yet matched to a child. */
  const pendingPrompts = new Map()

  // Capture the delegating prompt before the child exists: the child only keeps
  // the descriptor label, and read-only exemption needs the prompt's intent.
  ctx.on('tools/pre-execute', (exec, next) => {
    const tool = exec?.name
    if (tool === 'subagent' || tool === 'subagent_fork') {
      const parentId = exec?.agent?.id
      const description = exec?.arguments?.description
      if (typeof parentId === 'string' && typeof description === 'string') {
        const key = `${parentId}\u0000${description}`
        const queue = pendingPrompts.get(key) ?? []
        queue.push(typeof exec.arguments.prompt === 'string' ? exec.arguments.prompt : '')
        pendingPrompts.set(key, queue)
        if (pendingPrompts.size > 512) pendingPrompts.delete(pendingPrompts.keys().next().value)
      }
    }
    return next()
  })

  ctx.on('agent/created', ({ agent }) => {
    const header = agent?.session?.header
    if (header?.origin !== 'subagent') return
    const childId = agent.id
    const label = readLabel(agent)
    const key = `${header.parentSession ?? ''}\u0000${label ?? ''}`
    const queued = pendingPrompts.get(key)
    const prompt = queued?.shift()
    if (queued !== undefined && queued.length === 0) pendingPrompts.delete(key)
    const readOnly = isReadOnlyDelegation({ label, prompt }, config.stall.exempt)

    const record = {
      parentId: header.parentSession,
      label,
      readOnly,
      steps: 0,
      writes: 0,
      files: [],
      failure: undefined,
      stallBlocked: false,
    }
    children.set(childId, record)

    agent.ctx.effect(() => agent.ctx.on('agent/request-error', (payload, next) => {
      const code = payload?.failure?.code
      if (failures.observe(childId, code) === 'retry') return next()
      record.failure = { code, message: payload?.failure?.message }
      record.steps = Math.max(record.steps, payload?.step ?? 0)
      return undefined
    }, true))

    agent.ctx.effect(() => agent.ctx.on('tools/post-execute', (exec, _result, next) => {
      if (!isWriteActivity(exec, config.stall)) return next()
      stalls.recordActivity(childId, true)
      record.writes += 1
      const path = exec?.arguments?.file_path ?? exec?.arguments?.path
      if (typeof path === 'string' && !record.files.includes(path)) record.files.push(path)
      return next()
    }))

    if (config.stall.enabled && !readOnly) {
      agent.ctx.effect(() => agent.ctx.on('agent/pre-step', (payload, next) => {
        record.steps += 1
        const verdict = stalls.beginStep(childId)
        if (verdict === 'block') {
          record.stallBlocked = true
          return { kind: 'reject' }
        }
        if (verdict === 'nudge') {
          sendText(agent, renderNudge(childId, stalls.stepsWithoutWrite(childId)), 'steer')
        }
        return next()
      }))
    }
  })

  ctx.on('subagent/end', (info) => {
    const childId = info?.childId ?? info?.id
    const record = childId === undefined ? undefined : children.get(childId)
    if (record === undefined || reported.has(childId)) return

    const stopReason = info?.stopReason ?? info?.outcome ?? info?.terminal?.stopReason
    const failed = stopReason === 'error' || record.failure !== undefined
    if (!failed && !record.stallBlocked) return
    reported.add(childId)

    const parent = ctx.agents?.get?.(record.parentId)
    if (parent === undefined) return
    const text = renderNotice({
      childId,
      label: record.label,
      reason: record.failure !== undefined ? 'error' : 'blocked（连续无写操作）',
      failureCode: record.failure?.code,
      failureMessage: record.failure?.message,
      steps: record.steps,
      writes: record.writes,
      files: record.files,
    })
    sendText(parent, text, 'followup')
  })
}
