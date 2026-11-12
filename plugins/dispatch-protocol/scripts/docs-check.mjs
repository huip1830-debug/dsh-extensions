#!/usr/bin/env node
/**
 * docs-check.mjs — 确定性文档检查器（纯 Node、零依赖、只读）。
 *
 * 契约：docs/superpowers/specs/2026-11-12-doc-verification-by-assertion.md §1 D1。
 *
 * 用法：
 *   node scripts/docs-check.mjs [--self-test] [--root <dir>] [files...]
 *
 * 无 files 且无 --self-test 时扫描 <root>（默认 cwd）下的「当前事实文档」：
 * AGENTS.md、README.md、`docs/agent/**`、`plugins/*\/README.md`、
 * `docs/superpowers/specs/**`；跳过 docs/reviews、docs/superpowers/plans 等
 * 历史/证据快照，以及 node_modules/、.git/、tmp/。
 *
 * 输出逐条 `PASS|FAIL <code> <file>:<line> <detail>`，末行
 * `docs-check: files=<N> fail=<M>`；M>0 → exit 1。
 *
 * DOC005 的「键名是真实配置键」只查 `lib/config-keys.mjs` 的 `CONFIG_KEYS`
 * 显式清单（逐字命中）。0.12.0 前的「末段属性名兜底」已删除——兜底会让
 * `gates.review.textDocOnly` 这类已删除的键靠注释/错误串里的属性名蒙混过关。
 *
 * 只读：仅 --self-test 会写 os.tmpdir()，结束即删除；绝不写被检查文件。
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { CONFIG_KEYS } from '../lib/config-keys.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp'])
const CODES = ['DOC001', 'DOC002', 'DOC003', 'DOC004', 'DOC005']
const CONFIG_KEY_SET = new Set(CONFIG_KEYS)

/** 结果记录：{ code, file, line, detail }。 */
function finding(code, file, line, detail) {
  return { code, file, line, detail }
}

/** 把 `PASS|FAIL <code> <file>:<line> <detail>` 渲染成一行。 */
function render(ok, code, file, line, detail) {
  return `${ok ? 'PASS' : 'FAIL'} ${code} ${file}:${line} ${detail}`
}

/**
 * 遮罩行内代码 `` `…` ``：按 CommonMark 的「同长度反引号串配对」规则，
 * 把整个 span（含边界反引号）替换为 CODE，供括号/竖线/链接检查忽略。
 * 连续 ≥3 个反引号按字面量处理（表格单元里描述 ``` 围栏时很常见；
 * 整行围栏已由 inFence 跳过，这里只影响正文/表格行）。
 */
function maskInlineCode(line) {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i]
      i += 1
      continue
    }
    let n = 0
    while (line[i + n] === '`') n += 1
    if (n >= 3) {
      out += '`'.repeat(n)
      i += n
      continue
    }
    let j = i + n
    let close = -1
    while (j < line.length) {
      if (line[j] === '`') {
        let m = 0
        while (line[j + m] === '`') m += 1
        if (m === n) {
          close = j
          break
        }
        j += m
      } else {
        j += 1
      }
    }
    if (close === -1) {
      out += '`'.repeat(n)
      i += n
    } else {
      out += 'CODE'
      i = close + n
    }
  }
  return out
}

/** 行内代码遮罩（供括号/竖线/链接检查忽略代码内容）。 */
function stripInlineCode(line) {
  return maskInlineCode(line)
}

/** 表格行按未转义 `|` 切列，去掉行内代码影响后计算列数。 */
function tableColumns(line) {
  const masked = stripInlineCode(line)
  const cells = masked.split(/(?<!\\)\|/)
  // 去掉行首/行尾 `|` 切出的一个空串（只去一个）；中间的空单元格是真实列。
  if (cells.length > 0 && cells[0] === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.length
}

function countChars(text, ch) {
  let n = 0
  for (const c of text) if (c === ch) n += 1
  return n
}

/**
 * 递归收集默认扫描目标（只收存在的文件）：spec D1 的「当前事实文档」集合。
 *
 * 只扫 AGENTS.md、README.md、`docs/agent/**`、`plugins/*\/README.md`、
 * `docs/superpowers/specs/**`；`docs/reviews/**` 与 `docs/superpowers/plans/**`
 * 是历史/证据快照，不冒充现状，天然不在扫描根下。`node_modules/`、`.git/`、
 * `tmp/` 一律跳过。
 */
function defaultFiles(root) {
  const out = []
  const addFile = (p) => {
    if (existsSync(p) && statSync(p).isFile()) out.push(p)
  }
  for (const name of ['AGENTS.md', 'README.md']) addFile(join(root, name))

  const walkMarkdown = (dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walkMarkdown(join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(join(dir, entry.name))
      }
    }
  }
  walkMarkdown(join(root, 'docs', 'agent'))
  walkMarkdown(join(root, 'docs', 'superpowers', 'specs'))

  const plugins = join(root, 'plugins')
  if (existsSync(plugins) && statSync(plugins).isDirectory()) {
    for (const entry of readdirSync(plugins, { withFileTypes: true })) {
      if (entry.isDirectory()) addFile(join(plugins, entry.name, 'README.md'))
    }
  }
  return out
}

