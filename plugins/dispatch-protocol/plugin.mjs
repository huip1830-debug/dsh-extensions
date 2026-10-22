// dispatch-protocol — always-on dispatch discipline for DSH sessions.
//
// Three mechanisms, all DSH-only:
//   1. One system-prompt section, so every request (main agent and every
//      subagent) carries the five dispatch rules. Independent of which skills
//      the model chose to load.
//   2. A completion checkpoint: when a child agent finishes, its parent gets one
//      short reminder to read the diff and re-run the command the child claims.
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
import { renderNudge, shouldNudge, summarizeTurn } from './lib/nudge.mjs'

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
 * Append one accounting line for a delivered nudge.
 *
 * Best-effort by design: a full disk or a bad path must never close a turn.
 * @param nudge - the resolved `nudge` section.
 * @param agent - the nudged agent.
 * @param summary - `{ turn, writes, files, delegations }`.
 */
function recordNudge(nudge, agent, summary) {
  if (nudge.log === false) return
  try {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      session: agent?.session?.id ?? agent?.id ?? null,
      turn: summary.turn,
      writes: summary.writes,
      files: summary.files,
      delegations: summary.delegations,
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
 * @param ctx - the plugin context.
 * @param checkpoint - the resolved `checkpoint` section.
 */
function registerCheckpoint(ctx, checkpoint) {
  if (!checkpoint.enabled) return

  /** childId → `{ parentId, label }` for settlement lookup. */
  const children = new Map()
  const reported = new Set()

  ctx.on('agent/created', ({ agent }) => {
    const header = agent?.session?.header
    if (header?.origin !== 'subagent') return
    children.set(agent.id, {
      parentId: header.parentSession,
      label: readLabel(agent) ?? '未命名',
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
    const text = checkpoint.text
      .replaceAll('{childId}', childId)
      .replaceAll('{label}', record.label)
    if (typeof parent.followup === 'function') parent.followup(userMessage(text))
  })
}
