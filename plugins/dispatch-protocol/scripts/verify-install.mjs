#!/usr/bin/env node
/**
 * verify-install.mjs — dispatch-protocol 安装核验（发布流程防漂移）
 *
 * 用途：核验 ~/.dsh/profiles/<profile>/node_modules/dispatch-protocol/ 的安装副本
 *       是否与仓库 plugins/dispatch-protocol/ 一致，并核验 profile 的
 *       cordis.patch.yml 只读角色表未漂移（`- match: 只读` / `- match: 勘察`
 *       块内必须含 `sandbox: read-only`）。
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
 *       检查项固定为 installed-dir / version / files / profile-roles。
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
    if (!repoBuf.equals(instBuf)) {
      mismatches.push(`${rel}: 内容不同（仓库 ${repoBuf.length} B / installed ${instBuf.length} B）`);
    }
  }
  if (mismatches.length > 0) {
    for (const detail of mismatches) fail('files', detail);
    return;
  }
  pass('files', `${relFiles.length} 个文件与 installed 逐字节一致`);
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
    fail('profile-roles', `未找到 roles: 段（${ymlPath}）`);
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

  return results.every((r) => r.ok) ? 0 : 1;
}

// 直接运行脚本时执行核验；被 import 时只暴露上面三个行级解析助手（供反例测试复用）。
const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedAsScript) {
  process.exitCode = main();
}
