#!/usr/bin/env node
/**
 * verify-install.mjs — dispatch-protocol 安装核验（发布流程防漂移）
 *
 * 用途：核验 ~/.dsh/profiles/<profile>/node_modules/dispatch-protocol/ 的安装副本
 *       是否与仓库 plugins/dispatch-protocol/ 一致，以及两组 0.21.0/0.25.0 insert
 *       （`preset-dispatch-readonly` + `tool-subagent-readonly`、
 *       `preset-dispatch-spike` + `tool-subagent-spike`）仍在且带 `agentOptions`
 *       路由钉。profile 侧另核 0.25.0 的 roles 退役迁移（roles 表运行时忽略：
 *       纯路由角色是 WARN，带 `sandbox` 字段的角色失效方向是放宽约束，必须 FAIL）
 *       与 `readonlySandbox.presets` 是否仍收窄 spike。
 *
 * 依据：docs/superpowers/specs/2026-11-25-subagent-route-structural-ownership-design.md
 *       §4.1（roles 退役：路由失效安全、沙箱失效放宽）、§6.3（检查项清单）、
 *       §9（三处钉路不再互相踩踏，不一致只剩运维统一性问题，故 route-coverage 只 WARN）；
 *       0.4.1 patch plan §6 / 评审主文档 §10.3-P1（只读沙箱失守的实证）。
 *       本脚本是发布流程的防漂移核验：插件走 GitHub 依赖安装到 profile 后，
 *       用本脚本在发布前后各跑一次。
 *
 * 用法：
 *   node plugins/dispatch-protocol/scripts/verify-install.mjs [--profile <name>]
 *   --profile  指定 profile 名（默认 desktop），即 ~/.dsh/profiles/<name>/
 *
 * 输出：每行 [PASS] <name> — <detail> / [WARN] <name> — <detail> /
 *       [FAIL] <name> — <detail>；WARN 只提示，不计 fail。检查项为
 *       installed-dir / version / files / readonly-tool / spike-tool /
 *       whitelist-mode / route-coverage / roles-migration / presets-override
 *       （whitelist-mode 恒 PASS 只报告注入式/兜底式；0.25.0 起 route-alignment
 *       退役——两份事实已由结构钉路消除，改为 route-coverage 的 WARN 级一致性
 *       提示；profile-roles 随 model-pin 0.5.0 的 roles 退役一并删除，roles 面
 *       由 roles-migration 承担）。
 *       任一 FAIL → 进程退出码 1；无 FAIL → 退出码 0。
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

// 0.25.0：WARN 级只提示、不影响退出码（results 不记账）。用于「两份事实已消除、
// 不一致只是运维不统一」的场景（spec §9）——不把提示升级成发布闸门。
function warn(name, detail) {
  console.log(`[WARN] ${name} ${EM_DASH} ${detail}`);
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

// ---- 0.25.0 钉路覆盖（route-coverage，WARN 级）与 roles 退役迁移 --------------
// 0.25.0 起三处钉路各自独立、不再互相踩踏：
//   tool-subagent-readonly.agentOptions / tool-subagent-spike.agentOptions /
//   model-pin 顶层 provider+model。不一致只剩运维统一性问题（spec §9），所以只
//   WARN；任一处缺失时降级为单项提示，不 FAIL、不崩脚本。

// 取块体内某个嵌套段（如 agentOptions:）的路由字段。
// 段从 `key:` 行之后开始，到第一个缩进 <= key 行缩进的非空非注释行为止。
// 键缺失返回 null（区别于「键在但值为空」——行级解析不区分 null 值）。
function extractRouteBlock(body, key) {
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

// 取块体的「顶层」路由字段：同键多行时取缩进最小者（roles 等嵌套段里的同名键更深）。
function extractTopRoute(body) {
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

const normEffort = (route) => route.reasoningEffort === undefined || route.reasoningEffort === '' ? undefined : route.reasoningEffort

const routeTextOf = (route) => route === null
  ? '缺失'
  : `${route.provider ?? '?'}/${route.model ?? '?'}${normEffort(route) === undefined ? '' : ` effort=${normEffort(route)}`}`

// 三处钉路是否同一条路由：provider/model 必须相等，effort 按「未 pin = undefined」比较。
function sameRoute(a, b) {
  return a.provider === b.provider && a.model === b.model && normEffort(a) === normEffort(b)
}

// 工具实例的有效钉路：profile 覆盖优先，缺省取安装副本（bundle）默认值。
// 重要（config 整体替换语义）：profile 覆盖段存在但缺 agentOptions 时该工具**没有
// 钉路**，子代理继承父路由——bundle 默认根本不会生效，不能回退成 bundle 路由。
// 返回 `{ route, source, line }`；无钉路时 route 为 null（覆盖缺字段或两侧都没有）。
function effectiveToolRoute(profileLines, bundleLines, id) {
  const override = findInsertBlock(profileLines, id)
  if (override !== null) {
    const route = extractRouteBlock(override.body, 'agentOptions')
    if (route !== null) return { route, source: 'profile 覆盖', line: override.line }
    return { route: null, source: 'profile 覆盖缺 agentOptions', line: override.line }
  }
  if (bundleLines !== null) {
    const bundle = findInsertBlock(bundleLines, id)
    if (bundle !== null) {
      const route = extractRouteBlock(bundle.body, 'agentOptions')
      if (route !== null) return { route, source: 'bundle 默认', line: bundle.line }
    }
  }
  return null
}

// model-pin 顶层路由：profile 覆盖优先，缺省取 model-pin 安装副本（bundle）的
// cordis.patch.yml（安装副本是 profiles 目录外的另一份 bundle，不在本插件安装目录内）。
function effectiveModelPinRoute(profileLines, modelPinBundleLines) {
  const override = findInsertBlock(profileLines, 'subagent-model-pin')
  if (override !== null) {
    const route = extractTopRoute(override.body)
    if (route.provider !== undefined && route.model !== undefined) {
      return { route, source: 'profile 覆盖', line: override.line }
    }
  }
  if (modelPinBundleLines !== null) {
    const bundle = findInsertBlock(modelPinBundleLines, 'subagent-model-pin')
    if (bundle !== null) {
      const route = extractTopRoute(bundle.body)
      if (route.provider !== undefined && route.model !== undefined) {
        return { route, source: 'bundle 默认', line: bundle.line }
      }
    }
  }
  return null
}

/**
 * 比对三处钉路：readonly 工具、spike 工具、model-pin 顶层路由。
 * 纯函数：输入 yml 行数组，返回判定；不读盘、不打印。
 * @param profileLines - profile 的 cordis.patch.yml 行
 * @param bundleLines - dispatch-protocol 安装副本的行（可为 null）
 * @param modelPinBundleLines - subagent-model-pin 安装副本的行（可为 null）
 * @returns `{ level, status, routes }`：status ∈ aligned | drift | incomplete |
 *   override-without-pin；level ∈ pass | warn；routes 每项 `{ route, source, line }`
 *   （无钉路的覆盖段 route 为 null）或 null。
 */
