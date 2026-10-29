// dispatch-protocol — always-on dispatch discipline for DSH sessions.
//
// Four mechanisms, all DSH-only:
//   1. One system-prompt section, so every request (main agent and every
//      subagent) carries the six dispatch rules. Independent of which skills
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
//   4. 状态闸门（0.6.0/0.7.0）：WaitGate（等待期只读轮询）、VerifyGate（验证后
//      又改却准备 present/commit）、ContractGate（有子代理在跑时改写契约文件）、
//      ReviewGate（只读评审后改动工作区）与 HandoffGate（空回合兜底）各提醒一次。
//      它们排在 checkpoint 之后、nudge 之前，每回合最多一条；判据只读已提交事件，
//      不拦截任何工具调用。证据 session-92f462d1：66 次状态查询轮询；最终 diff
//      在最后一次集成命令（事件 1112）之后又被改却准备收口；契约在线改写、评审
//      后未重开、空回合中断也是同一会话的形态。
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
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from './lib/config.mjs'
import { callTouchesFile, renderNudge, shouldNudge, summarizeTurn, justifiedInTurn } from './lib/nudge.mjs'
import {
  evaluateContractGate, evaluateHandoffGate, evaluateReviewGate,
  evaluateVerifyGate, evaluateWaitGate,
  renderContractGate, renderHandoffGate, renderReviewGate, renderVerifyGate, renderWaitGate,
} from './lib/gates.mjs'

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
 * 判定：子代理整个会话是否零写入（只读勘察）。
 *
 * 0.4.0 起与 nudge 共用 `callTouchesFile`：`write`/`edit` 尝试即算，`pwsh`
 * 命中变更动词也算——样本 session-82db5b7d 的 W-5 用 `Remove-Item` 删死代码、
 * 零 write/edit，被判只读而静默。判定抛错时返回 `false`（按执行类处理），
 * 与检查点「宁可多提醒」的防御风格一致。
 * @param agent - the settled child agent.
 * @returns true when the child never attempted a file mutation.
 */
function ranReadOnly(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    return !events.some(event => event?.type === 'tool/call' && callTouchesFile(event.data?.name, event.data?.arguments))
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
 * @param payload - `{ turn, kind, decision, reason?, childId?, label?, writes?, files?, delegations?, gate?, observations?, changes?, lastVerify?, emptyTurns? }`.
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
      ...(payload.deferred === undefined ? {} : { deferred: payload.deferred }),
      ...(payload.childId === undefined ? {} : { childId: payload.childId }),
      ...(payload.label === undefined ? {} : { label: payload.label }),
      ...(payload.writes === undefined ? {} : { writes: payload.writes }),
      ...(payload.files === undefined ? {} : { files: payload.files }),
      ...(payload.delegations === undefined ? {} : { delegations: payload.delegations }),
      // 0.6.0 状态闸门：与 checkpoint/nudge 共用同一份决定日志。`gate` 区分
      // wait/verify；`observations` 与 `changes`/`lastVerify` 是各自的事实字段。
      ...(payload.gate === undefined ? {} : { gate: payload.gate }),
      ...(payload.observations === undefined ? {} : { observations: payload.observations }),
      ...(payload.changes === undefined ? {} : { changes: payload.changes }),
      ...(payload.lastVerify === undefined ? {} : { lastVerify: payload.lastVerify }),
      // 0.7.0 HandoffGate：连续空回合数，供日志回答「到底空了多久」。
      ...(payload.emptyTurns === undefined ? {} : { emptyTurns: payload.emptyTurns }),
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

  registerReminders(ctx, config.nudge, config.checkpoint, config.observation, config.gates)
}

