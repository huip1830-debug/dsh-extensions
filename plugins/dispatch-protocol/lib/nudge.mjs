// Missed-dispatch detection: a turn that changed several files while delegating
// nothing.
//
// The five rules in the system prompt are advisory — nothing in the harness
// makes a model dispatch. A session can therefore survey, edit five files, build
// and test entirely on its own and still read as compliant, because the
// discipline only governs the *form* of a dispatch, never its occurrence.
// Observed case: session-a80150dd (2 turns, 56 steps, 67 tool calls, 0
// delegations) — the model weighed the small-change exemption for a five-file
// change, found that `writing-plans` was missing, and fell back to doing the
// work inline. This module turns that into a checkable signal instead of a
// post-mortem.

import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Delegation tools: a turn that used one of these did not miss the dispatch. */
export const DEFAULT_DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'workflow']

/** Tools whose calls count as "touched a file" for this check. */
export const DEFAULT_WRITE_TOOLS = ['write', 'edit']

/**
 * Shell command fragments that mutate files or the repo tree (0.4.0).
 *
 * The write-tools list cannot see a `pwsh` deletion: sample session-82db5b7d's
 * W-5 removed dead files with `Remove-Item` and zero `write`/`edit` calls, and
 * was judged read-only. This pattern is the shared fix for both the nudge
 * counter and the checkpoint's read-only verdict. It is deliberately
 * over-inclusive (a mutation verb in an unexecuted branch still counts) — the
 * cost of a false positive is one silencable reminder, the cost of a false
 * negative is a silently unverified write batch. Build/test/db commands
 * (`dotnet build`, `npx jest`, `prisma migrate`) are intentionally absent:
 * they touch artifacts, not the reviewed source set.
 */
export const DEFAULT_PWSH_MUTATION_PATTERN = /\b(Remove-Item|Set-Content|Out-File|Add-Content|Clear-Content|New-Item|Copy-Item|Move-Item|Rename-Item|ri|del|erase|ren|rename|move|copy|mkdir|rmdir|rd|tee)\b|(?<![\d&])>{1,2}(?![&=\d])|\bgit\s+(apply|checkout|restore|commit|merge|rebase|cherry-pick|rm|mv|clean)\b/i

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
 * The one model-facing reminder. Delivered at most once per turn, so a model
 * that answers it with more edits cannot re-trigger it in the same turn.
 *
 * A turn whose own prose already justifies the skip is suppressed before this
 * text is ever rendered, so the wording no longer hedges ("若超出豁免…"): the
 * absence of an explanation is exactly what earned it.
 */
export const DEFAULT_NUDGE_TEXT = '[dispatch-protocol] 本回合改了 {fileCount} 个文件（{writes} 次写入）：{files}。派发 0 次，也没有说明理由。要么一行给出不派发的理由，要么改为派发。'

/**
 * Substrings that count as "this turn already explained itself".
 *
 * Starts narrow (`理由` / `无需` alone would swallow unrelated prose like
 * "无需修改") and is widened only from observed misses: 0.3.8 adds the three
 * phrasings a real turn used while still being reminded — "同一处改动的三个面",
 * "一条命令验完", "镜像面". A missed suppression only costs the reminder the turn
 * would have received anyway, so growth is allowed but each addition is a
 * deliberate, reviewable decision. Width variants fold through NFKC; whitespace
 * inside a phrase ("不 派 发") is NOT repaired — an accepted limit.
 */
export const DEFAULT_JUSTIFIED_PATTERNS = [
  '豁免', '不派发', '未派发', '无需派发', '不需要派发', '直接做',
  '一条命令验完', '一处改动的', '镜像面',
]

/** Cap on how many paths the reminder prints verbatim. */
const MAX_LISTED_FILES = 5

/**
 * Validate the `nudge` config section.
 *
 * `log` is the shared decision log for both mechanisms (checkpoint and nudge),
 * keeping the historical `nudge.log` key: `false` turns all decision logging
 * off, a non-empty string overrides the default `%TEMP%` path. The old
 * `dispatch-protocol-nudge.jsonl` is no longer written.
 * @param source - the raw `nudge` object from the profile patch layer.
 * @returns the resolved section, with `log` already expanded to a path.
 */
export function resolveNudge(source = {}) {
  const config = source ?? {}

  const threshold = config.threshold ?? 2
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error('dispatch-protocol: nudge.threshold must be a positive integer')
  }

  const text = config.text ?? DEFAULT_NUDGE_TEXT
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('dispatch-protocol: nudge.text must be a non-empty string')
  }

  const writeTools = config.writeTools ?? DEFAULT_WRITE_TOOLS
  if (!Array.isArray(writeTools) || writeTools.length === 0
    || writeTools.some(tool => typeof tool !== 'string' || tool.trim() === '')) {
    throw new Error('dispatch-protocol: nudge.writeTools must be a non-empty array of non-empty strings')
  }

  const delegationTools = config.delegationTools ?? DEFAULT_DELEGATION_TOOLS
  if (!Array.isArray(delegationTools) || delegationTools.length === 0
    || delegationTools.some(tool => typeof tool !== 'string' || tool.trim() === '')) {
    throw new Error('dispatch-protocol: nudge.delegationTools must be a non-empty array of non-empty strings')
  }

  const justifiedPatterns = config.justifiedPatterns ?? DEFAULT_JUSTIFIED_PATTERNS
  if (!Array.isArray(justifiedPatterns) || justifiedPatterns.length === 0
    || justifiedPatterns.some(pattern => typeof pattern !== 'string' || pattern.trim() === '')) {
    throw new Error('dispatch-protocol: nudge.justifiedPatterns must be a non-empty array of non-empty strings')
  }

  const log = config.log === false
    ? false
    : (typeof config.log === 'string' && config.log.trim() !== ''
      ? config.log
      : join(tmpdir(), 'dispatch-protocol-decisions.jsonl'))
  if (log !== false && typeof log !== 'string') {
    throw new Error('dispatch-protocol: nudge.log must be a path or false')
  }

  return { enabled: config.enabled !== false, threshold, writeTools, delegationTools, justifiedPatterns, text, log }
}

