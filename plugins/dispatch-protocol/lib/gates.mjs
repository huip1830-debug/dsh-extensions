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
  DEFAULT_CONTROL_PLANE_PATTERNS, DEFAULT_PWSH_SHELL_PATTERN, DEFAULT_WRITE_TOOLS, isControlPlanePath,
} from './tool-calls.mjs'

/** await 闸门的默认查询工具：全是「只读状态」类工具，不产生新证据。 */
export const DEFAULT_WAIT_TOOLS = ['list_agents', 'job_list', 'schedule_list', 'get_goal']

/** 一回合查询达到该次数才提醒（契约 §3 默认 3）。 */
export const DEFAULT_WAIT_THRESHOLD = 3

/** WaitGate 默认文案；`{count}` 为查询次数，`{tools}` 为去重工具名（最多 4 个）。 */
export const DEFAULT_WAIT_TEXT = '[dispatch-protocol] 本回合 {count} 次状态查询（{tools}），写入/派发/验证均为 0。结束回合等完成事件；只允许预算过半时主动检查一次。'

/** 视为「集成验证」的命令片段（大小写不敏感子串，契约 §4）。 */
export const DEFAULT_VERIFY_COMMANDS = ['npm test', 'npm run build', 'dotnet test', 'jest', 'tsc', 'prisma migrate deploy', 'node test']

/**
 * 文档类改动片段（0.10.0 C2，大小写不敏感子串，复用 `matchesPath`）。
 *
 * 纯文档改动没有可验证的代码行为：上游 session-32cd3319 里 3 次 VerifyGate
 * 全部由 `.md` / `AGENTS.md` 写入触发，代价是三端 build+test。这里只豁免
 * 「整批脏改动全是文档或控制面」的情形，混入任何代码路径照旧提醒。
 */
export const DEFAULT_DOC_PATTERNS = ['.md', '.mdx', 'docs/', 'dispatch/', 'LICENSE', '.gitignore', '.gitattributes']

/**
 * 无法定位路径的脏条目占位（0.10.0 C2）。
 *
 * `pwsh` 变更拿不到可靠文件名；`write`/`edit` 缺 `file_path` 时同理。占位一律
 * 算非文档——「不知道改了什么」不能当成「只是文档」。
 */
const SHELL_PATH = '<shell>'

/**
 * 收口动作里的 commit/push 识别（字符串形式，加载期编译）。
 *
 * 与观测档位的 shell 变更判定不同，这里专门匹配 git commit / push——它们是
 * 「宣布改动完成」的动作，而不是又一次文件写入。`-C <path>` 的三种写法沿用
 * 0.4.1 的修复口径（S6 t6 曾整条漏判）。
 */
export const DEFAULT_VERIFY_COMMIT_PATTERN = '\\bgit\\s+(?:-C\\s+(?:"[^"]*"|\'[^\']*\'|\\S+)\\s+)?(commit|push)\\b'

/**
 * VerifyGate 默认文案（0.10.0 C5 点名文件）。
 *
 * `{files}` 为脏路径（最多展示 3 个，多余追加「等 N 个」），`{kind}` 为
 * `代码`|`未知`；0.9.x 的 `{changes}`/`{lastVerify}` 保留兼容，旧自定义文案
 * 不会因新占位缺失而抛错。
 */
export const DEFAULT_VERIFY_TEXT = '[dispatch-protocol] 本回合准备 present/commit，但 {files}（{kind}改动）在最后一次成功集成命令之后又有改动（或从未跑过）。先跑一次集成命令并留存退出码，再收口。'

/** ContractGate：写入路径命中这些片段的文件算「契约文件」（大小写不敏感子串）。 */
export const DEFAULT_CONTRACT_PATTERNS = ['contract']

