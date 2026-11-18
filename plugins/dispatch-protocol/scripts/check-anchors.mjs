#!/usr/bin/env node
/**
 * check-anchors.mjs — README `文件#符号` 锚点检查器（纯 Node、零依赖、只读）。
 *
 * 背景：README 曾用 `文件:行号` 定位代码，每次在文件里插入代码都会让锚点整体
 * 漂移（0.14.0 / 0.14.1 / 0.15.0 各重算一次）。锚点改成 `文件#符号` 后只依赖
 * 符号名，代码插在哪都不失效；本脚本把「文档说的符号是否真的存在」变成一次
 * 确定性检查。
 *
 * 用法：
 *   node plugins/dispatch-protocol/scripts/check-anchors.mjs [files...]
 *   node plugins/dispatch-protocol/scripts/check-anchors.mjs --self-test
 *
 * 无 files 时扫仓库根的 `README.md` 与 `plugins/*\/README.md`。锚点按「文档
 * 所在目录 → 仓库根 → `plugins/<插件名>/`」依次解析文件；符号在接受
 * `function X` / `const X` / `export function X` / `class X` / `X =` 等常见
 * 定义形态的文件里用词边界匹配，匹配前先剥离注释（`// function foo` 不算定义）。
 *
 * 行号锚点直接判 FAIL：`foo.mjs:12`、`lib/foo.mjs:12-34` 都会随代码插入失效，
 * 提示改成 `文件#符号`。判定面只含 `.mjs`（仓库自身源码）：`.js` 行号锚点可能
 * 指向宿主打包产物（如 `dsh-client-ui-xxx` 的 `lib/client.js`），不在本仓库
 * 扫描面内，不判；本 README 里的 `client.js:行号` 仍按本批要求改成
 * `client.js#符号`。
 *
 * 输出逐条 `PASS|FAIL <code> <file>:<line> <detail>`，末行
 * `anchors-check: files=<N> fail=<M>`；M>0 → exit 1。
 *
 * 只读：仅 --self-test 会写 os.tmpdir()，结束即删除；绝不写被检查文件。
 * 围栏（``` / ~~~）里的内容是示例不是锚点，不参与解析与行号禁止判定。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const CODES = ['ANCHOR000', 'ANCHOR001', 'ANCHOR002']

/** 行内锚点：`` `文件#符号` ``；文件可带相对路径。 */
const ANCHOR_SPAN = /^([\w./-]+)#([A-Za-z_$][\w$]*)$/

/** 行号锚点：`.mjs` 后跟 `:数字`（含区间）。 */
const LINE_ANCHOR = /[\w./-]+\.mjs:\d+(?:-\d+)?/g

/** 仓库根：本脚本固定位于 `<仓库根>/plugins/dispatch-protocol/scripts/`。 */
function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/** 默认扫描集：仓库根 README.md + plugins/*​/README.md（按路径排序，输出稳定）。 */
function defaultFiles(root) {
  const files = []
  const rootReadme = join(root, 'README.md')
  if (existsSync(rootReadme)) files.push(rootReadme)
  let entries = []
  try {
    entries = readdirSync(join(root, 'plugins'), { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const readme = join(root, 'plugins', entry.name, 'README.md')
    if (existsSync(readme)) files.push(readme)
  }
  return files
}

/** 文档所在插件名（`<root>/plugins/<name>/…`）；拿不到返回 undefined。 */
function pluginNameOf(docDir, root) {
  const pluginsDir = join(root, 'plugins')
  const rel = relative(pluginsDir, docDir).replaceAll(sep, '/')
  if (rel === '' || rel === '..' || rel.startsWith('../')) return undefined
  const name = rel.split('/')[0]
  return name === '' ? undefined : name
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 剥掉注释后再匹配，避免 `// function foo` 被判成定义（假 PASS）。
 *
 * 保守口径：只剥成对块注释与「行首或空白之后」的 `//` 行注释；
 * 字符串 / 正则里的 `//` 前面通常是引号或 `:`，不剥——宁少剥，不误删真定义。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\r\n]*/gm, '$1')
}

