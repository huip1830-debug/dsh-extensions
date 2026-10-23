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
// The nudge yields to the checkpoint: a turn that delivered a checkpoint, or
// that turned out to be an acceptance turn for a child report, or that directly
// follows a delivered checkpoint (one-turn grace), is left alone. Every decision
// — delivered or silenced — is appended to one shared decision log, so
// "never fired" and "fired and was silenced" stay distinguishable.
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
 * Append one accounting line for a reminder decision.
 *
 * One line per decision, silenced ones included: the log is the only place that
 * separates "never fired" from "fired and was silenced". Best-effort by design —
 * a full disk or a bad path must never close a turn.
 * @param log - the resolved decision-log path, or false when logging is off.
 * @param agent - the agent the decision belongs to.
 * @param payload - `{ turn, kind, decision, reason?, childId?, label?, writes?, files?, delegations? }`.
 */
function recordDecision(log, agent, payload) {
  if (log === false) return
  try {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      session: agent?.session?.id ?? agent?.id ?? null,
      turn: payload.turn ?? null,
      kind: payload.kind,
      decision: payload.decision,
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      ...(payload.childId === undefined ? {} : { childId: payload.childId }),
      ...(payload.label === undefined ? {} : { label: payload.label }),
      ...(payload.writes === undefined ? {} : { writes: payload.writes }),
      ...(payload.files === undefined ? {} : { files: payload.files }),
      ...(payload.delegations === undefined ? {} : { delegations: payload.delegations }),
    })
    appendFileSync(log, `${line}\n`)
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

  registerReminders(ctx, config.nudge, config.checkpoint)
}

/**
 * Run both reminders from one turn-stopping handler per agent.
 *
 * The completion checkpoint is judged first and a delivered checkpoint owns the
 * turn, so a nudge never shares a turn with it — no dependence on subscription
 * order, and only one `steer` per turn. Turn state is keyed by parent id;
 * `lastCheckpointTurn` is recorded for the later one-turn grace rule.
 * @param ctx - the plugin context.
 * @param nudge - the resolved `nudge` section.
 * @param checkpoint - the resolved `checkpoint` section.
 */
