// 回合收尾状态闸门：WaitGate（等待期轮询）、VerifyGate（未验证就收口），
// 0.7.0 再加 ContractGate（派发冻结期改写契约）、ReviewGate（评审后改动未重开）
// 与 HandoffGate（空回合兜底）。
//
// 依据见冻结契约 `tmp/dispatch-gates-contract.md` 与
// `tmp/dispatch-gates-0.7-contract.md`，以及 session-92f462d1 审查：同一会话
// 出现 66 次状态查询（每次付一整步模型步进）；最终 diff 在最后一次集成命令
// （事件 1112）之后又被写入却准备收口；同一会话还在子代理运行期间改过契约文件、
// 在只读评审之后继续改工作区，并出现过无工具调用、无文本的空回合。这些纪律
// 原本只写在系统提示词里，提示词不会在回合收尾时被重新读一遍，所以这里把
// 「回合/会话里实际发生了什么」变成一次可核对的提醒。
//
// 设计边界（契约 §1）：只读 `session.snapshotEvents()`，不跑 git、不读磁盘、
// 不阻断任何工具调用。判定与投递失败一律吞掉——闸门是提醒，不是门禁。

import {
  DEFAULT_CONTROL_PLANE_PATTERNS, DEFAULT_PWSH_NUDGE_SHELL_PATTERN, DEFAULT_WRITE_TOOLS, isControlPlanePath,
} from './nudge.mjs'

/** await 闸门的默认查询工具：全是「只读状态」类工具，不产生新证据。 */
export const DEFAULT_WAIT_TOOLS = ['list_agents', 'job_list', 'schedule_list', 'get_goal']

/** 一回合查询达到该次数才提醒（契约 §3 默认 3）。 */
export const DEFAULT_WAIT_THRESHOLD = 3

/** WaitGate 默认文案；`{count}` 为查询次数，`{tools}` 为去重工具名（最多 4 个）。 */
export const DEFAULT_WAIT_TEXT = '[dispatch-protocol] 本回合 {count} 次状态查询（{tools}），写入/派发/验证均为 0。结束回合等完成事件；只允许预算过半时主动检查一次。'

/** 视为「集成验证」的命令片段（大小写不敏感子串，契约 §4）。 */
export const DEFAULT_VERIFY_COMMANDS = ['npm test', 'npm run build', 'dotnet test', 'jest', 'tsc', 'prisma migrate deploy', 'node test']

/**
 * 收口动作里的 commit/push 识别（字符串形式，加载期编译）。
 *
 * 与 nudge 的 shell 变更档位不同，这里专门匹配 git commit / push——它们是
 * 「宣布改动完成」的动作，而不是又一次文件写入。`-C <path>` 的三种写法沿用
 * 0.4.1 的修复口径（S6 t6 曾整条漏判）。
 */
export const DEFAULT_VERIFY_COMMIT_PATTERN = '\\bgit\\s+(?:-C\\s+(?:"[^"]*"|\'[^\']*\'|\\S+)\\s+)?(commit|push)\\b'

/** VerifyGate 默认文案；`{changes}` 为脏改动数，`{lastVerify}` 为最近一次成功验证命令。 */
export const DEFAULT_VERIFY_TEXT = '[dispatch-protocol] 本回合准备 present/commit，但当前 diff 在最后一次成功集成命令之后又有改动（或从未跑过）。先跑一次集成命令并留存退出码，再收口。'

/** ContractGate：写入路径命中这些片段的文件算「契约文件」（大小写不敏感子串）。 */
export const DEFAULT_CONTRACT_PATTERNS = ['contract']

/** ContractGate 默认文案；`{files}` 为命中的去重路径（最多 3 个）。 */
export const DEFAULT_CONTRACT_TEXT = '[dispatch-protocol] 本回合在有子代理运行时改写了契约文件（{files}）。派发即冻结：先 interrupt 停批，改完重派并注明「契约已变」。'

/** ReviewGate：label 以这些前缀开头的子代理算只读评审（与 footer 的 label 约定一致）。 */
export const DEFAULT_REVIEW_LABEL_PREFIXES = ['只读评审', '只读复审']