/**
 * 符号是否在源码里以「具名定义」出现（注释先剥离）。
 *
 * 词边界用 `(?<![\w$.])` / `(?![\w$])` 而不是 `\b`：`$`/`.` 不是单词字符，
 * `\b` 会把 `state.warned = true` 误认成 `warned` 的定义。
 */
function hasSymbol(source, symbol) {
  const name = escapeRegExp(symbol)
  const before = '(?<![\\w$.])'
  const after = '(?![\\w$])'
  const code = stripComments(source)
  const patterns = [
    new RegExp(`${before}(?:async\\s+)?function\\s+${name}${after}`),
    new RegExp(`${before}class\\s+${name}${after}`),
    new RegExp(`${before}(?:const|let|var)\\s+${name}${after}`),
    new RegExp(`${before}${name}\\s*=(?!=)`),
    new RegExp(`${before}export\\s*\\{[^}]*${name}${after}[^}]*\\}`),
  ]
  return patterns.some((pattern) => pattern.test(code))
}

/** 锚点目标文件：文档目录 → 仓库根 → plugins/<插件名>/，首个存在者为准。 */
function resolveTarget(ref, docDir, root) {
  const candidates = [resolve(docDir, ref), resolve(root, ref)]
  const plugin = pluginNameOf(docDir, root)
  if (plugin !== undefined) candidates.push(resolve(root, 'plugins', plugin, ref))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 展示用相对路径；根外的显式文件原样展示。 */
function displayPath(file, root) {
  const rel = relative(root, file).replaceAll(sep, '/')
  return rel === '' || rel.startsWith('../') ? file.replaceAll(sep, '/') : rel
}

/** 检查一份文档，返回 `[{ ok, code, line, file, detail }]`。 */
function analyzeDocument(text, { file, docDir, root, sourceCache }) {
  const findings = []
  const lines = text.split(/\r?\n/)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const span = match[1].trim()
      const anchor = ANCHOR_SPAN.exec(span)
      if (anchor === null) continue
      const [, ref, symbol] = anchor
      const target = resolveTarget(ref, docDir, root)
      if (target === undefined) {
        findings.push({
          ok: false,
          code: 'ANCHOR001',
          line: i + 1,
          file,
          detail: `${span}：文件不存在（按文档目录 / 仓库根 / plugins/<插件名>/ 都找不到）`,
        })
        continue
      }
      let source = sourceCache.get(target)
      if (source === undefined) {
        source = readFileSync(target, 'utf8')
        sourceCache.set(target, source)
      }
      if (!hasSymbol(source, symbol)) {
        findings.push({
          ok: false,
          code: 'ANCHOR001',
          line: i + 1,
          file,
          detail: `${span}：在 ${displayPath(target, root)} 里找不到符号 ${symbol}（接受 function / const / let / var / class 定义或 \`${symbol} =\` 赋值）`,
        })
        continue
      }
      findings.push({
        ok: true,
        code: 'ANCHOR001',
        line: i + 1,
        file,
        detail: `${span} -> ${displayPath(target, root)}`,
      })
    }

    for (const match of line.matchAll(LINE_ANCHOR)) {
      findings.push({
        ok: false,
        code: 'ANCHOR002',
        line: i + 1,
        file,
        detail: `${match[0]}：行号锚点会随代码插入失效，改为 \`文件#符号\``,
      })
    }
  }
  return findings
}

/** 检查一批文件：返回 `{ findings, fail, files }`。 */
function checkFiles(files, { root }) {
  const findings = []
  const sourceCache = new Map()
  const scanned = []
  for (const file of files) {
    if (!existsSync(file)) {
      findings.push({ ok: false, code: 'ANCHOR000', line: 0, file, detail: '文件不存在' })
      scanned.push(file)
      continue
    }
    scanned.push(file)
    const text = readFileSync(file, 'utf8')
    findings.push(...analyzeDocument(text, { file, docDir: dirname(file), root, sourceCache }))
  }
  return { findings, fail: findings.filter((finding) => !finding.ok).length, files: scanned }
}

