// 写入守卫（write policy，0.9.0）：把派发纪律从「回合末提醒」前移到工具边界。
//
// 0.8.x 的 nudge 在回合收尾才评估「写了多个文件却没派发」，实测 45/45 次投递
// 都发生在最终答复之后、0 次促成派发（spec `2026-11-04-dispatch-write-policy.md`
// §1）。0.9.0 换成 `ctx.tools.guard(fn)`：同步、单调，返回字符串即拒绝该次工具
// 调用，模型收到 `Error: <reason>` 后回合继续——纠正点落在动作之前，成本是零模型
// 步进。
//
// 本模块只做纯判定（无状态、不读宿主对象），宿主相关的一切（注册、日志、拒绝
// 串投递）在 `plugin.mjs`。判定口径（spec §4）：
//   1. 名单内（控制面）→ 放行，且**不写日志**：控制面写入不制造噪音；
//   2. `dispatch/override.json` 有效 → 放行 + 记日志 `reason: 'override'`；
//   3. 否则拒绝，`reason` 为 `'no-override' | 'stale' | 'invalid'`。
// override 是唯一的豁免凭据：散文判定（旧的 `justifiedPatterns`）已删除，豁免
// 必须留下机器可读的一行。

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, posix } from 'node:path'
import { DEFAULT_DELEGATION_TOOLS, DEFAULT_WRITE_TOOLS } from './tool-calls.mjs'

/**
 * 主控可直接写的前缀（cwd 相对、大小写不敏感）。
 *
 * 与 `tool-calls.mjs` 的 `DEFAULT_CONTROL_PLANE_PATTERNS` 同源（规则 1 的七类
 * 控制面动作），但匹配口径更严：守卫按「前缀 + 词边界」匹配整条相对路径，而
 * 观测/闸门只做子串粗判。
 */
export const DEFAULT_ALLOWLIST = ['dispatch/', 'docs/superpowers/specs/']

/** override 文件的默认位置（cwd 相对）。 */
export const DEFAULT_OVERRIDE_PATH = 'dispatch/override.json'

/** 守卫默认模式：`enforce` 真拦，`shadow` 只记日志。 */
export const DEFAULT_WRITE_POLICY_MODE = 'enforce'

/** 校验「非空字符串数组」，返回原数组。 */
function readStringList(value, fallback, name) {
  const list = value ?? fallback
  if (!Array.isArray(list) || list.length === 0
    || list.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`dispatch-protocol: writePolicy.${name} must be a non-empty array of non-empty strings`)
  }
  return list
}

/**
 * Validate the `writePolicy` config section (spec §3).
 *
 * 所有默认值在加载期校验：`mode` 拼错或 `tools: []` 若静默降级，守卫会「永远
 * 放行」或「永远不拦」，和「配置正确但没命中」在日志里无法区分。
 * @param source - the raw `writePolicy` object from the profile patch layer.
 * @returns the resolved section `{ enabled, mode, allowlist, overridePath, tools, delegationTools }`.
 */
export function resolveWritePolicy(source = {}) {
  const config = source ?? {}

  const mode = config.mode ?? DEFAULT_WRITE_POLICY_MODE
  if (mode !== 'enforce' && mode !== 'shadow') {
    throw new Error("dispatch-protocol: writePolicy.mode must be 'enforce' or 'shadow'")
  }

  const allowlist = readStringList(config.allowlist, DEFAULT_ALLOWLIST, 'allowlist')
  const tools = readStringList(config.tools, DEFAULT_WRITE_TOOLS, 'tools')
  const delegationTools = readStringList(config.delegationTools, DEFAULT_DELEGATION_TOOLS, 'delegationTools')

  const overridePath = config.overridePath ?? DEFAULT_OVERRIDE_PATH
  if (typeof overridePath !== 'string' || overridePath.trim() === '') {
    throw new Error('dispatch-protocol: writePolicy.overridePath must be a non-empty string')
  }

  return { enabled: config.enabled !== false, mode, allowlist, overridePath, tools, delegationTools }
}

