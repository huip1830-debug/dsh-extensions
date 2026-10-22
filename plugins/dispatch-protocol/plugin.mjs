// dispatch-protocol — always-on dispatch discipline for DSH sessions.
//
// Three mechanisms, all DSH-only:
//   1. One system-prompt section, so every request (main agent and every
//      subagent) carries the five dispatch rules. Independent of which skills
//      the model chose to load.
//   2. A completion checkpoint: when a child agent finishes, the parent gets one
//      short reminder to read the diff and re-run the command the child claims.
//      Delivery waits for the parent's next turn-stopping, so a parent that
//      already acted on the report is skipped instead of re-reminded.
//      Static rules alone get skipped; a timed reminder does not.
//   3. A missed-dispatch nudge: a turn that changed several files without
//      delegating anything gets one reminder before it closes. The rules govern
//      the *form* of a dispatch and can never require one, so "did this turn
//      skip the dispatch?" is an observation, not an inference — counted from
//      the committed `tool/call` log of that turn.
//
// Why a plugin instead of AGENTS.md: AGENTS.md is shared with Codex, OpenCode
// and Claude Code, where this DSH-specific delegation discipline does not
// apply.
//
// Extension points (installed dsh 0.2.1-rc.2):
//   - `ctx.systemPrompt.section({ name, order, text, interpolate })`
//   - `agent/created({ agent })` — subagent children carry
//     `session.header.parentSession` and `origin === 'subagent'`.
//   - `subagent/end(info)` — settlement; `stopReason` says how it ended.
//   - `ctx.agents.get(parentSessionId).followup(userMessage)`.
//   - per-agent `agent/turn-stopping({ turn, signal })` — serial, fired while the
//     turn is about to close and before `turn/end` commits; a listener that
//     steers runs another step in the same turn, so a nudge costs one step and
//     cannot fire twice for the same turn.
//   - `session.snapshotEvents()` — committed `tool/call` events carry their own
//     `turn`, `name` and JSON `arguments`.
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolveConfig } from './lib/config.mjs'
import { renderNudge, shouldNudge, summarizeTurn, justifiedInTurn } from './lib/nudge.mjs'

export const name = 'dispatch-protocol'
export const inject = ['systemPrompt', 'agents']

/**
 * Build a complete user-role message. `Agent.followup` takes a `UserMessage`,
 * not a bare `{ content }`; a message without `role` is rejected by the provider.
 * @param text - the message text.
 * @returns a user message the session layer accepts.
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
 * Tool names that mark a child as execution-class. Hard-coded on purpose: a
 * child that ever *attempted* a write is execution-class even if the write was
 * refused, so the checkpoint is delivered rather than risk missing it.
 */
const CHECKPOINT_WRITE_TOOLS = ['write', 'edit']

/**
 * 判定：子代理整个会话是否零写入（只读勘察）。
 *
 * 只认已提交 `tool/call` 的工具名，尝试即算——不解析 `tool/result` 成败。
 * 判定抛错时返回 `false`（按执行类处理），与检查点「宁可多提醒」的防御风格一致。
 * @param agent - the settled child agent.
 * @returns true when the child never called `write`/`edit`.
 */
function ranReadOnly(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    return !events.some(event => event?.type === 'tool/call' && CHECKPOINT_WRITE_TOOLS.includes(event.data?.name))
  } catch {
    return false
  }
}

/** Child descriptor label, used only for the checkpoint text. */
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
 * Deliver one model-facing message while the turn is still open.
 * @param agent - the delegating agent.
 * @param text - the message text.
 * @returns the delivery result, or undefined when the agent cannot be steered.
 */
function steerText(agent, text) {
  const message = userMessage(text)
  if (typeof agent?.steer === 'function') return agent.steer(message)
  if (typeof agent?.inject === 'function') return agent.inject(message)
  return undefined
}

/**
 * Append one accounting line for a nudge decision.
 *
 * Best-effort by design: a full disk or a bad path must never close a turn.
 * @param nudge - the resolved `nudge` section.
 * @param agent - the agent whose turn closed.
 * @param summary - `{ turn, writes, files, delegations }`.
 * @param suppressed - why no message was delivered, when it was suppressed.
 */