/** ReviewGate 默认文案；`{files}` 为评审后 dirty 期间命中的去重路径（最多 3 个）。 */
export const DEFAULT_REVIEW_TEXT = '[dispatch-protocol] 本批在只读评审之后又改动了工作区（{files}）。评审已失效：重开受影响切片再收口。'

/** HandoffGate：连续空回合达到该数量才提醒（默认 1）。 */
export const DEFAULT_HANDOFF_EMPTY_TURNS = 1

/** HandoffGate 默认文案；`{emptyTurns}` 为连续空回合数（可选占位）。 */
export const DEFAULT_HANDOFF_TEXT = '[dispatch-protocol] 本回合没有任何产出（无工具调用、无文本）。若模型失稳，停止 /compact：先把进度写到 dispatch/state.md（模板见 README「交接」），开新会话接力。'

/** 判断一个值是否普通对象（数组与 null 都不算配置对象）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验「非空字符串数组」，返回原数组。 */
function readStringList(value, fallback, name) {
  const list = value ?? fallback
  if (!Array.isArray(list) || list.length === 0
    || list.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`dispatch-protocol: gates.${name} must be a non-empty array of non-empty strings`)
  }
  return list
}

/** 校验「非空字符串」。 */
function readText(value, fallback, name) {
  const text = value ?? fallback
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`dispatch-protocol: gates.${name} must be a non-empty string`)
  }
  return text
}

/**
 * 校验并解析 `gates` 配置段（契约 §6）。
 *
 * 校验放在加载期：一个拼错的 threshold / commitPattern 若静默降级，闸门就
 * 永远不触发，而「永远不触发」和「配置正确但没命中」在日志里无法区分。错误
 * 前缀统一 `dispatch-protocol: gates.`，方便宿主一眼定位到配置段。
 * @param source - profile patch 层传入的原始 `gates` 对象。
 * @returns 解析后的 `gates` 段（含编译好的 commitRegExp）。
 */
export function resolveGates(source = {}) {
  const config = source ?? {}
  if (!isRecord(config)) throw new Error('dispatch-protocol: gates must be an object')

  // 0.8.2 控制面路径豁免：一份顶层配置，解析后同时挂到 `verify` 与 `review`
  // 两个子段，避免同一份片段要在两处各写一遍、改一处漏一处。
  const controlPlanePatterns = readStringList(config.controlPlanePatterns, DEFAULT_CONTROL_PLANE_PATTERNS, 'controlPlanePatterns')

  const waitSource = config.wait ?? {}
  if (!isRecord(waitSource)) throw new Error('dispatch-protocol: gates.wait must be an object')
  const threshold = waitSource.threshold ?? DEFAULT_WAIT_THRESHOLD
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error('dispatch-protocol: gates.wait.threshold must be a positive integer')
  }
  const wait = {
    enabled: waitSource.enabled !== false,
    threshold,
    tools: readStringList(waitSource.tools, DEFAULT_WAIT_TOOLS, 'wait.tools'),
    text: readText(waitSource.text, DEFAULT_WAIT_TEXT, 'wait.text'),
  }

  const verifySource = config.verify ?? {}
  if (!isRecord(verifySource)) throw new Error('dispatch-protocol: gates.verify must be an object')
  const commands = readStringList(verifySource.commands, DEFAULT_VERIFY_COMMANDS, 'verify.commands')
  const commitPattern = verifySource.commitPattern ?? DEFAULT_VERIFY_COMMIT_PATTERN
  if (typeof commitPattern !== 'string' || commitPattern.trim() === '') {
    throw new Error('dispatch-protocol: gates.verify.commitPattern must be a compilable regular expression string')
  }
  let commitRegExp
  try {
    commitRegExp = new RegExp(commitPattern, 'i')
  } catch {
    throw new Error('dispatch-protocol: gates.verify.commitPattern must be a compilable regular expression string')
  }

  const verify = {
    enabled: verifySource.enabled !== false,
    commands,
    commitPattern,
    commitRegExp,
    controlPlanePatterns,
    text: readText(verifySource.text, DEFAULT_VERIFY_TEXT, 'verify.text'),
  }

  const contractSource = config.contract ?? {}
  if (!isRecord(contractSource)) throw new Error('dispatch-protocol: gates.contract must be an object')
  const contract = {
    enabled: contractSource.enabled !== false,
    patterns: readStringList(contractSource.patterns, DEFAULT_CONTRACT_PATTERNS, 'contract.patterns'),
    text: readText(contractSource.text, DEFAULT_CONTRACT_TEXT, 'contract.text'),
  }

  const reviewSource = config.review ?? {}
  if (!isRecord(reviewSource)) throw new Error('dispatch-protocol: gates.review must be an object')
  const review = {
    enabled: reviewSource.enabled !== false,
    labelPrefixes: readStringList(reviewSource.labelPrefixes, DEFAULT_REVIEW_LABEL_PREFIXES, 'review.labelPrefixes'),
    controlPlanePatterns,
    text: readText(reviewSource.text, DEFAULT_REVIEW_TEXT, 'review.text'),
  }

  const handoffSource = config.handoff ?? {}
  if (!isRecord(handoffSource)) throw new Error('dispatch-protocol: gates.handoff must be an object')
  const emptyTurns = handoffSource.emptyTurns ?? DEFAULT_HANDOFF_EMPTY_TURNS
  if (!Number.isInteger(emptyTurns) || emptyTurns < 1) {
    throw new Error('dispatch-protocol: gates.handoff.emptyTurns must be a positive integer')
  }
  const handoff = {
    enabled: handoffSource.enabled !== false,
    emptyTurns,
    text: readText(handoffSource.text, DEFAULT_HANDOFF_TEXT, 'handoff.text'),
  }

  return { enabled: config.enabled !== false, controlPlanePatterns, wait, verify, contract, review, handoff }
}