/** ContractGate 默认文案；`{files}` 为命中的去重路径（最多 3 个）。 */
export const DEFAULT_CONTRACT_TEXT = '[dispatch-protocol] 本回合在有子代理运行时改写了契约文件（{files}）。派发即冻结：先 interrupt 停批，改完重派并注明「契约已变」。'

/** ReviewGate：label 以这些前缀开头的子代理算只读评审（与 footer 的 label 约定一致）。 */
export const DEFAULT_REVIEW_LABEL_PREFIXES = ['只读评审', '只读复审']

/** ReviewGate 默认文案；`{files}` 为评审后 dirty 期间命中的去重路径（最多 3 个）。 */
export const DEFAULT_REVIEW_TEXT = '[dispatch-protocol] 本批在只读评审之后又改动了工作区（{files}）。评审已失效：重开受影响切片再收口。'

/**
 * ReviewGate 文档/控制面改动的文案（0.10.0 C4）。
 *
 * 评审之后再写文档或控制面，不会让已评审的代码切片失效；原文案要求「重开受
 * 影响切片」，上游证据里主控只能为一个文档切片再派一次评审（10.4 min /
 * 2.37M token）。这里改问「机器校验 + 最小复核」，但每个评审波次仍只提醒一次。
 */
export const DEFAULT_REVIEW_TEXT_DOC_ONLY = '[dispatch-protocol] 只读评审之后又改了文档/控制面（{files}）。这类改动不使代码切片失效：机器校验（路径/链接/括号/术语）即可，不必重开代码评审；若改的正是刚评审的那份文档，最小复核该文档即可。'

/** HandoffGate：连续空回合达到该数量才提醒（默认 1）。 */
export const DEFAULT_HANDOFF_EMPTY_TURNS = 1

/** HandoffGate 默认文案；`{emptyTurns}` 为连续空回合数（可选占位）。 */
export const DEFAULT_HANDOFF_TEXT = '[dispatch-protocol] 本回合没有任何产出（无工具调用、无文本）。若模型失稳，停止 /compact：先把进度写到 dispatch/state/<需求>.md（模板见 README「交接」），开新会话接力。'

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
    // 0.10.0 C2：文档类改动不触发 VerifyGate。随 verify 段解析，review 段复用
    // 同一份列表（与 controlPlanePatterns 一样「一份配置，两处判定」）。
    docPatterns: readStringList(verifySource.docPatterns, DEFAULT_DOC_PATTERNS, 'verify.docPatterns'),
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
    docPatterns: verify.docPatterns,
    text: readText(reviewSource.text, DEFAULT_REVIEW_TEXT, 'review.text'),
    // 0.10.0 C4：文档/控制面改动走另一套文案，明确「不必重开代码评审」。
    textDocOnly: readText(reviewSource.textDocOnly, DEFAULT_REVIEW_TEXT_DOC_ONLY, 'review.textDocOnly'),
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
 * tool-calls.mjs 里有同名私有实现；白名单不允许改它，所以这里保留一份最小副本。
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
 * tool-calls.mjs 有同名私有实现；白名单不允许改它，所以这里保留最小副本。路径
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
 * 路径是否命中配置片段（大小写不敏感子串，0.10.0 起反斜杠先归一）。
 * @param path - 调用参数里的文件路径。
 * @param patterns - 解析后的片段列表。
 */
