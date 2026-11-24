#!/usr/bin/env node
/**
 * verify-install.mjs — dispatch-protocol 安装核验（发布流程防漂移）
 *
 * 用途：核验 ~/.dsh/profiles/<profile>/node_modules/dispatch-protocol/ 的安装副本
 *       是否与仓库 plugins/dispatch-protocol/ 一致，并核验 profile 的
 *       cordis.patch.yml 只读角色表未漂移（`- match: 只读` / `- match: 勘察`
 *       块内必须含 `sandbox: read-only`），以及插件 bundle 的两行 0.21.0 insert
 *       （`preset-dispatch-readonly` / `tool-subagent-readonly`）仍在，且
 *       0.22.0 起后者带 `agentOptions` 路由钉（provider / model / reasoningEffort）。
 *
 * 依据：docs/superpowers/specs/2026-10-26-dispatch-protocol-0.4.1-patch-plan.md §6；
 *       评审主文档 §10.3-P1（profile 角色表丢失中文前缀 → 只读沙箱失守的实证）。
 *       本脚本是发布流程的防漂移核验：插件走 GitHub 依赖安装到 profile 后，
 *       用本脚本在发布前后各跑一次，确认「版本 / 文件内容 / 只读角色表」三项未漂移。
 *
 * 用法：
 *   node plugins/dispatch-protocol/scripts/verify-install.mjs [--profile <name>]
 *   --profile  指定 profile 名（默认 desktop），即 ~/.dsh/profiles/<name>/
 *
 * 输出：每行 [PASS] <name> — <detail> 或 [FAIL] <name> — <detail>；
 *       检查项固定为 installed-dir / version / files / profile-roles /
 *       readonly-tool / whitelist-mode / route-alignment（0.23.0 起：profile-roles
 *       缺失降为提示，whitelist-mode 恒 PASS 只报告注入式/兜底式；0.23.2 起
 *       route-alignment 断言 model-pin 只读角色表与 agentOptions 钉路一致）。
 *       任一 FAIL → 进程退出码 1；全 PASS → 退出码 0。
 *
 * 约束：纯只读脚本，只读文件与目录，不写任何文件（无临时文件、无日志）。
 *       行级解析 cordis.patch.yml，不引 YAML 依赖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EM_DASH = '—'; // U+2014，输出格式固定为 "[PASS] name — detail"

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// 仓库根：相对脚本位置 ../../..（plugins/dispatch-protocol/scripts → 仓库根）
const repoRoot = path.resolve(scriptDir, '../../..');
const repoPluginDir = path.join(repoRoot, 'plugins', 'dispatch-protocol');

const results = []; // 每项 { ok: boolean }

function pass(name, detail) {
  results.push({ ok: true });
  console.log(`[PASS] ${name} ${EM_DASH} ${detail}`);
}

function fail(name, detail) {
  results.push({ ok: false });
  console.log(`[FAIL] ${name} ${EM_DASH} ${detail}`);
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJsonVersion(pkgPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

// 递归列出目录下的普通文件（相对路径统一用 '/'，便于跨平台比对与展示）。
// 按契约排除 node_modules（插件依赖不属于发布内容）。
function listFiles(rootDir, relBase = '') {
  const out = [];
  const abs = relBase ? path.join(rootDir, relBase) : rootDir;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listFiles(rootDir, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// ---- 参数解析 ---------------------------------------------------------------

function parseArgs(argv) {
  let profile = 'desktop';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile') {
      if (i + 1 >= argv.length) return { error: '--profile 缺少参数值' };
      profile = argv[++i];
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
    } else if (arg === '-h' || arg === '--help') {
      return { help: true };
    } else {
      return { error: `未知参数: ${arg}` };
    }
  }
  if (!profile) return { error: '--profile 参数值为空' };
  return { profile };
}

// ---- 行级解析 cordis.patch.yml ----------------------------------------------

const INDENT_OF = (line) => {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
};

// 返回 { start, end }：`roles:` 段的行号范围（0 基，左闭右开）。
// 段从 roles: 行之后开始，到第一个缩进 <= roles: 缩进的非空非注释行为止。
// 只取文件中第一个 roles: 段（profile 契约里 roles 只出现一次；注释行不参与判定）。
export function findRolesSegment(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*roles:\s*(#.*)?$/.test(line)) {
      const indent = INDENT_OF(line);
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        const s = lines[j].trim();
        if (s === '' || s.startsWith('#')) continue;
        if (INDENT_OF(lines[j]) <= indent) {
          end = j;
          break;
        }
      }
      return { start: i + 1, end };
    }
  }
  return null;
}

// 把 roles: 段按 `- match: <value>` 切块；每块到段内下一个 `- match:` 行为止。
export function splitMatchBlocks(lines, segment) {
  const { start, end } = segment;
  const blocks = [];
  let current = null;
  for (let i = start; i < end; i += 1) {
    const m = lines[i].match(/^\s*-\s*match:\s*(.*?)\s*$/);
    if (m) {
      current = { match: m[1].replace(/^['"]|['"]$/g, ''), line: i + 1, body: [] };
      blocks.push(current);
    } else if (current) {
      current.body.push(lines[i]);
    }
  }
  return blocks;
}

export function hasReadOnlySandbox(body) {
  // 行级判定，但忽略 `#` 后的注释：注释掉的 `sandbox: read-only` 不生效，不算数。
  return body.some((line) => /sandbox:\s*read-only\b/.test(line.replace(/\s#.*$/, '')));
}

// ---- 内容比较 ---------------------------------------------------------------

// 文本归一：把缓冲区按 UTF-8 解码为字符串，并把 CRLF / 孤立 CR 统一为 LF。
// 解码失败（二进制/非 UTF-8）返回 null，由调用方退回逐字节比较。
// 背景：仓库工作树在 core.autocrlf=true 下是 CRLF，安装副本（来自提交/pack）是 LF，
//       按字节比较会把「仅换行符不同」误判为内容漂移（Windows 验收永远过不了）。
export function normalizeText(buf) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  } catch {
    return null;
  }
}

// 判定两侧内容是否一致：两侧都能解码为文本时只比归一后内容；
// 任一侧解码失败则退回逐字节比较（保持原行为，二进制不会被放宽）。
export function contentsEqual(bufA, bufB) {
  const textA = normalizeText(bufA);
  const textB = normalizeText(bufB);
  if (textA !== null && textB !== null) return textA === textB;
  return bufA.equals(bufB);
}

// ---- 检查项 -----------------------------------------------------------------

function checkInstalledDir(installedDir) {
  if (isDirectory(installedDir)) {
    pass('installed-dir', installedDir);
    return;
  }
  fail('installed-dir', `不存在 ${installedDir}`);
}

function checkVersion(installedDir) {
  const repoPkgPath = path.join(repoPluginDir, 'package.json');
  const instPkgPath = path.join(installedDir, 'package.json');
  const repoVersion = readJsonVersion(repoPkgPath);
  const instVersion = readJsonVersion(instPkgPath);

  if (repoVersion === null) {
    fail('version', `仓库 package.json 缺失或无法解析: ${repoPkgPath}`);
    return;
  }
  if (instVersion === null) {
    fail('version', `installed package.json 缺失或无法解析: ${instPkgPath}`);
    return;
  }
  if (instVersion !== repoVersion) {
    fail('version', `installed ${instVersion} ≠ 仓库 ${repoVersion}`);
    return;
  }
  pass('version', `installed ${instVersion} = 仓库 ${repoVersion}`);
}

function checkFiles(installedDir) {
  if (!isDirectory(repoPluginDir)) {
    fail('files', `仓库插件目录不存在: ${repoPluginDir}`);
    return;
  }
  const relFiles = listFiles(repoPluginDir);
  const mismatches = [];
  for (const rel of relFiles) {
    const repoPath = path.join(repoPluginDir, ...rel.split('/'));
    const instPath = path.join(installedDir, ...rel.split('/'));
    if (!isFile(instPath)) {
      mismatches.push(`${rel}: installed 缺失`);
      continue;
    }
    const repoBuf = fs.readFileSync(repoPath);
    const instBuf = fs.readFileSync(instPath);
    if (!contentsEqual(repoBuf, instBuf)) {
      // detail 保留原始字节数（诊断用）；判定只看归一后内容。
      mismatches.push(`${rel}: 内容不同（仓库 ${repoBuf.length} B / installed ${instBuf.length} B）`);
    }
  }
  if (mismatches.length > 0) {
    for (const detail of mismatches) fail('files', detail);
    return;
  }
  pass('files', `${relFiles.length} 个文件与 installed 内容一致（文本按 UTF-8 归一后比较，忽略 CRLF/LF 差异）`);
}

function checkProfileRoles(ymlPath) {
  let lines;
  try {
    lines = fs.readFileSync(ymlPath, 'utf8').split(/\r?\n/);
  } catch {
    fail('profile-roles', `无法读取 ${ymlPath}`);
    return;
  }
  const segment = findRolesSegment(lines);
  if (!segment) {
    // 0.23.0：roles 表只服务 spike 沙箱（评审角色已由 readonlySandbox +
    // agentOptions 结构覆盖），缺失是开源默认安装的合法形态——降为提示。
    pass('profile-roles', '未配置 roles 表：spike 沙箱不收窄（评审角色已由 readonlySandbox + agentOptions 结构覆盖）');
    return;
  }
  const blocks = splitMatchBlocks(lines, segment);
  const existing = blocks.map((b) => b.match).join(', ') || '（空）';

  for (const role of ['只读', '勘察']) {
    const matched = blocks.filter((b) => b.match === role);
    if (matched.length === 0) {
      fail('profile-roles', `roles 段未找到 "- match: ${role}" 块（现有 match: ${existing}）`);
      continue;
    }
    const missing = matched.filter((b) => !hasReadOnlySandbox(b.body));
    if (missing.length > 0) {
      fail(
        'profile-roles',
        `"- match: ${role}" 块（L${missing.map((b) => b.line).join(',')}）缺 sandbox: read-only`,
      );
      continue;
    }
    pass('profile-roles', `"- match: ${role}" 块含 sandbox: read-only（L${matched.map((b) => b.line).join(',')}）`);
  }
}

// ---- 0.21.0 只读评审 preset / 委派工具 --------------------------------------
// 判定对象是**安装副本**的 cordis.patch.yml：两行 insert 由本插件 bundle patch
// 注入，profile 自己的 cordis.patch.yml 里未必出现（files 项已比对内容，本项
// 专门断言两行存在且关键字段正确——它们缺一，纪律文本引用的 subagent_readonly
// 就在宿主里不存在，评审会退回普通 subagent、工具面强制静默失效）。

// 返回 `- id: <id>` 所在 insert 项的行号（1 基）与块体；块到下一个缩进 <= 自身的
// `- id:` 行为止。行级解析，注释行与空行不参与边界判定。
export function findInsertBlock(lines, id) {
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^([ \t]*)-[ \t]*id:[ \t]*(\S+)[ \t]*(?:#.*)?$/);
    if (!head || head[2] !== id) continue;
    const indent = head[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const s = lines[j].trim();
      if (s === '' || s.startsWith('#')) continue;
      const next = lines[j].match(/^([ \t]*)-[ \t]*id:/);
      if (next && next[1].length <= indent) {
        end = j;
        break;
      }
    }
    return { line: i + 1, body: lines.slice(i + 1, end) };
  }
  return null;
}

export function findInsertField(body, key, value) {
  const pattern = new RegExp(`^[ \\t]*${key}:[ \\t]*${value}[ \\t]*$`);
  return body.some((line) => pattern.test(line));
}

function checkReadonlyTool(installedDir) {
  const ymlPath = path.join(installedDir, 'cordis.patch.yml');
  let lines;
  try {
    lines = fs.readFileSync(ymlPath, 'utf8').split(/\r?\n/);
  } catch {
    fail('readonly-tool', `无法读取 ${ymlPath}`);
    return;
  }
  const preset = findInsertBlock(lines, 'preset-dispatch-readonly');
  if (!preset) {
    fail('readonly-tool', `未找到 "- id: preset-dispatch-readonly"（${ymlPath}）`);
    return;
  }
  const tool = findInsertBlock(lines, 'tool-subagent-readonly');
  if (!tool) {
    fail('readonly-tool', `未找到 "- id: tool-subagent-readonly"（${ymlPath}）`);
    return;
  }
  const missing = [];
  for (const [key, value] of [
    ['provider', 'spawn'],
    ['toolName', 'subagent_readonly'],
    ['agentPreset', 'dispatch-readonly'],
    // 0.22.0：路由在工具实例上钉死；缺了 agentOptions 字段，评审角色的路由就
    // 退回继承 + model-pin 兜底（descriptor 不一致的老问题回归）。
    // 0.23.0：默认路由是 stock 可用的 deepseek-official/deepseek-flash，不 pin
    // effort；机器专属路由属于 profile 覆盖，不在安装副本的断言面内。
    ['agentOptions', ''],
    ['provider', 'deepseek-official'],
    ['model', 'deepseek-flash'],
  ]) {
    if (!findInsertField(tool.body, key, value)) missing.push(value === '' ? key : `${key}: ${value}`);
  }
  if (missing.length > 0) {
    fail('readonly-tool', `"- id: tool-subagent-readonly"（L${tool.line}）缺 ${missing.join('、')}`);
    return;
  }
  pass(
    'readonly-tool',
    `preset-dispatch-readonly（L${preset.line}）+ tool-subagent-readonly（L${tool.line}）含 provider: spawn / toolName: subagent_readonly / agentPreset: dispatch-readonly / agentOptions: deepseek-official+deepseek-flash`,
  );
}

// ---- 0.23.0 白名单模式提示 --------------------------------------------------
// model-pin 0.4.0 起注入感知白名单：profile 启用了
// subagent-model-selection-settings（enabled: true）→ 注入式（descriptor /
// 首请求 / 冷恢复一致）；否则兜底式（agent/created select）。两种模式都能用，
// 本项恒 PASS，只把不可见的语义差异变成可见。

function checkWhitelistMode(ymlPath) {
  let lines;
  try {
    lines = fs.readFileSync(ymlPath, 'utf8').split(/\r?\n/);
  } catch {
    fail('whitelist-mode', `无法读取 ${ymlPath}`);
    return;
  }
  const row = findInsertBlock(lines, 'subagent-model-selection-settings');
  const enabled = row !== null && findInsertField(row.body, 'enabled', 'true');
  pass(
    'whitelist-mode',
    enabled
      ? `注入式：白名单已启用（L${row.line}），model-pin 走 tools/execute 注入`
      : '兜底式：无白名单策略，model-pin 跳过注入、走 agent/created select（可用；要 descriptor 一致就在「子智能体」设置页启用白名单）',
  );
}

// ---- 0.23.2 钉路一致性（route-alignment） -----------------------------------
// 问题：评审/勘察角色的路由由 tool-subagent-readonly 的 agentOptions 在创建时
// 钉死；model-pin 的 roles 表（R4）若把只读前缀（只读/勘察/评审…）指向另一条
// 路由，会在 agent/created 时 select 覆盖钉路——descriptor 与运行路由不一致，
// 且路由结果取决于 label 措辞（前缀命中才覆盖）。本项在两份 yml 上行级比对，
// 让漂移在任何机器上可见。实证：2026-11-24 本机「评审…」被覆盖、「…勘察」
// 词尾不命中而保留，同批派发两套路由。

/** 只读角色前缀（小写）：roles 表里这些 match 会作用于 subagent_readonly 子代理。 */
export const READONLY_ROLE_PREFIXES = ['只读', '勘察', '评审', '复审', 'survey', 'review', 'recon']