/**
 * 从工具调用参数里取 shell 命令。
 *
 * nudge.mjs 里有同名私有实现；白名单不允许改它，所以这里保留一份最小副本。
 * 解析失败返回 undefined——参数坏了不能让闸门判定抛错。
 * @param raw - `tool/call` 里 JSON 编码的 arguments。
 * @returns 命令文本，或 undefined。
 */
function readCommand(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const command = JSON.parse(raw)?.command
    return typeof command === 'string' && command !== '' ? command : undefined
  } catch {
    return undefined
  }
}

/**
 * 从工具调用参数里取目标路径（0.7.0 ContractGate/ReviewGate 共用）。
 *
 * nudge.mjs 有同名私有实现；白名单不允许改它，所以这里保留最小副本。路径
 * 缺失或参数损坏时返回 undefined——匹配不到就不提醒，绝不能抛错。
 * @param raw - `tool/call` 里 JSON 编码的 arguments。
 * @returns 路径文本，或 undefined。
 */
function readPath(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const args = JSON.parse(raw)
    const path = args?.file_path ?? args?.path
    return typeof path === 'string' && path !== '' ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * 路径是否命中配置片段（大小写不敏感子串）。
 * @param path - 调用参数里的文件路径。
 * @param patterns - 解析后的片段列表。
 */
export function matchesPath(path, patterns) {
  if (typeof path !== 'string' || path === '') return false
  const lower = path.toLowerCase()
  return patterns.some(fragment => lower.includes(fragment.toLowerCase()))
}

/**
 * 命令是否命中 `gates.verify.commands`（大小写不敏感子串）。
 * @param command - 已解析的 shell 命令。
 * @param commands - 解析后的命令片段列表。
 */
export function matchesVerifyCommand(command, commands) {
  if (typeof command !== 'string' || command === '') return false
  const lower = command.toLowerCase()
  return commands.some(fragment => lower.includes(fragment.toLowerCase()))
}

/**
 * 取一条 `tool/result` 的纯文本（退出码就写在这里）。
 * @param message - `event.data.message`。
 */
function resultText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * 成功退出码判定（契约 §2）：文本里没有 `exit code: N` 且 `isError !== true`
 * 视为成功；有标记时只认 0。
 * @param message - `event.data.message`。
 */
function exitedZero(message) {
  const match = /exit code:\s*(\d+)/i.exec(resultText(message))
  return match === null || Number(match[1]) === 0
}

/** 收集 callId → result message，用于「成功/失败/无结果」三态判定。 */
function collectResults(events) {
  const results = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = message?.toolCallId
    if (typeof callId === 'string' && callId !== '') results.set(callId, message)
  }
  return results
}

