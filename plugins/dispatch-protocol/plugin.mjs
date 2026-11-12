// dispatch-protocol — always-on dispatch discipline for DSH sessions.
//
// Four mechanisms, all DSH-only:
//   1. One system-prompt section, so every request (main agent and every
//      subagent) carries the six dispatch rules. Independent of which skills
//      the model chose to load.
//   2. A write guard at the tool boundary (0.9.0): a root agent's `write`/`edit`
//      outside the control-plane allowlist is rejected before it runs, unless
//      `dispatch/override.json` carries a reason written in this session. The
//      rejection is a tool error — the turn continues — and it costs no model
//      step, which is what the 0.8.x turn-end nudge could not do: all 45 located
//      nudge deliveries happened after the final answer and none produced a
//      dispatch (spec 2026-11-04-dispatch-write-policy.md §1). The correction
//      point moved from "after the fact" to "before the action".
//   3. A completion checkpoint: when a child agent finishes, the parent gets one
//      short reminder to read the diff and re-run the command the child claims.
//      Delivery waits for the parent's next turn-stopping, so a parent that
//      already acted on the report is skipped instead of re-reminded.
//      Static rules alone get skipped; a timed reminder does not.
//   4. 状态闸门（0.6.0/0.7.0）：WaitGate（等待期只读轮询）、VerifyGate（验证后
//      又改却准备 present/commit）、ContractGate（有子代理在跑时改写契约文件）、
//      ReviewGate（只读评审后改动工作区）与 HandoffGate（空回合兜底）各提醒一次。
//      它们排在 checkpoint 之后，每回合最多一条；判据只读已提交事件，
//      不拦截任何工具调用。证据 session-92f462d1：66 次状态查询轮询；最终 diff
//      在最后一次集成命令（事件 1112）之后又被改却准备收口；契约在线改写、评审
//      后未重开、空回合中断也是同一会话的形态。
//
// Every guard decision that is not a control-plane write — allowed by override,
// denied, or denied in shadow mode — is appended to one shared decision log, so
// "never fired" and "fired and was silenced" stay distinguishable. Control-plane
// writes are deliberately not logged: they are the main agent's legitimate work.
//
// Why a plugin instead of AGENTS.md: AGENTS.md is shared with Codex, OpenCode
// and Claude Code, where this DSH-specific delegation discipline does not
// apply.
//
// Extension points (installed dsh 0.2.1-rc.2):
//   - `ctx.systemPrompt.section({ name, order, text, interpolate })`
//   - `ctx.tools.guard(fn)` — sync and monotonic; a returned string rejects that
//     one call and the model sees `Error: <reason>` while the turn continues.
//     Registered as `ctx.effect(() => ctx.tools.guard(guard))` so the disposer
//     removes it with the plugin.
//   - `agent/created({ agent })` — subagent children carry
//     `session.header.parentSession` and `origin === 'subagent'`.
//   - `subagent/end(info)` — settlement; `stopReason` says how it ended.
//   - `ctx.agents.get(parentSessionId).followup(userMessage)`.
//   - per-agent `agent/turn-stopping({ turn, signal })` — serial, fired while the
//     turn is about to close and before `turn/end` commits; a listener that
//     steers runs another step in the same turn, so a reminder costs one step and
//     cannot fire twice for the same turn.
//   - `session.snapshotEvents()` — committed `tool/call` events carry their own
//     `turn`, `name` and JSON `arguments`.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from './lib/config.mjs'
import { callTouchesFile, summarizeTurn } from './lib/tool-calls.mjs'
import { evaluateWritePolicy, renderDenyText } from './lib/write-policy.mjs'
import {
  evaluateContractGate, evaluateHandoffGate, evaluateReviewGate,
  evaluateVerifyGate, evaluateWaitGate,
  renderContractGate, renderHandoffGate, renderReviewGate, renderVerifyGate, renderWaitGate,
} from './lib/gates.mjs'

