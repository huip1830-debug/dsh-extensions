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

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