/**
 * Count one turn's file writes and delegations from the committed session log.
 *
 * `tool/call` carries its own `turn`, so a turn boundary needs no bookkeeping:
 * everything is derived from the log, and a resumed session computes the same
 * numbers as a live one.
 * @param events - `session.snapshotEvents()`.
 * @param turn - the turn being closed.
 * @param config - the resolved `nudge` section.
 * @returns `{ writes, files, delegations }` for that turn.
 */
export function summarizeTurn(events, turn, config) {
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

    if (config.delegationTools.includes(tool)) {
      delegations += 1
      continue
    }
    if (!config.writeTools.includes(tool) && tool !== 'pwsh') continue
    // A refused write never touched the file: skip it. A call with no id, or
    // with no result event, stays counted — a missing result must not erase a
    // write.
    if (failedCallIds.has(data.callId)) {
      failedWrites += 1
      continue
    }

    if (config.writeTools.includes(tool)) {
      writes.push(tool)
      const path = readPath(data.arguments)
      if (path !== undefined && !files.includes(path)) files.push(path)
      continue
    }
    // `pwsh` counts only when the command mutates files or the repo tree —
    // builds and read-only queries must not mark a survey turn as a write turn.
    const command = readCommand(data.arguments)
    if (command !== undefined && DEFAULT_PWSH_MUTATION_PATTERN.test(command)) shellWrites += 1
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
function collectFailedCallIds(events) {
  const ids = new Set()
  for (const event of events) {
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
 * Decide whether this turn looks like a skipped dispatch.
 *
 * `threshold` counts distinct files, not write calls: editing one file three
 * times stays inside the small-change exemption. Shell mutations carry no
 * reliable path, so each counts as one anonymous file (0.4.0).
 * @param summary - `summarizeTurn(...)` output.
 * @param config - the resolved `nudge` section.
 * @returns true when the turn touched enough distinct files and delegated nothing.
 */
export function shouldNudge(summary, config) {
  const touched = summary.files.length + (summary.shellWrites ?? 0)
  return touched >= config.threshold && summary.delegations === 0
}

/**
 * Decide whether this turn's own prose already explains the skipped dispatch.
 *
 * Only `assistant/message` text of the closing turn counts: a keyword quoted in
 * a tool result, or said in an earlier turn, is not an explanation for this one.
 * The scan is generous across steps (a model that explains mid-turn and closes
 * with "已完成。" is still covered), and coarse by design — quoting the rule text
 * ("超出单文件豁免") suppresses the reminder too, which fails toward silence.
 * @param events - `session.snapshotEvents()`.
 * @param turn - the turn being closed.
 * @param patterns - the resolved `nudge.justifiedPatterns`.
 * @returns true when any text block of that turn contains a pattern.
 */
export function justifiedInTurn(events, turn, patterns) {
  const prose = []
  for (const event of events ?? []) {
    if (event?.type !== 'assistant/message') continue
    const data = event.data ?? {}
    if (data.turn !== turn) continue
    const content = data.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') prose.push(block.text)
    }
  }
  if (prose.length === 0) return false
  const text = prose.join('\n').normalize('NFKC')
  return patterns.some(pattern => text.includes(pattern.normalize('NFKC')))
}

/**
 * Render the reminder text.
 * @param template - `nudge.text`, with `{fileCount}`, `{writes}`, `{files}`, `{turn}`.
 * @param summary - `summarizeTurn(...)` output plus the closing `turn`.
 * @returns the message body.
 */
export function renderNudge(template, summary) {
  const fileCount = summary.files.length + (summary.shellWrites ?? 0)
  return template
    .replaceAll('{fileCount}', String(fileCount))
    .replaceAll('{writes}', String(summary.writes + (summary.shellWrites ?? 0)))
    .replaceAll('{files}', formatFiles(summary.files, summary.shellWrites ?? 0))
    .replaceAll('{turn}', String(summary.turn))
}

/**
 * Join paths for the reminder, capping the list so one long path cannot double
 * the message size. Shell mutations have no reliable path and are reported as
 * a count (0.4.0).
 * @param files - distinct paths written this turn.
 * @param shellWrites - pwsh mutation commands this turn.
 * @returns a comma-separated list, plus a "+N" suffix when truncated.
 */
function formatFiles(files, shellWrites = 0) {
  const shellNote = shellWrites > 0 ? `另有 ${shellWrites} 条 shell 变更命令` : ''
  if (files.length === 0) return shellNote || '未记录路径'
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ')
  const base = files.length > MAX_LISTED_FILES ? `${shown} 等 ${files.length} 个` : shown
  return shellNote ? `${base}，${shellNote}` : base
}
