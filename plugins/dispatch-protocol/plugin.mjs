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
import { randomBytes, randomUUID } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { AUTO_TEXT, resolveConfig, resolveRulesPreset } from './lib/config.mjs'
import { DEFAULT_PROJECT_SWITCH, PROJECT_MODES, readProjectMode, readProjectPolicy, writeProjectMode } from './lib/project.mjs'
import { callTouchesFile, summarizeTurn } from './lib/tool-calls.mjs'
import { evaluateWritePolicy, normalizePath, renderDenyText, toCwdRelative } from './lib/write-policy.mjs'
import {
  evaluateContractGate, evaluateHandoffGate, evaluateReviewGate,
  evaluateVerifyGate, evaluateWaitGate,
  renderContractGate, renderHandoffGate, renderReviewGate, renderVerifyGate, renderWaitGate,
} from './lib/gates.mjs'

export const name = 'dispatch-protocol'
export const inject = ['systemPrompt', 'agents', 'tools']

// ---------------------------------------------------------------------------
// 0.15.0 项目策略文件（spec `2026-11-17-project-policy-design.md` §2.3）：把
// `dispatch/protocol.json` 里出现的字段投影到「本次判定」的配置副本上。
//
// 三个投影点共用一条口径：字段缺省即回落 profile 的原值；只读、不缓存判定结果
// （策略文件按 `(路径, mtime)` 记忆化在 `lib/project.mjs` 里），且返回的必须是
// 新对象——profile 配置是进程级共享的，就地改 `config.gates` / `config.writePolicy`
// 会让一个项目的策略泄漏到其它项目。

/**
 * 把策略字段并入一次闸门判定用的 gates（§2.3 五闸门一行）。
 *
 * `verify.commands` / `contract.patterns` 逐字段覆盖；`docs.patterns` 与
 * `controlPlanePatterns` 同时挂到 verify 与 review——0.12 起 review 复用
 * verify.docPatterns，两处不同源会让评审闸门按另一套口径判定（spec §2.3 明示
 * 「保持同源」）。
 * @param gates - 已解析的 `gates` 段（profile 值）。
 * @param policy - `readProjectPolicy` 的返回值；缺字段即回落。
 * @returns 供本次判定使用的新 gates 对象；`gates` 本身不被修改。
 */
function applyPolicyToGates(gates, policy) {
  if (policy === undefined || policy === null) return gates
  return {
    ...gates,
    verify: {
      ...gates.verify,
      ...(policy.verifyCommands === undefined ? {} : { commands: policy.verifyCommands }),
      ...(policy.docsPatterns === undefined ? {} : { docPatterns: policy.docsPatterns }),
      ...(policy.controlPlanePatterns === undefined ? {} : { controlPlanePatterns: policy.controlPlanePatterns }),
    },
    contract: {
      ...gates.contract,
      ...(policy.contractPatterns === undefined ? {} : { patterns: policy.contractPatterns }),
    },
    review: {
      ...gates.review,
      ...(policy.docsPatterns === undefined ? {} : { docPatterns: policy.docsPatterns }),
      ...(policy.controlPlanePatterns === undefined ? {} : { controlPlanePatterns: policy.controlPlanePatterns }),
    },
  }
}

/**
 * 把策略字段并入一次写入判定用的 writePolicy 副本（§2.3 写入守卫一行）。
 *
 * `controlPlanePatterns` 一并带上：`evaluateWritePolicy` 目前不消费它，但判定的
 * 配置面上要能回答「这个项目把哪些路径算控制面」——后续机制读同一份副本即可，
 * 不必再各读一次策略文件。
 * @param writePolicy - 已解析的 `writePolicy` 段（profile 值）。
 * @param policy - `readProjectPolicy` 的返回值；缺字段即回落。
 * @returns 供本次判定使用的新 writePolicy 对象；`writePolicy` 本身不被修改。
 */
