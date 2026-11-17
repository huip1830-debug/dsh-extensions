// 项目级开关（project switch，0.13.0）：按会话 cwd 决定派发纪律的档位。
//
// 同一个 profile 里，有些项目不需要派发纪律：项目根放一个标记文件
// （默认 `dispatch/protocol.json`），该项目的会话就降档或静默，其它项目维持
// 0.12.3 的行为。判定在每个工具调用 / 回合收尾时实时读文件——不需要重启 DSH，
// 也不需要改 profile。
//
// 本模块只做纯判定（无宿主对象、无日志）：读标记文件 → `'full' | 'shadow' | 'off'`。
// fail-open 是本模块唯一的口径（spec §3.2）：
//   1. 开关关闭 / cwd 非法 / 路径归一化失败 → 'full'
//   2. 文件不存在（stat/read 失败）→ 'full'
//   3. JSON 解析失败或顶层不是 plain object → 'full'（坏文件是「没配」，不是错误）
//   4. `mode` 命中三档 → 该值
//   5. 否则 `enabled === false` → 'off'，其余 → 'full'
//
// 路径归一化复用 `write-policy.mjs` 的 `normalizePath` / `toCwdRelative`：名单、
// override 与本开关必须共用同一套折叠规则，否则 `dispatch/../src` 这类路径会在
// 一处命中、另一处不命中。
//
// 记忆化按 `(归一化绝对路径, mtimeMs)` 缓存：同一回合里守卫、闸门、观察行会各
// 读一次模式，缓存把重复读取压成一次 stat。缓存键含绝对路径，不会跨 cwd 串味；
// stat 失败或读取失败不缓存（下一次调用仍会重试）。

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizePath, toCwdRelative } from './write-policy.mjs'

/** 项目级开关的默认配置段；`config.mjs` 只校验与转发，默认值只有这一个入口。 */
export const DEFAULT_PROJECT_SWITCH = { enabled: true, path: 'dispatch/protocol.json' }

/** 允许的档位，顺序即优先级无关的完整枚举。 */
export const PROJECT_MODES = ['full', 'shadow', 'off']

/** `(归一化绝对路径, mtimeMs)` → 模式。mtime 变了就是新键，旧项不再命中。 */
const modeCache = new Map()

/**
 * 把 `projectSwitch.path` 解析成标记文件的绝对路径。
 *
 * 只相对会话 cwd（spec §3.1）：绝对路径允许落在 cwd 内，落在 cwd 外或含
 * `..` 逃逸的一律按「归一化失败」处理（返回 undefined → `'full'`）。
 * @param cwd - 会话工作目录（`session.cwd ?? session.header.cwd`）。
 * @param markerPath - 配置里的 cwd 相对路径。
 * @returns 绝对路径，或 undefined。
 */
function resolveMarkerFile(cwd, markerPath) {
  const normalizedPath = normalizePath(markerPath)
  if (normalizedPath === undefined) return undefined
  const normalizedCwd = normalizePath(cwd)
  if (normalizedCwd === undefined) return undefined
  const relative = toCwdRelative(normalizedPath, normalizedCwd)
  if (relative === undefined || relative === '') return undefined
  if (relative === '..' || relative.startsWith('../')) return undefined
  return join(normalizedCwd, relative)
}

/**
 * 读并解析标记文件，返回模式；读不到返回 undefined（不缓存）。
 * @param file - 标记文件绝对路径。
 * @returns `'full' | 'shadow' | 'off' | undefined`。
 */
function readMarkerMode(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return 'full'
  }
  // 数组与 null 都不是「配置对象」：与 `readOverride` 的 invalid 口径一致。
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'full'

  if (typeof data.mode === 'string' && PROJECT_MODES.includes(data.mode)) return data.mode
  if (data.enabled === false) return 'off'
  return 'full'
}

/**
 * 解析一个会话 cwd 的项目档位（spec §3.2）。
 * @param cwd - 会话工作目录（`session.cwd ?? session.header.cwd`）。
 * @param projectSwitch - 已解析的 `projectSwitch` 段；缺省用默认值。
 * @returns `'full' | 'shadow' | 'off'`，任何异常都回落 `'full'`。
 */