/**
 * 判断一个写入类调用是否真的改了工作树。
 *
 * 三态（契约 §4）：有失败结果 → 没改；没有结果 → 按改过算（宁可多提醒，回合
 * 被打断时不能把写入抹掉）；其余 → 改过。0.8.2 起 write/edit 先取路径，命中
 * 控制面（state/ledger/specs）的写入不算脏改动——那是主控的合法动作。
 * @param call - 一条 `tool/call` 事件。
 * @param results - `collectResults` 的结果。
 * @param patterns - 控制面路径片段（`gates.verify.controlPlanePatterns`）。
 */
function touchedWorkingTree(call, results, patterns = DEFAULT_CONTROL_PLANE_PATTERNS) {
  const data = call.data ?? {}
  const name = data?.name
  if (DEFAULT_WRITE_TOOLS.includes(name)) {
    const path = readPath(data?.arguments)
    if (isControlPlanePath(path, patterns)) return false
    const message = results.get(data?.callId)
    return message === undefined || message.isError !== true
  }
  if (name !== 'pwsh') return false
  const command = readCommand(data?.arguments)
  if (command === undefined || !DEFAULT_PWSH_NUDGE_SHELL_PATTERN.test(command)) return false
  // 复用 nudge 档位：git commit 不是工作树内容变更，不能把「收口动作」本身
  // 算成一次新的脏改动（0.4.1 I3）。
  const message = results.get(data?.callId)
  return message === undefined || message.isError !== true
}

/**
 * 推导「最近一次成功验证」与它之后的脏改动（契约 §4）。
 *
 * 全 session 事件序、不跨会话；只看已提交事件。`lastVerify` 为 null 表示从未
 * 成功验证，此时按契约 §11-A「有成功写入但从未验证」才触发（零写入的纯只读
 * present 不提醒），`changes` 仍是全 session 的写入计数（默认文案不展示，但
 * 决定日志要能回答「到底改了多少」）。
 * @param events - `session.snapshotEvents()`。
 * @param verify - 解析后的 `gates.verify`。
 * @returns `{ lastVerify, dirty, changes }`。
 */
export function analyzeVerification(events, verify) {
  const log = events ?? []
  const results = collectResults(log)

  let lastIndex = -1
  let lastVerify = null
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]
    if (event?.type !== 'tool/call' || event.data?.name !== 'pwsh') continue
    const command = readCommand(event.data?.arguments)
    if (!matchesVerifyCommand(command, verify.commands)) continue
    const message = results.get(event.data?.callId)
    // 「有对应结果、isError !== true、退出码为 0」三条件缺一不可；失败或没有
    // 结果的验证调用不算验证——否则一条 `npm test` 报错就能把闸门永久静音。
    if (message === undefined || message.isError === true || !exitedZero(message)) continue
    lastIndex = i
    lastVerify = command
    break
  }

  let dirty = false
  let changes = 0
  for (let i = lastIndex + 1; i < log.length; i++) {
    const event = log[i]
    if (event?.type !== 'tool/call') continue
    if (!touchedWorkingTree(event, results, verify.controlPlanePatterns ?? DEFAULT_CONTROL_PLANE_PATTERNS)) continue
    dirty = true
    changes += 1
  }

  return { lastVerify, dirty, changes }
}

/**
 * WaitGate 判定（契约 §3）。
 *
 * 只统计本回合的 `tool/call`。一旦回合里有任何「产生新证据」的动作——写文件、
 * 派发、present、给子代理发消息/打断/杀任务、跑集成验证——就不算干等：这些
 * 动作本身会改变状态，提醒只会打断正常工作。
 * @param events - `session.snapshotEvents()`。
 * @param turn - 正在收尾的回合。
 * @param gates - 解析后的 `gates` 段。
 * @param delegationTools - 派发工具名（复用 `nudge.delegationTools`，契约 §3）。
 * @returns `{ count, tools }`，不该提醒时返回 null。
 */