/**
 * 归一化一条路径：反斜杠转正斜杠、去 `./`、折叠 `.`/`..` 段。
 *
 * 折叠是必要的：名单按字面前缀匹配，未折叠的 `dispatch/../src/x.ts` 会假命中
 * `dispatch/`（一条白名单绕过）。
 * @param value - 原始路径。
 * @returns 归一化后的正斜杠路径，或 undefined（非字符串/空串）。
 */
function normalizePath(value) {
  if (typeof value !== 'string') return undefined
  const slashed = value.replaceAll('\\', '/').trim()
  if (slashed === '') return undefined
  const collapsed = posix.normalize(slashed)
  if (collapsed === '.' || collapsed === './') return undefined
  return collapsed
}

/** 绝对路径判定：node 的 isAbsolute 在 Windows 认盘符，跨平台再兜一层。 */
function isAbsolutePath(value) {
  return isAbsolute(value) || /^[A-Za-z]:\//.test(value)
}

/**
 * 把工具参数里的路径换成「cwd 相对」形式。
 * @param file - `write`/`edit` 的 `file_path` 或 `path`。
 * @param cwd - 会话工作目录（`session.cwd ?? session.header.cwd`）。
 * @returns cwd 相对路径；cwd 外或参数非法时返回 undefined。
 */
function toCwdRelative(file, cwd) {
  const normalizedFile = normalizePath(file)
  if (normalizedFile === undefined) return undefined
  if (!isAbsolutePath(normalizedFile)) return normalizedFile
  const normalizedCwd = normalizePath(cwd)
  if (normalizedCwd === undefined) return undefined
  const cwdRoot = normalizedCwd.replace(/\/+$/, '')
  const fileLower = normalizedFile.toLowerCase()
  const cwdLower = cwdRoot.toLowerCase()
  if (fileLower === cwdLower) return ''
  // 绝对路径在 cwd 外 → 视为不在名单（spec §4）。
  if (!fileLower.startsWith(`${cwdLower}/`)) return undefined
  return normalizedFile.slice(cwdRoot.length + 1)
}

/**
 * Decide whether one file write lands on the dispatcher's control plane.
 *
 * 匹配口径（spec §4）：相对路径先相对 cwd 解析，绝对路径先转 cwd 相对；名单
 * 条目大小写不敏感，带尾 `/` 按前缀匹配，无尾 `/` 按词边界匹配（条目本身或
 * `条目 + '/'`）——否则 `dispatch-notes.md` 会被 `dispatch` 误放行。
 * @param file - 工具参数里的路径。
 * @param cwd - 会话工作目录。
 * @param allowlist - 控制面前缀列表。
 * @returns 命中返回 true。
 */
export function isAllowedPath(file, cwd, allowlist = DEFAULT_ALLOWLIST) {
  const relativePath = toCwdRelative(file, cwd)
  if (relativePath === undefined || relativePath === '') return false
  const target = relativePath.toLowerCase()
  const entries = Array.isArray(allowlist) ? allowlist : DEFAULT_ALLOWLIST
  return entries.some((entry) => {
    const normalized = normalizePath(entry)
    if (normalized === undefined) return false
    const pattern = normalized.toLowerCase()
    if (pattern.endsWith('/')) return target.startsWith(pattern)
    return target === pattern || target.startsWith(`${pattern}/`)
  })
}

/**
 * Read and validate `<cwd>/<overridePath>` (spec §4).
 *
 * 有效的 override 必须：能 JSON 解析、是对象、`reason` 为非空字符串、并且是
 * 「本会话写下的」——`statSync().mtimeMs >= sessionStart`。取不到会话开始时间
 * 时跳过新鲜度判断（fail-open），但仍以 `reason: 'override-unbounded'` 记一行，
 * 让日志能区分「有时间戳兜底的 override」和「无时间戳的 override」。
 * @param file - override 文件的绝对路径。
 * @param sessionStart - 会话开始时间（毫秒），取不到传 undefined。
 * @returns `{ ok, reason, data }`，`reason` 为 `'missing' | 'stale' | 'invalid' | 'override' | 'override-unbounded'`。
 */