function toDisplayPath(abs, root, explicit) {
  if (explicit) {
    const rel = relative(process.cwd(), abs)
    return isAbsolute(rel) || rel.startsWith('..') ? abs.replaceAll(sep, '/') : rel.replaceAll(sep, '/')
  }
  const rel = relative(root, abs)
  return (rel === '' ? abs : rel).replaceAll(sep, '/')
}

/**
 * 分析一个文档内容，返回 findings。
 * @param {string} text 文档全文
 * @param {{file: string, docDir: string, root: string}} ctx
 */
function analyzeDocument(text, ctx) {
  const { file, docDir, root } = ctx
  const lines = text.split(/\r?\n/)
  const findings = []
  const inFence = new Array(lines.length).fill(false)

  // 第一遍：围栏状态标注（DOC001/003/004/005 跳过围栏内行）。
  let openAt = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) {
      if (openAt === 0) {
        openAt = i + 1
        inFence[i] = true
      } else {
        inFence[i] = true
        openAt = 0
      }
      continue
    }
    if (openAt !== 0) inFence[i] = true
  }
  if (openAt !== 0) {
    findings.push(finding('DOC002', file, openAt, '代码围栏未闭合（``` 计数为奇数）'))
  }

  // DOC001：全角/半角括号逐行平衡（跳过围栏与行内代码）。
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i]) continue
    const visible = stripInlineCode(lines[i])
    const fwOpen = countChars(visible, '（')
    const fwClose = countChars(visible, '）')
    const hwOpen = countChars(visible, '(')
    const hwClose = countChars(visible, ')')
    if (fwOpen !== fwClose || hwOpen !== hwClose) {
      findings.push(finding(
        'DOC001', file, i + 1,
        `括号不平衡：全角 ${fwOpen}/${fwClose}，半角 ${hwOpen}/${hwClose}`,
      ))
    }
  }

  // DOC003：同一连续表格块内列数一致（跳过围栏，忽略行内代码里的 `|`）。
  let blockStart = 0
  let expected = 0
  for (let i = 0; i < lines.length; i += 1) {
    const isRow = !inFence[i] && lines[i].startsWith('|')
    if (isRow) {
      const cols = tableColumns(lines[i])
      if (blockStart === 0) {
        blockStart = i + 1
        expected = cols
      } else if (cols !== expected) {
        findings.push(finding(
          'DOC003', file, i + 1,
          `表格列数 ${cols}，与块首（第 ${blockStart} 行）的 ${expected} 列不一致`,
        ))
      }
    } else {
      blockStart = 0
      expected = 0
    }
  }

  // DOC004：相对链接目标存在（跳过外链/锚点，先文档目录、后 root 解析）。
  // 围栏与行内代码里的 `](x)` 是示例，不是链接，跳过。
  const linkRe = /\]\(([^)]+)\)/g
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i]) continue
    const visible = maskInlineCode(lines[i])
    linkRe.lastIndex = 0
    let m
    while ((m = linkRe.exec(visible)) !== null) {
      const raw = m[1].trim()
      if (raw === '') continue
      if (/^(https?:\/\/|mailto:|#)/i.test(raw)) continue
      let target = raw.replace(/^<|>$/g, '')
      // 去掉 `"title"` 或 'title' 后缀；去锚点/查询串。
      target = target.replace(/\s+("[^"]*"|'[^']*')$/, '').trim()
      target = target.split('#')[0].split('?')[0]
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      const candidates = [resolve(docDir, target), resolve(root, target)]
      if (!candidates.some((p) => existsSync(p))) {
        findings.push(finding('DOC004', file, i + 1, `链接目标不存在：${raw}`))
      }
    }
  }

  // DOC005：配置表行首键必须逐字命中 CONFIG_KEYS 清单（只查表格行）。
  const keyRe = /^\|\s*`(gates|writePolicy)\.[A-Za-z.]+`/
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i]) continue
    const m = keyRe.exec(lines[i])
    if (!m) continue
    const key = m[0].replace(/^\|\s*`/, '').replace(/`$/, '')
    if (!CONFIG_KEY_SET.has(key)) {
      findings.push(finding('DOC005', file, i + 1, `配置键不在 CONFIG_KEYS 清单中：${key}`))
    }
  }

  return findings
}

