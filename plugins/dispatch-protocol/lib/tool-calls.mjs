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
 * 控制面路径片段（0.8.2 起）。
 *
 * 规则 1 明许主控写 `dispatch/state.md`、`dispatch/ledger/*` 与
 * `docs/superpowers/specs/*`：这些写入是主控的合法控制面动作，不是脏改动或
 * 评审失效的信号。片段按大小写不敏感子串匹配；路径里的反斜杠先归一为正斜杠，
 * 所以 `dispatch\ledger\x.md` 与 `dispatch/ledger/x.md` 等价。
 *
 * 0.9.0：写入守卫的 `writePolicy.allowlist` 用同一份默认值（见
 * `lib/write-policy.mjs` 的 `DEFAULT_ALLOWLIST`），但匹配口径不同——守卫按
 * cwd 相对路径的前缀/词边界匹配，这里仍是子串匹配（观测与闸门只需要粗判）。
 */
export const DEFAULT_CONTROL_PLANE_PATTERNS = ['dispatch/state.md', 'dispatch/ledger/', 'docs/superpowers/specs/']

/**
 * 判断一个写入路径是否落在控制面。
 * @param path - `write`/`edit` 调用参数里的文件路径。
 * @param patterns - 控制面路径片段列表。
 * @returns 命中返回 true；路径缺失或为空返回 false。
 */
export function isControlPlanePath(path, patterns = DEFAULT_CONTROL_PLANE_PATTERNS) {
  if (typeof path !== 'string' || path === '') return false
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  return patterns.some(fragment => normalized.includes(fragment.toLowerCase()))
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
 * `{ writeTools, delegationTools, controlPlanePatterns, shellPattern? }`。
 * @param events - `session.snapshotEvents()`.
 * @param turn - the turn being closed.
 * @param options - `{ writeTools, delegationTools, controlPlanePatterns, shellPattern }`.
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
      if (isControlPlanePath(path, controlPlanePatterns)) continue
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