export function readProjectMode(cwd, projectSwitch) {
  try {
    const settings = projectSwitch ?? DEFAULT_PROJECT_SWITCH
    if (settings.enabled === false) return 'full'
    if (typeof cwd !== 'string' || cwd.trim() === '') return 'full'
    const file = resolveMarkerFile(cwd, settings.path ?? DEFAULT_PROJECT_SWITCH.path)
    if (file === undefined) return 'full'

    let mtimeMs
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      // 文件不存在（ENOENT）与其它 stat 失败同口径：fail-open，且不缓存。
      return 'full'
    }

    const key = `${file}\0${mtimeMs}`
    const cached = modeCache.get(key)
    if (cached !== undefined) return cached

    const mode = readMarkerMode(file)
    if (mode === undefined) return 'full'
    modeCache.set(key, mode)
    return mode
  } catch {
    return 'full'
  }
}

/**
 * 写项目标记文件（spec `2026-11-17-dispatch-ui-design.md` §3.1 第 4 步）。
 *
 * 命令层与 UI 都改这一个文件，所以写入必须和读取共用同一套路径归一化：
 * 复用模块内的 `resolveMarkerFile`，`normalizePath` / `toCwdRelative` 仍只有
 * `write-policy.mjs` 一份实现。原子写（同目录 `<file>.tmp-<pid>-<rand>` + `rename`）
 * 保证读侧永远看不到半截 JSON——`readProjectMode` 把坏文件当 `'full'`，一次
 * 写到一半的切换会静默恢复全文规则，比写失败更难排查。
 *
 * `projectSwitch.enabled === false` 时**照写**：文件是唯一真相，开关只是
 * 「当前不生效」；是否提示由命令层决定，本函数不改变写入语义。
 *
 * 永不抛错：返回值即契约。
 * - 成功：`{ ok: true, file: '<cwd 相对 posix 路径>', mode }`
 * - 失败：`{ ok: false, reason: 'invalid-cwd' | 'invalid-path' | 'write-failed', error? }`
 *   非法档位同样按 `invalid-path` 返回（契约只给这三个 reason；命令层已先挡
 *   非法档位，这里只是防御）。
 * @param cwd - 会话工作目录（`session.cwd ?? session.header.cwd`）。
 * @param projectSwitch - 已解析的 `projectSwitch` 段；缺省用默认值。
 * @param mode - `'full' | 'shadow' | 'off'`。
 * @returns 写入结果，见上。
 */
export function writeProjectMode(cwd, projectSwitch, mode) {
  const settings = projectSwitch ?? DEFAULT_PROJECT_SWITCH
  try {
    if (!PROJECT_MODES.includes(mode)) return { ok: false, reason: 'invalid-path' }
    if (typeof cwd !== 'string' || cwd.trim() === '') return { ok: false, reason: 'invalid-cwd' }
    // cwd 本身归一化失败（如 '.'）与「没给 cwd」同属 invalid-cwd；路径逃出 cwd
    // 才是 invalid-path，两者在日志/提示里必须可区分。
    if (normalizePath(cwd) === undefined) return { ok: false, reason: 'invalid-cwd' }
    const file = resolveMarkerFile(cwd, settings.path ?? DEFAULT_PROJECT_SWITCH.path)
    if (file === undefined) return { ok: false, reason: 'invalid-path' }
    const relative = toCwdRelative(file, cwd)
    if (relative === undefined || relative === '') return { ok: false, reason: 'invalid-path' }

    // 随机后缀：同一进程里两个并发写入（两个会话同时切档）不会撞同一个临时名，
    // 否则后一个 rename 会带走前一个正在写的内容。
    const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify({ mode })}\n`)
      renameSync(temporary, file)
    } catch (error) {
      // rename 失败时临时文件可能已经存在：清掉，不留 `.tmp-<pid>-<rand>` 垃圾。
      try {
        unlinkSync(temporary)
      } catch {
        // 临时文件从未创建（mkdir/write 就失败了）。
      }
      return { ok: false, reason: 'write-failed', error: error?.message ?? String(error) }
    }
    return { ok: true, file: relative, mode }
  } catch (error) {
    return { ok: false, reason: 'write-failed', error: error?.message ?? String(error) }
  }
}
