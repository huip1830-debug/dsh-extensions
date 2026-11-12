// 工具调用计数器：从已提交的 `tool/call` 事件里数「谁写了哪些文件、派发了几次」。
//
// 0.9.0 起本模块由 `lib/nudge.mjs` 裁剪而来：nudge（漏派发提醒）整套判定/投递
// 已删除，只留下 checkpoint 的只读判定、observation 的观测行、以及状态闸门
// （`lib/gates.mjs`）共用的计数工具。写入约束已经前移到工具边界
// （`lib/write-policy.mjs` 的 `ctx.tools.guard`），这里只做**事实统计**，不做
// 任何模型可见的判定或文案。
//
// 计数的口径（沿用 0.4.0 起的证据口径）：`write`/`edit` 尝试即算，`pwsh` 命中
// 变更动词也算——样本 session-82db5b7d 的 W-5 用 `Remove-Item` 删死代码、零
// write/edit，被判只读而静默。

/** Delegation tools: a turn that used one of these did not miss the dispatch. */
export const DEFAULT_DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'workflow']

/** Tools whose calls count as "touched a file" for this check. */
export const DEFAULT_WRITE_TOOLS = ['write', 'edit']

/**
 * 产物分类（0.11.0 D1）：闸门与观测只消费这四个值。
 *
 * 0.10.0 的教训：控制面集合是子串 `dispatch/`，于是 `src/app/dispatch/state.ts`
 * 这类同名源码路径被连带豁免（假阴性：未验证的代码改动不再触发闸门）。0.11.0
 * 改成「先相对化到 cwd，再按路径段判定」的单一分类器，方向是宁可多报。
 */
export const ARTIFACT = { CONTROL: 'control-plane', DOC: 'doc', CODE: 'code', UNKNOWN: 'unknown' }

/**
 * 控制面路径片段（0.8.2 起；0.11.0 D1 改为路径段匹配）。
 *
 * 规则 1 明许主控写 `dispatch/` 整棵子树（台账、spec、override 凭据、勘察记录、
 * 观测行）与 `docs/superpowers/specs/*`：这些写入是主控的合法控制面动作，不是
 * 脏改动或评审失效的信号。
 *
 * 0.10.0（C1）：集合与写入守卫的 `writePolicy.allowlist` 同值
 * （`lib/write-policy.mjs` 的 `DEFAULT_ALLOWLIST`）。0.9.1 只豁免
 * state/ledger/specs，`dispatch/override.json`、`dispatch/recon/*`、
 * `dispatch/runs/*` 仍被闸门当脏改动——上游证据 4 次注入 0 真阳性里有一次正是
 * `dispatch/override.json`。
 *
 * 0.11.0（D1）：匹配口径收敛为路径段前缀——带尾 `/` 按目录前缀，否则按整段
 * 相等或 `pattern + '/'` 前缀。`src/app/dispatch/state.ts` 不再命中 `dispatch/`。
 */
export const DEFAULT_CONTROL_PLANE_PATTERNS = ['dispatch/', 'docs/superpowers/specs/']

/** 比较前的模式归一：反斜杠转正斜杠、去前导 `./`（只用于配置片段）。 */
function normalizeForMatch(value) {
  let slashed = value.replaceAll('\\', '/')
  while (slashed.startsWith('./')) slashed = slashed.slice(2)
  return slashed
}

/** 绝对路径判定：POSIX 根、UNC 或 Windows 盘符。 */
function isAbsoluteLike(value) {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value)
}

/** 逃出根的哨兵（D1-2a）：`..` 折叠越过根 → 整条路径不可信，直接 CODE。 */
const UNTRUSTED_PATH = Symbol('untrusted-path')

/**
 * 段级归一（D1-2a）：`\`→`/`、按 `/` 切段、丢弃空段与 `.`、逐段折叠 `..`。
 *
 * 绝对路径先摘出盘符/根（含 UNC `//server/share`），只对根之后的段折叠——
 * `D:\proj\dispatch\..\src\x.ts` → `D:/proj/src/x.ts`。相对路径的 `..` 折叠到
 * 栈空即「逃出根」：返回哨兵，调用方必须直接给 CODE，不得再做控制面/文档判定
 * （否则 `dispatch/../src/x.ts` 会成为一条路径穿越绕过）。
 * @param value - 原始路径（非空）。
 * @returns 归一后的正斜杠路径，或 UNTRUSTED_PATH。
 */