function recordNudge(nudge, agent, summary, suppressed) {
  if (nudge.log === false) return
  try {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      session: agent?.session?.id ?? agent?.id ?? null,
      turn: summary.turn,
      writes: summary.writes,
      files: summary.files,
      delegations: summary.delegations,
      ...(suppressed === undefined ? {} : { suppressed }),
    })
    appendFileSync(nudge.log, `${line}\n`)
  } catch {
    // accounting must never break the host
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  if (config.enabled) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'dispatch-protocol',
      order: config.order,
      text: config.text,
      interpolate: false,
    }))
  }

  registerNudge(ctx, config.nudge)
  registerCheckpoint(ctx, config.checkpoint)
}

/**
 * Remind a delegating agent that closed a multi-write turn without dispatching.
 * @param ctx - the plugin context.
 * @param nudge - the resolved `nudge` section.
 */
function registerNudge(ctx, nudge) {
  if (!nudge.enabled) return

  ctx.on('agent/created', ({ agent }) => {
    // Children cannot delegate, and their writes are already covered by the
    // parent's own turn — nudging them would only add noise.
    if (agent?.session?.header?.origin === 'subagent') return
    if (typeof agent?.ctx?.on !== 'function') return

    /** Turns already reminded, so the extra step cannot re-trigger the nudge. */
    const nudgedTurns = new Set()

    const observe = ({ agent: scopedAgent, turn } = {}) => {
      try {
        const target = scopedAgent ?? agent
        if (!Number.isInteger(turn) || nudgedTurns.has(turn)) return
        const events = target?.session?.snapshotEvents?.() ?? []
        const summary = summarizeTurn(events, turn, nudge)
        if (!shouldNudge(summary, nudge)) return
        nudgedTurns.add(turn)
        const withTurn = { ...summary, turn }
        // A turn that already said why it skipped the dispatch gets no message:
        // repeating it back is pure noise. The decision is still logged.
        if (justifiedInTurn(events, turn, nudge.justifiedPatterns)) {
          recordNudge(nudge, target, withTurn, 'justified')
          return
        }
        steerText(target, renderNudge(nudge.text, withTurn))
        recordNudge(nudge, target, withTurn)
      } catch {
        // Observation is advisory: never fail a turn on it.
      }
    }

    const subscribe = () => agent.ctx.on('agent/turn-stopping', observe)
    if (typeof agent.ctx.effect === 'function') agent.ctx.effect(subscribe)
    else subscribe()
  })
}

/**
 * Remind the parent when a delegated child reports success.
 *
 * Delivery is deferred to the parent's next `agent/turn-stopping`. Settlement
 * happens right after the child reports, before the parent has read the diff,
 * so judging at settle time always reads "not handled yet". The deferred
 * judgment sees the parent's whole turn instead.
 * @param ctx - the plugin context.
 * @param checkpoint - the resolved `checkpoint` section.
 */