export function evaluateWaitGate(events, turn, gates, delegationTools = []) {
  if (!gates.wait.enabled) return null
  const calls = (events ?? []).filter(event => event?.type === 'tool/call' && event.data?.turn === turn)
  const queries = calls.filter(call => gates.wait.tools.includes(call.data?.name))
  if (queries.length < gates.wait.threshold) return null

  const acted = calls.some((call) => {
    const name = call.data?.name
    if (name === 'write' || name === 'edit') return true
    if (delegationTools.includes(name)) return true
    if (name === 'present' || name === 'send_message' || name === 'interrupt_agent' || name === 'job_kill') return true
    if (name === 'pwsh') {
      return matchesVerifyCommand(readCommand(call.data?.arguments), gates.verify.commands)
    }
    return false
  })
  if (acted) return null

  const tools = []
  for (const call of queries) {
    if (!tools.includes(call.data.name)) tools.push(call.data.name)
  }
  return { count: queries.length, tools: tools.slice(0, 4) }
}

/**
 * VerifyGate 判定（契约 §4）。
 *
 * 触发需要同时满足：本回合出现收口动作（present，或匹配 commitPattern 的
 * git commit/push），且「有成功写入但从未验证」或「最近一次成功验证之后又脏
 * 了」（契约 §11-A：零写入的纯只读 present 豁免）。
 * 判定对齐的是「准备收口时的实际状态」，不是「这一回合有没有跑过命令」。
 * @param events - `session.snapshotEvents()`。
 * @param turn - 正在收尾的回合。
 * @param gates - 解析后的 `gates` 段。
 * @returns `{ changes, lastVerify, dirty }`，不该提醒时返回 null。
 */
export function evaluateVerifyGate(events, turn, gates) {
  if (!gates.verify.enabled) return null
  const calls = (events ?? []).filter(event => event?.type === 'tool/call' && event.data?.turn === turn)
  const closing = calls.some((call) => {
    const name = call.data?.name
    if (name === 'present') return true
    if (name !== 'pwsh') return false
    const command = readCommand(call.data?.arguments)
    return command !== undefined && gates.verify.commitRegExp.test(command)
  })
  if (!closing) return null

  const state = analyzeVerification(events, gates.verify)
  // 契约 §11-A：整会话零写入、也从未验证的纯只读 present（present 一份报告/
  // 计划）没有 diff 可验，提醒只会让模型为一条空命令多花一步。
  if (state.lastVerify === null && state.changes === 0) return null
  if (state.lastVerify !== null && !state.dirty) return null
  return state
}

/**
 * 渲染 WaitGate 文案。
 * @param template - `gates.wait.text`。
 * @param info - `evaluateWaitGate` 的返回值。
 */
export function renderWaitGate(template, info) {
  return template
    .replaceAll('{count}', String(info.count))
    .replaceAll('{tools}', info.tools.join(', '))
}

/**
 * 渲染 VerifyGate 文案。
 * @param template - `gates.verify.text`。
 * @param info - `evaluateVerifyGate` 的返回值。
 */
export function renderVerifyGate(template, info) {
  return template
    .replaceAll('{changes}', String(info.changes))
    .replaceAll('{lastVerify}', info.lastVerify ?? '从未验证')
}

/** 把去重路径拼成文案；没有可展示路径时给出明确占位。 */
function formatPaths(files) {
  return files.length === 0 ? '未记录路径' : files.join(', ')
}

/**
 * ContractGate 判定（契约 §3）。
 *
 * 只在「本回合确实改写了契约文件」且「收尾时刻仍有未结束子代理」时提醒：
 * 派发即冻结是规则 2 的硬前提，而不是另一条建议。只看收尾时刻的 active 集合
 * ——子代理在写入之后、收尾之前结束的不会触发（契约 §3 已知边界）。
 * @param events - `session.snapshotEvents()`。
 * @param turn - 正在收尾的回合。
 * @param gates - 解析后的 `gates` 段。
 * @param activeCount - 该 parent 下未结束的子代理数量。
 * @returns `{ files }`，不该提醒时返回 null。
 */
export function evaluateContractGate(events, turn, gates, activeCount = 0) {
  if (!gates.contract.enabled || !(activeCount > 0)) return null
  const calls = (events ?? []).filter(event => event?.type === 'tool/call' && event.data?.turn === turn)
  const files = []
  for (const call of calls) {
    const name = call.data?.name
    if (name !== 'write' && name !== 'edit') continue
    const path = readPath(call.data?.arguments)
    if (!matchesPath(path, gates.contract.patterns)) continue
    if (!files.includes(path)) files.push(path)
  }
  if (files.length === 0) return null
  return { files: files.slice(0, 3) }
}