function foldPath(value) {
  const slashed = value.replaceAll('\\', '/')
  let prefix = ''
  let rest = slashed
  if (slashed.startsWith('//')) {
    const parts = slashed.split('/').filter(segment => segment !== '')
    if (parts.length < 2) return UNTRUSTED_PATH
    prefix = `//${parts[0]}/${parts[1]}`
    rest = parts.slice(2).join('/')
  } else if (/^[A-Za-z]:(\/|$)/.test(slashed)) {
    prefix = slashed.slice(0, 2)
    rest = slashed.slice(2).replace(/^\/+/, '')
  } else if (slashed.startsWith('/')) {
    prefix = '/'
    rest = slashed.replace(/^\/+/, '')
  }
  const stack = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return UNTRUSTED_PATH
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  const folded = stack.join('/')
  if (prefix === '') return folded
  if (prefix === '/') return `/${folded}`
  if (folded === '') return `${prefix}/`
  return `${prefix}/${folded}`
}

/**
 * 把写入路径换成 cwd 相对路径（D1-2 / D1-2a）。
 *
 * 先做段级归一（折叠 `.`/`..`，逃出根 → 哨兵），再相对化：绝对路径按大小写
 * 不敏感比较 cwd，命中时去掉 `cwd + '/'`。绝对路径等于 cwd、跑出 cwd，或归一
 * 不可信时返回 undefined/哨兵（调用方按代码处理，保守）。
 * @param file - 调用参数里的文件路径（已非空）。
 * @param cwd - 会话工作目录。
 * @returns cwd 相对路径、undefined，或 UNTRUSTED_PATH。
 */
function toCwdRelative(file, cwd) {
  const normalizedFile = foldPath(file)
  if (normalizedFile === UNTRUSTED_PATH) return UNTRUSTED_PATH
  if (!isAbsoluteLike(normalizedFile)) return normalizedFile
  const normalizedCwd = foldPath(cwd)
  if (normalizedCwd === UNTRUSTED_PATH) return UNTRUSTED_PATH
  const cwdRoot = normalizedCwd.replace(/\/+$/, '')
  const fileLower = normalizedFile.toLowerCase()
  const cwdLower = cwdRoot.toLowerCase()
  if (fileLower === cwdLower) return undefined
  if (!fileLower.startsWith(`${cwdLower}/`)) return undefined
  return normalizedFile.slice(cwdRoot.length + 1)
}

/**
 * 控制面命中（D1-3）：带尾 `/` 按目录段前缀；否则整段相等或 `pattern + '/'`。
 * @param path - 已小写的 cwd 相对路径。
 * @param patterns - 控制面片段列表。
 */
function matchesControlPlane(path, patterns) {
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string' || pattern === '') return false
    const needle = normalizeForMatch(pattern).toLowerCase()
    if (needle === '') return false
    if (needle.endsWith('/')) return path.startsWith(needle)
    return path === needle || path.startsWith(`${needle}/`)
  })
}

/**
 * 单段名模式（如 `LICENSE`）：整段相等，或路径首段以它开头（D1-4 的
 * 「段相等或段前缀」）。`a/LICENSE` 命中（整段相等），`LICENSE-MIT` 命中（首段
 * 前缀），`a/LICENSE-BACKUP` 不命中。
 * @param path - 已小写的 cwd 相对路径。
 * @param needle - 已小写的单段模式。
 */
function matchesNameSegment(path, needle) {
  return path.startsWith(needle) || path.split('/').includes(needle)
}

/**
 * 文档命中（D1-4）。
 *
 * 以 `.` 开头按扩展名后缀；有扩展名的路径只按扩展名判文档（`docs/agent/a.ts`
 * 不因为 `docs/` 前缀变成文档——扩展优先）；无扩展名时，`/` 结尾按段前缀，
 * 其余按段相等或首段前缀。
 * @param path - 已小写的 cwd 相对路径。
 * @param patterns - 文档片段列表。
 */