function registerCheckpoint(ctx, checkpoint) {
  if (!checkpoint.enabled) return

  /** childId → `{ parentId, label, agent }` for settlement lookup. */
  const children = new Map()
  const reported = new Set()
  /** parentId → Map<childId, `{ label, agent }`> awaiting the parent's next turn-stopping. */
  const pending = new Map()
  /** Parent ids whose `agent/turn-stopping` subscription is already installed. */
  const watched = new Set()

  /** Apply the skip rules (read-only child, parent already acted). */
  const needsCheckpoint = (parent, childId, record) => {
    // A child that never attempted a write is a read-only survey: there is no
    // diff to read and no command to re-run, so the checkpoint would be noise.
    if (ranReadOnly(record.agent)) return false
    if (parentAlreadyHandled(parent, record.agent, childId)) return false
    return true
  }

  const render = (record, childId) => checkpoint.text
    .replaceAll('{childId}', childId)
    .replaceAll('{label}', record.label)

  /**
   * Drain one parent's pending checkpoints. The subscription is installed once
   * per parent and reused across turns; an empty queue is a no-op.
   * @param parentId - the parent session id.
   * @param scopedAgent - the agent carried by the hook event, when present.
   */
  const drain = (parentId, scopedAgent) => {
    const queue = pending.get(parentId)
    if (queue === undefined) return
    const parent = scopedAgent ?? ctx.agents?.get?.(parentId)
    const entries = [...queue]
    pending.delete(parentId)
    if (parent === undefined) return
    for (const [childId, record] of entries) {
      try {
        if (needsCheckpoint(parent, childId, record)) steerText(parent, render(record, childId))
      } catch {
        // Observation is advisory: never fail a turn on it.
      }
    }
  }

  /** Install the parent's turn-stopping hook at most once. */
  const watch = (parent, parentId) => {
    if (watched.has(parentId)) return
    watched.add(parentId)
    const subscribe = () => parent.ctx.on('agent/turn-stopping', ({ agent } = {}) => drain(parentId, agent))
    if (typeof parent.ctx.effect === 'function') parent.ctx.effect(subscribe)
    else subscribe()
  }

  ctx.on('agent/created', ({ agent }) => {
    const header = agent?.session?.header
    if (header?.origin !== 'subagent') return
    children.set(agent.id, {
      parentId: header.parentSession,
      label: readLabel(agent) ?? '未命名',
      agent,
    })
  })

  ctx.on('subagent/end', (info) => {
    const childId = info?.childId ?? info?.id
    const record = childId === undefined ? undefined : children.get(childId)
    if (record === undefined || reported.has(childId)) return

    const stopReason = info?.stopReason ?? info?.outcome ?? info?.terminal?.stopReason
    if (stopReason !== 'completed') return
    reported.add(childId)

    const parent = ctx.agents?.get?.(record.parentId)
    if (parent === undefined) return

    if (typeof parent?.ctx?.on === 'function') {
      // Preferred: register the checkpoint and judge it at the parent's next
      // turn-stopping — by then the parent's whole turn is in its log.
      let queue = pending.get(record.parentId)
      if (queue === undefined) {
        queue = new Map()
        pending.set(record.parentId, queue)
      }
      queue.set(childId, { label: record.label, agent: record.agent })
      watch(parent, record.parentId)
      return
    }

    // Fallback: a parent with no hook scope (e.g. a nested subagent as parent).
    // Judge and deliver at settle time, as 0.3.3 did.
    if (!needsCheckpoint(parent, childId, record)) return
    if (typeof parent.followup === 'function') parent.followup(userMessage(render(record, childId)))
  })
}

/** 判定：父代理是否已经按该子代理的汇报动过手。 */
function parentAlreadyHandled(parent, child, childId) {
  try {
    const parentEvents = parent?.session?.snapshotEvents?.() ?? []
    const marker = `Agent ${childId} sent a message`
    let reportAt = -1
    for (let i = 0; i < parentEvents.length; i++) {
      const event = parentEvents[i]
      if (event?.type !== 'agent/inbox/spliced') continue
      if (!splicedTexts(event).some(text => text.includes(marker))) continue
      reportAt = i
    }
    if (reportAt < 0) return false
    if (!hasToolCallAfter(parentEvents, reportAt)) return false

    const childEvents = child?.session?.snapshotEvents?.() ?? []
    const sendAt = lastIndexWhere(childEvents, e => e?.type === 'tool/call' && e.data?.name === 'send_message')
    if (sendAt < 0) return true
    const wroteAfter = hasToolCallAfter(childEvents, sendAt, ['write', 'edit'])
    return !wroteAfter
  } catch {
    return false
  }
}

function splicedTexts(event) {
  const inserted = event?.data?.inserted
  if (!Array.isArray(inserted)) return []
  return inserted.flatMap(item => (item?.content ?? []).map(block => block?.text ?? ''))
}

function hasToolCallAfter(events, index, names) {
  for (let i = index + 1; i < events.length; i++) {
    const event = events[i]
    if (event?.type !== 'tool/call') continue
    if (!names) return true
    if (names.includes(event.data?.name)) return true
  }
  return false
}

function lastIndexWhere(events, predicate) {
  for (let i = events.length - 1; i >= 0; i--) if (predicate(events[i])) return i
  return -1
}