function applyPolicyToWritePolicy(writePolicy, policy) {
  const allowlist = policy?.allowlist
  const controlPlanePatterns = policy?.controlPlanePatterns
  if (allowlist === undefined && controlPlanePatterns === undefined) return writePolicy
  return {
    ...writePolicy,
    ...(allowlist === undefined ? {} : { allowlist }),
    ...(controlPlanePatterns === undefined ? {} : { controlPlanePatterns }),
  }
}

/**
 * 把一个 JSON 对象渲染成提示词段正文，口径与 `resolveConfig` 完全一致
 * （标题 + 编号规则 + 空行 + footer）。
 * @param rules - 规则正文数组（不带编号）。
 * @param footer - 收尾段。
 * @returns the section body.
 */
function renderRulesText(rules, footer) {
  const numbered = rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')
  return ['## 派发纪律（DSH）', '', numbered, '', footer].join('\n')
}

/**
 * 进程内 `(mode, rules)` 渲染缓存：提示词段每次 assemble 都会求值，business
 * 预设是冻结常量（`resolveRulesPreset` 忽略 profile），重复拼 3KB 字符串没有意义。
 */
const presetTextCache = new Map()

/**
 * 按项目策略选提示词正文（§2.3 提示词段一行）。
 * @param policy - `readProjectPolicy` 的返回值。
 * @param config - the resolved plugin config（`text` 是 profile 的回落值）。
 * @returns 提示词段正文；非 business 一律回落 `config.text`（逐字节不变）。
 */
function projectTextFor(policy, config) {
  if (policy?.rules !== 'business') return config.text
  let cached = presetTextCache.get('business')
  if (cached === undefined) {
    const preset = resolveRulesPreset('business', config)
    cached = renderRulesText(preset.rules, preset.footer)
    presetTextCache.set('business', cached)
  }
  return cached
}

/** 原子写一个 JSON 文件：同目录临时文件 + `rename`（与 `lib/project.mjs` 同款口径）。 */
function writeJsonAtomically(file, document) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(document)}\n`)
    renameSync(temporary, file)
  } catch (error) {
    // rename 失败时临时文件可能已经存在：清掉，不留 `.tmp-<pid>-<rand>` 垃圾。
    try {
      unlinkSync(temporary)
    } catch {
      // 临时文件从未创建（mkdir/write 就失败了）。
    }
    throw error
  }
}

/**
 * 把 `projectSwitch.path` 解析成 `{ file, relative }`（命令层读写用）。
 *
 * `lib/project.mjs` 的解析器是私有函数且不在本批白名单里，所以这里复用同一套
 * 归一化（`normalizePath` / `toCwdRelative` 仍只有 `write-policy.mjs` 一份实现），
 * 只补「必须在 cwd 内」这一步：逃出 cwd 或无法解析一律返回 undefined，调用方
 * 回落 0.14 的 `writeProjectMode`（读写都由它给出权威的失败原因）。
 * @param cwd - 会话工作目录。
 * @param projectSwitch - 已解析的 `projectSwitch` 段。
 * @returns `{ file: absolute, relative: cwd-relative posix }`, or undefined.
 */
function resolveProjectFile(cwd, projectSwitch) {
  const settings = projectSwitch ?? DEFAULT_PROJECT_SWITCH
  const normalizedCwd = normalizePath(cwd)
  const normalizedPath = normalizePath(settings.path ?? DEFAULT_PROJECT_SWITCH.path)
  if (normalizedCwd === undefined || normalizedPath === undefined) return undefined
  // 与 `write-policy.mjs#toCwdRelative` 同一套绝对路径判定（盘符或根斜杠）。
  const absolute = /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('/')
  const file = absolute ? normalizedPath : join(normalizedCwd, normalizedPath)
  const relative = toCwdRelative(file, cwd)
  if (relative === undefined || relative === '') return undefined
  if (relative === '..' || relative.startsWith('../')) return undefined
  return { file, relative }
}

