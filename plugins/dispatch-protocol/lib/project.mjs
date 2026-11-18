// 项目级开关（project switch，0.13.0）：按会话 cwd 决定派发纪律的档位。
//
// 同一个 profile 里，有些项目不需要派发纪律：项目根放一个标记文件
// （默认 `dispatch/protocol.json`），该项目的会话就降档或静默，其它项目维持
// 0.12.3 的行为。判定在每个工具调用 / 回合收尾时实时读文件——不需要重启 DSH，
// 也不需要改 profile。
//
// 本模块只做纯判定（无宿主对象、无日志）。
//
// 0.15.0：标记文件升级成「项目策略文件」（spec
// `2026-11-17-project-policy-design.md` §2.1/§2.2）。`readProjectPolicy` 返回
// `{ mode, rules?, allowlist? }`，只带「文件里有效出现的字段」；缺省字段
// 不出现，由调用方回落 profile 配置。`readProjectMode` 保留为
// `readProjectPolicy(...).mode` 的薄封装（0.13 调用面不断裂）。
//
// 0.17.0：五个收尾闸门删除后，只有闸门消费的 `controlPlanePatterns` /
// `verify.commands` / `contract.patterns` / `docs.patterns` 一并删除；策略文件
// 里写这些字段不再有效果（读取侧忽略，不报错）。
//
// 0.16.0：默认档从 `full` 改为 `auto`（spec
// `2026-11-18-dispatch-auto-mode-design.md` §2.1）——没有标记文件的项目只注入
// 提级提示，不再默认背全文纪律。fail-open 的口径仍是「永不抛错」，但方向分成
// 两类：
//   1. 开关关闭 / cwd 非法 / 路径归一化失败 → 'full'
//      （无法判定项目或用户显式关闭项目开关时，回到旧行为）
//   2. 文件不存在 / stat 或读取失败 / JSON 坏 → 'auto'
//      （按「没配」处理；坏文件不得把成本静默抬到 full）
//   3. `mode` 命中四档 → 该值；否则 `enabled:false → off`、`enabled:true → full`、
//      其余 → 'auto'
//   4. 0.15：策略字段类型/内容非法 → **只丢该字段**，其它字段与 mode 不受影响
//
// 路径归一化复用 `write-policy.mjs` 的 `normalizePath` / `toCwdRelative`：名单、
// override 与本开关必须共用同一套折叠规则，否则 `dispatch/../src` 这类路径会在
// 一处命中、另一处不命中。
//
// 记忆化按 `(归一化绝对路径, mtimeMs)` 缓存：同一回合里守卫、闸门、观察行会各
// 读一次策略，缓存把重复读取压成一次 stat。缓存键含绝对路径，不会跨 cwd 串味；
// stat 失败或读取失败不缓存（下一次调用仍会重试）。

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizePath, toCwdRelative } from './write-policy.mjs'

/** 项目级开关的默认配置段；`config.mjs` 只校验与转发，默认值只有这一个入口。 */
export const DEFAULT_PROJECT_SWITCH = { enabled: true, path: 'dispatch/protocol.json' }

/** 允许的档位，顺序即显示顺序（0.16.0 增加 auto）。 */
export const PROJECT_MODES = ['off', 'auto', 'shadow', 'full']

/** 没有可用策略文件时的默认档位（0.16.0）。 */
export const DEFAULT_PROJECT_MODE = 'auto'

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


/** `(归一化绝对路径, mtimeMs)` → 解析后的策略文件内容（或坏文件哨兵）。mtime 变了就是新键。 */
const policyCache = new Map()

/** 坏文件（JSON 坏 / 顶层不是 plain object）的缓存哨兵：等于「只回 mode」。 */
const INVALID_DOCUMENT = Symbol('invalid-policy-document')

/** 规则预设枚举（spec §2.1）；只影响提示词段正文，不影响任何机制。 */
const RULE_PRESETS = ['plugin', 'business']

/** 只有 plain object 才算「配置对象」；数组与 null 都不是。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 只保留「非空字符串数组」；其它形状一律返回 undefined（＝该字段不存在）。
 * 返回副本：调用方拿到的数组永远不与缓存共享。
 * @param value - 文件里的候选值。
 * @returns 非空字符串数组的副本，或 undefined。
 */
function validStringList(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  if (!value.every(item => typeof item === 'string' && item.trim() !== '')) return undefined
  return value.slice()
}

/**
 * `mode` / `enabled` 的判定（0.16.0：文档为空或只有策略字段时回落 auto）：
 * `mode` 命中四档优先，其次 `enabled: false → 'off'`、`enabled: true → 'full'`，
 * 其余 `'auto'`。
 * @param document - 策略文件解析结果（plain object）。
 * @returns `'full' | 'shadow' | 'auto' | 'off'`。
 */