/**
 * Run the reminders from one turn-stopping handler per agent.
 *
 * The completion checkpoint is judged first and a delivered checkpoint owns the
 * turn, so a gate or nudge never shares a turn with it — no dependence on
 * subscription order, and only one `steer` per turn. 0.6.0 inserts the event
 * gates between checkpoint and nudge; 0.7.0 extends the gate order to
 * Wait → Verify → Contract → Review → Handoff. A delivered gate also owns the
 * turn, so the nudge yields to it. Turn state is keyed by parent id;
 * `lastCheckpointTurn` is recorded for the later one-turn grace rule.
 * @param ctx - the plugin context.
 * @param nudge - the resolved `nudge` section.
 * @param checkpoint - the resolved `checkpoint` section.
 * @param observation - the resolved `observation` section (0.4.0).
 * @param gates - the resolved `gates` section (0.6.0).
 */
function registerReminders(ctx, nudge, checkpoint, observation, gates) {
  if (!nudge.enabled && !checkpoint.enabled && !observation.enabled && !gates.enabled) return

  /** childId → `{ parentId, label, agent }` for settlement lookup. */
  const children = new Map()
  const reported = new Set()
  /** parentId → Map<childId, `{ label, agent }`> awaiting the parent's next turn-stopping. */
  const pending = new Map()
  /** Agent ids whose single `agent/turn-stopping` handler is already installed. */
  const watched = new Set()

  // One log for every mechanism: `nudge.log` is the key (kept for compatibility),
  // `false` silences checkpoint, nudge and state-gate decisions too.
  const decisionLog = nudge.log

  const lastDeliveredTurn = new Map()
  const lastCheckpointTurn = new Map()
  const lastNudgedTurn = new Map()
  /** parentId → last turn number that went through nudge evaluation (0.4.0). */
  const lastEvaluatedTurn = new Map()
  /** parentId → last turn number that already produced one observation row (0.4.1). */
  const lastObservedTurn = new Map()
  /** parentId → last turn number that already produced one gate message (0.6.0). */
  const lastGateTurn = new Map()
  /**
   * parentId → Map<childId, `{ label, ended }`>（0.7.0 ContractGate）。
   * 不删除已结束项：收尾判定要区分「有活跃子代理」与「本轮有过子代理」，
   * 删除会让刚结束的子代理看起来从未存在。
   */
  const activeChildren = new Map()
  /**
   * parentId → `{ pending, warned, since }`（0.7.0 ReviewGate）。
   * `since` 是评审完成时父事件的长度，即「此后的写入才算评审后改动」的边界；
   * `dirty` 不落状态，判定时从 `since` 往后扫，避免在每次 tool 事件上记账。
   */
  const reviewState = new Map()
  /**
   * parentId → Set<childId>（契约 §12-B）：已处理过 completed 的评审子代理。
   * 重复 settle 若再次建立基线，会把 warned 重置成 false，让同一轮评审多提醒
   * 一次；与 checkpoint 的 `reported` 同思路，只认第一次。新评审 child 的 id
   * 不同，仍会正常建立新基线。
   */
  const reviewSettled = new Map()

  const render = (record, childId) => checkpoint.text
    .replaceAll('{childId}', childId)
    .replaceAll('{label}', record.label)

  /**
   * Render one aggregated checkpoint for a wave of finished children (0.4.0).
   * @param entries - deliverable `[childId, record]` pairs.
   */
  const renderWave = (entries) => {
    const labels = entries.map(([, record]) => record.label)
    const shown = labels.slice(0, 5).join('、')
    const suffix = labels.length > 5 ? ` 等 ${labels.length} 个` : ''
    return checkpoint.waveText
      .replaceAll('{count}', String(entries.length))
      .replaceAll('{labels}', shown + suffix)
  }

  /**
   * Classify one pending checkpoint, applying the skip rules.
   * @param parent - the parent agent.
   * @param childId - the settled child id.
   * @param record - `{ label, agent }` for that child.
   * @returns `'delivered' | 'read-only' | 'handled'`.
   */
  const classify = (parent, childId, record) => {
    // A child that never attempted a write is a read-only survey: there is no
    // diff to read and no exit code to check, so the checkpoint would be noise.
    if (ranReadOnly(record.agent)) return 'read-only'
    if (parentAlreadyHandled(parent, record.agent, childId)) return 'handled'
    return 'delivered'
  }

  /**
   * Drain one parent's pending checkpoints and report the verdict for the turn.
   *
   * Every pending child still produces its own decision line (accounting stays
   * per child), but the model-facing message is aggregated (0.4.0): a wave that
   * finishes N children earns ONE steer, not N — per-child messages scaled with
   * fan-out and violated the "one fact, one reminder" constraint in spirit.
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
    const deliverable = []
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
        deliverable.push([childId, record])
        recordDecision(decisionLog, parent, {
          turn, kind: 'checkpoint', decision: 'delivered', childId, label: record.label,
        })
      } catch {
        // Observation is advisory: never fail a turn on it.
      }
    }
    if (deliverable.length === 1) {
      const [childId, record] = deliverable[0]
      steerText(parent, render(record, childId))
      result.delivered = true
    } else if (deliverable.length > 1) {
      steerText(parent, renderWave(deliverable))
      result.delivered = true
    }
    return result
  }

  /** label 是否命中只读评审前缀（0.7.0 ReviewGate）。 */
  const isReviewLabel = (label) => typeof label === 'string'
    && gates.review.labelPrefixes.some(prefix => label.startsWith(prefix))

  /** 该 parent 下收尾时刻仍未结束的子代理数（0.7.0 ContractGate）。 */
  const activeChildCount = (parentId) => {
    const map = activeChildren.get(parentId)
    if (map === undefined) return 0
    let count = 0
    for (const record of map.values()) if (record.ended !== true) count += 1
    return count
  }

  /**
   * 判定并投递本回合的状态闸门（0.6.0/0.7.0，契约 §3-§6）。
   *
   * 顺序固定 Wait → Verify → Contract → Review → Handoff：一个回合最多一条
   * 闸门消息（`lastGateTurn` 去重），投递后设 `lastDeliveredTurn`，nudge 让位。
   * 只对根代理生效：子代理不能再派发，它们的写入也已经记在父回合里，提醒子
   * 代理只会多一条噪音。全程 try/catch——闸门读的是宿主日志，解析失败或宿主
   * 接口变动都不该让回合失败（与 observation 的防御口径一致）。
   * @param target - 正在收尾的代理。
   * @param parentId - 该代理的会话 id。
   * @param turn - 正在收尾的回合。
   * @param isRootAgent - 是否根代理。
   * @returns true 表示本回合投递了一条闸门消息。
   */
  const evaluateGates = (target, parentId, turn, isRootAgent) => {
    if (!gates.enabled || !isRootAgent) return false
    // 同回合已经投递过任何提醒（checkpoint/nudge/闸门）就不再投闸门：那条
    // steer 已让本回合多跑一步，第二次收尾再发就是同回合两条 steer。契约
    // §11-A 的硬边界；`lastGateTurn` 只防闸门自己重复。
    if (!Number.isInteger(turn)
      || lastGateTurn.get(parentId) === turn
      || lastDeliveredTurn.get(parentId) === turn) return false
    try {
      const events = target?.session?.snapshotEvents?.() ?? []
      /** 投递一条闸门消息：steer + 决定日志 + 本回合去重 + nudge 让位。 */
      const deliver = (text, payload) => {
        steerText(target, text)
        recordDecision(decisionLog, target, { turn, kind: 'gate', decision: 'delivered', ...payload })
        lastGateTurn.set(parentId, turn)
        lastDeliveredTurn.set(parentId, turn)
        return true
      }
      // 派发工具名复用 nudge 的解析结果：两套名单若各写一份，配置改了其中
      // 一处就会出现「nudge 认为派发过、闸门认为干等」的矛盾（契约 §3）。
      const wait = evaluateWaitGate(events, turn, gates, nudge.delegationTools)
      if (wait !== null) return deliver(renderWaitGate(gates.wait.text, wait), { gate: 'wait', observations: wait.count })

      const verify = evaluateVerifyGate(events, turn, gates)
      if (verify !== null) {
        return deliver(renderVerifyGate(gates.verify.text, verify),
          { gate: 'verify', changes: verify.changes, lastVerify: verify.lastVerify })
      }

      const contract = evaluateContractGate(events, turn, gates, activeChildCount(parentId))
      if (contract !== null) {
        return deliver(renderContractGate(gates.contract.text, contract), { gate: 'contract', files: contract.files })
      }

      const review = evaluateReviewGate(events, gates, reviewState.get(parentId))
      if (review !== null) {
        const delivered = deliver(renderReviewGate(gates.review.text, review), { gate: 'review', files: review.files })
        // 同一轮评审只提醒一次；下一轮评审 created 或任一评审 completed 时重置
        // （契约 §4/§11-B/§12-B）。
        const state = reviewState.get(parentId)
        if (state !== undefined) state.warned = true
        return delivered
      }

      const handoff = evaluateHandoffGate(events, turn, gates)
      if (handoff !== null) {
        return deliver(renderHandoffGate(gates.handoff.text, handoff), { gate: 'handoff', emptyTurns: handoff.emptyTurns })
      }
      return false
    } catch {
      // 提醒是建议性的：判定失败时保持静默，绝不阻断回合。
      return false
    }
  }

  /**
   * Evaluate one turn for a missed dispatch and maybe deliver the nudge.
   *
   * The nudge yields in this order: a checkpoint already delivered this turn
   * (handled before the call, so nothing is logged twice), the turn is an
   * acceptance turn for a child report (`handled`), the previous turn received a
   * checkpoint (`grace`), or the turn's own prose already explained the skip.
   * Each of the three logged silences is written only when the nudge condition
   * itself holds, so a quiet ordinary turn adds no lines.
   *
   * 0.4.0: the evaluator returns whether it delivered, marks the turn as
   * evaluated (for the deferred check), and accepts `deferred` — a turn closed
   * by interruption never reaches `agent/turn-stopping`, so its evaluation runs
   * when the NEXT turn closes, and the decision line carries `deferred: true`.
   * @param target - the agent whose turn is closing.
   * @param parentId - that agent's session id.
   * @param turn - the turn being evaluated.
   * @param isRootAgent - whether the agent may be nudged at all.
   * @param options - `{ handled, deferred }`.
   * @returns true when the nudge was delivered.
   */
  const evaluateNudgeTurn = (target, parentId, turn, isRootAgent, { handled = false, deferred = false } = {}) => {
    // Children cannot delegate, and their writes are already covered by the
    // parent's own turn — nudging them would only add noise.
    if (!nudge.enabled || !isRootAgent) return false
    if (!Number.isInteger(turn) || lastNudgedTurn.get(parentId) === turn) return false
    if (lastDeliveredTurn.get(parentId) === turn) return false
    lastEvaluatedTurn.set(parentId, turn)
    const events = target?.session?.snapshotEvents?.() ?? []
    const summary = summarizeTurn(events, turn, nudge)
    if (!shouldNudge(summary, nudge)) return false
    lastNudgedTurn.set(parentId, turn)
    const withTurn = { ...summary, turn, ...(deferred ? { deferred: true } : {}) }
    if (handled) {
      recordDecision(decisionLog, target, { ...withTurn, kind: 'nudge', decision: 'suppressed', reason: 'handled' })
      return false
    }
    // Known cost: a real miss right after an acceptance turn goes unreminded.
    // The direction is deliberate — fewer interruptions over one lost nudge.
    if (lastCheckpointTurn.get(parentId) === turn - 1) {
      recordDecision(decisionLog, target, { ...withTurn, kind: 'nudge', decision: 'suppressed', reason: 'grace' })
      return false
    }
    // A turn that already said why it skipped the dispatch gets no message:
    // repeating it back is pure noise. The decision is still logged.
    if (justifiedInTurn(events, turn, nudge.justifiedPatterns)) {
      recordDecision(decisionLog, target, { ...withTurn, kind: 'nudge', decision: 'suppressed', reason: 'justified' })
      return false
    }
    steerText(target, renderNudge(nudge.text, withTurn))
    recordDecision(decisionLog, target, { ...withTurn, kind: 'nudge', decision: 'delivered' })
    lastDeliveredTurn.set(parentId, turn)
    return true
  }

  /**
   * Append one observation row for a root-agent turn that wrote or delegated
   * (0.4.0, G1/G7 evidence floor).
   *
   * This is the minimal answer to "evidence lived in the session and died with
   * compression": every qualifying turn leaves one machine-readable line naming
   * the files, the write counts and the delegation count. Rows are observation,
   * not a gate — nothing reads them back into the turn, and any failure is
   * swallowed by design.
   * @param target - the agent whose turn is closing.
   * @param parentId - that agent's session id.
   * @param turn - the turn being closed.
   * @param isRootAgent - child turns are covered by the parent's rows.
   */
  const observeTurn = (target, parentId, turn, isRootAgent) => {
    // One row per (session, turn) (0.4.1, I4). A `steer` makes the same turn run
    // another step, so `turn-stopping` fires again for a turn that was already
    // observed; all 7 duplicate pairs in the three samples line up one-to-one
    // with a steer (review §10.3-I4). The extra step is the model answering the
    // reminder, not new evidence, so the first row — the natural turn-end
    // snapshot — is kept and the post-steer one is dropped. Known tradeoff: if
    // that extra step really writes or delegates, the row does not record it;
    // it is accounted for under the next turn.
    if (lastObservedTurn.get(parentId) === turn) return
    if (!observation.enabled || observation.dir === false || !isRootAgent) return
    if (!Number.isInteger(turn)) return
    try {
      const cwd = target?.session?.cwd ?? target?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return
      const events = target?.session?.snapshotEvents?.() ?? []
      const summary = summarizeTurn(events, turn, nudge)
      if (summary.writes === 0 && summary.shellWrites === 0 && summary.delegations === 0) return
      const dir = join(cwd, observation.dir)
      mkdirSync(dir, { recursive: true })
      const sessionId = target?.session?.id ?? parentId ?? 'session'
      appendFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
        time: new Date().toISOString(),
        session: sessionId,
        turn,
        writes: summary.writes,
        files: summary.files,
        shellWrites: summary.shellWrites,
        failedWrites: summary.failedWrites,
        delegations: summary.delegations,
      })}\n`)
      lastObservedTurn.set(parentId, turn)
    } catch {
      // observation must never break the host
    }
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
        // Deferred evaluation (0.4.0, N2): a turn closed by user interruption
        // never fires this hook — exactly the turns that most need the nudge
        // (session-82db5b7d T5: 43 edits / 14 files / 0 dispatches, aborted by
        // the user's "为什么不派发子智能体？"). Only the immediate predecessor
        // is re-checked, and only after some turn was already evaluated, so a
        // freshly attached session never retro-nudges its backlog.
        const lastEvaluated = lastEvaluatedTurn.get(parentId)
        let deferredDelivered = false
        if (Number.isInteger(turn) && lastEvaluated !== undefined && lastEvaluated < turn - 1) {
          deferredDelivered = evaluateNudgeTurn(target, parentId, turn - 1, isRootAgent, { deferred: true })
        }
        const verdict = checkpoint.enabled
          ? drain(parentId, target, turn)
          : { delivered: false, handled: false, readOnly: false, empty: true }
        if (verdict.delivered) {
          if (Number.isInteger(turn)) {
            lastDeliveredTurn.set(parentId, turn)
            lastCheckpointTurn.set(parentId, turn)
          }
          observeTurn(target, parentId, turn, isRootAgent)
          return
        }
        // 0.6.0：闸门排在 checkpoint 之后、nudge 之前（契约 §5）。checkpoint
        // 已投递会直接 return，所以这里只在它让位时执行。闸门投递后设
        // `lastDeliveredTurn` 让 nudge 让位，但仍补一条观测行保持语义。
        // 若 deferred（N−1）nudge 已经占用这次收尾，本回合不再叠加闸门——
        // 宁可少一条提醒，也不要一次收尾投递两条 steer。
        if (!deferredDelivered && evaluateGates(target, parentId, turn, isRootAgent)) {
          observeTurn(target, parentId, turn, isRootAgent)
          return
        }
        // When the deferred nudge already consumed this turn's one reminder,
        // the current turn is deliberately left unevaluated: the next closing
        // turn picks it up through the same deferred path, so no fact is lost
        // and no turn ever carries two nudges.
        if (!deferredDelivered) evaluateNudgeTurn(target, parentId, turn, isRootAgent, { handled: verdict.handled })
        observeTurn(target, parentId, turn, isRootAgent)
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
      const parentId = header.parentSession
      const label = readLabel(agent) ?? '未命名'
      children.set(agent.id, { parentId, label, agent })
      // 0.7.0 ContractGate：登记 active child；已结束项不删除，收尾判定看
      // `ended` 标记，而不是「有没有登记过」。
      let active = activeChildren.get(parentId)
      if (active === undefined) {
        active = new Map()
        activeChildren.set(parentId, active)
      }
      active.set(agent.id, { label, ended: false })
      // 0.7.0 ReviewGate：新一轮只读评审开始就覆盖上一轮的 pending/dirty/warned，
      // 因为上一轮评审的结论已被这次评审取代（契约 §4）。
      if (isReviewLabel(label)) reviewState.set(parentId, { pending: false, warned: false, since: undefined })
    }
    attach(agent)
  })

  ctx.on('subagent/end', (info) => {
    const childId = info?.childId ?? info?.id
    const record = childId === undefined ? undefined : children.get(childId)
    const stopReason = info?.stopReason ?? info?.outcome ?? info?.terminal?.stopReason

    // 0.7.0：先更新闸门状态，再走 checkpoint 的早退（契约 §6）。checkpoint
    // 的行为与文案不变；即使 checkpoint 关闭，闸门仍需要 ended/pending。
    if (record !== undefined) {
      const active = activeChildren.get(record.parentId)?.get(childId)
      if (active !== undefined) active.ended = true
      if (isReviewLabel(record.label) && stopReason === 'completed') {
        let settled = reviewSettled.get(record.parentId)
        if (settled === undefined) {
          settled = new Set()
          reviewSettled.set(record.parentId, settled)
        }
        // 重复 settle 直接跳过：否则会把 warned 重置，同一轮评审再提醒一次。
        if (!settled.has(childId)) {
          settled.add(childId)
          const parent = ctx.agents?.get?.(record.parentId)
          let since = 0
          try {
            since = parent?.session?.snapshotEvents?.()?.length ?? 0
          } catch {
            since = 0
          }
          const state = reviewState.get(record.parentId) ?? { pending: false, warned: false, since: undefined }
          // 契约 §11-B：任一评审子代理完成都建立新基线——pending 置真、`since`
          // 取 max(旧值, 当前父事件长度)（并行切片晚完成时基线只前进不倒退）、
          // warned 重置。否则第二个评审完成后的写入会被旧 warned 永久静音。
          const oldSince = Number.isInteger(state.since) ? state.since : 0
          reviewState.set(record.parentId, {
            pending: true,
            warned: false,
            since: Math.max(oldSince, since),
          })
        }
      }
    }

    if (!checkpoint.enabled) return
    if (record === undefined || reported.has(childId)) return
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