export function assessRouteCoverage(profileLines, bundleLines, modelPinBundleLines) {
  const routes = {
    readonly: effectiveToolRoute(profileLines, bundleLines, 'tool-subagent-readonly'),
    spike: effectiveToolRoute(profileLines, bundleLines, 'tool-subagent-spike'),
    modelPin: effectiveModelPinRoute(profileLines, modelPinBundleLines),
  }
  const entries = Object.values(routes)
  const hasRoute = (entry) => entry !== null && entry.route !== null
    && entry.route.provider !== undefined && entry.route.model !== undefined
  // profile 覆盖段存在但缺 agentOptions：运行时该工具没有钉路，子代理继承父路由
  // （config 整体替换，bundle 默认不生效）。0.5.0 起 R4' 不再覆盖它，只剩「子代理
  // 跑父路由」的成本问题，所以只 WARN、不报一致性。
  if (entries.some((entry) => entry !== null && entry.route === null)) {
    return { level: 'warn', status: 'override-without-pin', routes }
  }
  // 其余缺失：降级为单项提示（readonly-tool / spike-tool 已各自断言安装副本，这里不重复 FAIL）。
  if (!entries.every(hasRoute)) return { level: 'pass', status: 'incomplete', routes }
  const aligned = entries.every((entry) => sameRoute(entry.route, entries[0].route))
  return { level: aligned ? 'pass' : 'warn', status: aligned ? 'aligned' : 'drift', routes }
}