function modeOfDocument(document) {
  if (typeof document.mode === 'string' && PROJECT_MODES.includes(document.mode)) return document.mode
  if (document.enabled === false) return 'off'
  if (document.enabled === true) return 'full'
  return DEFAULT_PROJECT_MODE
}

/**
 * 把策略文件内容投影成 `readProjectPolicy` 的返回对象：只写「有效出现」的字段。
 * 字段级校验在这里做——缓存里永远只有原始解析结果，不会缓存校验后的返回值，
 * 所以一个字段写坏只丢它自己，也不会把脏值留给下一次调用。
 * @param document - 策略文件解析结果（plain object）。
 * @returns 策略对象，至少含 `mode`。
 */
function buildPolicy(document) {
  const policy = { mode: modeOfDocument(document) }

  if (RULE_PRESETS.includes(document.rules)) policy.rules = document.rules
  const allowlist = validStringList(document.allowlist)
  if (allowlist !== undefined) policy.allowlist = allowlist

  return policy
}

/**
 * 读并解析标记文件，返回策略文件内容；读不到返回 undefined（不缓存）。
 * @param file - 标记文件绝对路径。
 * @returns 解析后的 plain object、坏文件哨兵，或 undefined（读失败）。
 */
function readPolicyDocument(file) {
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
    // 坏文件是「没配」，不是错误：等价于只剩 mode（spec §2.1）。
    return INVALID_DOCUMENT
  }
  // 数组与 null 都不是「配置对象」：与 `readOverride` 的 invalid 口径一致。
  if (!isPlainObject(data)) return INVALID_DOCUMENT
  return data
}

/**
 * 解析一个会话 cwd 的项目策略（spec §2.1/§2.2）。
 *
 * 只返回文件里**有效出现**的字段；缺省字段不出现，由调用方回落 profile 配置。
 * 字段级 fail-open：某字段类型/内容非法 → 该字段不出现，其它字段与 mode 不受
 * 影响；整个文件坏/缺失 → 回落默认档 `auto`（无法判定 cwd / 路径配置错误时
 * 仍是 `full`）。永不抛错。
 * @param cwd - 会话工作目录（`session.cwd ?? session.header.cwd`）。
 * @param projectSwitch - 已解析的 `projectSwitch` 段；缺省用默认值。
 * @returns `{ mode, rules?, allowlist? }`。
 */
export function readProjectPolicy(cwd, projectSwitch) {
  try {
    const settings = projectSwitch ?? DEFAULT_PROJECT_SWITCH
    if (settings.enabled === false) return { mode: 'full' }
    if (typeof cwd !== 'string' || cwd.trim() === '') return { mode: 'full' }
    const file = resolveMarkerFile(cwd, settings.path ?? DEFAULT_PROJECT_SWITCH.path)
    if (file === undefined) return { mode: 'full' }

    let mtimeMs
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      // 文件不存在（ENOENT）与其它 stat 失败同口径：按「没配」处理，回落默认
      // auto（0.16.0），且不缓存。
      return { mode: DEFAULT_PROJECT_MODE }
    }

    // 键仍是 `(绝对路径, mtimeMs)`：同一回合里守卫、闸门、提示词段各读一次，
    // 缓存把重复读取压成一次 stat；stat/读取失败不缓存（下一次调用仍会重试）。
    const key = `${file}\0${mtimeMs}`
    let document = policyCache.get(key)
    if (document === undefined) {
      document = readPolicyDocument(file)
      if (document === undefined) return { mode: DEFAULT_PROJECT_MODE }
      policyCache.set(key, document)
    }
    if (document === INVALID_DOCUMENT) return { mode: DEFAULT_PROJECT_MODE }
    return buildPolicy(document)
  } catch {
    return { mode: 'full' }
  }
}

/**
 * 解析一个会话 cwd 的项目档位（spec §3.2 / 0.15 §2.2）。
 *
 * 0.15.0 起是 `readProjectPolicy(...).mode` 的薄封装：导出保留，0.13 调用面与
 * 可观察行为（含记忆化）不变。
 * @param cwd - 会话工作目录（`session.cwd ?? session.header.cwd`）。
 * @param projectSwitch - 已解析的 `projectSwitch` 段；缺省用默认值。
 * @returns `'full' | 'shadow' | 'auto' | 'off'`，任何异常都回落 `'full'`。
 */
export function readProjectMode(cwd, projectSwitch) {
  return readProjectPolicy(cwd, projectSwitch).mode
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
 * @param mode - `'off' | 'auto' | 'shadow' | 'full'`。
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