export const name = 'dispatch-protocol'
export const inject = ['systemPrompt', 'agents', 'tools']

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
 * 0.4.0 起与计数工具共用 `callTouchesFile`（现位于 `lib/tool-calls.mjs`）：`write`/`edit` 尝试即算，`pwsh`
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
 * @param payload - `{ turn, kind, decision, reason?, childId?, label?, writes?, files?, delegations?, gate?, observations?, changes?, lastVerify?, emptyTurns?, tool?, file?, mode? }`.
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
      // 0.6.0 状态闸门：与 checkpoint、写入守卫共用同一份决定日志。`gate` 区分
      // wait/verify；`observations` 与 `changes`/`lastVerify` 是各自的事实字段。
      ...(payload.gate === undefined ? {} : { gate: payload.gate }),
      ...(payload.observations === undefined ? {} : { observations: payload.observations }),
      ...(payload.changes === undefined ? {} : { changes: payload.changes }),
      ...(payload.lastVerify === undefined ? {} : { lastVerify: payload.lastVerify }),
      // 0.10.0 C4：ReviewGate 记录「这批脏改动是不是纯文档/控制面」，日志里能
      // 区分「换了文案的提醒」与「真的重开代码切片」。
      ...(payload.docOnly === undefined ? {} : { docOnly: payload.docOnly }),
      // 0.7.0 HandoffGate：连续空回合数，供日志回答「到底空了多久」。
      ...(payload.emptyTurns === undefined ? {} : { emptyTurns: payload.emptyTurns }),
      // 0.9.0 写入守卫：`tool`/`file` 是被放行或被拦下的具体调用，`mode` 区分
      // enforce 与 shadow（shadow 只记日志、绝不拦）。守卫的记录没有回合，`turn`
      // 落成 null。
      ...(payload.tool === undefined ? {} : { tool: payload.tool }),
      ...(payload.file === undefined ? {} : { file: payload.file }),
      ...(payload.mode === undefined ? {} : { mode: payload.mode }),
    })
    appendFileSync(log, `${line}\n`)
  } catch {
    // accounting must never break the host
  }
}

/**
 * 从工具调用参数里取目标路径。
 *
 * 只认 `file_path` 与 `path` 两个键（spec §4）：别的键既可能是目录也可能是
 * 命令，猜错会误拦。取不到就是「没有写入路径」，守卫放行。
 * @param args - `exec.arguments`（已解析的冻结对象）。
 * @returns the path, or undefined when the call names none.
 */
function readArgumentPath(args) {
  if (typeof args !== 'object' || args === null) return undefined
  const path = args.file_path ?? args.path
  return typeof path === 'string' && path !== '' ? path : undefined
}

/**
 * 读会话开始时间（毫秒），用于 override 新鲜度判断。
 *
 * 宿主两个版本分别放在 `session.createdAt` 与 `session.header.createdAt`；取不到
 * 就返回 undefined，判定退化为 fail-open（仍记 `reason: override-unbounded`）。
 * @param session - the agent's session handle.
 * @returns epoch milliseconds, or undefined.
 */
function readSessionStart(session) {
  const start = session?.createdAt ?? session?.header?.createdAt
  return typeof start === 'number' && Number.isFinite(start) ? start : undefined
}

/**
 * Build the tool-boundary guard (0.9.0, spec §4).
 *
 * 豁免顺序：没有 `agent`（宿主无作用域）→ 子代理（执行面，`origin ===
 * 'subagent'`）→ 工具不在 `writePolicy.tools` → 参数里没有路径。剩下的一律
 * 交给 `evaluateWritePolicy` 判定；判定为名单内时不写日志（控制面写入不制造
 * 噪音），override 放行记 `reason: 'override'`，拒绝记 `no-override`/`stale`/
 * `invalid` 并在 enforce 下返回拒绝串。
 *
 * 整个守卫包在 try/catch 里：守卫的 bug 绝不能影响宿主，任何异常都按放行处理
 * （fail-open）。
 * @param config - the resolved plugin config.
 * @returns a sync guard `(exec) => string | undefined`.
 */