/**
 * 切换档位时保留策略文件里的其它字段（§2.3 新条款）。
 *
 * `writeProjectMode` 只写 `{"mode":…}`，按它切换会把用户手写的 `rules` /
 * `allowlist` / `verify` 等整份策略抹掉。这里先读现有 JSON，再原子写
 * `{ ...existing, mode }`；文件不存在 / 坏 JSON / 顶层不是对象时**仍走
 * `writeProjectMode`**，保持 0.14 行为（也是既有断言的口径）。
 * @param cwd - 会话工作目录。
 * @param projectSwitch - 已解析的 `projectSwitch` 段。
 * @param mode - `'full' | 'shadow' | 'off'`。
 * @returns 与 `writeProjectMode` 相同的 `{ ok, file?, mode?, reason?, error? }`。
 */
function mergeModeIntoPolicyFile(cwd, projectSwitch, mode) {
  const settings = projectSwitch ?? DEFAULT_PROJECT_SWITCH
  try {
    if (!PROJECT_MODES.includes(mode)) return { ok: false, reason: 'invalid-path' }
    if (typeof cwd !== 'string' || cwd.trim() === '') return { ok: false, reason: 'invalid-cwd' }
    const resolved = resolveProjectFile(cwd, settings)
    // 路径非法 / 逃出 cwd / cwd 归一化失败：交给 `writeProjectMode` 给出权威原因。
    if (resolved === undefined) return writeProjectMode(cwd, settings, mode)
    let existing
    try {
      const parsed = JSON.parse(readFileSync(resolved.file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) existing = parsed
    } catch {
      // 文件缺失或坏 JSON：0.14 行为，只写 mode。
    }
    if (existing === undefined) return writeProjectMode(cwd, settings, mode)
    writeJsonAtomically(resolved.file, { ...existing, mode })
    return { ok: true, file: resolved.relative, mode }
  } catch (error) {
    return { ok: false, reason: 'write-failed', error: error?.message ?? String(error) }
  }
}

/** 读一个 JSON 文件；不存在 / 坏 JSON / 读失败都返回 undefined（best-effort）。 */
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 判断一个值是否是普通对象（数组与 null 都不算）。 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 扫描项目并生成 `dispatch/protocol.json` 的内容（§2.5，全部 best-effort）。
 *
 * 每一段检测独立回落：读不到 `package.json`、目录不可列、没有锁文件都只是少
 * 写一个字段，绝不抛错。检测到的字段才写进文件——空数组在读取侧是非法字段
 * （`readProjectPolicy` 会丢掉它），写进文件只会造成误导。
 * @param cwd - 会话工作目录。
 * @returns the policy document to write.
 */
function detectProjectPolicy(cwd) {
  const has = (relative) => existsSync(join(cwd, ...relative.split('/')))
  let entries = []
  try {
    entries = readdirSync(cwd)
  } catch {
    entries = []
  }
  const lowerEntries = entries.map(entry => entry.toLowerCase())
  const hasEntry = (name) => lowerEntries.includes(name.toLowerCase())
  const hasSuffix = (suffix) => lowerEntries.some(entry => entry.endsWith(suffix))

  const packageJson = readJsonFile(join(cwd, 'package.json'))
  const hasPackageJson = isPlainRecord(packageJson)
  const scripts = hasPackageJson && isPlainRecord(packageJson.scripts) ? packageJson.scripts : {}

  // 包管理器：锁文件优先（spec §2.5 的顺序）；有 package.json 但没有锁文件时按
  // npm（npm 是基线，缺锁文件的检出仍能跑起来）。
  const manager = hasEntry('pnpm-lock.yaml') ? 'pnpm'
    : hasEntry('yarn.lock') ? 'yarn'
      : hasEntry('package-lock.json') ? 'npm'
        : hasPackageJson ? 'npm' : undefined

  const commands = []
  for (const name of ['test', 'typecheck', 'build']) {
    const script = scripts[name]
    if (typeof script !== 'string' || script.trim() === '') continue
    commands.push(name === 'test'
      ? `${manager} test`
      : manager === 'npm' ? `npm run ${name}` : `${manager} ${name}`)
  }
  if (hasEntry('uv.lock') || hasEntry('pyproject.toml')) commands.push('uv run pytest')
  if (hasSuffix('.csproj') || hasSuffix('.sln')) commands.push('dotnet test')

  // 文档目录：存在 docs/ 时把整棵目录纳入主控白名单与文档判定。
  const hasDocs = has('docs')
  const allowlist = hasDocs ? ['dispatch/', 'docs/'] : ['dispatch/']
  const docsPatterns = hasDocs ? ['.md', 'docs/'] : ['.md']

  const contractPatterns = []
  if (has('src/types')) contractPatterns.push('src/types/')
  if (has('prisma/schema.prisma')) contractPatterns.push('prisma/schema.prisma')
  for (const name of ['openapi.yaml', 'openapi.yml', 'openapi.json']) {
    if (hasEntry(name)) contractPatterns.push(name)
  }

  // 预设：DSH 插件（package.json#dsh.bundle / dsh.client）用 plugin 规则，其余
  // 项目用精简的 business 规则（spec §2.5 第 1 步）。
  const dsh = hasPackageJson && isPlainRecord(packageJson.dsh) ? packageJson.dsh : {}
  const rules = Object.hasOwn(dsh, 'bundle') || Object.hasOwn(dsh, 'client') ? 'plugin' : 'business'

  return {
    mode: 'full',
    rules,
    allowlist,
    controlPlanePatterns: allowlist.slice(),
    ...(commands.length === 0 ? {} : { verify: { commands } }),
    ...(contractPatterns.length === 0 ? {} : { contract: { patterns: contractPatterns } }),
    docs: { patterns: docsPatterns },
  }
}

/**
 * `/dispatch init`（§2.5）：扫项目、写出一份贴合的 `dispatch/protocol.json`。
 *
 * 已存在即拒绝：文件是唯一真相，覆盖会丢掉用户手写的策略。全部 best-effort——
 * 任何异常都变成 `{ kind: 'error' }`，绝不抛回宿主。
 * @param cwd - 会话工作目录。
 * @param projectSwitch - 已解析的 `projectSwitch` 段。
 * @returns the command result `{ kind, text }`.
 */
function runInit(cwd, projectSwitch) {
  try {
    const resolved = resolveProjectFile(cwd, projectSwitch)
    if (resolved === undefined) return { kind: 'error', text: 'init 失败：项目策略文件路径非法' }
    if (existsSync(resolved.file)) {
      return { kind: 'error', text: `已存在 ${resolved.relative}，未覆盖；先查看或删除该文件后再 /dispatch init` }
    }
    const document = detectProjectPolicy(cwd)
    writeJsonAtomically(resolved.file, document)
    const commandCount = document.verify?.commands?.length ?? 0
    const contractCount = document.contract?.patterns?.length ?? 0
    return {
      kind: 'success',
      text: `已生成 ${resolved.relative}（preset: ${document.rules}，命令 ${commandCount} 条，契约面 ${contractCount} 个）；随时 /dispatch off|auto|shadow|full 切档`,
    }
  } catch (error) {
    const detail = error?.message === undefined ? '' : `（${error.message}）`
    return { kind: 'error', text: `init 失败：write-failed${detail}` }
  }
}

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
  // 0.13.0 项目级开关：`off` 的决定日志每 `(session, cwd)` 只记一条（spec §3.4），
  // 否则一次会话里每次写入都会多一行噪音。
  const reported = new Set()
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
      // 0.13.0 项目级开关（spec §3.3）：`off` 直接放行（只留一条决定日志），
      // `shadow` 让判定照跑但不返回拒绝串。0.16.0 起 `auto` 同样放行（默认档，
      // 不写日志）。模式判定 fail-open，读不到标记文件不再等于 full。
      // 0.15.0：同一次读取带回策略字段（spec §2.3），守卫按项目的 allowlist
      // 判定；`off`/`shadow` 分支与 0.14 行为一致。
      const projectPolicy = readProjectPolicy(cwd, config.projectSwitch)
      const projectMode = projectPolicy.mode
      // 0.16.0：auto 与 off 一样直接放行；区别只在日志——off 保留每会话一条
      // `project-off`，auto 是默认档、不是一次判定，不写决定日志。
      if (projectMode === 'off' || projectMode === 'auto') {
        if (projectMode === 'off') {
          const key = `${session?.id ?? ''}\0${cwd ?? ''}`
          if (!reported.has(key)) {
            reported.add(key)
            recordDecision(config.log, agent, {
              kind: 'project', decision: 'suppressed', reason: 'project-off',
            })
          }
        }
        return undefined
      }
      const effectivePolicy = applyPolicyToWritePolicy(policy, projectPolicy)
      const result = evaluateWritePolicy({
        file, cwd, tool, config: effectivePolicy, sessionStart: readSessionStart(session),
      })

      if (result.decision === 'allow') {
        // 控制面写入是主控的合法动作：放行且不留噪音。
        if (result.reason === 'allowlist') return undefined
        recordDecision(config.log, agent, {
          kind: 'write-policy', decision: 'allowed', reason: result.reason, tool, file,
        })
        return undefined
      }

      // 项目 shadow：拒绝改为一条 `project-shadow` 记录，永不返回拒绝串。
      if (projectMode === 'shadow') {
        recordDecision(config.log, agent, {
          kind: 'write-policy', decision: 'allowed', reason: 'project-shadow', tool, file, mode: 'shadow',
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
      return renderDenyText({
        tool, file, allowlist: effectivePolicy.allowlist, overridePath: policy.overridePath,
      })
    } catch {
      // 守卫自己出错时按放行处理：绝不影响宿主。
      return undefined
    }
  }
}

/** `/dispatch` 的用法行：参数不在四档或 `init` 时原样返回（spec §3.1 第 3 步、§2.5 第 4 条）。 */
const COMMAND_USAGE = '用法：/dispatch [off|auto|shadow|full|init]（无参=查询）'

/**
 * 注册宿主命令 `/dispatch`（0.14.0，spec `2026-11-17-dispatch-ui-design.md` §3.1）。
 *
 * 命令是「文件唯一真相」的第二个写入口：无参读 `readProjectMode`，带参写
 * `writeProjectMode`（0.15.0 起走 `mergeModeIntoPolicyFile`，只替换 mode 并保留
 * 策略字段），`init` 生成一份项目策略文件（spec §2.5），和 UI 控件读写同一个
 * 标记文件。不写决定日志——日志只记守卫/闸门/检查点的判定，命令是用户显式
 * 动作，不需要记账。
 *
 * 注册用可选服务注入 `ctx.inject(['commands'], …)`，而不是插件顶层的 `inject`
 * 数组：`commands` 是可选能力，放进顶层会让 headless/ACP 宿主因为缺服务而整个
 * 插件不加载。没有 `inject`（测试/老宿主）或注入不回调用时静默跳过，`apply`
 * 不得因此抛错。
 *
 * 命令执行面全程 try/catch：handler 的任何异常都变成 `{ kind: 'error' }`，命令
 * 执行失败不能影响宿主回合。
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config (`projectSwitch` is read here).
 */
function registerCommand(ctx, config) {
  if (typeof ctx?.inject !== 'function') return
  const handler = ({ agent, rawInput } = {}) => {
    try {
      const session = agent?.session
      const cwd = session?.cwd ?? session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        return { kind: 'error', text: '无法确定会话工作目录' }
      }
      const settings = config.projectSwitch
      // 只有 undefined（宿主没给参）与字符串算参数形态：数组/对象/数字不是
      // 「无参查询」，按用法错误处理，否则一次畸形调用会被静默当成查询。
      if (rawInput !== undefined && typeof rawInput !== 'string') {
        return { kind: 'error', text: COMMAND_USAGE }
      }
      const argument = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : ''
      if (argument === '') {
        return { kind: 'success', text: `当前项目档位：${readProjectMode(cwd, settings)}` }
      }
      // 0.15.0 新增子命令（spec §2.5）：扫项目并生成策略文件。已存在即拒绝，
      // 不覆盖用户手写的策略。
      if (argument === 'init') return runInit(cwd, settings)
      if (!PROJECT_MODES.includes(argument)) return { kind: 'error', text: COMMAND_USAGE }

      // 0.15.0 §2.3：切换档位只替换 `mode`，文件里其它策略字段必须保留；文件
      // 缺失 / 坏 JSON 时该函数仍走 0.14 的 `writeProjectMode`（只写 mode）。
      const written = mergeModeIntoPolicyFile(cwd, settings, argument)
      if (!written.ok) {
        const detail = written.error === undefined ? '' : `（${written.error}）`
        return { kind: 'error', text: `保存失败：${written.reason}${detail}` }
      }
      // `enabled: false` 时文件照写（文件是唯一真相），但要提示「当前不生效」，
      // 否则用户会以为切换失败。
      const suffix = settings.enabled === false ? '；注意：项目开关已关闭，本文件当前不生效' : ''
      return { kind: 'success', text: `已切换为 ${written.mode}（${written.file}）${suffix}` }
    } catch (error) {
      const detail = error?.message === undefined ? '' : `（${error.message}）`
      return { kind: 'error', text: `保存失败：write-failed${detail}` }
    }
  }

  try {
    ctx.inject(['commands'], (cctx) => {
      try {
        const register = () => cctx.commands.register({
          name: 'dispatch',
          description: '查看/切换当前项目的派发纪律档位',
          input: { hint: '[off|auto|shadow|full|init]' },
          handler,
        })
        // 与 DSH settings README 的写法一致：disposer 交给子上下文的 effect，
        // 插件卸载时命令随之注销。
        if (typeof cctx.effect === 'function') return cctx.effect(register)
        return register()
      } catch {
        // 子上下文没有 commands 服务：命令能力静默缺席，其余机制照常。
        return undefined
      }
    })
  } catch {
    // 宿主拒绝可选注入（服务缺失）：静默跳过，绝不影响插件加载。
  }
}