function isDocumentation(path, patterns) {
  const slash = path.lastIndexOf('/')
  const basename = slash === -1 ? path : path.slice(slash + 1)
  const extensioned = basename.includes('.')
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string' || pattern === '') return false
    const needle = normalizeForMatch(pattern).toLowerCase()
    if (needle === '') return false
    if (needle.startsWith('.')) return path.endsWith(needle)
    if (extensioned) return false
    if (needle.endsWith('/')) return path.startsWith(needle)
    if (needle.includes('/')) return path === needle || path.startsWith(`${needle}/`)
    return matchesNameSegment(path, needle)
  })
}

/**
 * 唯一分类器（0.11.0 D1）：一个写入路径是控制面、文档还是代码。
 *
 * 判定顺序：缺失/空 → `UNKNOWN`；归一 + 相对化；控制面；文档；其余 `CODE`。
 * cwd 缺失或为空时不做相对化，控制面判定一律失败 → `CODE`（保守方向：闸门
 * 宁可多提醒，也不要把未验证的写入当文档/控制面静音）。
 * @param file - `write`/`edit` 调用参数里的文件路径。
 * @param options - `{ cwd, controlPlanePatterns, docPatterns }`。
 * @returns `ARTIFACT.CONTROL | ARTIFACT.DOC | ARTIFACT.CODE | ARTIFACT.UNKNOWN`。
 */
export function classifyPath(file, options = {}) {
  const config = options ?? {}
  if (typeof file !== 'string' || file.trim() === '') return ARTIFACT.UNKNOWN
  const cwd = typeof config.cwd === 'string' ? config.cwd.trim() : ''
  if (cwd === '') return ARTIFACT.CODE
  const relativePath = toCwdRelative(file.trim(), cwd)
  // D1-2a：逃出根的 `..` 是不可信路径 —— 直接 CODE，不得再尝试控制面/文档
  // 判定（`dispatch/../src/x.ts` 曾因此绕过闸门）。
  if (relativePath === UNTRUSTED_PATH) return ARTIFACT.CODE
  if (relativePath === undefined || relativePath === '') return ARTIFACT.CODE
  const target = relativePath.toLowerCase()
  const controlPatterns = config.controlPlanePatterns ?? DEFAULT_CONTROL_PLANE_PATTERNS
  const docPatterns = config.docPatterns ?? []
  if (matchesControlPlane(target, controlPatterns)) return ARTIFACT.CONTROL
  if (isDocumentation(target, docPatterns)) return ARTIFACT.DOC
  return ARTIFACT.CODE
}

/**
 * Shell command fragments that mutate files or the repo tree (0.4.0; redirect
 * lookbehind and git `-C` widened in 0.4.1).
 *
 * The write-tools list cannot see a `pwsh` deletion: sample session-82db5b7d's
 * W-5 removed dead files with `Remove-Item` and zero `write`/`edit` calls, and
 * was judged read-only. This pattern is the shared fix for both the observation
 * counter and the checkpoint's read-only verdict. It is deliberately
 * over-inclusive (a mutation verb in an unexecuted branch still counts) — the
 * cost of a false positive is one extra observation row, the cost of a false
 * negative is a silently unverified write batch. Build/test/db commands
 * (`dotnet build`, `npx jest`, `prisma migrate`) are intentionally absent:
 * they touch artifacts, not the reviewed source set.
 *
 * 0.4.1 (I5): the redirect branch now also ignores a `>` that follows `=`, `-`
 * or `?`, so `=>`, `->` and generics such as `<string?>` no longer read as
 * output redirects (`2>&1` was already excluded by the `\d`/`&` guards).
 * Accepted limit: a bare generic `<T>` still matches, because its `>` follows a
 * letter — none of the three reviewed samples used that shape.
 * 0.4.1 (I3): the git branch accepts an optional `-C <path>` (bare word or
 * single/double quoted). `git -C <path> commit` used to slip past
 * `\bgit\s+commit` (S6 t6) and was counted nowhere.
 */