function makeGuard(config) {
  const policy = config.writePolicy
  return (exec) => {
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return undefined
      const session = agent.session
      // 子代理是执行面：它写 src/tests/scripts 正是派发要的结果。
      if (session?.header?.origin === 'subagent') return undefined
      const tool = exec?.name
      if (typeof tool !== 'string' || !policy.tools.includes(tool)) return undefined
      const file = readArgumentPath(exec?.arguments)
      if (file === undefined) return undefined

      const cwd = session?.cwd ?? session?.header?.cwd
      const result = evaluateWritePolicy({
        file, cwd, tool, config: policy, sessionStart: readSessionStart(session),
      })

      if (result.decision === 'allow') {
        // 控制面写入是主控的合法动作：放行且不留噪音。
        if (result.reason === 'allowlist') return undefined
        recordDecision(config.log, agent, {
          kind: 'write-policy', decision: 'allowed', reason: result.reason, tool, file,
        })
        return undefined
      }

      recordDecision(config.log, agent, {
        kind: 'write-policy',
        decision: 'denied',
        reason: result.reason,
        tool,
        file,
        mode: policy.mode,
      })
      if (policy.mode === 'shadow') return undefined
      return renderDenyText({ tool, file, allowlist: policy.allowlist, overridePath: policy.overridePath })
    } catch {
      // 守卫自己出错时按放行处理：绝不影响宿主。
      return undefined
    }
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // 0.9.0：顶层 `enabled` 是**总开关**。0.8.x 里它只关提示词 section，写入守卫与
  // 收尾提醒照旧注册——插件页上「关闭」和实际行为不一致（守卫仍在拦、提醒仍在
  // 发）。关闭即什么都不注册：无 section、无写入守卫、无 checkpoint/观测/闸门。
  if (!config.enabled) return

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dispatch-protocol',
    order: config.order,
    text: config.text,
    interpolate: false,
  }))

  // 0.9.0 写入守卫：唯一能真正阻止一次写入的地方。`ctx.effect` 持有 disposer，
  // 插件卸载时守卫一并消失；`inject` 里的 `'tools'` 保证 `ctx.tools` 存在。
  if (config.writePolicy.enabled && typeof ctx.tools?.guard === 'function') {
    ctx.effect(() => ctx.tools.guard(makeGuard(config)))
  }

  registerReminders(ctx, config)
}

/**
 * Run the reminders from one turn-stopping handler per agent.
 *
 * The completion checkpoint is judged first and a delivered checkpoint owns the
 * turn, so a gate never shares a turn with it — no dependence on subscription
 * order, and only one `steer` per turn. 0.6.0 inserts the event gates after the
 * checkpoint; 0.7.0 extends the gate order to Wait → Verify → Contract → Review
 * → Handoff. 0.9.0 removes the missed-dispatch nudge entirely: the write guard
 * (see `makeGuard`) now owns that constraint at the tool boundary, so this
 * function only accounts for checkpoint / observation / gate decisions. Turn
 * state is keyed by parent id.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config (`log`, `writePolicy`, `checkpoint`,
 *   `observation`, `gates` are read here).
 */