export function readOverride(file, sessionStart) {
  if (typeof file !== 'string' || file === '') return { ok: false, reason: 'missing', data: undefined }

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // 文件不存在是常态（没写 override），任何其它读取错误按非法处理。
    return { ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'invalid', data: undefined }
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid', data: undefined }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'invalid', data: undefined }
  }
  if (typeof data.reason !== 'string' || data.reason.trim() === '') {
    return { ok: false, reason: 'invalid', data }
  }

  const start = typeof sessionStart === 'number' && Number.isFinite(sessionStart) ? sessionStart : undefined
  if (start === undefined) return { ok: true, reason: 'override-unbounded', data }

  let mtimeMs
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return { ok: false, reason: 'invalid', data }
  }
  if (!(mtimeMs >= start)) return { ok: false, reason: 'stale', data }
  return { ok: true, reason: 'override', data }
}

/**
 * 一次写入的最终判定（纯函数，供守卫与测试共用）。
 * @param options - `{ file, cwd, tool, config, sessionStart }`。
 * @param options.file - 工具参数里的路径。
 * @param options.cwd - 会话工作目录。
 * @param options.tool - 工具名（只进日志，不参与判定）。
 * @param options.config - 已解析的 `writePolicy` 段。
 * @param options.sessionStart - 会话开始时间（毫秒），取不到传 undefined。
 * @returns `{ decision: 'allow' | 'deny', reason, file }`；`reason` 为
 *   `'allowlist' | 'override' | 'override-unbounded' | 'no-override' | 'stale' | 'invalid'`。
 */
export function evaluateWritePolicy({ file, cwd, tool, config, sessionStart } = {}) {
  const policy = config ?? resolveWritePolicy()

  // 1. 控制面：放行，调用方不得为此写日志。
  if (isAllowedPath(file, cwd, policy.allowlist)) return { decision: 'allow', reason: 'allowlist', file }

  // 2. override：唯一豁免凭据。
  const normalizedCwd = normalizePath(cwd)
  const normalizedOverride = normalizePath(policy.overridePath)
  const overrideFile = normalizedCwd === undefined || normalizedOverride === undefined
    ? policy.overridePath
    : join(normalizedCwd, normalizedOverride)
  const override = readOverride(overrideFile, sessionStart)
  if (override.ok) return { decision: 'allow', reason: override.reason, file }

  // 3. 其余一律拒绝；`missing` 对外说成 `no-override`（日志里的原因词）。
  return { decision: 'deny', reason: override.reason === 'missing' ? 'no-override' : override.reason, file }
}

/**
 * Render the one model-facing rejection string (spec §4).
 *
 * 单条文本：第一行说清「拦了什么、不在哪份名单」，第二行给两条出路——派发，
 * 或按用户明确授权先写 override。模型收到的工具错误是 `Error: <这段文本>`，
 * 回合继续，所以文案必须自带下一步动作。
 * @param options - `{ tool, file, allowlist, overridePath }`。
 * @param options.tool - 被拦下的工具名。
 * @param options.file - 被拦下的路径（模型原样给出的那个）。
 * @param options.allowlist - 控制面前缀列表。
 * @param options.overridePath - override 文件路径。
 * @returns the rejection text.
 */
export function renderDenyText({ tool, file, allowlist = DEFAULT_ALLOWLIST, overridePath = DEFAULT_OVERRIDE_PATH } = {}) {
  const list = (Array.isArray(allowlist) ? allowlist : DEFAULT_ALLOWLIST).join('、')
  const path = typeof overridePath === 'string' && overridePath !== '' ? overridePath : DEFAULT_OVERRIDE_PATH
  return `[dispatch-protocol] 拦截：${tool} 要写 ${file}，不在主控白名单内（${list}）。\n两条出路：①把这项写入派给执行批；②若用户本轮明确要求主控亲自做，先写 ${path}（如 {"reason":"用户要求直接修这 4 行"}）再重试。`
}