function registerReminders(ctx, nudge, checkpoint) {
  if (!nudge.enabled && !checkpoint.enabled) return

  /** childId → `{ parentId, label, agent }` for settlement lookup. */
  const children = new Map()
  const reported = new Set()
  /** parentId → Map<childId, `{ label, agent }`> awaiting the parent's next turn-stopping. */
  const pending = new Map()
  /** Agent ids whose single `agent/turn-stopping` handler is already installed. */
  const watched = new Set()

  // One log for both mechanisms: `nudge.log` is the key (kept for compatibility),
  // `false` silences checkpoint decisions too.
  const decisionLog = nudge.log

  const lastDeliveredTurn = new Map()
  const lastCheckpointTurn = new Map()
  const lastNudgedTurn = new Map()

  const render = (record, childId) => checkpoint.text
    .replaceAll('{childId}', childId)
    .replaceAll('{label}', record.label)

  /**
   * Classify one pending checkpoint, applying the skip rules.
   * @param parent - the parent agent.
   * @param childId - the settled child id.
   * @param record - `{ label, agent }` for that child.
   * @returns `'delivered' | 'read-only' | 'handled'`.
   */
  const classify = (parent, childId, record) => {
    // A child that never attempted a write is a read-only survey: there is no
    // diff to read and no command to re-run, so the checkpoint would be noise.
    if (ranReadOnly(record.agent)) return 'read-only'
    if (parentAlreadyHandled(parent, record.agent, childId)) return 'handled'
    return 'delivered'
  }

  /**
   * Drain one parent's pending checkpoints and report the verdict for the turn.
   *
   * Every pending child produces exactly one decision line: delivered when
   * steered, suppressed with `read-only` or `handled` otherwise.
   * @param parentId - the parent session id.
   * @param scopedAgent - the agent carried by the hook event, when present.
   * @param turn - the turn being closed, for the decision log.
   * @returns `{ delivered, handled, readOnly, empty }`.
   */
  const drain = (parentId, scopedAgent, turn) => {
    const result = { delivered: false, handled: false, readOnly: false, empty: true }
    const queue = pending.get(parentId)
    if (queue === undefined) return result
    result.empty = false
    const parent = scopedAgent ?? ctx.agents?.get?.(parentId)
    const entries = [...queue]
    pending.delete(parentId)
    if (parent === undefined) return result
    for (const [childId, record] of entries) {
      try {
        const verdict = classify(parent, childId, record)
        if (verdict === 'read-only') {
          result.readOnly = true
          recordDecision(decisionLog, parent, {
            turn, kind: 'checkpoint', decision: 'suppressed', reason: 'read-only', childId, label: record.label,
          })
          continue
        }
        if (verdict === 'handled') {
          result.handled = true
          recordDecision(decisionLog, parent, {
            turn, kind: 'checkpoint', decision: 'suppressed', reason: 'handled', childId, label: record.label,
          })
          continue
        }
        steerText(parent, render(record, childId))
        result.delivered = true
        recordDecision(decisionLog, parent, {
          turn, kind: 'checkpoint', decision: 'delivered', childId, label: record.label,
        })
      } catch {
        // Observation is advisory: never fail a turn on it.
      }
    }
    return result
  }

  /**
   * Remind a root agent that closed a multi-write turn without dispatching.
   *
   * The nudge yields in this order: a checkpoint already delivered this turn
   * (handled before the call, so nothing is logged twice), the turn is an
   * acceptance turn for a child report (`handled`), the previous turn received a
   * checkpoint (`grace`), or the turn's own prose already explained the skip.
   * Each of the three logged silences is written only when the nudge condition
   * itself holds, so a quiet ordinary turn adds no lines.
   * @param target - the agent whose turn is closing.
   * @param parentId - that agent's session id.
   * @param turn - the turn being closed.
   * @param isRootAgent - whether the agent may be nudged at all.
   * @param handled - whether a pending checkpoint judged this an acceptance turn.
   */
  const evaluateNudge = (target, parentId, turn, isRootAgent, handled) => {
    // Children cannot delegate, and their writes are already covered by the
    // parent's own turn — nudging them would only add noise.
    if (!nudge.enabled || !isRootAgent) return
    if (!Number.isInteger(turn) || lastNudgedTurn.get(parentId) === turn) return
    if (lastDeliveredTurn.get(parentId) === turn) return
    const events = target?.session?.snapshotEvents?.() ?? []
    const summary = summarizeTurn(events, turn, nudge)
    if (!shouldNudge(summary, nudge)) return
    lastNudgedTurn.set(parentId, turn)
    const withTurn = { ...summary, turn }
    if (handled) {
      recordDecision(decisionLog, target, { ...withTurn, kind: 'nudge', decision: 'suppressed', reason: 'handled' })
      return
    }
    // Known cost: a real miss right after an acceptance turn goes unreminded.
    // The direction is deliberate — fewer interruptions over one lost nudge.
    if (lastCheckpointTurn.get(parentId) === turn - 1) {
      recordDecision(decisionLog, target, { ...withTurn, kind: 'nudge', decision: 'suppressed', reason: 'grace' })
      return
    }
    // A turn that already said why it skipped the dispatch gets no message:
    // repeating it back is pure noise. The decision is still logged.
    if (justifiedInTurn(events, turn, nudge.justifiedPatterns)) {
      recordDecision(decisionLog, target, { ...withTurn, kind: 'nudge', decision: 'suppressed', reason: 'justified' })
      return
    }
    steerText(target, renderNudge(nudge.text, withTurn))
    recordDecision(decisionLog, target, { ...withTurn, kind: 'nudge', decision: 'delivered' })
    lastDeliveredTurn.set(parentId, turn)
  }

  /** Install the single turn-stopping handler for one agent, at most once. */
  const attach = (agent) => {
    if (typeof agent?.ctx?.on !== 'function') return
    // Canonical key: the settlement queue is keyed by the parent *session* id
    // (`session.header.parentSession`), which is not the agent handle id.
    const parentId = agent?.session?.id ?? agent?.id
    if (parentId === undefined || watched.has(parentId)) return
    watched.add(parentId)
    const isRootAgent = agent?.session?.header?.origin !== 'subagent'

    const handle = ({ agent: scopedAgent, turn } = {}) => {
      try {
        const target = scopedAgent ?? agent
        const verdict = checkpoint.enabled
          ? drain(parentId, target, turn)
          : { delivered: false, handled: false, readOnly: false, empty: true }
        if (verdict.delivered) {
          if (Number.isInteger(turn)) {
            lastDeliveredTurn.set(parentId, turn)
            lastCheckpointTurn.set(parentId, turn)
          }
          return
        }
        evaluateNudge(target, parentId, turn, isRootAgent, verdict.handled)
      } catch {
        // Observation is advisory: never fail a turn on it.
      }
    }

    const subscribe = () => agent.ctx.on('agent/turn-stopping', handle)
    if (typeof agent.ctx.effect === 'function') agent.ctx.effect(subscribe)
    else subscribe()
  }

  ctx.on('agent/created', ({ agent }) => {
    const header = agent?.session?.header
    if (header?.origin === 'subagent') {
      children.set(agent.id, {
        parentId: header.parentSession,
        label: readLabel(agent) ?? '未命名',
        agent,
      })
    }
    attach(agent)
  })

  ctx.on('subagent/end', (info) => {
    if (!checkpoint.enabled) return
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
      attach(parent)
      return
    }

    // Fallback: a parent with no hook scope (e.g. a nested subagent as parent).
    // Judge and deliver at settle time, as 0.3.3 did. No turn is known yet, so
    // the decision line carries `turn: null`.
    const verdict = classify(parent, childId, record)
    recordDecision(decisionLog, parent, {
      kind: 'checkpoint',
      decision: verdict === 'delivered' ? 'delivered' : 'suppressed',
      ...(verdict === 'delivered' ? {} : { reason: verdict }),
      childId,
      label: record.label,
    })
    if (verdict !== 'delivered') return
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