/** 0.16.0 升级工具名；`AUTO_TEXT` 正文里逐字引用。 */
const UPGRADE_TOOL_NAME = 'dispatch_upgrade_full'

/**
 * 注册模型可调用的单向升级工具（spec `2026-11-18-dispatch-auto-mode-design.md`
 * §2.4）。
 *
 * `when` 让工具只在「根代理 + 当前 auto」时出现在模型工具表里：off/shadow/full
 * 下不可见，子代理也不可见。工具只做 auto → full；降档仍走 `/dispatch` 或 dock。
 * 定义是手写的 `ToolDefinition`（不 import `@deepseek-ai/dsh-tools`），保持
 * `node test.mjs` 零依赖；`ctx.tools.register` 只校验 `output`，这个形状合法。
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 */
function registerUpgradeTool(ctx, config) {
  if (typeof ctx?.tools?.register !== 'function') return
  const definition = {
    name: UPGRADE_TOOL_NAME,
    description: 'Switch the current project from the auto dispatch mode to full. Call only after the user explicitly confirms; never call on your own.',
    parameters: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'true only after the user explicitly agreed to switch to full' },
      },
      required: ['confirmed'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      if (args?.confirmed !== true) throw new Error('user confirmation is required')
      const agent = exec?.agent
      const session = agent?.session
      const cwd = session?.cwd ?? session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        throw new Error('cannot determine the session working directory')
      }
      const current = readProjectPolicy(cwd, config.projectSwitch).mode
      if (current === 'full') return '已是 full，无需切换'
      if (current !== 'auto') throw new Error(`current mode is ${current}; only auto can be upgraded`)
      const written = mergeModeIntoPolicyFile(cwd, config.projectSwitch, 'full')
      if (!written.ok) throw new Error(`switch failed: ${written.reason}`)
      recordDecision(config.log, agent, {
        kind: 'project', decision: 'switched', reason: 'user-confirmed', mode: 'full', file: written.file,
      })
      return `已切换为 full（${written.file}）；后续步骤按 full 执行。`
    },
  }
  try {
    ctx.effect(() => ctx.tools.register(definition, {
      when: ({ agent }) => {
        try {
          if (agent?.session?.header?.origin === 'subagent') return false
          const cwd = agent?.session?.cwd ?? agent?.session?.header?.cwd
          return readProjectPolicy(cwd, config.projectSwitch).mode === 'auto'
        } catch {
          return false
        }
      },
    }))
  } catch {
    // 工具注册失败不影响其余机制；提示段仍给出 dock / 命令的兜底路径。
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // 0.9.0：顶层 `enabled` 是**总开关**。0.8.x 里它只关提示词 section，写入守卫与
  // 收尾提醒照旧注册——插件页上「关闭」和实际行为不一致（守卫仍在拦、提醒仍在
  // 发）。关闭即什么都不注册：无 section、无写入守卫、无 checkpoint/观测/闸门。
  if (!config.enabled) return

  // 0.13.0 项目级开关（spec §3.3）：`text` 从定值改成函数，每次 assemble 按会话
  // cwd 求值。`off` 时返回空串——系统提示词渲染层会丢弃 `text.length === 0` 的
  // 段，规则随之消失；0.16.0 的 `auto` 只返回提级提示（子代理为空），其余档位
  // 维持全文/预设。拿不到 context 或判定抛错时一律回落 `config.text`：提示词
  // 组装失败会让整个请求失败，项目开关只是便利功能，不能有这种代价。
  // 0.15.0：同一次读取选择规则预设（spec §2.3）——`rules: "business"` 用精简
  // 正文，其余（含 `plugin`、缺省）逐字节回落 `config.text`。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dispatch-protocol',
    order: config.order,
    text: (context) => {
      try {
        const session = context?.agent?.session
        const cwd = session?.cwd ?? session?.header?.cwd
        const projectPolicy = readProjectPolicy(cwd, config.projectSwitch)
        if (projectPolicy.mode === 'off') return ''
        // 0.16.0：auto 只给根代理注入提级提示——子代理没有用户可问，拿到这段
        // 只会多一份无用的上下文。
        if (projectPolicy.mode === 'auto') {
          const origin = context?.agent?.session?.header?.origin
          return origin === 'subagent' ? '' : AUTO_TEXT
        }
        return projectTextFor(projectPolicy, config)
      } catch {
        return config.text
      }
    },
    interpolate: false,
  }))

  // 0.14.0 `/dispatch` 宿主命令：无参查询、带参写标记文件（spec §3.1）。
  registerCommand(ctx, config)

  // 0.16.0 模型可调用的单向升级工具（spec §2.4）。
  registerUpgradeTool(ctx, config)

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
    if (parentAlreadyHandled(parent, childId)) return 'handled'
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
    // 0.13.0 项目级开关（spec §3.3）：`off` 的项目不投递检查点，但每个 child 仍
    // 留一条 suppressed 决定——「没触发」与「触发后被静默」必须可区分。0.16.0
    // 的 `auto` 同样不投递，但它是默认档，不写 suppressed 行（与 off 的唯一差别）。
    // `empty` 保持既有语义：队列非空（上方已置 false）。
    const parentCwd = parent?.session?.cwd ?? parent?.session?.header?.cwd
    const parentMode = readProjectMode(parentCwd, config.projectSwitch)
    if (parentMode === 'off' || parentMode === 'auto') {
      if (parentMode === 'off') {
        for (const [childId, record] of entries) {
          recordDecision(decisionLog, parent, {
            turn, kind: 'checkpoint', decision: 'suppressed', reason: 'project-off', childId, label: record.label,
          })
        }
      }
      return result
    }
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
      // 0.13.0 项目级开关（spec §3.3）：`off` 的项目不投递任何状态闸门；0.16.0
      // 的 `auto` 是默认档，同样不投递（闸门只在 full/shadow 生效）。判定放在
      // cwd 之后、任何 `deliver` 之前，本回合继续走观测与收尾。
      // 0.15.0（spec §2.3）：一次读取带回策略字段，构造本回合的 `effectiveGates`
      // ——纯函数返回新对象，不改 `config.gates`；闸门文案仍取 profile 的值。
      const projectPolicy = readProjectPolicy(cwd, config.projectSwitch)
      if (projectPolicy.mode === 'off' || projectPolicy.mode === 'auto') return false
      const effectiveGates = applyPolicyToGates(gates, projectPolicy)
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
      const wait = evaluateWaitGate(events, turn, effectiveGates, writePolicy.delegationTools)
      if (wait !== null) return deliver(renderWaitGate(gates.wait.text, wait), { gate: 'wait', observations: wait.count })

      const verify = evaluateVerifyGate(events, turn, effectiveGates, cwd)
      if (verify !== null) {
        return deliver(renderVerifyGate(gates.verify.text, verify),
          { gate: 'verify', changes: verify.changes, lastVerify: verify.lastVerify })
      }

      const contract = evaluateContractGate(events, turn, effectiveGates, activeChildCount(parentId))
      if (contract !== null) {
        return deliver(renderContractGate(gates.contract.text, contract), { gate: 'contract', files: contract.files })
      }

      const review = evaluateReviewGate(events, effectiveGates, reviewState.get(parentId), cwd)
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

      const handoff = evaluateHandoffGate(events, turn, effectiveGates)
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
      // 0.13.0 项目级开关（spec §3.3）：`off` 的项目不写 jsonl、也不建目录。
      // 0.16.0 的 `auto` 同样不写：没有派发纪律的回合不是观测对象。
      const observeMode = readProjectMode(cwd, config.projectSwitch)
      if (observeMode === 'off' || observeMode === 'auto') return
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
function parentAlreadyHandled(parent, childId) {
  try {
    const parentEvents = parent?.session?.snapshotEvents?.() ?? []
    // 报告可见点（D1）：`send_message` 的 splice 与 settle notice 都是「子代理的
    // 汇报对父代理可见」的事件；取最后一条——settle 必然晚于任何此类写入。
    const marker = `Agent ${childId} sent a message`
    let reportAt = -1
    for (let i = 0; i < parentEvents.length; i++) {
      const event = parentEvents[i]
      if (event?.type === 'agent/inbox/spliced') {
        if (splicedTexts(event).some(text => text.includes(marker))) reportAt = i
        continue
      }
      const source = event?.data?.source
      if (event?.type === 'user/message' && source?.kind === 'subagent-settled'
        && source.senderSessionId === childId) reportAt = i
    }
    // 没有可见性证据时保守投递（早退不产生「已处理」的假阴性）。
    if (reportAt < 0) return false
    return hasToolCallAfter(parentEvents, reportAt)
  } catch {
    return false
  }
}

function splicedTexts(event) {
  const inserted = event?.data?.inserted
  if (!Array.isArray(inserted)) return []
  return inserted.flatMap(item => (item?.content ?? []).map(block => block?.text ?? ''))
}

function hasToolCallAfter(events, index) {
  for (let i = index + 1; i < events.length; i++) {
    if (events[i]?.type === 'tool/call') return true
  }
  return false
}