function registerReminders(ctx, config) {
  const { log, writePolicy, checkpoint, observation, gates } = config
  if (!checkpoint.enabled && !observation.enabled && !gates.enabled) return

  /** childId → `{ parentId, label, agent }` for settlement lookup. */
  const children = new Map()
  const reported = new Set()
  /** parentId → Map<childId, `{ label, agent }`> awaiting the parent's next turn-stopping. */
  const pending = new Map()
  /** Agent ids whose single `agent/turn-stopping` handler is already installed. */
  const watched = new Set()

  // One log for every mechanism: the top-level `log` key (0.9.0; it replaced
  // `nudge.log`), `false` silences checkpoint, write-guard and state-gate
  // decisions too.
  const decisionLog = log

  const lastDeliveredTurn = new Map()
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
   * 闸门消息（`lastGateTurn` 去重），投递后设 `lastDeliveredTurn`，本回合不再投
   * 第二条提醒（0.9.0 起收尾只剩闸门与 checkpoint 两个候选）。
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
    // 同回合已经投递过任何提醒（checkpoint/闸门）就不再投闸门：那条
    // steer 已让本回合多跑一步，第二次收尾再发就是同回合两条 steer。契约
    // §11-A 的硬边界；`lastGateTurn` 只防闸门自己重复。
    if (!Number.isInteger(turn)
      || lastGateTurn.get(parentId) === turn
      || lastDeliveredTurn.get(parentId) === turn) return false
    try {
      const events = target?.session?.snapshotEvents?.() ?? []
      // 0.11.0 D2：闸门用的 cwd 与写入守卫同源（`session.cwd ?? header.cwd`）；
      // 分类器靠它把绝对路径相对化，取不到时按保守口径把写入当代码。
      const cwd = target?.session?.cwd ?? target?.session?.header?.cwd
      /** 投递一条闸门消息：steer + 决定日志 + 本回合去重。 */
      const deliver = (text, payload) => {
        steerText(target, text)
        recordDecision(decisionLog, target, { turn, kind: 'gate', decision: 'delivered', ...payload })
        lastGateTurn.set(parentId, turn)
        lastDeliveredTurn.set(parentId, turn)
        return true
      }
      // 派发工具名复用写入守卫的解析结果：两套名单若各写一份，配置改了其中
      // 一处就会出现「守卫认为派发过、闸门认为干等」的矛盾（spec §3）。
      const wait = evaluateWaitGate(events, turn, gates, writePolicy.delegationTools)
      if (wait !== null) return deliver(renderWaitGate(gates.wait.text, wait), { gate: 'wait', observations: wait.count })

      const verify = evaluateVerifyGate(events, turn, gates, cwd)
      if (verify !== null) {
        return deliver(renderVerifyGate(gates.verify.text, verify),
          { gate: 'verify', changes: verify.changes, lastVerify: verify.lastVerify })
      }

      const contract = evaluateContractGate(events, turn, gates, activeChildCount(parentId))
      if (contract !== null) {
        return deliver(renderContractGate(gates.contract.text, contract), { gate: 'contract', files: contract.files })
      }

      const review = evaluateReviewGate(events, gates, reviewState.get(parentId), cwd)
      if (review !== null) {
        // 0.11.0 D4：文案模型统一——`renderReviewGate` 按 `docOnly` 自己选
        // `{action}`（文档/控制面改动只提示机器校验，混合代码时重开受影响切片）。
        const delivered = deliver(renderReviewGate(gates.review.text, review),
          { gate: 'review', files: review.files, docOnly: review.docOnly })
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
      // 口径来自写入守卫：写入工具、派发工具、控制面名单都只有这一份真相
      // （0.9.0；此前复用的是 nudge 段）。
      const summary = summarizeTurn(events, turn, {
        writeTools: writePolicy.tools,
        delegationTools: writePolicy.delegationTools,
        controlPlanePatterns: writePolicy.allowlist,
        cwd,
      })
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
        const verdict = checkpoint.enabled
          ? drain(parentId, target, turn)
          : { delivered: false, handled: false, readOnly: false, empty: true }
        if (verdict.delivered) {
          if (Number.isInteger(turn)) lastDeliveredTurn.set(parentId, turn)
          observeTurn(target, parentId, turn, isRootAgent)
          return
        }
        // 0.6.0：闸门排在 checkpoint 之后（契约 §5）。checkpoint 已投递会直接
        // return，所以这里只在它让位时执行。闸门投递后设 `lastDeliveredTurn`，
        // 但仍补一条观测行保持语义。0.9.0 之后本回合不再有第二个提醒候选——
        // 漏派发约束已前移到工具边界（`makeGuard`），收尾只做观测。
        if (evaluateGates(target, parentId, turn, isRootAgent)) {
          observeTurn(target, parentId, turn, isRootAgent)
          return
        }
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