// 从块体里取某个嵌套段（如 agentOptions:）内的 provider/model/reasoningEffort。
// 段从 `key:` 行之后开始，到第一个缩进 <= key 行缩进的非空非注释行为止。
// 键缺失返回 null（区别于「键在但值为空」——行级解析不区分 null 值）。
export function extractNestedRoute(body, key) {
  for (let i = 0; i < body.length; i += 1) {
    const head = body[i].match(new RegExp(`^([ \\t]*)${key}:[ \\t]*(?:#.*)?$`))
    if (!head) continue
    const indent = head[1].length
    const route = {}
    for (let j = i + 1; j < body.length; j += 1) {
      const s = body[j].trim()
      if (s === '' || s.startsWith('#')) continue
      if (INDENT_OF(body[j]) <= indent) break
      const m = body[j].match(/^[ \t]*(provider|model|reasoningEffort):[ \t]*(\S+?)[ \t]*$/)
      if (m && route[m[1]] === undefined) route[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
    return route
  }
  return null
}

// 取块体的「直接」路由字段：同键多行时取缩进最小者（嵌套段里的同名键更深）。
export function extractDirectRoute(body) {
  const best = {}
  for (const line of body) {
    const m = line.match(/^([ \t]*)(provider|model|reasoningEffort):[ \t]*(\S+?)[ \t]*$/)
    if (!m) continue
    const indent = m[1].length
    if (best[m[2]] === undefined || indent < best[m[2]].indent) {
      best[m[2]] = { indent, value: m[3].replace(/^['"]|['"]$/g, '') }
    }
  }
  const route = {}
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    if (best[key] !== undefined) route[key] = best[key].value
  }
  return route
}

// 取单个 roles 块的路由：块内同名字段只出现一次，直接逐行取。
export function extractRoleRoute(blockBody) {
  const route = {}
  for (const line of blockBody) {
    const m = line.replace(/\s#.*$/, '').match(/^[ \t]*(provider|model|reasoningEffort):[ \t]*(\S+?)[ \t]*$/)
    if (m && route[m[1]] === undefined) route[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return route
}

const normEffort = (route) => route.reasoningEffort === undefined || route.reasoningEffort === '' ? undefined : route.reasoningEffort

/**
 * 比对 profile 的 model-pin 只读角色表与 tool-subagent-readonly 的有效钉路。
 * 纯函数：输入两份 yml 的行数组，返回判定；不读盘、不打印。
 * @returns `{ status, pin, drifts }`：status ∈ no-model-pin | no-roles |
 *   pin-missing | aligned | drift；drifts 元素 `{ match, line, route }`。
 */
export function assessRouteAlignment(profileLines, bundleLines) {
  const pin = (() => {
    const overrideBlock = findInsertBlock(profileLines, 'tool-subagent-readonly')
    if (overrideBlock !== null) {
      const route = extractNestedRoute(overrideBlock.body, 'agentOptions')
      return route === null ? null : { ...route, source: 'profile 覆盖' }
    }
    const bundleBlock = findInsertBlock(bundleLines, 'tool-subagent-readonly')
    if (bundleBlock === null) return undefined // 安装副本缺行：readonly-tool 项已 FAIL
    return { ...extractNestedRoute(bundleBlock.body, 'agentOptions'), source: 'bundle 默认' }
  })()

  const modelPin = findInsertBlock(profileLines, 'subagent-model-pin')
  if (modelPin === null) return { status: 'no-model-pin', pin, drifts: [] }

  const segment = findRolesSegment(profileLines)
  const blocks = segment === null ? [] : splitMatchBlocks(profileLines, segment)
  const defaultEffort = normEffort(extractDirectRoute(modelPin.body))
  const readonlyRoles = blocks.filter((b) => READONLY_ROLE_PREFIXES.includes(b.match.trim().toLowerCase()))
  if (readonlyRoles.length === 0) return { status: 'no-roles', pin, drifts: [] }
  if (pin === null) return { status: 'pin-missing', pin, drifts: [] }
  if (pin === undefined) return { status: 'no-roles', pin, drifts: [] } // 钉路缺失另行报告，不在本项重复 FAIL

  const drifts = readonlyRoles.filter((b) => {
    const route = extractRoleRoute(b.body)
    // 角色的有效 effort = 自己的 ?? model-pin 默认；与钉路 effort 对齐才算一致。
    const roleEffort = normEffort(route) ?? defaultEffort
    return route.provider !== pin.provider || route.model !== pin.model || roleEffort !== normEffort(pin)
  }).map((b) => ({ match: b.match, line: b.line, route: extractRoleRoute(b.body) }))
  return { status: drifts.length === 0 ? 'aligned' : 'drift', pin, drifts }
}

const routeTextOf = (route) => `${route.provider ?? '?'}/${route.model ?? '?'}${normEffort(route) === undefined ? '' : ` effort=${normEffort(route)}`}`

function checkRouteAlignment(installedDir, ymlPath) {
  let profileLines
  let bundleLines
  try {
    profileLines = fs.readFileSync(ymlPath, 'utf8').split(/\r?\n/)
    bundleLines = fs.readFileSync(path.join(installedDir, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
  } catch (error) {
    fail('route-alignment', `无法读取 yml：${error.message}`)
    return
  }
  const { status, pin, drifts } = assessRouteAlignment(profileLines, bundleLines)
  if (status === 'no-model-pin') {
    pass('route-alignment', 'profile 未覆盖 model-pin：只读角色路由由 agentOptions 钉死，无 roles 漂移面')
    return
  }
  if (status === 'no-roles') {
    pass('route-alignment', `roles 表无只读角色：评审/勘察走 ${pin === null || pin === undefined ? '继承路由（钉路缺失，见 readonly-tool 项）' : `agentOptions 钉路 ${routeTextOf(pin)}（${pin.source}）`}`)
    return
  }
  if (status === 'pin-missing') {
    fail('route-alignment', 'profile 覆盖了 tool-subagent-readonly 但缺 agentOptions：钉路被移除，只读角色退回 model-pin 角色表（descriptor 不一致的老问题回归）')
    return
  }
  if (status === 'aligned') {
    pass('route-alignment', `只读角色表与钉路一致：${routeTextOf(pin)}（${pin.source}）`)
    return
  }
  for (const d of drifts) {
    fail(
      'route-alignment',
      `"- match: ${d.match}"（L${d.line}）= ${routeTextOf(d.route)} ≠ 钉路 ${routeTextOf(pin)}（${pin.source}）：该角色会在 agent/created 时 select 覆盖钉路，descriptor 与运行路由不一致。修法：profile 按 id 整段覆盖 tool-subagent-readonly 的 agentOptions 为该路由，或把角色改为钉路路由，或删除该角色（roles 只留 spike 沙箱职责）`,
    )
  }
}

// ---- 主流程 -----------------------------------------------------------------

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log('用法: node plugins/dispatch-protocol/scripts/verify-install.mjs [--profile <name>]');
    return 0;
  }
  if (parsed.error) {
    console.error(`verify-install: ${parsed.error}（用法: --profile <name>，默认 desktop）`);
    return 1;
  }

  const profile = parsed.profile;
  const profileDir = path.join(os.homedir(), '.dsh', 'profiles', profile);
  const installedDir = path.join(profileDir, 'node_modules', 'dispatch-protocol');
  const ymlPath = path.join(profileDir, 'cordis.patch.yml');

  checkInstalledDir(installedDir);
  checkVersion(installedDir);
  checkFiles(installedDir);
  checkProfileRoles(ymlPath);
  checkReadonlyTool(installedDir);
  checkWhitelistMode(ymlPath);
  checkRouteAlignment(installedDir, ymlPath);

  return results.every((r) => r.ok) ? 0 : 1;
}

// 直接运行脚本时执行核验；被 import 时只暴露行级解析助手里及内容归一助手（供反例测试复用）。
const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedAsScript) {
  process.exitCode = main();
}