function render(finding, root) {
  return `${finding.ok ? 'PASS' : 'FAIL'} ${finding.code} ${displayPath(finding.file, root)}:${finding.line} ${finding.detail}`
}

/** 入口：普通检查。 */
function run(args) {
  const root = repoRoot()
  const explicit = args.filter((arg) => !arg.startsWith('--'))
  const files = explicit.length > 0
    ? explicit.map((file) => resolve(file))
    : defaultFiles(root)
  const result = checkFiles(files, { root })
  for (const finding of result.findings) console.log(render(finding, root))
  console.log(`anchors-check: files=${result.files.length} fail=${result.fail}`)
  return result.fail > 0 ? 1 : 0
}

/** 内建自检：全部 fixture 建在 os.tmpdir()，结束即删。 */
function selfTest() {
  let pass = 0
  let fail = 0
  const t = (name, ok, detail) => {
    if (ok) {
      pass += 1
      return
    }
    fail += 1
    console.log(`FAIL self-test ${name} ${detail ?? ''}`)
  }
  const base = mkdtempSync(join(tmpdir(), 'dispatch-anchors-'))
  try {
    const root = join(base, 'repo')
    const plugin = join(root, 'plugins', 'demo')
    const nested = join(plugin, 'docs')
    mkdirSync(nested, { recursive: true })

    writeFileSync(join(root, 'README.md'), '# root\n\n没有锚点。\n', 'utf8')
    writeFileSync(join(plugin, 'plugin.mjs'), [
      '// 定义形态：function / const / class / 赋值。',
      'function makeGuard(config) { return config }',
      'const CSS = [\'a\']',
      'class Widget {}',
      'let counter = 0',
      'container.counter = 1',
      'export { makeGuard, CSS, Widget }',
      '',
    ].join('\n'), 'utf8')
    mkdirSync(join(plugin, 'lib'), { recursive: true })
    writeFileSync(join(plugin, 'client.js'), [
      'const CSS = [\'a\']',
      'const MARKER_PATH = \'dispatch/protocol.json\'',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(plugin, 'lib', 'project.mjs'), 'export function readProjectPolicy(cwd) { return cwd }\n', 'utf8')
    writeFileSync(join(plugin, 'README.md'), [
      '# demo',
      '',
      '| 机制 | 位置 |',
      '|---|---|',
      '| 守卫 | `plugin.mjs#makeGuard` |',
      '| 样式 | `client.js#CSS` |',
      '| 读取 | `lib/project.mjs#readProjectPolicy` |',
      '| 类 | `plugin.mjs#Widget` |',
      '| 导出列表 | `plugin.mjs#counter` |',
      '',
      '失败样本：',
      '',
      '- `plugin.mjs#noSuchSymbol`',
      '- `lib/missing.mjs#anything`',
      '- `plugin.mjs:12`',
      '- `client.js:49-52`',
      '- 外部包不判：`src/client/service.ts:420-435`',
      '',
      '```text',
      '围栏里的示例不算锚点：`plugin.mjs:99`',
      '```',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(nested, 'note.md'), '不是 README，默认扫描不收。\n', 'utf8')

    const scanned = defaultFiles(root).map((file) => displayPath(file, root))
    t('默认扫描集 = 根 README + plugins/*/README.md',
      scanned.length === 2 && scanned.includes('README.md') && scanned.includes('plugins/demo/README.md'),
      JSON.stringify(scanned))

    const result = checkFiles(defaultFiles(root), { root })
    const fails = result.findings.filter((finding) => !finding.ok)
    const passes = result.findings.filter((finding) => finding.ok)
    t('有效锚点全 PASS（文档目录 / 插件根 / client.js / 导出形态）',
      passes.length === 5, JSON.stringify(passes.map((finding) => finding.detail)))
    t('缺符号 → ANCHOR001 FAIL',
      fails.some((finding) => finding.code === 'ANCHOR001' && finding.detail.includes('noSuchSymbol')),
      JSON.stringify(fails))
    t('缺文件 → ANCHOR001 FAIL',
      fails.some((finding) => finding.code === 'ANCHOR001' && finding.detail.includes('lib/missing.mjs')),
      JSON.stringify(fails))
    t('`.mjs:行号` → ANCHOR002 FAIL',
      fails.some((finding) => finding.code === 'ANCHOR002' && finding.detail.includes('plugin.mjs:12')),
      JSON.stringify(fails))
    t('`.js:行号` 不在禁止面（可指向宿主打包产物）',
      !fails.some((finding) => finding.detail.includes('client.js:49')), JSON.stringify(fails))
    t('外部 `.ts:行号` 不误报',
      !fails.some((finding) => finding.detail.includes('service.ts')), JSON.stringify(fails))
    t('围栏内示例不误报',
      !fails.some((finding) => finding.detail.includes('plugin.mjs:99')), JSON.stringify(fails))
    t('汇总 fail 计数与 FAIL 行数一致', result.fail === fails.length, `${result.fail} vs ${fails.length}`)

    const okFile = join(base, 'ok.md')
    writeFileSync(okFile, '`plugins/demo/plugin.mjs#makeGuard`\n', 'utf8')
    t('explicit 文件按文档目录解析且 fail=0', checkFiles([okFile], { root }).fail === 0, '')

    const missing = join(base, 'missing.md')
    const r = checkFiles([missing], { root })
    t('显式文件不存在 → ANCHOR000 + fail>0',
      r.findings.some((finding) => finding.code === 'ANCHOR000') && r.fail === 1, JSON.stringify(r.findings))

    writeFileSync(join(plugin, 'lib', 'comments-only.mjs'), [
      '// function onlyInComment() { return 1 }',
      '/* class alsoOnlyInComment {} */',
      'const realOne = 1',
      '',
    ].join('\n'), 'utf8')
    const commentDoc = join(base, 'comments.md')
    writeFileSync(commentDoc, [
      '`plugins/demo/lib/comments-only.mjs#onlyInComment`',
      '`plugins/demo/lib/comments-only.mjs#alsoOnlyInComment`',
      '`plugins/demo/lib/comments-only.mjs#realOne`',
      '',
    ].join('\n'), 'utf8')
    const commentResult = checkFiles([commentDoc], { root })
    const commentFails = commentResult.findings.filter((finding) => !finding.ok)
    t('仅注释里出现符号 → ANCHOR001 FAIL（行注释/块注释先剥离）',
      commentFails.length === 2
        && commentFails.every((finding) => finding.code === 'ANCHOR001')
        && commentResult.findings.some((finding) => finding.ok && finding.detail.includes('#realOne')),
      JSON.stringify(commentResult.findings))

    // 回归：「// 」只在行首/空白后剥离，`https://` 与字符串里的 ` // ` 前的真定义不能被连带删掉，
    // 否则只会假 FAIL（保守方向可接受，但定义须仍在）。keepMe 与 URL 同行，专测 URL 不被剥；
    // afterSep 在含 ` // ` 字符串的下一行，专测剥离不越行。
    writeFileSync(join(plugin, 'lib', 'strings.mjs'), [
      '// `https://` 与字符串里的 `//` 不是注释起点的回归样本。',
      'const url = \'https://example.com\'; function keepMe() { return 1 }',
      'const sep = \' // \'',
      'function afterSep() { return 1 }',
      '',
    ].join('\n'), 'utf8')
    const stringsDoc = join(base, 'strings.md')
    writeFileSync(stringsDoc, [
      '`plugins/demo/lib/strings.mjs#keepMe`',
      '`plugins/demo/lib/strings.mjs#afterSep`',
      '',
    ].join('\n'), 'utf8')
    const stringsResult = checkFiles([stringsDoc], { root })
    t('`https://` 与字符串内 ` // ` 不被剥离（真定义仍在）',
      stringsResult.fail === 0
        && stringsResult.findings.filter((finding) => finding.ok).length === 2,
      JSON.stringify(stringsResult.findings))
  } finally {
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判定。
    }
  }
  console.log(`self-test: pass=${pass} fail=${fail}`)
  return fail > 0 ? 1 : 0
}

// 入口
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  process.exitCode = args.includes('--self-test') ? selfTest() : run(args)
}