export function matchesPath(path, patterns) {
  if (typeof path !== 'string' || path === '') return false
  const lower = path.replaceAll('\\', '/').toLowerCase()
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

/** 按引号切分一个 shell 片段（只用于 `git ...` 还原判定）。 */
function tokenizeShell(segment) {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

/** 去掉一层引号。 */
function unquote(token) {
  return token.replace(/^["']|["']$/g, '')
}

/**
 * 取一个片段的 git 动作：`{ verb, args }`；不是 git 调用返回 null。
 *
 * 只跳过 `-C <path>`、`-c <key=value>` 两种前置参数（与观测档位 `git -C` 的
 * 口径一致）；其余前置参数无法可靠判定，交给调用方按脏处理。
 */
function readGitInvocation(segment) {
  const tokens = tokenizeShell(segment).map(unquote)
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1
  if (index >= tokens.length || tokens[index].toLowerCase() !== 'git') return null
  index += 1
  while (index < tokens.length && (tokens[index] === '-C' || tokens[index] === '-c')) index += 2
  if (index >= tokens.length) return null
  return { verb: tokens[index].toLowerCase(), args: tokens.slice(index + 1) }
}

/**
 * 中性只读 git 动作（0.10.0 C3a）：与还原段出现在同一条复合命令里时，不算
 * 「又改了工作区」。上游真实误报正是 `git checkout -- …; git status --porcelain`
 * ——还原之后自查状态，不该被当成第二次脏改动。
 */
const NEUTRAL_GIT_VERBS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'remote'])

/** 段内出现这些形态即有写盘可能（C3a）：还原/只读段一律按脏处理。 */
const SHELL_WRITE_PATTERN = />|--output|Out-File|Set-Content|Add-Content|tee/i

/**
 * 一个 git 动作是否是中性只读段（C3a）。
 *
 * 名单外一律 false。`stash` 只认 `list` 子命令（`git stash` 裸调用等同 push）；
 * `branch` 只认 `--list` / `-l` / 无参数（`-d`/`-D` 会删分支）。
 */
function isNeutralReadOnlyGit(invocation) {
  if (NEUTRAL_GIT_VERBS.has(invocation.verb)) return true
  if (invocation.verb === 'stash') return (invocation.args[0] ?? '').toLowerCase() === 'list'
  if (invocation.verb === 'branch') {
    if (invocation.args.length === 0) return true
    const first = invocation.args[0].toLowerCase()
    return first === '--list' || first === '-l'
  }
  return false
}

/**
 * 一条命令是否只是把工作树还原到 HEAD（0.10.0 C3；C3a 放宽到复合命令）。
 *
 * 上游证据：`git checkout -- migration_lock.toml` 之后主控自查「这确实改动了
 * 工作区」，可它只是把文件还原到 HEAD，并没有产生新 diff。按 `|| && ; \n |`
 * 切段后，每段必须属于两类之一，且**至少有一段是还原段**才返回 true：
 *
 * - 还原段：`git [... -C <path>] checkout -- <路径…>`（`--` 必须紧跟 `checkout`，
 *   之前出现任何 token——分支/提交/选项如 `-b`——都不是「从 HEAD 还原」）、
 *   `git [... -C <path>] restore <路径…>`（不含 `--source`/`-s`，任何以 `-` 开头
 *   的参数都按脏）；
 * - 中性只读段（C3a）：`git [... -C <path>] status|diff|log|show|rev-parse|
 *   ls-files|remote …`、`git stash list`、`git branch [--list|-l]`。真实误报的
 *   `git checkout -- …; git status --porcelain` 由此豁免。
 *
 * 任何一段含 `>`/`>>`/`--output`/Out-File/Set-Content/Add-Content/tee 时整条按
 * 脏处理（有写盘可能）。其余写法（`git checkout <branch|ref>`、`git checkout
 * -b`、`git restore --source=…`、`git add`/`commit`/`rm`、非 git 命令段、无法
 * 可靠解析的段）一律返回 false——保守方向，宁可多提醒一次。
 * @param command - `pwsh` 调用里的命令文本。
 */
export function isRestoreCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return false
  // 管道/串行连接符切开：每条段都要能证明自己「不写盘」。
  const segments = command.split(/\|\||&&|[;\n\r|]/).map(part => part.trim()).filter(Boolean)
  if (segments.length === 0) return false
  let restores = 0
  for (const segment of segments) {
    if (SHELL_WRITE_PATTERN.test(segment)) return false
    const invocation = readGitInvocation(segment)
    if (invocation === null) return false
    if (invocation.verb === 'checkout') {
      const delimiter = invocation.args.indexOf('--')
      if (delimiter !== 0) return false
      if (invocation.args.length - delimiter - 1 < 1) return false
      restores += 1
      continue
    }
    if (invocation.verb === 'restore') {
      if (invocation.args.length === 0) return false
      if (invocation.args.some(arg => arg.startsWith('-'))) return false
      restores += 1
      continue
    }
    if (!isNeutralReadOnlyGit(invocation)) return false
  }
  return restores > 0
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
 * 控制面（state/ledger/specs）的写入不算脏改动——那是主控的合法动作。0.10.0
 * 起控制面扩为 `dispatch/` 整树，且 `pwsh` 里「还原到 HEAD」的命令不算脏
 * （C1/C3）。
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
  if (command === undefined || !DEFAULT_PWSH_SHELL_PATTERN.test(command)) return false
  // 0.10.0 C3：`git checkout -- <路径>` / `git restore <路径>` 只是把工作树
  // 还原到 HEAD，没有产生新 diff；无法可靠判定的写法仍按脏处理。
  if (isRestoreCommand(command)) return false
  // 复用观测档位：git commit 不是工作树内容变更，不能把「收口动作」本身
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
 *
 * 0.10.0 C2：返回值加 `files`（去重脏路径，`pwsh` 等无法定位的记 `<shell>`）
 * 与 `docOnly`（脏条目全部命中 `verify.docPatterns` 或控制面）。`docOnly` 只
 * 描述「这一批脏改动是不是纯文档」，`changes` 语义不变。
 * @param events - `session.snapshotEvents()`。
 * @param verify - 解析后的 `gates.verify`。
 * @returns `{ lastVerify, dirty, changes, files, docOnly }`。
 */
export function analyzeVerification(events, verify) {
  const log = events ?? []
  const results = collectResults(log)
  const docPatterns = verify.docPatterns ?? DEFAULT_DOC_PATTERNS
  const controlPlanePatterns = verify.controlPlanePatterns ?? DEFAULT_CONTROL_PLANE_PATTERNS

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
  let documentationOnly = true
  const files = []
  for (let i = lastIndex + 1; i < log.length; i++) {
    const event = log[i]
    if (event?.type !== 'tool/call') continue
    if (!touchedWorkingTree(event, results, controlPlanePatterns)) continue
    dirty = true
    changes += 1
    const path = dirtyPath(event)
    if (!files.includes(path)) files.push(path)
    if (path === SHELL_PATH) documentationOnly = false
    else if (!matchesPath(path, docPatterns) && !isControlPlanePath(path, controlPlanePatterns)) documentationOnly = false
  }

  return { lastVerify, dirty, changes, files, docOnly: changes > 0 && documentationOnly }
}

/**
 * 一个脏调用的展示路径：`write`/`edit` 取参数里的 `file_path`/`path`；取不到
 * （或 `pwsh` 变更）一律记 `<shell>`，因此绝不会被当成文档。
 * @param call - 一条已判定为脏的 `tool/call` 事件。
 */
function dirtyPath(call) {
  if (DEFAULT_WRITE_TOOLS.includes(call.data?.name)) {
    const path = readPath(call.data?.arguments)
    if (path !== undefined) return path
  }
  return SHELL_PATH
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
 * @param delegationTools - 派发工具名（复用 `writePolicy.delegationTools`，契约 §3）。
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
 * 0.10.0 C2：整批脏改动都是文档/控制面（`docOnly`）时静默——纯文档改动没有
 * 可验证的代码行为，「从未跑过」分支同样适用。
 * @param events - `session.snapshotEvents()`。
 * @param turn - 正在收尾的回合。
 * @param gates - 解析后的 `gates` 段。
 * @returns `{ changes, lastVerify, dirty, files, docOnly }`，不该提醒时返回 null。
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
  // C2：纯文档/控制面改动不需要集成命令。
  if (state.docOnly === true) return null
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
 * 渲染 VerifyGate 文案（0.10.0 C5）。
 *
 * 新占位 `{files}`/`{kind}` 负责点名；旧占位 `{changes}`/`{lastVerify}` 保留，
 * 0.9.x 的自定义文案照旧渲染，不会因为模板里没有新占位而抛错。
 * @param template - `gates.verify.text`。
 * @param info - `evaluateVerifyGate` 的返回值。
 */
export function renderVerifyGate(template, info) {
  return template
    .replaceAll('{files}', formatPaths(info.files))
    .replaceAll('{kind}', changeKind(info.files))
    .replaceAll('{changes}', String(info.changes))
    .replaceAll('{lastVerify}', info.lastVerify ?? '从未验证')
}

/**
 * 把去重路径拼成文案（C5）：最多展示 3 个，多余追加「等 N 个」（N 为去重后
 * 的总数）；没有可展示路径时用「工作区」。
 * @param files - 去重后的路径列表（`undefined` 按空处理）。
 */
function formatPaths(files) {
  const list = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file !== '') : []
  if (list.length === 0) return '工作区'
  const shown = list.slice(0, 3).join(', ')
  return list.length > 3 ? `${shown} 等 ${list.length} 个` : shown
}

/** `{kind}`：能指出代码路径就是「代码」，只有 `<shell>`（或空）时是「未知」。 */
function changeKind(files) {
  const list = Array.isArray(files) ? files : []
  return list.some(file => file !== SHELL_PATH) ? '代码' : '未知'
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
 *
 * 0.10.0 C4：返回值加 `docOnly`——评审后的脏改动全部命中 `docPatterns` 或
 * 控制面时为 true，调用方据此换文案（文档改动不必重开代码评审）。`files` 仍是
 * 去重路径（含 `<shell>` 占位），展示时由 `formatPaths` 截到 3 个。
 * @param events - 父代理的 `session.snapshotEvents()`。
 * @param gates - 解析后的 `gates` 段。
 * @param state - `{ pending, warned, since }`。
 * @returns `{ files, docOnly }`，不该提醒时返回 null。
 */
export function evaluateReviewGate(events, gates, state) {
  if (!gates.review.enabled || state === undefined) return null
  if (!state.pending || state.warned) return null
  const log = events ?? []
  const results = collectResults(log)
  const since = Number.isInteger(state.since) ? state.since : 0
  const docPatterns = gates.review.docPatterns ?? DEFAULT_DOC_PATTERNS
  const controlPlanePatterns = gates.review.controlPlanePatterns ?? DEFAULT_CONTROL_PLANE_PATTERNS
  const files = []
  let changes = 0
  let documentationOnly = true
  for (let i = since; i < log.length; i++) {
    const event = log[i]
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (name !== 'write' && name !== 'edit') continue
    // 0.8.2/0.10.0：控制面写入（dispatch/ 整树、specs）是主控的合法动作，不会
    // 让评审失效（既不计 `changes`，也不入 `files`）。
    const path = readPath(event.data?.arguments)
    if (isControlPlanePath(path, controlPlanePatterns)) continue
    // 与 VerifyGate 的防御口径一致：有失败结果才算没改；没有结果按改过算。
    const message = results.get(event.data?.callId)
    if (message?.isError === true) continue
    changes += 1
    const file = path ?? SHELL_PATH
    if (!files.includes(file)) files.push(file)
    if (file === SHELL_PATH) documentationOnly = false
    else if (!matchesPath(file, docPatterns) && !isControlPlanePath(file, controlPlanePatterns)) documentationOnly = false
  }
  if (changes === 0) return null
  return { files, docOnly: documentationOnly }
}

/** 渲染 ReviewGate 文案（`{files}` 最多 3 个，多余追加「等 N 个」）。 */
export function renderReviewGate(template, info) {
  return template.replaceAll('{files}', formatPaths(info.files))
}