/** 渲染 ContractGate 文案。 */
export function renderContractGate(template, info) {
  return template.replaceAll('{files}', formatPaths(info.files))
}

/**
 * 判断一个回合是否为空（契约 §5）：没有本回合 `tool/call`，也没有本回合带
 * 非空 `type:'text'` 块的 `assistant/message`。空回合可能是模型失稳、也可能是
 * 宿主中断；两种都值得一条「先落状态再开新会话」的提醒。
 *
 * 单次遍历预计算「不空的回合号」：逐回合重扫事件在长会话里是 O(回合×事件)，
 * 而这个判定每次 turn-stopping 都会跑。
 */
function nonEmptyTurns(events) {
  const busy = new Set()
  for (const event of events ?? []) {
    const turn = event?.data?.turn
    if (!Number.isInteger(turn)) continue
    if (event?.type === 'tool/call') {
      busy.add(turn)
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    if (content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')) {
      busy.add(turn)
    }
  }
  return busy
}

/**
 * HandoffGate 判定（契约 §5）。
 *
 * 从当前收尾回合往前数连续空回合，达到 `emptyTurns` 才提醒；日志里的
 * `emptyTurns` 是实际连续数（不是阈值）。连续空回合会在下一个空回合再次
 * 提醒（弱提醒，不阻断），`lastGateTurn` 只保证同一回合一条。
 * @param events - `session.snapshotEvents()`。
 * @param turn - 正在收尾的回合。
 * @param gates - 解析后的 `gates` 段。
 * @returns `{ emptyTurns }`，不该提醒时返回 null。
 */
export function evaluateHandoffGate(events, turn, gates) {
  if (!gates.handoff.enabled || !Number.isInteger(turn)) return null
  const busy = nonEmptyTurns(events)
  let consecutive = 0
  for (let candidate = turn; candidate >= 1; candidate--) {
    if (busy.has(candidate)) break
    consecutive += 1
  }
  if (consecutive < gates.handoff.emptyTurns) return null
  return { emptyTurns: consecutive }
}

/** 渲染 HandoffGate 文案。 */
export function renderHandoffGate(template, info) {
  return template.replaceAll('{emptyTurns}', String(info.emptyTurns))
}

/**
 * ReviewGate 判定（契约 §4）。
 *
 * 状态机由调用方维护：评审子代理 created 时重置、completed 时置 pending 并
 * 记录父事件下标 `since`；本函数只从 `since` 往后找成功的 write/edit。只看
 * 「有评审完成 + 之后有写入」，不解析评审报告 PASS/FAIL——FAIL 后返修同样应
 * 重开，方向一致（契约 §4 已知边界）。
 * @param events - 父代理的 `session.snapshotEvents()`。
 * @param gates - 解析后的 `gates` 段。
 * @param state - `{ pending, warned, since }`。
 * @returns `{ files }`，不该提醒时返回 null。
 */
export function evaluateReviewGate(events, gates, state) {
  if (!gates.review.enabled || state === undefined) return null
  if (!state.pending || state.warned) return null
  const log = events ?? []
  const results = collectResults(log)
  const since = Number.isInteger(state.since) ? state.since : 0
  const files = []
  let changes = 0
  for (let i = since; i < log.length; i++) {
    const event = log[i]
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (name !== 'write' && name !== 'edit') continue
    // 0.8.2：控制面写入（state/ledger/specs）是主控的合法动作，不会让评审失效
    // （既不计 `changes`，也不入 `files`）。
    const path = readPath(event.data?.arguments)
    if (isControlPlanePath(path, gates.review.controlPlanePatterns ?? DEFAULT_CONTROL_PLANE_PATTERNS)) continue
    // 与 VerifyGate 的防御口径一致：有失败结果才算没改；没有结果按改过算。
    const message = results.get(event.data?.callId)
    if (message?.isError === true) continue
    changes += 1
    if (path !== undefined && !files.includes(path)) files.push(path)
  }
  if (changes === 0) return null
  return { files: files.slice(0, 3) }
}

/** 渲染 ReviewGate 文案。 */
export function renderReviewGate(template, info) {
  return template.replaceAll('{files}', formatPaths(info.files))
}