/**
 * 0.25.0 roles 退役迁移判定（spec §4.1）。纯函数：只读行数组，不读盘、不打印。
 * 失效方向不对称：角色路由失效安全（少一次覆盖），角色沙箱失效是**放宽约束**
 * （spike 不再收窄）——所以含 sandbox 字段的角色必须是 FAIL 级。
 * @returns `{ level, status, roles }`：status ∈ no-model-pin | no-roles |
 *   routing-only | sandbox | mixed；roles 元素 `{ match, line, sandbox }`（line 为文件行号）。
 */
export function assessRolesMigration(profileLines) {
  const modelPin = findInsertBlock(profileLines, 'subagent-model-pin')
  if (modelPin === null) return { level: 'pass', status: 'no-model-pin', roles: [] }
  const segment = findRolesSegment(modelPin.body)
  if (segment === null) return { level: 'pass', status: 'no-roles', roles: [] }
  const roles = splitMatchBlocks(modelPin.body, segment).map((block) => ({
    match: block.match,
    line: modelPin.line + block.line,
    sandbox: hasSandboxField(block.body),
  }))
  if (roles.length === 0) return { level: 'pass', status: 'no-roles', roles: [] }
  const sandboxed = roles.filter((role) => role.sandbox)
  if (sandboxed.length === 0) return { level: 'warn', status: 'routing-only', roles }
  return { level: 'fail', status: sandboxed.length === roles.length ? 'sandbox' : 'mixed', roles }
}