export const DEFAULT_PWSH_MUTATION_PATTERN = /\b(Remove-Item|Set-Content|Out-File|Add-Content|Clear-Content|New-Item|Copy-Item|Move-Item|Rename-Item|ri|del|erase|ren|rename|move|copy|mkdir|rmdir|rd|tee)\b|(?<![\d&=\-?])>{1,2}(?![&=\d])|\bgit\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?(apply|checkout|restore|commit|merge|rebase|cherry-pick|rm|mv|clean)\b/i

/**
 * The same shell-mutation shape minus the `commit` verb — the observation tier
 * of the 0.4.1 (I3) split.
 *
 * Commit rights belong to the dispatcher (rule 5), so the dispatcher's own
 * `git commit` must not count as a working-tree change; four observed false
 * positives: sample four T3, S5 t34, S6 t13 and S7 t2. The checkpoint's
 * read-only verdict keeps the full pattern above: a child that commits is
 * execution-class and is not exempt from review.
 *
 * Accepted cost: a commit-only turn now reports no observation row (shellWrites
 * stays 0, so `observeTurn` early-returns). Commit evidence lives in git history;
 * the observation row only tracks working-tree content changes. `git checkout --
 * <file>` still counts, because restoring a working-tree file is a content change.
 *
 * 0.9.0：由 `DEFAULT_PWSH_NUDGE_SHELL_PATTERN` 更名而来——nudge 已删除，这个
 * 档位现在是「观测档」，被 observation 与 VerifyGate/ReviewGate 复用。
 */
export const DEFAULT_PWSH_SHELL_PATTERN = /\b(Remove-Item|Set-Content|Out-File|Add-Content|Clear-Content|New-Item|Copy-Item|Move-Item|Rename-Item|ri|del|erase|ren|rename|move|copy|mkdir|rmdir|rd|tee)\b|(?<![\d&=\-?])>{1,2}(?![&=\d])|\bgit\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?(apply|checkout|restore|merge|rebase|cherry-pick|rm|mv|clean)\b/i

/**
 * Decide whether one committed tool call touched a file.
 *
 * `write`/`edit` always count; `pwsh` counts only when the command carries a
 * mutation verb or an output redirect. Attempted-but-refused calls still count
 * for the checkpoint's read-only verdict (defensive direction), so callers
 * that care about results must filter those before asking.
 * @param name - the tool name from `tool/call`.
 * @param argsJson - the JSON-encoded arguments string the log stores.
 * @param writeTools - the resolved write-tool list.
 * @param mutationPattern - the shell-mutation pattern.
 * @returns true when the call attempted a file mutation.
 */
export function callTouchesFile(name, argsJson, writeTools = DEFAULT_WRITE_TOOLS, mutationPattern = DEFAULT_PWSH_MUTATION_PATTERN) {
  if (typeof name !== 'string') return false
  if (writeTools.includes(name)) return true
  if (name !== 'pwsh') return false
  const command = readCommand(argsJson)
  return command !== undefined && mutationPattern.test(command)
}

/**
 * Read the shell command out of a tool call's arguments.
 * @param raw - the JSON-encoded arguments string the log stores.
 * @returns the command, or undefined when the call names none.
 */
export function readCommand(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const command = JSON.parse(raw)?.command
    return typeof command === 'string' && command !== '' ? command : undefined
  } catch {
    return undefined
  }
}

/**
 * Count one turn's file writes and delegations from the committed session log.
 *
 * `tool/call` carries its own `turn`, so a turn boundary needs no bookkeeping:
 * everything is derived from the log, and a resumed session computes the same
 * numbers as a live one.
 *
 * 0.9.0：第三个参数从「nudge 配置段」改成口径对象——nudge 段已删除，调用方
 * （observation 与闸门）直接传写入守卫的名单，避免配置里出现第二套真相：
 * `{ writeTools, delegationTools, controlPlanePatterns, shellPattern?, cwd? }`。
 * 0.11.0：控制面判定改用 `classifyPath`（D1），`cwd` 用于把绝对路径相对化；
 * 省略 `cwd` 时按保守口径把控制面写入算作执行工作。
 * @param events - `session.snapshotEvents()`.
 * @param turn - the turn being closed.
 * @param options - `{ writeTools, delegationTools, controlPlanePatterns, shellPattern, cwd }`.
 * @param shellPattern - shell-mutation pattern for `shellWrites`; defaults to
 *   the observation tier, which excludes `git commit` (0.4.1).
 * @returns `{ writes, files, shellWrites, failedWrites, delegations }` for that turn.
 */