/** 逐文件检查，返回 { findings, files }。targets: { path, explicit }[]。 */
function checkFiles(targets, { root }) {
  const findings = []
  let files = 0
  for (const target of targets) {
    const abs = target.path
    files += 1
    const file = toDisplayPath(abs, root, target.explicit)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      findings.push(finding('DOC000', file, 0, '文件不存在'))
      continue
    }
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch (error) {
      findings.push(finding('DOC000', file, 0, `无法读取：${error.message}`))
      continue
    }
    const docFindings = analyzeDocument(text, { file, docDir: dirname(abs), root })
    findings.push(...docFindings)
  }
  return { findings, files }
}

/** 输出结果并返回退出码。 */
function emit({ findings, files }) {
  let failed = 0
  for (const f of findings) {
    failed += 1
    console.log(render(false, f.code, f.file, f.line, f.detail))
  }
  console.log(`docs-check: files=${files} fail=${failed}`)
  return failed > 0 ? 1 : 0
}

/** CLI 主流程。 */
function run(argv) {
  const options = parseArgs(argv)
  if (options.error) {
    console.error(`docs-check: ${options.error}`)
    return 2
  }
  if (options.selfTest) return selfTest()

  const root = resolve(options.root ?? process.cwd())
  const targets = options.files.length > 0
    ? options.files.map((f) => ({ path: resolve(process.cwd(), f), explicit: true }))
    : defaultFiles(root).map((abs) => ({ path: abs, explicit: false }))

  const result = checkFiles(targets, { root })

  // 每个文件每个 code 至少一条 PASS（无 FAIL 时）；先 PASS 后 FAIL，末行汇总。
  const failedCodes = new Set(result.findings.map((f) => `${f.file}|${f.code}`))
  const passLines = []
  for (const target of targets) {
    const display = toDisplayPath(target.path, root, target.explicit)
    const missing = result.findings.some((f) => f.file === display && f.code === 'DOC000')
    if (missing) continue
    for (const code of CODES) {
      if (!failedCodes.has(`${display}|${code}`)) {
        passLines.push(render(true, code, display, 1, code === 'DOC002' ? '围栏成对闭合' : '检查通过'))
      }
    }
  }
  for (const line of passLines) console.log(line)
  return emit(result)
}