/** `sandbox:` 字段是否真的生效（注释掉的键不算）。 */
function hasSandboxField(body) {
  return body.some((line) => {
    const s = line.trim()
    if (s === '' || s.startsWith('#')) return false
    return /^\s*sandbox:\s*\S/.test(line.replace(/\s#.*$/, ''))
  })
}

/** 取块体内某个键的嵌套段（0 基行号范围 + key 行号，相对入参数组）。 */
function findKeySegment(body, key) {
  for (let i = 0; i < body.length; i += 1) {
    if (!new RegExp(`^\\s*${key}:\\s*(?:#.*)?$`).test(body[i])) continue
    const indent = INDENT_OF(body[i])
    let end = body.length
    for (let j = i + 1; j < body.length; j += 1) {
      const s = body[j].trim()
      if (s === '' || s.startsWith('#')) continue
      if (INDENT_OF(body[j]) <= indent) {
        end = j
        break
      }
    }
    return { start: i + 1, end, keyLine: i }
  }
  return null
}

/** 读嵌套段内的 `presets:` 列表；inline `[a, b]` 与块状 `- a` 两种写法都认。 */
function parsePresets(body, segment) {
  for (let i = segment.start; i < segment.end; i += 1) {
    const line = body[i].replace(/\s#.*$/, '')
    const inline = line.match(/^\s*presets:\s*\[(.*?)\]\s*$/)
    if (inline) {
      return inline[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    }
    if (!/^\s*presets:\s*$/.test(line)) continue
    const indent = INDENT_OF(body[i])
    const presets = []
    for (let j = i + 1; j < segment.end; j += 1) {
      const s = body[j].trim()
      if (s === '' || s.startsWith('#')) continue
      if (INDENT_OF(body[j]) <= indent) break
      const item = body[j].match(/^\s*-\s*(\S+)\s*$/)
      if (item) presets.push(item[1].replace(/^['"]|['"]$/g, ''))
    }
    return presets
  }
  return null
}

/**
 * 0.25.0 `readonlySandbox.presets` 覆盖判定（spec §5.3/§6.3）。纯函数。
 * 无覆盖 → 默认含 dispatch-spike；覆盖了且不含 → spike 子代理不收窄（fail-open）。
 * @returns `{ level, status, presets, line }`：status ∈ no-override |
 *   no-readonly-sandbox | no-presets | ok | missing-spike。
 */
export function assessPresetsOverride(profileLines) {
  const override = findInsertBlock(profileLines, 'dispatch-protocol')
  if (override === null) return { level: 'pass', status: 'no-override', presets: null, line: null }
  const segment = findKeySegment(override.body, 'readonlySandbox')
  if (segment === null) return { level: 'pass', status: 'no-readonly-sandbox', presets: null, line: null }
  const line = override.line + segment.keyLine
  const presets = parsePresets(override.body, segment)
  if (presets === null) return { level: 'pass', status: 'no-presets', presets: null, line }
  return presets.includes('dispatch-spike')
    ? { level: 'pass', status: 'ok', presets, line }
    : { level: 'warn', status: 'missing-spike', presets, line }
}

/**
 * 0.25.0 spike 结构锚点（spec §5.1/§5.2）。纯函数：只读 cordis.patch.yml 行数组。
 * @returns `{ level, status, preset, tool, missing }`：status ∈
 *   missing（块缺失） | incomplete（字段缺失） | ok。
 */
export function assessSpikeTool(lines) {
  const preset = findInsertBlock(lines, 'preset-dispatch-spike')
  const tool = findInsertBlock(lines, 'tool-subagent-spike')
  if (preset === null || tool === null) return { level: 'fail', status: 'missing', preset, tool, missing: [] }
  const missing = []
  for (const [key, value] of [
    ['provider', 'spawn'],
    ['toolName', 'subagent_spike'],
    ['agentPreset', 'dispatch-spike'],
    ['modelSelection', 'false'],
    // 0.25.0：与 readonly 同口径——spike 组合在创建时钉死 stock 路由；profile
    // 覆盖不属于安装副本的断言面。
    ['agentOptions', ''],
    ['provider', 'deepseek-official'],
    ['model', 'deepseek-flash'],
  ]) {
    if (!findInsertField(tool.body, key, value)) missing.push(value === '' ? key : `${key}: ${value}`)
  }
  return missing.length === 0
    ? { level: 'pass', status: 'ok', preset, tool, missing }
    : { level: 'fail', status: 'incomplete', preset, tool, missing }
}

/** 逐条读 yml 行；不可读返回 null（0.25.0 新增项共用）。 */
function readYmlLines(ymlPath) {
  try {
    return fs.readFileSync(ymlPath, 'utf8').split(/\r?\n/)
  } catch {
    return null
  }
}

/** route-coverage：三处钉路一致性，只 WARN（不一致不 FAIL、不崩脚本）。 */
function checkRouteCoverage(installedDir, ymlPath) {
  const profileLines = readYmlLines(ymlPath)
  if (profileLines === null) {
    fail('route-coverage', `无法读取 ${ymlPath}`);
    return;
  }
  const bundleLines = readYmlLines(path.join(installedDir, 'cordis.patch.yml'));
  // model-pin 是同一 profile 的另一份安装副本（profiles 目录之外的独立 bundle），
  // 不在本插件安装目录内：取 node_modules/subagent-model-pin/cordis.patch.yml。
  const modelPinBundleLines = readYmlLines(path.join(installedDir, '..', 'subagent-model-pin', 'cordis.patch.yml'));
  const { status, routes } = assessRouteCoverage(profileLines, bundleLines, modelPinBundleLines);
  const detailOf = (name, entry) => {
    if (entry === null) return `${name}=缺失`;
    if (entry.route === null) return `${name}=无钉路（${entry.source}，L${entry.line}）`;
    return `${name}=${routeTextOf(entry.route)}（${entry.source}，L${entry.line}）`;
  };
  const detail = [detailOf('readonly', routes.readonly), detailOf('spike', routes.spike), detailOf('model-pin', routes.modelPin)].join('；');
  if (status === 'override-without-pin') {
    warn('route-coverage', `profile 覆盖段缺 agentOptions：config 整体替换语义下该工具没有钉路，子代理继承父路由（bundle 默认不生效；model-pin 0.5.0 起 R4' 不再覆盖它，只是成本问题）：${detail}`);
    return;
  }
  if (status === 'incomplete') {
    pass('route-coverage', `钉路未取齐，降级为单项提示（readonly-tool / spike-tool 已各自断言安装副本）：${detail}`);
    return;
  }
  if (status === 'aligned') {
    pass('route-coverage', `三处钉路一致：${detail}`);
    return;
  }
  warn('route-coverage', `三处钉路不一致（不再互相踩踏，只是运维不统一；要统一就按 id 整段覆盖对应工具或 model-pin 顶层路由）：${detail}`);
}

/** roles-migration：roles 表已退役；带 sandbox 的角色必须 FAIL（失效方向是放宽约束）。 */
function checkRolesMigration(ymlPath) {
  const lines = readYmlLines(ymlPath)
  if (lines === null) {
    fail('roles-migration', `无法读取 ${ymlPath}`);
    return;
  }
  const { status, roles } = assessRolesMigration(lines);
  if (status === 'no-model-pin') {
    pass('roles-migration', 'profile 未覆盖 subagent-model-pin：无 roles 迁移面');
    return;
  }
  if (status === 'no-roles') {
    pass('roles-migration', 'model-pin 未配置 roles 表：无迁移面');
    return;
  }
  const locate = (list) => list.map((role) => `"- match: ${role.match}"（L${role.line}）`).join('、');
  const sandboxed = roles.filter((role) => role.sandbox);
  if (sandboxed.length > 0) {
    fail('roles-migration', `model-pin 0.5.0 起 roles 表运行时忽略，角色沙箱的失效方向是放宽约束（spike 不再收窄）：${locate(sandboxed)} 含 sandbox 字段。修法：删除 roles 表；spike 沙箱由 dispatch-protocol readonlySandbox 按 preset 收窄，只读路由由工具的 agentOptions 钉死`);
  }
  const routingOnly = roles.filter((role) => !role.sandbox);
  if (routingOnly.length > 0) {
    warn('roles-migration', `model-pin 0.5.0 起 roles 表运行时忽略，以下角色的 provider/model 不再生效（只读子代理恒为工具钉路）：${locate(routingOnly)}。修法：删除 roles 表，默认路由改用顶层 provider/model`);
  }
}

/** spike-tool：bundle 的 preset-dispatch-spike + tool-subagent-spike 结构锚点。 */
function checkSpikeTool(installedDir) {
  const ymlPath = path.join(installedDir, 'cordis.patch.yml');
  const lines = readYmlLines(ymlPath);
  if (lines === null) {
    fail('spike-tool', `无法读取 ${ymlPath}`);
    return;
  }
  const { status, preset, tool, missing } = assessSpikeTool(lines);
  if (status === 'missing') {
    const found = [
      preset === null ? '"- id: preset-dispatch-spike"' : null,
      tool === null ? '"- id: tool-subagent-spike"' : null,
    ].filter(Boolean);
    fail('spike-tool', `未找到 ${found.join('、')}（${ymlPath}）`);
    return;
  }
  if (status === 'incomplete') {
    fail('spike-tool', `"- id: tool-subagent-spike"（L${tool.line}）缺 ${missing.join('、')}`);
    return;
  }
  pass(
    'spike-tool',
    `preset-dispatch-spike（L${preset.line}）+ tool-subagent-spike（L${tool.line}）含 provider: spawn / toolName: subagent_spike / agentPreset: dispatch-spike / modelSelection: false / agentOptions: deepseek-official+deepseek-flash`,
  );
}

/** presets-override：profile 覆盖了 presets 却漏了 dispatch-spike → spike 不收窄，WARN。 */
function checkPresetsOverride(ymlPath) {
  const lines = readYmlLines(ymlPath);
  if (lines === null) {
    fail('presets-override', `无法读取 ${ymlPath}`);
    return;
  }
  const { status, presets, line } = assessPresetsOverride(lines);
  if (status === 'no-override') {
    pass('presets-override', 'profile 未覆盖 dispatch-protocol：readonlySandbox 用默认 presets（含 dispatch-spike）');
    return;
  }
  if (status === 'no-readonly-sandbox' || status === 'no-presets') {
    pass('presets-override', 'profile 覆盖了 dispatch-protocol 但未覆盖 readonlySandbox.presets：默认含 dispatch-spike，spike 仍收窄');
    return;
  }
  if (status === 'ok') {
    pass('presets-override', `readonlySandbox.presets（L${line}）含 dispatch-spike：${presets.join(', ')}`);
    return;
  }
  warn('presets-override', `readonlySandbox.presets（L${line}）= ${presets.join(', ')} 不含 dispatch-spike：spike 子代理不收窄（fail-open，继承父沙箱）。修法：把 dispatch-spike 加进 presets，或删除该覆盖用默认值`);
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
  checkReadonlyTool(installedDir);
  checkSpikeTool(installedDir);
  checkWhitelistMode(ymlPath);
  checkRouteCoverage(installedDir, ymlPath);
  checkRolesMigration(ymlPath);
  checkPresetsOverride(ymlPath);

  return results.every((r) => r.ok) ? 0 : 1;
}

// 直接运行脚本时执行核验；被 import 时只暴露行级解析助手里及内容归一助手（供反例测试复用）。
const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedAsScript) {
  process.exitCode = main();
}