export function summarizeTurn(events, turn, options = {}, shellPattern) {
  const config = options ?? {}
  // `options` 可能是 null（调用方显式传 null）：默认参数只在实参为 undefined 时
  // 生效，原先在参数列表里读 `options.shellPattern` 会抛 TypeError。先归一成对象
  // 再解析档位，判定口径不变。
  const pattern = shellPattern ?? config.shellPattern ?? DEFAULT_PWSH_SHELL_PATTERN
  const writeTools = config.writeTools ?? DEFAULT_WRITE_TOOLS
  const delegationTools = config.delegationTools ?? DEFAULT_DELEGATION_TOOLS
  const controlPlanePatterns = config.controlPlanePatterns ?? DEFAULT_CONTROL_PLANE_PATTERNS
  const cwd = typeof config.cwd === 'string' ? config.cwd : undefined
  const log = events ?? []
  const failedCallIds = collectFailedCallIds(log)
  const writes = []
  const files = []
  let delegations = 0
  let shellWrites = 0
  let failedWrites = 0

  for (const event of log) {
    if (event?.type !== 'tool/call') continue
    const data = event.data ?? {}
    if (data.turn !== turn) continue
    const tool = data.name
    if (typeof tool !== 'string') continue

    if (delegationTools.includes(tool)) {
      delegations += 1
      continue
    }
    if (!writeTools.includes(tool) && tool !== 'pwsh') continue
    // A refused write never touched the file: skip it. A call with no id, or
    // with no result event, stays counted — a missing result must not erase a
    // write.
    if (failedCallIds.has(data.callId)) {
      failedWrites += 1
      continue
    }

    if (writeTools.includes(tool)) {
      const path = readPath(data.arguments)
      // 0.8.2 控制面写入（state/ledger/specs）是主控的合法动作，既不计
      // `writes`，也不进 `files`。`pwsh` 壳变更没有可靠路径，口径不变。
      // 0.11.0：口径统一走 `classifyPath`——没有 cwd 时控制面判定失败，写入
      // 按执行工作计数（保守）。
      if (classifyPath(path, { cwd, controlPlanePatterns }) === ARTIFACT.CONTROL) continue
      writes.push(tool)
      if (path !== undefined && !files.includes(path)) files.push(path)
      continue
    }
    // `pwsh` counts only when the command mutates files or the repo tree —
    // builds and read-only queries must not mark a survey turn as a write turn.
    // 0.4.1: the observation tier leaves `git commit` out (dispatch-owner's own
    // commit is not a working-tree change); the optional 4th argument restores
    // the full pattern.
    const command = readCommand(data.arguments)
    if (command !== undefined && pattern.test(command)) shellWrites += 1
  }

  return { writes: writes.length, files, shellWrites, failedWrites, delegations }
}

/**
 * Collect the ids of calls whose logged result is an error.
 *
 * Results are not filtered by turn: a call id is unique session-wide, so the
 * set only needs to answer "did this call fail?".
 * @param events - the committed session log.
 * @returns the failed call ids.
 */
export function collectFailedCallIds(events) {
  const ids = new Set()
  for (const event of events ?? []) {
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message
    if (message?.isError !== true) continue
    const callId = message?.toolCallId ?? message?.source?.callId
    if (typeof callId === 'string' && callId !== '') ids.add(callId)
  }
  return ids
}

/**
 * Read the target path out of a tool call's arguments.
 * @param raw - the JSON-encoded arguments string the log stores.
 * @returns the path, or undefined when the call names none.
 */
export function readPath(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const args = JSON.parse(raw)
    const path = args?.file_path ?? args?.path
    return typeof path === 'string' && path !== '' ? path : undefined
  } catch {
    return undefined
  }
}