function parseArgs(argv) {
  const options = { selfTest: false, root: null, files: [], error: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--self-test') options.selfTest = true
    else if (arg === '--root') {
      if (i + 1 >= argv.length) return { ...options, error: '--root 需要一个目录参数' }
      options.root = argv[++i]
    } else if (arg.startsWith('--')) {
      return { ...options, error: `未知参数 ${arg}` }
    } else {
      options.files.push(arg)
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// self-test：fixture 全部建在 os.tmpdir()，不写仓库。
// ---------------------------------------------------------------------------

function selfTest() {
  const base = mkdtempSync(join(tmpdir(), 'docs-check-selftest-'))
  let pass = 0
  let fail = 0
  const t = (name, ok, detail) => {
    if (ok) {
      pass += 1
      console.log(`self-test PASS ${name}`)
    } else {
      fail += 1
      console.log(`self-test FAIL ${name}: ${detail}`)
    }
  }

  try {
    const docs = join(base, 'docs')
    mkdirp(docs)

    const writeFixture = (name, content) => {
      const p = join(docs, name)
      writeFileSync(p, content, 'utf8')
      return p
    }

    // 1) 括号平衡（含行内代码里的不平衡括弧，应忽略）。
    {
      const p = writeFixture('doc001-ok.md', [
        '# 标题（含说明）',
        '正文 `fn((` 与 `）` 在行内代码里，不算。',
        '半角 (a) 与全角（b）都平衡。',
      ].join('\n'))
      const fs1 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc001-ok.md', docDir: docs, root: base })
      t('DOC001 平衡', !fs1.some((f) => f.code === 'DOC001'), JSON.stringify(fs1))
    }
    // 2) 括号不平衡：真实样本 AGENTS.md:7 形态（全角 open=8 / close=7）。
    {
      const line7 = '规则：' + '（'.repeat(8) + '说明' + '）'.repeat(7)
      const p = writeFixture('doc001-bad.md', ['# 1', '', '# 3', '', '', '', line7].join('\n'))
      const fs2 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc001-bad.md', docDir: docs, root: base })
      const hit = fs2.find((f) => f.code === 'DOC001')
      t('DOC001 不平衡（AGENTS.md:7 形态）', Boolean(hit) && hit.line === 7, JSON.stringify(fs2))
    }
    // 3) 围栏闭合。
    {
      const p = writeFixture('doc002-ok.md', ['```js', 'a(b', '```', '', '```', 'c)）', '```'].join('\n'))
      const fs3 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc002-ok.md', docDir: docs, root: base })
      t('DOC002 围栏闭合', !fs3.some((f) => f.code === 'DOC002'), JSON.stringify(fs3))
    }
    // 4) 围栏不闭合。
    {
      const p = writeFixture('doc002-bad.md', ['# t', '```js', 'code', '```', '```js', 'never closed'].join('\n'))
      const fs4 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc002-bad.md', docDir: docs, root: base })
      t('DOC002 围栏不闭合', fs4.some((f) => f.code === 'DOC002'), JSON.stringify(fs4))
    }
    // 5) 表格齐（行内代码含 `|` 也不破坏列数）。
    {
      const p = writeFixture('doc003-ok.md', [
        '| 键 | 值 |',
        '| --- | --- |',
        '| `a|b` | x |',
        '| c | d |',
      ].join('\n'))
      const fs5 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc003-ok.md', docDir: docs, root: base })
      t('DOC003 表格齐', !fs5.some((f) => f.code === 'DOC003'), JSON.stringify(fs5))
    }
    // 5b) 首列为空的表格（`| | a |`）：只去掉分隔符产生的空串，空首列是真实列。
    {
      const p = writeFixture('doc003-empty-first.md', [
        '| | LLM 调用 | 输出 |',
        '|---|---:|---|',
        '| 主控 | 70 | 4.2 万 |',
      ].join('\n'))
      const fs5b = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc003-empty-first.md', docDir: docs, root: base })
      t('DOC003 空首列表格齐', !fs5b.some((f) => f.code === 'DOC003'), JSON.stringify(fs5b))
    }
    // 6) 表格不齐。
    {
      const p = writeFixture('doc003-bad.md', ['| a | b |', '| --- | --- |', '| c | d | e |'].join('\n'))
      const fs6 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc003-bad.md', docDir: docs, root: base })
      t('DOC003 表格不齐', fs6.some((f) => f.code === 'DOC003'), JSON.stringify(fs6))
    }
    // 7) 相对链接存在（文档目录 / root 两条解析路径）。
    {
      writeFixture('target.md', '# target')
      const p = writeFixture('doc004-ok.md', [
        '[同目录](target.md) [root 相对](docs/target.md) [外链](https://example.com) [锚点](#a)',
      ].join('\n'))
      const fs7 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc004-ok.md', docDir: docs, root: base })
      t('DOC004 链接存在', !fs7.some((f) => f.code === 'DOC004'), JSON.stringify(fs7))
    }
    // 8) 相对链接不存在。
    {
      const p = writeFixture('doc004-bad.md', '[缺失](no-such-file.md)')
      const fs8 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc004-bad.md', docDir: docs, root: base })
      t('DOC004 链接不存在', fs8.some((f) => f.code === 'DOC004'), JSON.stringify(fs8))
    }
    // 9) 配置键在 CONFIG_KEYS 清单内 → PASS。
    {
      const p = writeFixture('doc005-ok.md', ['| 键 | 默认 |', '| --- | --- |', '| `gates.wait.enabled` | true |'].join('\n'))
      const fs9 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc005-ok.md', docDir: docs, root: base })
      t('DOC005 清单内键通过', !fs9.some((f) => f.code === 'DOC005'), JSON.stringify(fs9))
    }
    // 10) 清单内的嵌套数组叶子（gates.verify.docPatterns 是输入键）逐字命中 → PASS。
    {
      const p = writeFixture('doc005-nested.md', ['| 键 | 默认 |', '| --- | --- |', '| `gates.verify.docPatterns` | `[]` |'].join('\n'))
      const fs10a = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc005-nested.md', docDir: docs, root: base })
      t('DOC005 清单内嵌套键通过', !fs10a.some((f) => f.code === 'DOC005'), JSON.stringify(fs10a))
    }
    // 11) 清单外键：0.10.0 已删除的 gates.review.textDocOnly 必须 FAIL。
    {
      const p = writeFixture('doc005-bad.md', ['| 键 | 默认 |', '| --- | --- |', '| `gates.review.textDocOnly` | false |'].join('\n'))
      const fs10 = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc005-bad.md', docDir: docs, root: base })
      t('DOC005 清单外键失败（0.10.0 textDocOnly 漂移形态）', fs10.some((f) => f.code === 'DOC005'), JSON.stringify(fs10))
    }
    // 11b) 末段兜底已删：末段名 enabled 虽在清单里，完整键不在 → FAIL。
    {
      const p = writeFixture('doc005-noleaf.md', ['| 键 | 默认 |', '| --- | --- |', '| `gates.unknown.enabled` | true |'].join('\n'))
      const fs10b = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc005-noleaf.md', docDir: docs, root: base })
      t('DOC005 不做末段兜底', fs10b.some((f) => f.code === 'DOC005'), JSON.stringify(fs10b))
    }
    // 11c) 0.10.0 真实漂移样本：把内部镜像字段 gates.review.docPatterns 当配置键 → FAIL。
    {
      const p = writeFixture('doc005-mirror.md', ['| 键 | 默认 |', '| --- | --- |', '| `gates.review.docPatterns` | `[]` |'].join('\n'))
      const fs10c = analyzeDocument(readFileSync(p, 'utf8'), { file: 'doc005-mirror.md', docDir: docs, root: base })
      t('DOC005 镜像字段冒充配置键失败（0.10.0 docPatterns 漂移形态）',
        fs10c.some((f) => f.code === 'DOC005'), JSON.stringify(fs10c))
    }
    // 12) 文件不存在 → DOC000，且整体 exit 1。
    {
      const missing = { path: join(docs, 'not-there.md'), explicit: true }
      const r = checkFiles([missing], { root: base })
      t('DOC000 文件不存在', r.findings.some((f) => f.code === 'DOC000') && exitCodeFor(r) === 1, JSON.stringify(r))
    }
    // 13) 汇总退出码：有 FAIL → 1，全 PASS → 0。
    {
      const good = { path: writeFixture('exit-ok.md', '# ok\n'), explicit: true }
      const rGood = checkFiles([good], { root: base })
      t('退出码：全 PASS → 0', exitCodeFor(rGood) === 0, JSON.stringify(rGood))
      const bad = { path: writeFixture('exit-bad.md', '（不闭合'), explicit: true }
      const rBad = checkFiles([bad], { root: base })
      t('退出码：有 FAIL → 1', exitCodeFor(rBad) === 1, JSON.stringify(rBad))
    }
    // 14) 默认扫描只收「当前事实文档」：docs/reviews 等历史快照不进扫描集。
    {
      const scanRoot = join(base, 'scan-root')
      mkdirp(join(scanRoot, 'docs', 'agent'))
      mkdirp(join(scanRoot, 'docs', 'superpowers', 'specs'))
      mkdirp(join(scanRoot, 'docs', 'reviews'))
      mkdirp(join(scanRoot, 'plugins', 'demo'))
      writeFileSync(join(scanRoot, 'README.md'), '# root\n', 'utf8')
      writeFileSync(join(scanRoot, 'docs', 'agent', 'y.md'), '# clean\n', 'utf8')
      writeFileSync(join(scanRoot, 'docs', 'superpowers', 'specs', 'z.md'), '# spec\n', 'utf8')
      writeFileSync(join(scanRoot, 'plugins', 'demo', 'README.md'), '# plugin\n', 'utf8')
      // 历史快照里的括号不平衡不得被扫描，否则无参运行会出现 reviews 噪音。
      writeFileSync(join(scanRoot, 'docs', 'reviews', 'x.md'), '（不闭合\n', 'utf8')

      const scanned = defaultFiles(scanRoot).map((abs) => relative(scanRoot, abs).replaceAll(sep, '/'))
      const expected = ['README.md', 'docs/agent/y.md', 'docs/superpowers/specs/z.md', 'plugins/demo/README.md']
      t('默认扫描只收当前事实文档',
        expected.every((p) => scanned.includes(p)) && !scanned.some((p) => p.startsWith('docs/reviews/')),
        JSON.stringify(scanned))
      const rScan = checkFiles(defaultFiles(scanRoot).map((abs) => ({ path: abs, explicit: false })), { root: scanRoot })
      t('默认扫描跳过 docs/reviews（无噪音 FAIL）', rScan.findings.length === 0, JSON.stringify(rScan.findings))
    }
  } finally {
    try { rmSync(base, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ }
  }

  console.log(`self-test: pass=${pass} fail=${fail}`)
  return fail > 0 ? 1 : 0
}

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true })
}

/** 仅计算退出码，不打印（self-test 用）。 */
function exitCodeFor(result) {
  return result.findings.length > 0 ? 1 : 0
}

// 入口
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2))
}
