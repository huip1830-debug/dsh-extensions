// Offline regression for the dispatch-protocol plugin — no DSH process, no dependencies.
//
//   node test.mjs
//
// The harness fakes the extension points the plugin uses:
//   - `ctx.systemPrompt.section(section)` (the system-prompt registry)
//   - `ctx.tools.guard(fn)` (0.9.0 write guard; `h.guard(exec)` replays a call)
//   - `agent/created` / `subagent/end` (root event bus)
//   - `agent.ctx.on('agent/turn-stopping')` + `agent.steer` (checkpoint)
//   - `session.snapshotEvents()` (committed `tool/call` records)
//   - `session.cwd` / `session.createdAt` (write-policy path and freshness)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from './plugin.mjs'
import { resolveConfig, AUTO_TEXT, DEFAULT_FOOTER, DEFAULT_RULES, BUSINESS_FOOTER, BUSINESS_RULES, resolveRulesPreset } from './lib/config.mjs'
import {
  DEFAULT_PROJECT_SWITCH, PROJECT_MODES, readProjectMode, readProjectPolicy, writeProjectMode,
} from './lib/project.mjs'
import {
  ARTIFACT, callTouchesFile, classifyPath, DEFAULT_CONTROL_PLANE_PATTERNS,
  DEFAULT_DOC_PATTERNS, DEFAULT_PWSH_MUTATION_PATTERN, DEFAULT_PWSH_SHELL_PATTERN, readWorkdir, summarizeTurn,
} from './lib/tool-calls.mjs'
import {
  DEFAULT_ALLOWLIST, DEFAULT_OVERRIDE_PATH, DEFAULT_WRITE_POLICY_MODE, resolveWritePolicy,
} from './lib/write-policy.mjs'

// Reminder behaviour is asserted from the harness messages. Decision logging
// stays off so a test run never appends to the real `%TEMP%` decision log; the
// tests that check log lines opt into an explicit path inside a temp dir.
const quiet = { log: false }

test('registers one prompt section with literal text and a stable order', () => {
  const h = harness()
  plugin.apply(h.ctx, {})

  assert.equal(h.sections.length, 1)
  const [section] = h.sections
  assert.equal(section.name, 'dispatch-protocol')
  assert.equal(section.order, 500)
  assert.equal(section.interpolate, false, '{{…}} in project text must stay literal')
})

test('the default text states all six dispatch rules', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /勘察/)
  assert.match(text, /白名单/)
  assert.match(text, /复跑/)
  assert.match(text, /只读评审/, 'an independent review child is required for qualifying batches')
  assert.match(text, /PASS\|FAIL/, 'the review verdict must be checkable, not prose')
  assert.match(text, /文件:行号/, 'each verdict must cite file:line evidence')
  assert.match(text, /不得采信实现者的自述或其测试通过/, 'the review must not trust the implementer or its tests')
  assert.match(text, /提交权/)
  assert.match(text, /并行/)
  assert.match(text, /互不依赖/, 'parallel recon must carry a trigger, not just a permission')
  assert.match(text, /在同一条消息里并行发出/, 'the trigger must name the concrete action')
  assert.match(text, /互斥并行写/, 'implementation parallelism is allowed behind disjoint whitelists')
  assert.match(text, /契约在派发前定死/, 'parallel implementation requires frozen contracts')
  assert.match(text, /共享产物/, 'shared build outputs stay serial')
  assert.match(text, /循环批/, 'the closing paragraph routes execution work to loop batches')
  assert.match(text, /合并判级/, '0.4.0: a change set cannot be split into normal batches to dodge review')
  assert.match(text, /重开评审|重开受影响切片|只重开被判 FAIL 的那一片/, '0.4.0/D6: post-review changes re-open the affected slice only')
  assert.match(text, /拆批方案或一行不派发理由/, '0.4.0: implementation plans must name the batches or the skip reason')

  // Rule 4 bounds the review object. The failure it prevents: a review that
  // starts from `git status` (or from "check the repo") turns one cross-cutting
  // change into a repository audit, and the report can no longer be tied to a
  // batch. A repo-wide sweep is legitimate only as a separate column with a
  // named search space, and only when the requirement is itself an invariant.
  assert.match(text, /评审只审变更集/, 'review covers the change set, not the repository')
  assert.match(text, /白名单并集的 diff/, 'the review input is the batch-union diff, not a worktree snapshot')
  assert.match(text, /不是工作区快照/, 'the brief must not hand the reviewer a worktree snapshot')
  assert.match(text, /不逐文件通读未改动文件/, 'the default review is not a repo audit')
  assert.match(text, /全仓不变量核查/, 'a repo-wide sweep is its own column, opened only for invariants')
  assert.match(text, /给定检索词与目录/, 'the sweep names its search space instead of "look everywhere"')
  assert.match(text, /用户可见的遗漏判 FAIL/, 'a sweep hit is a verdict, not a note')
  assert.match(text, /20 个文件或 3 个契约面/, 'the review package has an explicit capacity bound')
  assert.match(text, /跨切片一致性另设一包|跨切片一致性包只在切片确实独立/, 'cross-slice consistency is reviewed as its own package when slices are independent')
  assert.match(text, /程序化比对/, 'read-only shell comparison is in scope; build/test re-runs are not')

  // 0.5.1: the rules were reordered by "who decides what". Six rules, not
  // seven — the reordering moved review out of the grading rule into its own
  // paragraph, and an accidental seventh clause would silently dilute the
  // ownership split.
  assert.equal(DEFAULT_RULES.length, 6, '0.5.1: the rules are six, not seven')
  const order = ['先勘察', '执行类派发必须自包含', '验收与等待', '评审只审变更集', '提交权归派发方', '并行只读，互斥并行写'].map(t => text.indexOf(t))
  for (const index of order) assert.ok(index >= 0, '0.5.1: every rule title must be present')
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], '0.5.1: the rules must keep the responsibility order')
  }
  assert.match(text, /禁止重跑构建\/测试\/集成命令/)
  assert.match(text, /全 PASS 须说明每条例子的验证方式/)
  assert.match(text, /裁决归派发方/)
  assert.match(text, /按读写路径再切/)

  // The batch now has a clock and a freeze window. The failure it
  // prevents (session-1433e747): a 30-minute child burned 192 steps while the
  // dispatcher spent 54 of 106 minutes inside Start-Sleep, and the contract
  // moved under the child eight minutes in.
  assert.match(text, /覆盖本批改动的窄命令/, 'the child verification must be narrow')
  assert.match(text, /全量构建\/全量测试归派发方的集成命令/, 'the integrated run belongs to the dispatcher, not the brief')
  assert.match(text, /【预算：墙钟与步数上限】/, 'a batch carries a budget')
  assert.match(text, /一句话进度/, 'the child reports at half budget')
  assert.match(text, /超预算先报阻塞点再停/, 'over budget means report and stop, not extend')
  assert.match(text, /派发即冻结/, 'the contract is frozen while the batch runs')
  assert.match(text, /先停子代理（interrupt）/, 'a contract change stops the child first')
  assert.match(text, /结束回合等完成事件/, 'the dispatcher waits for the completion event instead of polling')
  assert.match(text, /不要用一串 Start-Sleep\/list_agents 轮询/, 'sleep-polling is named as the anti-pattern')
  assert.match(text, /一批最多一次主动检查/, 'at most one active check per batch')
  assert.match(text, /15 分钟或 30 次编辑/, 'the batch budget has calibrated defaults')
  assert.match(text, /10 分钟内出现第一个可验收切片/, 'slicing must produce an early verifiable piece')
  assert.doesNotMatch(text, /独立复跑/, 'the child claimed command is not re-run by the dispatcher')
  // 0.5.4: the no-re-run stance holds only while the integrated command covers
  // every narrow assertion; the single exception is spelled out in rule 3.
  assert.match(text, /集成命令必须覆盖各批窄验证断言点的并集/, 'the no-re-run stance has a coverage precondition')
  assert.match(text, /唯一的复跑例外/, 'the coverage gap exception is the only re-run')
})

// 0.12.0 — 文档通道实体化（spec §1 D2/D5）：机器检查器先跑，只有非空断言表
// 才买一次有界评审。断言放在渲染后的注入文本上，避免只改常量名却漏改正文。
test('0.12.0: rule 1 routes document batches through docs-check and an assertion table', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /scripts\/docs-check\.mjs/,
    '0.12.0 D2: rule 1 names the bundled deterministic checker instead of "机器校验"')
  assert.match(text, /断言 → 代码位置/,
    '0.12.0 D5: a document batch hands in an assertion → code-location table')
  assert.match(text, /本批无机制断言/,
    '0.12.0 D5 hardening: an empty table still leaves a ledger line')
})

test('0.12.0: rule 4 carries the injection surface and one bounded review', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /注入面/,
    '0.12.0 D5: AGENTS.md and docs/agent/* are an injection surface')
  assert.match(text, /有界评审/,
    '0.12.0 D5: a non-empty assertion table buys exactly one bounded review')
  assert.doesNotMatch(text, /必要时派最小只读评审/,
    '0.12.0 D5: the old "必要时" wording is replaced, not appended')
})

// 0.12.3 — 规则 1 的「表空即收口」曾吞掉规则 4 的注入面强制非空：注入面文档可以
// 凭一句无验证的「本批无机制断言」零评审收口。例外必须落在规则 1 正文里，所以断言
// 打在渲染后的注入文本上。
test('0.12.3: rule 1 exempts the injection surface from empty-table closure', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /注入面除外：断言表强制非空、不得空表收口/,
    '0.12.3: AGENTS.md and docs/agent/* cannot close on an empty assertion table')
  assert.match(text, /表空即收口且台账写「本批无机制断言」（AGENTS\.md 与 docs\/agent\/\* 注入面除外：断言表强制非空、不得空表收口）/,
    '0.12.3: the exception is attached to the empty-table clause instead of replacing it for ordinary documents')
})

test('2026-11-12: discipline text gaps', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  // D1 (A)：docs-check 在多数仓库不存在，允许「记一行台账」，但不得新建脚本。
  assert.match(text, /跑 scripts\/docs-check\.mjs（无此脚本的仓库记一行台账、不新建脚本）/,
    'D1: a repo without scripts/docs-check.mjs records one ledger line instead of failing')
  // D2 (B1)：只回 ok 不等于逐项确认，记法必须区分。
  assert.match(text, /用户只回 ok 时记「ok 视为接受推荐项」，不得写「用户已确认」。/,
    'D2: a bare "ok" is recorded as accepting the recommendation, never as user confirmation')
  // D3 (B2)：勘察必答现存调用方；没有调用方的实现要标「预防性实现」。
  assert.match(text, /结论（含现存调用方） \+ 不确定项」写成现状文件并在派发中引用，无现存调用方的实现在 spec 标「预防性实现」/,
    'D3: the survey answers reachability and marks a call-site-less implementation as preventive')
  // D4 (C)：多包仓库按端各一条集成命令，每端仍只跑一次。
  assert.match(text, /同一条命令全系统只跑一次，不重复付费（多包仓库按端各一条，每端只跑一次）。/,
    'D4: a multi-package repo gets one integrated command per side, each run once')
  // D5：规则正文同步「仓库无此脚本则记一行台账」。
  assert.match(text, /无此脚本的仓库记一行台账、不新建脚本/,
    'D5: the doc-only rule carries the ledger-line fallback')
})

test('0.12.0 D6: review rhythm is one package per change set, not one per batch', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /不得每批一评/,
    'D6: the default is a single final review per change set, not one review per batch')
  assert.match(text, /只重开被判 FAIL 的那一片/,
    'D6: a fix re-opens only the failed slice plus its direct impact surface')
})

test('configured rules replace the default text', () => {
  const h = harness()
  plugin.apply(h.ctx, { rules: ['第一条', '第二条'] })
  const text = h.sections[0].text

  assert.match(text, /第一条/)
  assert.match(text, /第二条/)
  // The closing paragraph stays: replacing `rules` replaces the numbered rules
  // only. `先勘察后派发` belongs to default rule 1, so its absence is what proves
  // the default rules are gone (0.11.0: the footer says 「先勘察后实现」, which is
  // deliberately a different string so this probe stays rule-1-only).
  assert.doesNotMatch(text, /先勘察后派发/)
  assert.match(text, /白名单与循环批/, 'the closing paragraph is independent of the rules')
})

test('a disabled plugin registers nothing', () => {
  const h = harness()
  plugin.apply(h.ctx, { enabled: false })
  assert.equal(h.sections.length, 0)
  // 0.9.0: 顶层 `enabled` 是总开关——提示词、写入守卫、收尾提醒一起关。
  assert.equal(h.guards.length, 0, 'enabled:false must not register the write guard')

  const parent = h.main('parent-disabled', [])
  h.created(h.child('child-disabled', 'parent-disabled', '实现 Task', [call(1, 'write', { file_path: 'a.ts' })]))
  h.ended({ childId: 'child-disabled', stopReason: 'completed' })
  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 0, 'enabled:false must not deliver any turn-stopping reminder')
})

test('config rejects values that would silently break the section', () => {
  assert.throws(() => resolveConfig({ order: Number.NaN }), /order/)
  assert.throws(() => resolveConfig({ rules: 'not-an-array' }), /rules/)
  assert.throws(() => resolveConfig({ rules: [] }), /rules/)

  const resolved = resolveConfig({})
  assert.equal(resolved.order, 500)
  assert.deepEqual(resolved.rules, DEFAULT_RULES)
})

test('the default rules carry the evidence and dispatch formats', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /文件:行号/, 'survey evidence format must be stated')
  assert.match(text, /允许修改/, 'dispatch whitelist section must be stated')
  assert.match(text, /唯一一条命令|一条命令/, 'single verification command must be stated')
})

test('one closing paragraph states who does what and when a dispatch may be skipped', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /白名单与循环批/, 'whitelist and loop batches are one paragraph')
  assert.match(text, /主控只做控制面/, 'the control plane is the only allowed surface')
  assert.match(text, /七类/, 'the control plane enumerates seven allowed action types')
  assert.match(text, /执行面一律派发/, 'execution work is always dispatched')
  assert.match(text, /循环批/, 'a loop batch is the routing unit for unknown-result work')
  assert.match(text, /NEEDS_DECISION/, 'a contract fork returns three lines, not a take-over')
  assert.match(text, /实测契约表/, 'external unknowns are measured before they are frozen')
  assert.match(text, /主控单回合 15 分钟\/20 步/, 'the symmetric budget caps the main agent turn')
  assert.match(text, /按「产出物归属」判定/, 'permission follows the artifact owner, not judgement density')
  assert.doesNotMatch(text, /均不命中/, 'the old micro-batch exemption exit must be gone')
  assert.doesNotMatch(text, /单文件且纯文案/, 'the small-change exemption is removed')
  assert.match(text, /轻批/, '0.8.1: a light batch is the small-task lane')
  assert.match(text, /有界直改/, '0.8.1: the bounded direct edit is the only main-agent write exception')
  assert.match(text, /单文件 ≤10 行/, '0.8.1: the direct edit is capped at one file of ten lines')
  assert.match(text, /同模式机械改写 ≤5 文件/, '0.8.1: the light batch covers up to five same-pattern files')
  assert.match(text, /按风险缩放/, '0.8.1: ceremony scales with risk')
  assert.match(text, /不搞全有或全无/, '0.8.1: the lane split is not all-or-nothing')
  assert.match(text, /默认派给子代理/, 'mechanical volume defaults to children')
  assert.match(text, /拆批/, 'uncertainty must map to batching')
  assert.match(text, /勘察一律用 `subagent_readonly`/, 'the first batch is a read-only survey dispatched through the readonly tool')
  assert.match(text, /可多批陆续派发/, 'several batches are allowed, split along mutually exclusive files')
  assert.match(text, /不许整包留给自己/, 'the fallback-to-self trap must be named')
  assert.match(text, /缺计划类 skill/, 'the missing-plan-skill path must be named')

  // No magic numbers on the two work bounds: the whitelist is bounded by "the
  // whole batch must be verifiable by one integrated command" and the task list
  // by "one entry = one decision or one batch". The one numeric bound in the
  // rules is review *capacity* (20 files / 3 contract surfaces), which is a
  // reviewer limit, not a limit on how much work a batch may contain.
  assert.doesNotMatch(text, /≤3 个/, 'the whitelist is not capped by file count')
  assert.doesNotMatch(text, /≤7 条/, 'the task list is not capped by item count')
  assert.match(text, /逐条列名/, 'the whitelist is enumerated, not counted')
  assert.match(text, /一条集成命令/, 'the batch bound is the integrated command')
  assert.match(text, /20 个文件或 3 个契约面/, 'the only numeric bound is the review package capacity')
  assert.match(text, /窄验证/, 'per-child verification is narrow, attribution stays intact')
  assert.match(text, /每条 = 一个决策点或一批派发/, 'task-list entries map to decisions or batches')

  const dropped = harness()
  plugin.apply(dropped.ctx, { footer: '' })
  assert.doesNotMatch(dropped.sections[0].text, /白名单与循环批/)

  assert.throws(() => resolveConfig({ footer: 42 }), /footer/)
})

test('the first rule scopes the main agent to the control plane', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /七类/, 'the first rule names the seven control-plane actions')
  assert.match(text, /唯一例外是用户显式要求主控亲自做/, 'only an explicit user request overrides the split')
  assert.match(text, /禁止把「调研 X 然后实现」/, 'research-then-implement must not be dispatched to an execution child')
})

test('the footer states the read-only label convention', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /只读类子代理（评审\/复审\/勘察）的 label 一律以「只读」或「勘察」开头/,
    '0.4.1: the label prefix is what the role table matches')
  assert.match(text, /执行类批次的 label 不得以这两个词开头/, 'the exclusion keeps execution batches out of the read-only roles')
  assert.match(text, /角色表按此前缀收窄沙箱与路由/, 'the sentence names the mechanism the prefix feeds')
})

test('a completed child triggers exactly one checkpoint message to its parent', () => {
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const parent = h.parent('parent-1')
  const child = h.child('child-1', 'parent-1', '实现 Task 1', [call(1, 'write', { file_path: 'a.ts' })])
  h.created(child)

  h.ended({ childId: 'child-1', stopReason: 'completed' })
  h.ended({ childId: 'child-1', stopReason: 'completed' })

  assert.equal(parent.messages.length, 1, 'the checkpoint is delivered once')
  assert.match(parent.messages[0].text, /child-1/)
  assert.match(parent.messages[0].text, /集成命令/)
  assert.match(parent.messages[0].text, /diff/)
  assert.doesNotMatch(parent.messages[0].text, /复跑/, 'the checkpoint must not ask for a re-run of the child command')
})

test('a failed or aborted child does not trigger a checkpoint', () => {
  const h = harness()
  plugin.apply(h.ctx, {})

  const parent = h.main('parent-1', [])
  h.created(h.child('child-2', 'parent-1', '实现 Task 2'))

  h.ended({ childId: 'child-2', stopReason: 'error' })
  h.ended({ childId: 'child-2', stopReason: 'aborted' })
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0)
})

test('checkpoint messages can be disabled by config', () => {
  const h = harness()
  plugin.apply(h.ctx, { checkpoint: { enabled: false } })

  const parent = h.parent('parent-1')
  h.created(h.child('child-3', 'parent-1', '实现 Task 3', [call(1, 'write', { file_path: 'a.ts' })]))
  h.ended({ childId: 'child-3', stopReason: 'completed' })

  assert.equal(parent.messages.length, 0)
})

test('a parent that already acted on the child report is not reminded again', () => {
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const parent = h.main('parent-1', [splice('child-9'), call(1, 'read', { file_path: 'a.ts' })])
  const child = h.child('child-9', 'parent-1', '实现 Task 9', [
    call(1, 'write', { file_path: 'a.ts' }),
    call(1, 'send_message', { agent_id: 'parent-1' }),
  ])
  h.created(child)

  h.ended({ childId: 'child-9', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 0, 'the report was delivered and handled in the parent turn')
})

test('a parent that received a report but did nothing is still reminded', () => {
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const parent = h.main('parent-2', [splice('child-10')])
  const child = h.child('child-10', 'parent-2', '实现 Task 10', [
    call(1, 'write', { file_path: 'a.ts' }),
    call(1, 'send_message', { agent_id: 'parent-2' }),
  ])
  h.created(child)

  h.ended({ childId: 'child-10', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 1, 'without a tool call the checkpoint still fires')
  assert.match(parent.messages[0].text, /dispatch-protocol/)
  assert.match(parent.messages[0].text, /child-10/)
})

test('a mid-run report does not suppress the reminder once the child settles', () => {
  const h = harness()
  plugin.apply(h.ctx, quiet)

  // 0.12.2 D1: settle is the last visibility point, so the fixture now carries
  // the runtime-owned settle notice. The report spliced mid-run was not the
  // child's final state, so the parent's earlier read does not suppress it.
  const parent = h.main('parent-3', [
    splice('child-11'),
    call(1, 'read', { file_path: 'a.ts' }),
    settleNotice('child-11'),
  ])
  const child = h.child('child-11', 'parent-3', '实现 Task 11', [
    call(1, 'send_message', { agent_id: 'parent-3' }),
    call(1, 'write', { file_path: 'a.ts' }),
  ])
  h.created(child)

  h.ended({ childId: 'child-11', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 1,
    'the parent acted before the settle notice; the settle notice is the last visibility point')
})

test('a read-only survey child does not trigger a checkpoint', () => {
  const h = harness()
  // 本用例只验证 checkpoint 对只读子代理的跳过，断言保持 0.3.3 原样。
  plugin.apply(h.ctx, { ...quiet })

  const parent = h.main('parent-4', [splice('child-12')])
  const child = h.child('child-12', 'parent-4', '勘察 Task 12', [
    call(1, 'read', { file_path: 'a.ts' }),
    call(1, 'grep', { pattern: 'checkpoint' }),
    call(1, 'pwsh', { command: 'git status' }),
    call(1, 'send_message', { agent_id: 'parent-4' }),
  ])
  h.created(child)

  h.ended({ childId: 'child-12', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 0, 'no diff to read and no command to re-run')
})

test('a child that called no tools at all does not trigger a checkpoint', () => {
  const h = harness()
  plugin.apply(h.ctx, { ...quiet })

  const parent = h.main('parent-5', [splice('child-13')])
  h.created(h.child('child-13', 'parent-5', '零工具子代理'))

  h.ended({ childId: 'child-13', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 0)
})

test('a skipped read-only child stays deduplicated across repeated settlement events', () => {
  const h = harness()
  plugin.apply(h.ctx, { ...quiet })

  const parent = h.main('parent-6', [splice('child-14')])
  const child = h.child('child-14', 'parent-6', '勘察 Task 14', [call(1, 'read', { file_path: 'a.ts' })])
  h.created(child)

  h.ended({ childId: 'child-14', stopReason: 'completed' })
  h.ended({ childId: 'child-14', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  h.turnStopping(parent, 1)
  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 0, 'the skipped child is still marked reported and never re-sent')
})

test('a checkpoint registered before the parent read the report cannot race the acceptance step', () => {
  // Regression for session-96dda908: the report is spliced, the child settles
  // with no parent tool call yet, and the parent only reads the diff later.
  // Judging at settle time (0.3.3) emitted the checkpoint three events too soon.
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const parentEvents = [splice('child-15')]
  const parent = h.main('parent-15', parentEvents)
  h.created(h.child('child-15', 'parent-15', '实现 Task 15', [
    call(1, 'write', { file_path: 'a.ts' }),
    call(1, 'send_message', { agent_id: 'parent-15' }),
  ]))

  h.ended({ childId: 'child-15', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  // The acceptance step lands only after settlement, as in the live session.
  parentEvents.push(call(1, 'read', { file_path: 'a.ts' }))
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0, 'the deferred judgment sees the acceptance step')
})

test('a drained checkpoint is not delivered again on a later turn-stopping', () => {
  const h = harness()
  plugin.apply(h.ctx, { ...quiet })

  const parent = h.main('parent-16', [splice('child-16')])
  h.created(h.child('child-16', 'parent-16', '实现 Task 16', [
    call(1, 'write', { file_path: 'a.ts' }),
    call(1, 'send_message', { agent_id: 'parent-16' }),
  ]))

  h.ended({ childId: 'child-16', stopReason: 'completed' })
  h.turnStopping(parent, 1)
  h.turnStopping(parent, 1)
  h.turnStopping(parent, 2)

  assert.equal(parent.messages.length, 1, 'the pending entry is removed after the judgment')
})

test('two pending checkpoints drain in one turn-stopping while the accepted one stays silent', () => {
  const h = harness()
  plugin.apply(h.ctx, quiet)

  // child-17a's report is followed by a parent tool call; b and c are not.
  const parent = h.main('parent-17', [
    splice('child-17a'),
    call(1, 'read', { file_path: 'a.ts' }),
    splice('child-17b'),
    splice('child-17c'),
  ])
  for (const id of ['child-17a', 'child-17b', 'child-17c']) {
    h.created(h.child(id, 'parent-17', `实现 ${id}`, [
      call(1, 'write', { file_path: `${id}.ts` }),
      call(1, 'send_message', { agent_id: 'parent-17' }),
    ]))
    h.ended({ childId: id, stopReason: 'completed' })
  }
  assert.equal(parent.messages.length, 0, 'settling delivers nothing')

  h.turnStopping(parent, 1)

  // 0.4.0: the unaccepted children share one aggregated wave message.
  assert.equal(parent.messages.length, 1, 'one aggregated message for the unaccepted wave')
  assert.match(parent.messages[0].text, /本波次 2 个子代理/)
  assert.match(parent.messages[0].text, /child-17b/)
  assert.match(parent.messages[0].text, /child-17c/)
  assert.doesNotMatch(parent.messages.map(message => message.text).join(''), /child-17a/)
})

test('the checkpoint queue is keyed by the parent session id, not the agent id', () => {
  // Production hands the plugin an agent handle whose `id` and `session.id` are
  // not the same string, while `session.header.parentSession` is a session id.
  // The settlement queue must use the same key the handler later drains with.
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('agent-40', [], {}, 'session-40')
  h.created(parent)
  h.created(h.child('child-40', 'session-40', '实现 Task 40', [call(1, 'write', { file_path: 'a.ts' })]))
  h.ended({ childId: 'child-40', stopReason: 'completed' })

  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 1, 'the pending queue is keyed by the session id')
  assert.match(parent.messages[0].text, /child-40/)
})

// 0.12.2 D1 — the visibility point is a splice *or* a settle notice, and the
// verdict is one primitive: did the parent call any tool after that point?

test('D1: a settle notice followed by a parent tool call is already handled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-settle-handled-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })

    // A closing-message child produces a splice without the marker; the runtime-
    // owned settle notice is the report the parent can see. The parent then acts
    // on it.
    const parent = h.main('parent-81', [
      settleNotice('child-81'),
      call(1, 'read', { file_path: 'a.ts' }, 'read-81'),
    ])
    h.created(h.child('child-81', 'parent-81', '实现 Task 81', [call(1, 'write', { file_path: 'a.ts' })]))
    h.ended({ childId: 'child-81', stopReason: 'completed' })

    h.turnStopping(parent, 1)
    assert.equal(parent.messages.length, 0, 'the settle notice was read and acted on')
    const row = readRows(log).find(entry => entry.kind === 'checkpoint')
    assert.equal(row.decision, 'suppressed')
    assert.equal(row.reason, 'handled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('D1: a settle notice with no parent action still delivers the checkpoint', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('parent-82', [settleNotice('child-82')])
  h.created(h.child('child-82', 'parent-82', '实现 Task 82', [call(1, 'write', { file_path: 'a.ts' })]))
  h.ended({ childId: 'child-82', stopReason: 'completed' })

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 1, 'no parent action after the settle notice: deliver once')
  assert.match(parent.messages[0].text, /child-82/)
})

test('D1: a send_message report with no settle notice still counts as handled', () => {
  // The D1 test above has a settle notice; a closing-message child can also
  // report only through `send_message` (an `agent/inbox/spliced` record) with no
  // settle notice at all. The verdict is still "report visible, then parent acted".
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-splice-handled-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })

    const parent = h.main('parent-83', [
      splice('child-83'),
      call(1, 'read', { file_path: 'a.ts' }, 'read-83'),
    ])
    h.created(h.child('child-83', 'parent-83', '实现 Task 83', [call(1, 'write', { file_path: 'a.ts' })]))
    h.ended({ childId: 'child-83', stopReason: 'completed' })

    h.turnStopping(parent, 1)
    assert.equal(parent.messages.length, 0, 'the splice report was acted on; no settle notice is required')
    const row = readRows(log).find(entry => entry.kind === 'checkpoint')
    assert.equal(row.decision, 'suppressed')
    assert.equal(row.reason, 'handled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 0.4.0 — shared file-touch detection (pwsh mutations count)

test('callTouchesFile sees pwsh mutations and ignores read-only shell work', () => {
  const cmd = command => JSON.stringify({ command })

  assert.equal(callTouchesFile('write', '{}'), true)
  assert.equal(callTouchesFile('edit', '{}'), true)
  assert.equal(callTouchesFile('pwsh', cmd('Remove-Item dead.cs -Force')), true)
  assert.equal(callTouchesFile('pwsh', cmd('Set-Content a.txt "x"')), true)
  assert.equal(callTouchesFile('pwsh', cmd('git commit -m "x"')), true)
  assert.equal(callTouchesFile('pwsh', cmd('Write-Output "x" > out.txt')), true, 'a redirect to a file mutates')

  assert.equal(callTouchesFile('pwsh', cmd('git status --short')), false)
  assert.equal(callTouchesFile('pwsh', cmd('Get-ChildItem -Recurse')), false)
  assert.equal(callTouchesFile('pwsh', cmd('dotnet build 2>&1 | Select-Object -Last 5')), false, 'builds touch artifacts, not the reviewed set')
  assert.equal(callTouchesFile('pwsh', cmd('npx jest --silent 2>&1')), false, 'stderr merges are not redirects')
  assert.equal(callTouchesFile('pwsh', cmd('npx prisma migrate deploy')), false)
  assert.equal(callTouchesFile('pwsh', 'not-json'), false)
  assert.equal(callTouchesFile('read', '{}'), false)
})

test('the redirect branch ignores arrows, generics and stderr merges', () => {
  const cmd = command => JSON.stringify({ command })

  assert.equal(callTouchesFile('pwsh', cmd('"$rev => $($x)"')), false, '0.4.1: => is an arrow, not a redirect')
  assert.equal(callTouchesFile('pwsh', cmd('Write-Output "$a -> $b"')), false, '0.4.1: -> is an arrow, not a redirect')
  assert.equal(callTouchesFile('pwsh', cmd('List<string?> items')), false, '0.4.1: a generic close is not a redirect')
  assert.equal(callTouchesFile('pwsh', cmd('dotnet build 2>&1')), false, '2>&1 merges stderr, it does not write a file')
  assert.equal(callTouchesFile('pwsh', cmd('git status --short')), false)
})

test('git -C and a chained git commit are counted as mutations', () => {
  const cmd = command => JSON.stringify({ command })

  assert.equal(callTouchesFile('pwsh', cmd('echo hi > out.txt')), true, 'a redirect to a real file mutates')
  assert.equal(callTouchesFile('pwsh', cmd('git add -A; git commit -m x')), true, 'a chained commit is a mutation')
  assert.equal(callTouchesFile('pwsh', cmd('git -C G:\\www\\ziyou\\dsh-extensions commit -m x')), true,
    'S6 t6: git -C <path> commit used to escape the pattern')
  assert.equal(callTouchesFile('pwsh', cmd('git -C "G:\\some path" commit -m x')), true, 'a quoted -C path is matched too')
  assert.equal(callTouchesFile('pwsh', cmd('git -C G:\\repo checkout -- a.md')), true,
    'git -C <path> checkout restoring a working-tree file is a mutation')
  assert.equal(callTouchesFile('pwsh', cmd('Remove-Item x')), true)
})

test('a child that only deleted files via pwsh is execution-class, not read-only', () => {
  // session-82db5b7d W-5: dead-code removal with zero write/edit calls was
  // judged read-only and the checkpoint never fired.
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const parent = h.parent('parent-52')
  h.created(h.child('child-52', 'parent-52', '清理死代码', [
    call(1, 'pwsh', { command: 'Remove-Item dead.cs -Force' }),
  ]))
  h.ended({ childId: 'child-52', stopReason: 'completed' })

  assert.equal(parent.messages.length, 1, 'the checkpoint fires for a pwsh-only write batch')
  assert.match(parent.messages[0].text, /child-52/)
})

test('a child whose pwsh work was read-only stays a read-only survey', () => {
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const parent = h.parent('parent-53')
  h.created(h.child('child-53', 'parent-53', '勘察日志', [
    call(1, 'pwsh', { command: 'git log --oneline -5' }),
    call(1, 'pwsh', { command: 'dotnet build 2>&1 | Select-Object -Last 3' }),
  ]))
  h.ended({ childId: 'child-53', stopReason: 'completed' })

  assert.equal(parent.messages.length, 0, 'no diff to read, no command to re-run — silence')
})

// ---------------------------------------------------------------------------
// 工具调用口径：workdir 解析、候选路径

test('readWorkdir: absolute and relative pass through, missing is undefined, unusable is null', () => {
  const args = value => JSON.stringify(value)
  assert.equal(readWorkdir(args({ command: 'x', workdir: 'G:\\repo\\server\\src' })), 'G:\\repo\\server\\src',
    'an absolute workdir is returned as written')
  assert.equal(readWorkdir(args({ command: 'x', workdir: 'server/src' })), 'server/src',
    'a relative workdir is returned as written; the caller resolves it against the session cwd')
  assert.equal(readWorkdir(args({ command: 'x' })), undefined, 'no workdir and no cwd key: nothing to resolve')
  assert.equal(readWorkdir('not-json'), undefined)
  assert.equal(readWorkdir(args({ command: 'x', cwd: 'G:\\repo\\server' })), 'G:\\repo\\server',
    'cwd is the fallback key when workdir is absent')
  assert.equal(readWorkdir(args({ command: 'x', workdir: {} })), null,
    'an object workdir must not silently fall back to the session cwd')
  assert.equal(readWorkdir(args({ command: 'x', workdir: 5 })), null)
  assert.equal(readWorkdir(args({ command: 'x', workdir: '' })), null)
})

test('a wave of finished children earns one aggregated checkpoint message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-wave-'))
  const log = join(dir, 'decisions.jsonl')
  try {
    const h = harness()
    plugin.apply(h.ctx, { log })

    const parent = h.main('parent-54', [])
    h.created(parent)
    for (const id of ['child-54a', 'child-54b', 'child-54c']) {
      h.created(h.child(id, 'parent-54', `实现 ${id}`, [call(1, 'write', { file_path: `${id}.ts` })]))
      h.ended({ childId: id, stopReason: 'completed' })
    }

    h.turnStopping(parent, 1)

    assert.equal(parent.messages.length, 1, 'three finished children, one message')
    assert.match(parent.messages[0].text, /本波次 3 个子代理/)
    assert.match(parent.messages[0].text, /child-54a/)
    assert.match(parent.messages[0].text, /child-54c/)

    const rows = readFileSync(log, 'utf8').trim().split('\n').map(row => JSON.parse(row))
    assert.equal(rows.filter(row => row.kind === 'checkpoint' && row.decision === 'delivered').length, 3,
      'accounting stays per child even though the message is aggregated')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a single deliverable child keeps the per-child checkpoint text', () => {
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const parent = h.parent('parent-55')
  h.created(h.child('child-55', 'parent-55', '实现 Task 55', [call(1, 'write', { file_path: 'a.ts' })]))
  h.ended({ childId: 'child-55', stopReason: 'completed' })

  assert.equal(parent.messages.length, 1)
  assert.match(parent.messages[0].text, /子代理 child-55（实现 Task 55）已完成/)
  assert.doesNotMatch(parent.messages[0].text, /本波次/)
})

// ---------------------------------------------------------------------------
// 0.4.0 — per-turn observation rows (G1/G7 evidence floor)

test('a root turn that wrote files appends one observation row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-observe-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, { log: false })

    const parent = h.main('parent-59', [
      call(1, 'edit', { file_path: 'a.ts' }),
      call(1, 'pwsh', { command: 'Remove-Item dead.cs' }),
      call(1, 'subagent', { description: '实现 X' }),
      call(2, 'read', { file_path: 'b.ts' }),
    ], {}, 'session-59', fullProject(dir))
    h.created(parent)

    h.turnStopping(parent, 1)
    h.turnStopping(parent, 2)

    const file = join(dir, 'dispatch', 'runs', 'session-59.jsonl')
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(row => JSON.parse(row))
    assert.equal(rows.length, 1, 'only the writing/delegating turn leaves a row')
    assert.equal(rows[0].turn, 1)
    assert.equal(rows[0].session, 'session-59')
    assert.equal(rows[0].writes, 1)
    assert.deepEqual(rows[0].files, ['a.ts'])
    assert.equal(rows[0].shellWrites, 1)
    assert.equal(rows[0].delegations, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('observation is off for child agents, missing cwd, and explicit disable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-observe-off-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, { log: false, observation: { enabled: false } })

    const parent = h.main('parent-60', [call(1, 'edit', { file_path: 'a.ts' })], {}, 'session-60', fullProject(dir))
    h.created(parent)
    h.turnStopping(parent, 1)

    assert.throws(() => readFileSync(join(dir, 'dispatch', 'runs', 'session-60.jsonl'), 'utf8'),
      'a disabled observation section writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one (session, turn) is observed once even when the turn closes twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-observe-dedupe-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, { log: false })

    const parent = h.main('parent-63', [
      call(1, 'edit', { file_path: 'a.ts' }),
      call(1, 'edit', { file_path: 'b.ts' }),
    ], {}, 'session-63', fullProject(dir))
    h.created(parent)

    h.turnStopping(parent, 1) // the turn-end snapshot appends the row
    h.turnStopping(parent, 1) // a second close for the same turn (post-steer step)

    assert.equal(parent.messages.length, 0, '0.9.0: a write turn gets no turn-end reminder')
    const file = join(dir, 'dispatch', 'runs', 'session-63.jsonl')
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(row => JSON.parse(row))
    assert.equal(rows.length, 1, '0.4.1: the second turn-stopping for the same turn adds no row')
    assert.equal(rows[0].turn, 1)
    assert.deepEqual(rows[0].files, ['a.ts', 'b.ts'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a commit-only turn leaves no observation row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-observe-commit-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, { log: false })

    const parent = h.main('parent-64', [
      call(1, 'pwsh', { command: 'git commit -m "x"' }),
    ], {}, 'session-64', fullProject(dir))
    h.created(parent)
    h.turnStopping(parent, 1)

    // Accepted cost of the two-tier split: the commit is not a working-tree
    // change, so the row is absent; commit evidence lives in git history.
    assert.throws(() => readFileSync(join(dir, 'dispatch', 'runs', 'session-64.jsonl'), 'utf8'),
      'a commit-only turn writes no observation row')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 规则正文与提示词段

test('the injected rules name the light-batch review exception and the ledger carrier', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /判为轻批的批次除外/, '0.8.2: gated does not re-open a light batch to review')
  assert.match(text, /任务清单或台账首行/, '0.8.2: grading may live in the ledger head instead of the task list')
  assert.match(text, /只写 dispatch\/state\/<需求>\.md、dispatch\/ledger\/<需求>\.md/,
    '0.9.1: rule 1 names the per-requirement ledger paths')
  assert.match(text, /同一工作区可能并行多个会话/,
    '0.9.1: rule 1 carries the multi-session paragraph')
})

// ---------------------------------------------------------------------------
// 0.9.0 — 写入守卫（write policy，spec §4/§7）

test('the plugin injects the tools service and registers exactly one guard', () => {
  assert.ok(plugin.inject.includes('tools'), 'the guard needs the tools service')

  const h = harness()
  plugin.apply(h.ctx, { log: false })
  assert.equal(h.guards.length, 1, 'apply() registers one guard')

  const off = harness()
  plugin.apply(off.ctx, { log: false, writePolicy: { enabled: false } })
  assert.equal(off.guards.length, 0, 'writePolicy.enabled:false registers nothing')
})

test('a root write outside the allowlist is denied with the paths and the override hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-deny-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-deny', [], {}, 'session-policy-deny', fullProject(dir))

    const verdict = h.guard({ agent: root, name: 'write', arguments: { file_path: 'server/src/x.ts' } })

    assert.equal(typeof verdict, 'string', 'enforce mode returns the rejection text')
    assert.match(verdict, /server\/src\/x\.ts/, 'the rejected path is named')
    assert.match(verdict, /不在主控白名单内/, 'the allowlist is named')
    assert.match(verdict, /dispatch\//, 'the control-plane prefixes are listed')
    assert.match(verdict, /docs\/superpowers\/specs\//)
    assert.match(verdict, /dispatch\/override\.json/, 'the single exemption file is named')
    assert.match(verdict, /派给执行批/, 'the dispatch exit is stated')

    const [row] = readRows(log)
    assert.equal(row.kind, 'write-policy')
    assert.equal(row.decision, 'denied')
    assert.equal(row.reason, 'no-override')
    assert.equal(row.turn, null, 'the guard is not tied to a turn')
    assert.equal(row.tool, 'write')
    assert.equal(row.file, 'server/src/x.ts')
    assert.equal(row.mode, 'enforce')
    assert.equal(row.session, 'session-policy-deny')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('control-plane writes pass without a decision-log line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-allow-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-allow', [], {}, 'session-policy-allow', fullProject(dir))

    const allowed = [
      'dispatch/state.md',
      'dispatch/state/x.md',
      'dispatch/ledger/x.md',
      'docs/superpowers/specs/x.md',
      join(dir, 'dispatch/state.md'),
      join(dir, 'docs/superpowers/specs/x.md'),
      'dispatch\\ledger\\x.md',
      './dispatch/state.md',
      'DISPATCH/STATE.MD',
    ]
    for (const file of allowed) {
      assert.equal(h.guard({ agent: root, name: 'write', arguments: { file_path: file } }), undefined,
        `control-plane write proceeds: ${file}`)
      assert.equal(h.guard({ agent: root, name: 'edit', arguments: { file_path: file } }), undefined,
        `control-plane edit proceeds: ${file}`)
    }

    assert.equal(existsSync(log), false, 'control-plane writes are deliberately not logged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a subagent write is execution work and passes unguarded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-child-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const child = h.main('child-policy', [], { origin: 'subagent', parentSession: 'parent-policy' }, 'child-policy', dir)

    assert.equal(h.guard({ agent: child, name: 'write', arguments: { file_path: 'src/x.ts' } }), undefined)
    assert.equal(h.guard({ agent: child, name: 'edit', arguments: { file_path: 'tests/y.test.ts' } }), undefined)
    assert.equal(existsSync(log), false, 'a subagent write is never a guard decision')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fresh override written in this session allows the write and logs reason override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-override-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const createdAt = Date.now() - 60_000
    const root = h.main('session-policy-override', [], {}, 'session-policy-override', fullProject(dir), createdAt)

    const overrideDir = join(dir, 'dispatch')
    const overrideFile = join(overrideDir, 'override.json')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(overrideFile, JSON.stringify({ reason: '用户要求直接修这 4 行', source: 'user' }))
    assert.ok(statSync(overrideFile).mtimeMs >= createdAt, 'the fixture override is newer than the session')

    assert.equal(h.guard({ agent: root, name: 'edit', arguments: { file_path: 'src/x.ts' } }), undefined,
      'a valid override releases the write')

    const [row] = readRows(log)
    assert.equal(row.kind, 'write-policy')
    assert.equal(row.decision, 'allowed')
    assert.equal(row.reason, 'override')
    assert.equal(row.turn, null)
    assert.equal(row.tool, 'edit')
    assert.equal(row.file, 'src/x.ts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an override older than the session is stale and denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-stale-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const createdAt = Date.now()
    const root = h.main('session-policy-stale', [], {}, 'session-policy-stale', fullProject(dir), createdAt)

    const overrideDir = join(dir, 'dispatch')
    const overrideFile = join(overrideDir, 'override.json')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(overrideFile, JSON.stringify({ reason: '上一个会话留下的 override' }))
    const old = new Date(createdAt - 120_000)
    utimesSync(overrideFile, old, old)

    const verdict = h.guard({ agent: root, name: 'write', arguments: { file_path: 'src/x.ts' } })
    assert.equal(typeof verdict, 'string', 'a stale override does not release the write')

    const [row] = readRows(log)
    assert.equal(row.kind, 'write-policy')
    assert.equal(row.decision, 'denied')
    assert.equal(row.reason, 'stale', 'the freshness check is per session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed override is invalid and denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-invalid-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-invalid', [], {}, 'session-policy-invalid', fullProject(dir))

    const overrideDir = join(dir, 'dispatch')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'override.json'), '{ not json')

    assert.equal(typeof h.guard({ agent: root, name: 'write', arguments: { file_path: 'src/x.ts' } }), 'string')

    const [row] = readRows(log)
    assert.equal(row.decision, 'denied')
    assert.equal(row.reason, 'invalid', 'an unparsable override is not an exemption')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an override without a non-empty reason is invalid and denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-noreason-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-noreason', [], {}, 'session-policy-noreason', fullProject(dir))

    const overrideDir = join(dir, 'dispatch')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'override.json'), JSON.stringify({ source: 'user', reason: '   ' }))

    assert.equal(typeof h.guard({ agent: root, name: 'write', arguments: { file_path: 'src/x.ts' } }), 'string')

    const [row] = readRows(log)
    assert.equal(row.decision, 'denied')
    assert.equal(row.reason, 'invalid', 'the reason must be a non-empty string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shadow mode logs the denial but lets the write through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-shadow-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log, writePolicy: { mode: 'shadow' } })
    const root = h.main('session-policy-shadow', [], {}, 'session-policy-shadow', fullProject(dir))

    assert.equal(h.guard({ agent: root, name: 'write', arguments: { file_path: 'server/src/x.ts' } }), undefined,
      'shadow mode never blocks')

    const [row] = readRows(log)
    assert.equal(row.kind, 'write-policy')
    assert.equal(row.decision, 'denied')
    assert.equal(row.reason, 'no-override')
    assert.equal(row.mode, 'shadow', 'the log distinguishes shadow from enforce')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools outside the write list, path-less calls and unscoped agents pass silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-exempt-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-exempt', [], {}, 'session-policy-exempt', fullProject(dir))

    assert.equal(h.guard({ agent: root, name: 'read', arguments: { file_path: 'server/src/x.ts' } }), undefined,
      'only the configured write tools are judged')
    assert.equal(h.guard({ agent: root, name: 'write', arguments: {} }), undefined, 'no path, nothing to judge')
    assert.equal(h.guard({ agent: root, name: 'edit', arguments: { file_path: '' } }), undefined)
    assert.equal(h.guard({ name: 'write', arguments: { file_path: 'server/src/x.ts' } }), undefined,
      'an unscoped host has no session to judge')
    assert.equal(h.guard({ agent: null, name: 'write', arguments: { file_path: 'server/src/x.ts' } }), undefined)

    assert.equal(existsSync(log), false, 'exemptions are not decisions')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an absolute path outside the session cwd is denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-outside-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-outside', [], {}, 'session-policy-outside', fullProject(dir))

    const outside = join(tmpdir(), `dispatch-protocol-outside-${process.pid}.ts`)
    assert.equal(typeof h.guard({ agent: root, name: 'write', arguments: { file_path: outside } }), 'string',
      'outside the cwd is outside the allowlist')

    const [row] = readRows(log)
    assert.equal(row.decision, 'denied')
    assert.equal(row.reason, 'no-override')
    assert.equal(row.file, outside)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a valid override without a session timestamp is allowed as override-unbounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-unbounded-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    // A minimal agent with no `createdAt` anywhere: the freshness check has no
    // anchor, so it is skipped (fail-open) and the log says why.
    const root = { session: { id: 'session-policy-unbounded', header: { origin: 'root' }, cwd: fullProject(dir) } }

    const overrideDir = join(dir, 'dispatch')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'override.json'), JSON.stringify({ reason: '用户要求直接修这 4 行' }))

    assert.equal(h.guard({ agent: root, name: 'edit', arguments: { file_path: 'src/x.ts' } }), undefined,
      'no session timestamp means the freshness check is skipped')

    const [row] = readRows(log)
    assert.equal(row.kind, 'write-policy')
    assert.equal(row.decision, 'allowed')
    assert.equal(row.reason, 'override-unbounded', 'an unbounded override is not logged as a fresh one')
    assert.equal(row.file, 'src/x.ts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dot-dot segments are folded before the allowlist match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-dotdot-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-dotdot', [], {}, 'session-policy-dotdot', fullProject(dir))

    assert.equal(typeof h.guard({ agent: root, name: 'write', arguments: { file_path: 'dispatch/../src/x.ts' } }), 'string',
      'dispatch/../src/x.ts escapes the control plane and is denied')

    const [row] = readRows(log)
    assert.equal(row.decision, 'denied')
    assert.equal(row.reason, 'no-override')

    assert.equal(h.guard({ agent: root, name: 'write', arguments: { file_path: 'dispatch/../dispatch/state.md' } }), undefined,
      'dispatch/../dispatch/state.md folds back onto the control plane')
    assert.equal(readRows(log).length, 1, 'the allowed write adds no log line')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the allowlist matches on a word boundary, so dispatch-notes.md is denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-boundary-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-boundary', [], {}, 'session-policy-boundary', fullProject(dir))

    assert.equal(typeof h.guard({ agent: root, name: 'write', arguments: { file_path: 'dispatch-notes.md' } }), 'string',
      'a dispatch/ entry must not leak to dispatch-notes.md')

    const [row] = readRows(log)
    assert.equal(row.decision, 'denied')
    assert.equal(row.reason, 'no-override')
    assert.equal(row.file, 'dispatch-notes.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a guard exception fails open so the host keeps working', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-failopen-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const broken = { get session() { throw new Error('host bug') } }

    assert.equal(h.guard({ agent: broken, name: 'write', arguments: { file_path: 'server/src/x.ts' } }), undefined,
      'a guard bug must never block a write')
    assert.equal(existsSync(log), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePolicy carries the 0.9.0 defaults and rejects silent breakage', () => {
  const resolved = resolveConfig({})
  assert.deepEqual(resolved.writePolicy, {
    enabled: true,
    mode: 'enforce',
    allowlist: DEFAULT_ALLOWLIST,
    overridePath: 'dispatch/override.json',
    tools: ['write', 'edit'],
    delegationTools: ['subagent', 'subagent_fork', 'workflow', 'subagent_readonly'],
  })
  assert.deepEqual(DEFAULT_ALLOWLIST, ['dispatch/', 'docs/superpowers/specs/'])
  assert.equal(DEFAULT_OVERRIDE_PATH, 'dispatch/override.json')
  assert.equal(DEFAULT_WRITE_POLICY_MODE, 'enforce')
  assert.equal(resolveWritePolicy({ enabled: false }).enabled, false)

  assert.throws(() => resolveConfig({ writePolicy: { mode: 'monitor' } }), /writePolicy\.mode/)
  assert.throws(() => resolveConfig({ writePolicy: { allowlist: [] } }), /writePolicy\.allowlist/)
  assert.throws(() => resolveConfig({ writePolicy: { allowlist: 'dispatch/' } }), /writePolicy\.allowlist/)
  assert.throws(() => resolveConfig({ writePolicy: { tools: [] } }), /writePolicy\.tools/)
  assert.throws(() => resolveConfig({ writePolicy: { delegationTools: [] } }), /writePolicy\.delegationTools/)
  assert.throws(() => resolveConfig({ writePolicy: { overridePath: '  ' } }), /writePolicy\.overridePath/)
})

test('the decision log defaults to the temp dir, accepts false and rejects non-paths', () => {
  const resolved = resolveConfig({})
  assert.match(resolved.log, /dispatch-protocol-decisions\.jsonl$/)
  assert.equal(resolved.log, join(tmpdir(), 'dispatch-protocol-decisions.jsonl'))
  assert.equal(resolveConfig({ log: false }).log, false, 'false silences every mechanism')
  assert.equal(resolveConfig({ log: 'tmp/decisions.jsonl' }).log, 'tmp/decisions.jsonl')
  assert.throws(() => resolveConfig({ log: 42 }), /log must be/)
  assert.throws(() => resolveConfig({ log: '' }), /log/,
    'an empty path must not silently fall back to the default log')
  assert.throws(() => resolveConfig({ log: '   ' }), /log/,
    'a whitespace path must not silently fall back to the default log')
})

test('the removed nudge section fails at load time with a migration hint', () => {
  assert.throws(() => resolveConfig({ nudge: {} }), (error) => {
    assert.match(error.message, /nudge/)
    assert.match(error.message, /迁移/)
    assert.match(error.message, /writePolicy\.delegationTools/)
    assert.match(error.message, /dispatch\/override\.json/)
    return true
  })
  assert.throws(() => resolveConfig({ nudge: { log: false } }), /nudge/)
})

test('0.17.0: the removed gates section fails at load time with a migration hint', () => {
  assert.throws(() => resolveConfig({ gates: {} }), (error) => {
    assert.match(error.message, /gates/)
    assert.match(error.message, /0\.17\.0/)
    assert.match(error.message, /迁移/)
    assert.match(error.message, /dispatch\/runs/)
    return true
  })
  assert.throws(() => resolveConfig({ gates: { enabled: false } }), /gates/)
})

test('0.17.0: a closing turn never steers; the observation row is the only evidence left', () => {
  // 用户裁决（2026-11-18）：收尾的可核对提醒几乎没有价值，还多一次模型步进。
  // 本用例同时喂「等待期轮询」和「未验证就 present」两种旧闸门形态，断言一条
  // 提醒都不发，而观测行照写。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-no-gates-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, quiet)
    const cwd = fullProject(dir)
    const parent = h.main('parent-no-gates', [
      call(1, 'list_agents', {}, 'poll-1'),
      call(1, 'list_agents', {}, 'poll-2'),
      call(1, 'list_agents', {}, 'poll-3'),
      call(1, 'list_agents', {}, 'poll-4'),
      call(1, 'write', { file_path: 'a.ts' }, 'write-1'),
      call(1, 'present', {}, 'present-1'),
    ], {}, 'session-no-gates', cwd)
    h.created(parent)
    h.turnStopping(parent, 1)

    assert.equal(parent.messages.length, 0, '0.17.0: closing the turn adds no reminder message')
    const rows = readRows(join(cwd, 'dispatch', 'runs', 'session-no-gates.jsonl'))
    assert.equal(rows.length, 1, 'the observation row still records the turn')
    assert.equal(rows[0].writes, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rule 1 names the override file and carries no nudge prose', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /dispatch\/override\.json/)
  assert.match(text, /守卫只认这个文件/)
  assert.match(text, /每会话有效，新会话需重写/)
  assert.match(text, /被 `dispatch-protocol` 守卫拦截时/)
  assert.match(text, /不要重试同一个调用/)
  assert.match(text, /有界直改同样先写 override/)
  assert.doesNotMatch(text, /记一行 override/, 'the 0.8.x prose exemption is gone')
  assert.doesNotMatch(text, /nudge/i)
})

test('the observation shell tier drops git commit while the mutation tier keeps it', () => {
  const commit = JSON.stringify({ command: 'git commit -m "x"' })
  assert.equal(DEFAULT_PWSH_SHELL_PATTERN.test('git commit -m "x"'), false)
  assert.equal(DEFAULT_PWSH_SHELL_PATTERN.test('git -C G:\\repo commit -m x'), false)
  assert.equal(DEFAULT_PWSH_MUTATION_PATTERN.test('git commit -m x'), true)
  assert.equal(DEFAULT_PWSH_MUTATION_PATTERN.test('git -C G:\\repo commit -m x'), true)
  assert.equal(DEFAULT_PWSH_SHELL_PATTERN.test('git checkout -- a.md'), true,
    'restoring a working-tree file is a content change')
  assert.equal(DEFAULT_PWSH_SHELL_PATTERN.test('echo hi > out.txt'), true)

  const events = [
    call(1, 'pwsh', { command: 'git commit -m "x"' }),
    call(1, 'write', { file_path: 'spec.md' }),
  ]
  const summary = summarizeTurn(events, 1, {})
  assert.equal(summary.writes, 1)
  assert.equal(summary.shellWrites, 0, 'the observation tier ignores a bare commit')
  const full = summarizeTurn(events, 1, {}, DEFAULT_PWSH_MUTATION_PATTERN)
  assert.equal(full.shellWrites, 1, 'the 4th argument restores the full mutation tier')

  // The checkpoint tier still treats a committing child as execution-class.
  assert.equal(callTouchesFile('pwsh', commit), true)
})

// ---------------------------------------------------------------------------
// 0.11.0 — 路径分类器（classifyPath）：观测与控制面判定共用同一套口径

test('D1: the classifier maps paths to control-plane, doc, code and unknown', () => {
  const cwd = 'G:\\repo'
  const docs = { cwd, docPatterns: DEFAULT_DOC_PATTERNS }

  assert.equal(classifyPath('dispatch/override.json', docs), ARTIFACT.CONTROL,
    'dispatch/override.json under the project cwd is the control plane')
  assert.equal(classifyPath('src/app/dispatch/state.ts', docs), ARTIFACT.CODE,
    'A1: a same-named source path is code, not the control plane')
  assert.equal(classifyPath('D:\\proj\\dispatch\\x.md', { cwd: 'D:\\proj', docPatterns: DEFAULT_DOC_PATTERNS }),
    ARTIFACT.CONTROL, 'an absolute path inside cwd is relativized (case-insensitive)')
  assert.equal(classifyPath('dispatch/x.md', { docPatterns: DEFAULT_DOC_PATTERNS }), ARTIFACT.CODE,
    'D1-6: without cwd the control-plane verdict fails (conservative)')
  assert.equal(classifyPath('docs/agent/a.md', docs), ARTIFACT.DOC)
  assert.equal(classifyPath('docs/agent/a.ts', docs), ARTIFACT.CODE,
    'D1-4: the extension wins over the docs/ prefix')
  assert.equal(classifyPath('README.md', docs), ARTIFACT.DOC)
  assert.equal(classifyPath('LICENSE', docs), ARTIFACT.DOC)
  assert.equal(classifyPath('LICENSE-MIT', docs), ARTIFACT.DOC, 'D1-4: a root name prefix is documentation')
  assert.equal(classifyPath('a/LICENSE-BACKUP', docs), ARTIFACT.CODE,
    'D1-4: a nested LICENSE-BACKUP is not documentation')
  assert.equal(classifyPath('G:\\repo\\dispatch\\ledger\\x.md', docs), ARTIFACT.CONTROL,
    'an absolute in-cwd path with backslashes is relativized')
  assert.equal(classifyPath('', docs), ARTIFACT.UNKNOWN, 'a missing path is unknown')
  assert.equal(classifyPath(undefined, docs), ARTIFACT.UNKNOWN)
})

// D1-2a — 路径段归一（折叠 `.`/`..`、丢弃空段）：`..` 不得成为穿越绕过。
// 每条断言独立成测，便于失败时直接定位到具体形态。

test('D1-2a(a): a traversal out of dispatch/ is code, not control plane', () => {
  assert.equal(classifyPath('dispatch/../src/x.ts', { cwd: 'G:\\repo', docPatterns: DEFAULT_DOC_PATTERNS }),
    ARTIFACT.CODE, 'folding turns it into src/x.ts, which is code')
})

test('D1-2a(b): leading and intermediate dot segments are folded', () => {
  assert.equal(classifyPath('./dispatch/./state.md', { cwd: 'G:\\repo', docPatterns: DEFAULT_DOC_PATTERNS }),
    ARTIFACT.CONTROL, 'dot segments normalize to dispatch/state.md')
})

test('D1-2a(c): folding into dispatch/ is the control plane', () => {
  assert.equal(classifyPath('src/../dispatch/recon/a.md', { cwd: 'G:\\repo', docPatterns: DEFAULT_DOC_PATTERNS }),
    ARTIFACT.CONTROL, 'src/../dispatch normalizes to dispatch/')
})

test('D1-2a(d): a relative path escaping the cwd root is untrusted and code', () => {
  assert.equal(classifyPath('../dispatch/x.md', { cwd: 'G:\\repo', docPatterns: DEFAULT_DOC_PATTERNS }),
    ARTIFACT.CODE, 'escaping .. is untrusted, so no control-plane/doc verdict is attempted')
})

test('D1-2a(e): a drive-rooted traversal keeps the drive and folds the rest', () => {
  assert.equal(classifyPath('D:\\proj\\dispatch\\..\\src\\x.ts', { cwd: 'D:\\proj', docPatterns: DEFAULT_DOC_PATTERNS }),
    ARTIFACT.CODE, 'D:/proj/dispatch/../src/x.ts relativizes to src/x.ts')
})

test('D1-2a(f): repeated slashes produce dropped segments', () => {
  assert.equal(classifyPath('dispatch//x.md', { cwd: 'G:\\repo', docPatterns: DEFAULT_DOC_PATTERNS }),
    ARTIFACT.CONTROL, 'the empty segment is dropped and dispatch/x.md stays control plane')
})

test('0.13.0: projectSwitch defaults and rejects silent breakage', () => {
  // §5-1
  const config = resolveConfig({})
  assert.deepEqual(config.projectSwitch, { enabled: true, path: 'dispatch/protocol.json' })
  assert.deepEqual(DEFAULT_PROJECT_SWITCH, { enabled: true, path: 'dispatch/protocol.json' },
    'the single default lives in lib/project.mjs')
  assert.deepEqual(PROJECT_MODES, ['off', 'auto', 'shadow', 'full'])

  assert.throws(() => resolveConfig({ projectSwitch: 42 }),
    { message: 'dispatch-protocol: projectSwitch must be an object' })
  assert.throws(() => resolveConfig({ projectSwitch: { enabled: 'yes' } }),
    { message: 'dispatch-protocol: projectSwitch.enabled must be a boolean' })
  assert.throws(() => resolveConfig({ projectSwitch: { path: '' } }),
    { message: 'dispatch-protocol: projectSwitch.path must be a non-empty string' })
})

test('0.13.0/0.16.0: readProjectMode reads the marker file with auto as the default', () => {
  // §5-2；0.16.0 默认改 auto，坏文件不再等于 full。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-project-mode-'))
  try {
    const config = resolveConfig({}).projectSwitch
    const project = (name, body) => {
      const cwd = join(dir, name)
      mkdirSync(cwd, { recursive: true })
      if (body !== undefined) writeProjectMarker(cwd, body)
      return cwd
    }

    assert.equal(readProjectMode(project('missing'), config), 'auto', 'no marker file → auto (0.16.0)')
    assert.equal(readProjectMode(project('empty-object', '{}'), config), 'auto', 'no mode or enabled → auto')
    assert.equal(readProjectMode(project('rules-only', '{"rules":"business"}'), config), 'auto',
      'a policy file without a mode defaults to auto')
    assert.equal(readProjectMode(project('enabled-off', '{"enabled":false}'), config), 'off')
    assert.equal(readProjectMode(project('enabled-on', '{"enabled":true}'), config), 'full',
      'the 0.13 explicit enable still means full')
    assert.equal(readProjectMode(project('mode-off', '{"mode":"off"}'), config), 'off')
    assert.equal(readProjectMode(project('mode-auto', '{"mode":"auto"}'), config), 'auto')
    assert.equal(readProjectMode(project('mode-shadow', '{"mode":"shadow"}'), config), 'shadow')
    assert.equal(readProjectMode(project('mode-full', '{"mode":"full"}'), config), 'full')
    assert.equal(readProjectMode(project('mode-wins', '{"mode":"off","enabled":true}'), config), 'off',
      'a valid mode wins over enabled')
    assert.equal(readProjectMode(project('bad-json', '{oops'), config), 'auto',
      'a broken file is treated as no policy, not as an error')
    assert.equal(readProjectMode(project('array', '[]'), config), 'auto')
    assert.equal(readProjectMode(project('switch-disabled', '{"mode":"off"}'),
      { enabled: false, path: 'dispatch/protocol.json' }), 'full',
    'projectSwitch.enabled === false wins over any marker content')
    assert.equal(readProjectMode('', config), 'full', 'an empty cwd falls back to full')
    assert.equal(readProjectMode(undefined, config), 'full')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.13.0: a project off mode lets the root write through and logs one project decision', () => {
  // §5-3
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-project-guard-off-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeProjectMarker(cwd, '{"mode":"off"}')

    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-project-off', [], {}, 'session-project-off', cwd)

    assert.equal(h.guard({ agent: root, name: 'write', arguments: { file_path: 'server/src/x.ts' } }), undefined,
      'off mode never blocks a root write')
    assert.equal(h.guard({ agent: root, name: 'edit', arguments: { file_path: 'src/y.ts' } }), undefined)

    const rows = readRows(log)
    const projectRows = rows.filter(row => row.kind === 'project')
    assert.equal(projectRows.length, 1, 'exactly one project decision per (session, cwd)')
    assert.equal(projectRows[0].decision, 'suppressed')
    assert.equal(projectRows[0].reason, 'project-off')
    assert.equal(projectRows[0].session, 'session-project-off')
    assert.equal(rows.filter(row => row.kind === 'write-policy').length, 0,
      'off mode does not also run the write-policy judgement')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.13.0: a project shadow mode logs project-shadow and never blocks', () => {
  // §5-4
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-project-guard-shadow-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeProjectMarker(cwd, '{"mode":"shadow"}')

    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-project-shadow', [], {}, 'session-project-shadow', cwd)

    assert.equal(h.guard({ agent: root, name: 'write', arguments: { file_path: 'server/src/x.ts' } }), undefined,
      'shadow mode never returns the rejection string')

    const rows = readRows(log)
    assert.equal(rows.length, 1, 'one row for the shadowed denial')
    assert.equal(rows[0].kind, 'write-policy')
    assert.equal(rows[0].decision, 'allowed')
    assert.equal(rows[0].reason, 'project-shadow')
    assert.equal(rows[0].mode, 'shadow')
    assert.equal(rows[0].file, 'server/src/x.ts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.13.0: a project off mode suppresses the checkpoint and keeps one row per child', () => {
  // §5-6
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-project-checkpoint-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeProjectMarker(cwd, '{"mode":"off"}')

    const h = harness()
    plugin.apply(h.ctx, { log })
    const parent = h.main('parent-project-cp', [], {}, 'parent-project-cp', cwd)
    h.created(parent)
    h.created(h.child('child-project-cp', 'parent-project-cp', '实现 Task',
      [call(1, 'write', { file_path: 'a.ts' })]))
    h.ended({ childId: 'child-project-cp', stopReason: 'completed' })
    h.turnStopping(parent, 1)

    assert.equal(parent.messages.length, 0, 'off mode does not deliver the checkpoint')

    const rows = readRows(log).filter(row => row.kind === 'checkpoint')
    assert.equal(rows.length, 1, 'one suppressed row per settled child')
    assert.equal(rows[0].decision, 'suppressed')
    assert.equal(rows[0].reason, 'project-off')
    assert.equal(rows[0].childId, 'child-project-cp')
    assert.equal(rows[0].label, '实现 Task')
    assert.equal(rows[0].turn, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.13.0: a project off mode writes no observation row and creates no runs dir', () => {
  // §5-7
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-project-observe-'))
  try {
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeProjectMarker(cwd, '{"mode":"off"}')

    const h = harness()
    plugin.apply(h.ctx, { log: false })
    const parent = h.main('parent-project-observe',
      [call(1, 'edit', { file_path: 'a.ts' })], {}, 'session-project-observe', cwd)
    h.created(parent)
    h.turnStopping(parent, 1)

    assert.equal(existsSync(join(cwd, 'dispatch', 'runs')), false,
      'off mode does not even create the observation directory')
    assert.equal(parent.messages.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.13.0/0.16.0: the prompt section text is a per-cwd function', () => {
  // §5-8；0.16.0 增加 auto：根代理拿到提级提示，子代理拿到空串。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-project-prompt-'))
  try {
    const fullCwd = join(dir, 'full')
    mkdirSync(fullCwd, { recursive: true })
    writeProjectMarker(fullCwd, '{"mode":"full"}')
    const autoCwd = join(dir, 'auto')
    mkdirSync(autoCwd, { recursive: true })
    const shadowCwd = join(dir, 'shadow')
    mkdirSync(shadowCwd, { recursive: true })
    writeProjectMarker(shadowCwd, '{"mode":"shadow"}')
    const offCwd = join(dir, 'off')
    mkdirSync(offCwd, { recursive: true })
    writeProjectMarker(offCwd, '{"mode":"off"}')

    const h = harness()
    plugin.apply(h.ctx, {})
    const config = resolveConfig({})

    assert.equal(typeof h.sections[0].text, 'string', 'the harness still exposes an evaluated string')
    const section = h.rawSections[0]
    assert.equal(typeof section.text, 'function', 'off is decided per assemble, not at load time')
    assert.equal(section.text({ agent: { session: { cwd: fullCwd } } }), config.text,
      'full keeps the rules')
    assert.equal(section.text({ agent: { session: { cwd: autoCwd } } }), AUTO_TEXT,
      'auto injects only the escalation hint')
    assert.equal(section.text({ agent: { session: { cwd: autoCwd, header: { origin: 'subagent' } } } }), '',
      'auto injects nothing for a subagent')
    assert.equal(section.text({ agent: { session: { cwd: shadowCwd } } }), config.text,
      'shadow keeps the rules and only changes the write guard')
    assert.equal(section.text({ agent: { session: { cwd: offCwd } } }), '',
      'off drops the section text so the prompt layer discards it')
    assert.equal(section.text({ agent: { session: { header: { cwd: offCwd } } } }), '',
      'the session header cwd is the fallback')
    assert.equal(section.text({}), config.text, 'a context without a session falls back to the rules')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 0.14.0 — `/dispatch` 宿主命令（spec `2026-11-17-dispatch-ui-design.md` §3.1/§5）
//
// 命令与 UI 读写同一个标记文件，所以断言打在文件内容上（读回 JSON）而不是
// `readProjectMode`：后者按 `(路径, mtime)` 记忆化，同一目录连续改写不保证
// mtime 变化。

test('0.14.0: apply registers the /dispatch command with the frozen shape', () => {
  // §5：命令名/描述/hint 是契约面，出错会直接改变用户看到的 `/` 菜单。
  // 0.15.0 契约演进：hint 加 `init`（spec §2.5 第 4 条），这是有意更新，不是回归。
  const h = harness()
  plugin.apply(h.ctx, quiet)

  assert.equal(h.commands.length, 1, 'exactly one command is registered')
  const [command] = h.commands
  assert.equal(command.name, 'dispatch')
  assert.equal(command.description, '查看/切换当前项目的派发纪律档位')
  assert.deepEqual(command.input, { hint: '[off|auto|shadow|full|init]' })
  assert.equal(typeof command.handler, 'function')
})

test('0.14.0: writeProjectMode creates parent dirs and writes the marker', () => {
  // §5：新建父目录 + 内容正确 + 返回值是 cwd 相对 posix 路径。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-write-mode-'))
  try {
    // cwd 本身不存在：父目录必须递归创建（`mkdirSync recursive`）。
    const cwd = join(dir, 'nested', 'project')
    const result = writeProjectMode(cwd, DEFAULT_PROJECT_SWITCH, 'shadow')

    assert.deepEqual(result, { ok: true, file: 'dispatch/protocol.json', mode: 'shadow' })
    assert.equal(readFileSync(join(cwd, 'dispatch', 'protocol.json'), 'utf8'), '{"mode":"shadow"}\n')
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'dispatch', 'protocol.json'), 'utf8')), { mode: 'shadow' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: writeProjectMode atomically overwrites an existing marker', () => {
  // §5：覆盖已有文件；rename 一步替换，成功后不留 `.tmp-<pid>`。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-write-overwrite-'))
  try {
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeProjectMarker(cwd, '{"mode":"off"}\n')

    const result = writeProjectMode(cwd, DEFAULT_PROJECT_SWITCH, 'full')

    assert.equal(result.ok, true)
    assert.equal(result.file, 'dispatch/protocol.json')
    assert.equal(readFileSync(join(cwd, 'dispatch', 'protocol.json'), 'utf8'), '{"mode":"full"}\n')
    assert.deepEqual(readdirSync(join(cwd, 'dispatch')).filter(name => name.includes('.tmp-')), [],
      'no temp file survives a successful write')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: writeProjectMode rejects a bad mode, cwd or escaping path without writing', () => {
  // §5：非法 mode / 非法 cwd / 逃出 cwd 返回失败且不写。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-write-invalid-'))
  try {
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })

    const cases = [
      ['unknown mode', writeProjectMode(cwd, DEFAULT_PROJECT_SWITCH, 'loud')],
      ['blank cwd', writeProjectMode('', DEFAULT_PROJECT_SWITCH, 'off')],
      ['missing cwd', writeProjectMode(undefined, DEFAULT_PROJECT_SWITCH, 'off')],
      ['relative escape', writeProjectMode(cwd, { enabled: true, path: '../outside.json' }, 'off')],
      ['absolute escape', writeProjectMode(cwd, { enabled: true, path: join(dir, 'outside.json') }, 'off')],
    ]
    for (const [label, result] of cases) {
      assert.equal(result.ok, false, label)
      assert.ok(['invalid-cwd', 'invalid-path', 'write-failed'].includes(result.reason),
        `${label}: reason ${result.reason} is one of the frozen three`)
    }
    assert.equal(existsSync(join(cwd, 'dispatch', 'protocol.json')), false, 'no marker is written on any failure')
    assert.equal(existsSync(join(dir, 'outside.json')), false, 'a path escaping the cwd is never written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: writeProjectMode reports write-failed and cleans the temp file', () => {
  // §5 的 `write-failed` 分支：目标位置被目录占住，rename 必然失败。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-write-failed-'))
  try {
    const cwd = join(dir, 'project')
    mkdirSync(join(cwd, 'dispatch', 'protocol.json'), { recursive: true })

    const result = writeProjectMode(cwd, DEFAULT_PROJECT_SWITCH, 'off')

    assert.equal(result.ok, false)
    assert.equal(result.reason, 'write-failed')
    assert.equal(typeof result.error, 'string', 'the underlying error text is reported')
    assert.deepEqual(readdirSync(join(cwd, 'dispatch')).filter(name => name.includes('.tmp-')), [],
      'the temp file is removed after a failed rename')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: the /dispatch command writes all four modes and reports the relative path', () => {
  // §5：四档各写一次并返回 success 文本；大小写与空白由 handler 归一化。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-command-write-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, quiet)

    for (const mode of PROJECT_MODES) {
      const cwd = join(dir, mode)
      mkdirSync(cwd, { recursive: true })
      const agent = h.main(`agent-${mode}`, [], {}, `session-${mode}`, cwd)
      const result = runCommand(h, `  ${mode.toUpperCase()}  `, agent)
      assert.deepEqual(result, { kind: 'success', text: `已切换为 ${mode}（dispatch/protocol.json）` }, mode)
      assert.equal(readFileSync(join(cwd, 'dispatch', 'protocol.json'), 'utf8'), `{"mode":"${mode}"}\n`, mode)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: the /dispatch command queries the current mode with no argument', () => {
  // §5：无参查询；`session.header.cwd` 是 cwd 的回落。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-command-query-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, quiet)

    const bare = join(dir, 'bare')
    mkdirSync(bare, { recursive: true })
    const bareAgent = h.main('agent-bare', [], {}, 'session-bare', bare)
    assert.deepEqual(runCommand(h, '', bareAgent), { kind: 'success', text: '当前项目档位：auto' },
      'no marker file means auto (0.16.0)')
    assert.deepEqual(runCommand(h, undefined, bareAgent), { kind: 'success', text: '当前项目档位：auto' })

    const off = join(dir, 'off')
    mkdirSync(off, { recursive: true })
    writeProjectMarker(off, '{"mode":"off"}')
    assert.deepEqual(runCommand(h, '   ', h.main('agent-off', [], {}, 'session-off', off)),
      { kind: 'success', text: '当前项目档位：off' })

    const header = join(dir, 'header')
    mkdirSync(header, { recursive: true })
    writeProjectMarker(header, '{"mode":"shadow"}')
    assert.deepEqual(runCommand(h, '', { session: { header: { cwd: header } } }),
      { kind: 'success', text: '当前项目档位：shadow' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: the /dispatch command rejects an unknown argument and a missing cwd', () => {
  // §5：非法参数、cwd 缺失都是 error，且都不写文件。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-command-errors-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, quiet)
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    const agent = h.main('agent-errors', [], {}, 'session-errors', cwd)

    assert.deepEqual(runCommand(h, 'loud', agent),
      { kind: 'error', text: '用法：/dispatch [off|auto|shadow|full|init]（无参=查询）' })
    assert.equal(existsSync(join(cwd, 'dispatch')), false, 'an unknown argument writes nothing')

    assert.deepEqual(runCommand(h, 'off', { session: {} }),
      { kind: 'error', text: '无法确定会话工作目录' })
    assert.deepEqual(runCommand(h, 'off', undefined),
      { kind: 'error', text: '无法确定会话工作目录' }, 'a handler without an agent cannot resolve a cwd')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: a non-string rawInput is a usage error, not a no-arg query', () => {
  // §5：只有 undefined（宿主没给参）与字符串是参数形态。数组/对象/数字若被当成
  // 「无参查询」，一次畸形调用会静默显示档位而不是报用法。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-command-raw-input-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, quiet)
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    const agent = h.main('agent-raw-input', [], {}, 'session-raw-input', cwd)

    for (const rawInput of [[], ['off'], {}, { mode: 'off' }, 42, null]) {
      assert.deepEqual(runCommand(h, rawInput, agent),
        { kind: 'error', text: '用法：/dispatch [off|auto|shadow|full|init]（无参=查询）' }, `rawInput=${JSON.stringify(rawInput)}`)
    }
    assert.equal(existsSync(join(cwd, 'dispatch')), false, 'a non-string argument writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: a failed command write surfaces 保存失败 with the reason', () => {
  // §3.1 第 4-5 步的失败面：命令层把 writeProjectMode 的 reason 原样带出。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-command-write-failed-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, quiet)
    const cwd = join(dir, 'project')
    mkdirSync(join(cwd, 'dispatch', 'protocol.json'), { recursive: true })

    const result = runCommand(h, 'off', h.main('agent-write-failed', [], {}, 'session-write-failed', cwd))

    assert.equal(result.kind, 'error')
    assert.match(result.text, /^保存失败：write-failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: apply survives a host without the commands service', () => {
  // §5：`commands` 服务缺失（ctx 无 `inject` 或 `inject` 不回调）时 `apply` 不抛，
  // 其余机制照常注册。
  const noInject = harness({ inject: false })
  assert.doesNotThrow(() => plugin.apply(noInject.ctx, quiet))
  assert.equal(noInject.commands.length, 0)
  assert.equal(noInject.sections.length, 1, 'the prompt section still registers')

  const noCallback = harness({ injectCallsBack: false })
  assert.doesNotThrow(() => plugin.apply(noCallback.ctx, quiet))
  assert.equal(noCallback.commands.length, 0)
  assert.equal(noCallback.guards.length, 1, 'the write guard still registers')
})

test('0.14.0: with projectSwitch.enabled false the command still writes and warns', () => {
  // §3.1 第 5 步：开关关闭时文件照写，文本追加「当前不生效」。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-command-switch-off-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, { log: false, projectSwitch: { enabled: false } })
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    const agent = h.main('agent-switch-off', [], {}, 'session-switch-off', cwd)

    const result = runCommand(h, 'off', agent)

    assert.equal(result.kind, 'success')
    assert.equal(result.text, '已切换为 off（dispatch/protocol.json）；注意：项目开关已关闭，本文件当前不生效')
    assert.equal(readFileSync(join(cwd, 'dispatch', 'protocol.json'), 'utf8'), '{"mode":"off"}\n',
      'the file is the single truth even when the switch is disabled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: the /dispatch handler turns any exception into an error result', () => {
  // §3.1：handler 内的异常不得让命令执行抛错。
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const exploded = {
    get session() {
      throw new Error('boom')
    },
  }
  const result = runCommand(h, 'off', exploded)

  assert.equal(result.kind, 'error')
  assert.match(result.text, /保存失败/)
})

test('0.14.0: client.js modeOfText matches the host reader case by case', () => {
  // §3.2：控件自带一份解析器，必须与宿主 `readProjectMode` 逐例同口径——两处
  // 漂移会让控件显示的档位与真正生效的档位不同，而 docs-check 判不出来。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-client-parity-'))
  const previousWindow = globalThis.window
  let captured
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    // `client.js` 是手写的惰性 CJS 注册脚本：顶层只碰 `window`，`document` 与
    // `react` 都在 factory 内或 `typeof` 守卫之后，所以 `new Function` 足够。
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()

    assert.equal(captured?.id, 'dispatch-protocol', 'the bundle registers under the npm package name')
    const react = { createElement: () => null }
    const exports = captured.factory((id) => {
      if (id === 'react') return react
      throw new Error(`client.js required an unexpected module: ${id}`)
    })
    const { modeOfText, MARKER_PATH } = exports.pure

    // 已知限制（README「已知坑」）：控件固定读默认路径，丢弃 projectSwitch.path。
    assert.equal(MARKER_PATH, DEFAULT_PROJECT_SWITCH.path, 'the dock reads the default marker path only')

    const config = resolveConfig({}).projectSwitch
    const cases = [
      ['missing', undefined],
      ['bad-json', '{oops'],
      ['array', '[]'],
      ['null', 'null'],
      ['empty-object', '{}'],
      ['enabled-false', '{"enabled":false}'],
      ['mode-off', '{"mode":"off"}'],
      ['mode-shadow', '{"mode":"shadow"}'],
      ['enabled-true-full', '{"enabled":true,"mode":"full"}'],
      ['unknown-mode', '{"mode":"loud"}'],
    ]
    for (const [name, body] of cases) {
      const cwd = join(dir, name)
      mkdirSync(cwd, { recursive: true })
      if (body !== undefined) writeProjectMarker(cwd, body)
      assert.equal(modeOfText(body), readProjectMode(cwd, config),
        `client.js modeOfText and readProjectMode disagree on ${name}`)
    }
  } finally {
    // 桩只活在这个用例里：其它用例依赖真实的宿主环境。
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.14.0: client.js declares the Remote namespace and both faces in inject', () => {
  // 线上缺陷回归：`remote.commands` / `remote.workspaceFiles` 是 Remote 下的独立
  // 子服务，只写 `remote` 不够——点按钮时读 `ctx.remote.commands` 会抛
  // `cannot get property "remote.commands" without inject`，写路径把异常冒成
  // 「切换失败」。读路径的异常被吞成「未知」，所以离线能抓住清单漂移的只有这条
  // 断言（被删掉的 `ctx.get(name)` 探测在运行期反而不报错，抓不住）。
  const previousWindow = globalThis.window
  let captured
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()
    const exports = captured.factory((id) => {
      if (id === 'react') return { createElement: () => null }
      throw new Error(`client.js required an unexpected module: ${id}`)
    })

    assert.ok(Array.isArray(exports.inject), 'client.js exports an inject list')
    for (const name of ['slots', 'locale', 'remote', 'remote.commands', 'remote.workspaceFiles']) {
      assert.ok(exports.inject.includes(name), `client.js must declare the "${name}" injection`)
    }
  } finally {
    // 桩只活在这个用例里：其它用例依赖真实的宿主环境。
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('0.15.1: the dock registers on conversation.input.dock (blank Sessions render it)', () => {
  // 线上缺陷回归：dock 原先挂在 `conversation.composer.dock`，宿主只在
  // `variant === 'composer'` 时渲染该槽（InputBar.tsx:596-599），而「新建会话」
  // 落到的空白会话是 hero 态（ConversationMainPanel.tsx:32-35），整行控件因此
  // 不出现，发出首条消息后才出现。`conversation.input.dock` 只要 session 与
  // inputState 就绪就渲染（ConversationContent.tsx:86-87、:169）。本用例把
  // 「落在哪个槽」钉死在测试里，防止再迁回 composer.dock。
  const previousWindow = globalThis.window
  let captured
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()
    const exports = captured.factory((id) => {
      if (id === 'react') return { createElement: () => null }
      throw new Error(`client.js required an unexpected module: ${id}`)
    })

    const injected = []
    const registered = []
    const ctx = {
      slots: {
        inject(name, callback) {
          injected.push(name)
          callback()
          return () => {}
        },
        register(definition, component) {
          registered.push({ definition, component })
          return () => {}
        },
      },
      locale: { register() { return () => {} } },
      remote: { workspaceFiles: { read() {} }, commands: { execute() {} } },
      effect(fn) { fn(); return () => {} },
      on() { return () => {} },
    }
    exports.apply(ctx)

    // 落点只能是 input.dock：一旦回到 composer.dock，「新建的空白会话」就又整行
    // 不渲染（hero 态不满足 composer 的 variant 条件）。deepEqual 顺带断言没有
    // 多注册第二个槽。
    assert.deepEqual(injected, ['conversation.input.dock'],
      'the dock injects exactly one slot: conversation.input.dock (never composer.dock)')

    assert.equal(registered.length, 1, 'the dock registers exactly one component')
    const { definition, component } = registered[0]
    // 注册定义三件套：名字、稳定 id（宿主靠它去重与卸载）、order 10（宿主 Todo
    // 是 0、队列是 20，本控件夹在两者中间）。
    assert.equal(definition.name, 'conversation.input.dock')
    assert.equal(definition.id, 'dispatch-protocol.dock')
    assert.equal(definition.order, 10)
    // locale 必须是本 bundle 的字典命名空间，否则 dock 文案回落成键名。
    assert.equal(definition.locale, exports.NS)
    assert.equal(definition.locale, 'dispatchProtocol')

    // session 作用域的 `inject` 由宿主以 SessionId 调用，返回值即组件 props；
    // 这条保证 props 里的 sessionId 与宿主 session 作用域同一条来路（读/写/刷新
    // 都拿它当键），不是靠 owner props 另取一份。
    assert.equal(typeof definition.inject, 'function', 'the slot definition exposes an inject callback')
    const props = definition.inject('sess-1')
    assert.equal(props.sessionId, 'sess-1')
    assert.equal(typeof props.readMode, 'function', 'readMode is passed to the component')
    assert.equal(typeof props.switchMode, 'function', 'switchMode is passed to the component')
    assert.equal(typeof props.subscribe, 'function', 'subscribe is passed to the component')
    assert.equal(typeof component, 'function', 'the registered component is the dock')
  } finally {
    // 桩只活在这个用例里：其它用例依赖真实的宿主环境。
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('0.17.1: the dock row mirrors the composer card width in every layout variant', () => {
  // 线上缺陷回归：`conversation.input.dock` 的 outlet 是 `display:contents`
  // （dsh-client-ui-renderer 的 ANCHOR_STYLE），控件直接成为宿主 `.composerStack`
  // 的 flex 子项；而这个栈占满整条会话列（输入框卡片只是其中一行）。宿主只给
  // 卡片自己 `max-width:var(--dsh-composer-card-max-width)` + 居中，控件不自己
  // 带上同样的宽度约束，整行就贴在会话列最左边（距离卡片上百像素），看起来
  // 「没有和输入框对齐」。官方 QueueDock / TodoPanel 都各自带这段 CSS。
  //
  // 修复不是一行 calc，而是照抄宿主的两级几何：`.ddp-frame` ≈ `.GRgSLq_root`
  // （侧留白 + 居中），`.ddp-dock` ≈ `.GRgSLq_card`（100% + 卡片宽度上限）。
  // 因为嵌入形态（右侧栏子代理会话）里 `--dsh-composer-card-max-width` 本身是
  // 百分比，单行 calc 会按「用的元素」解析、每边差 8px；镜像两级容器后两边解析
  // 基准一致，窗口任意宽度都对得上。
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  let captured
  const styles = []
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    globalThis.document = {
      querySelector: () => null,
      createElement: () => {
        const tag = { dataset: {}, textContent: '' }
        styles.push(tag)
        return tag
      },
      head: { appendChild() {} },
    }
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()
    const react = {
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useRef: (initial) => ({ current: initial }),
    }
    const exports = captured.factory((id) => {
      if (id === 'react') return react
      throw new Error(`client.js required an unexpected module: ${id}`)
    })

    const plain = styles.map((tag) => tag.textContent).join('\n')
    const frame = /\.ddp-frame\{([^}]*)\}/.exec(plain)?.[1]
    const dock = /\.ddp-dock\{([^}]*)\}/.exec(plain)?.[1]
    assert.ok(frame !== undefined, 'the dock ships a .ddp-frame rule (mirrors the composer root)')
    assert.ok(dock !== undefined, 'the dock ships a .ddp-dock rule (mirrors the composer card)')
    // 与宿主 `.GRgSLq_root` 同款：侧留白 + 列向居中，卡片宽度百分比才有同一基准。
    assert.match(frame, /padding:0 var\(--dsh-composer-side-clearance/,
      'the frame uses the same side clearance as the composer root')
    assert.match(frame, /align-items:center/, 'the frame centers the card-width row')
    // 与宿主 `.GRgSLq_card` 同款：先 100%（含窄屏），再由卡片上限收窄。
    assert.match(dock, /width:100%/, 'the row takes the whole available width first')
    assert.match(dock, /max-width:var\(--dsh-composer-card-max-width/,
      'then caps itself to the host composer card width')
    assert.match(dock, /box-sizing:border-box/, 'padding must not widen the capped row')

    // 结构契约：宽度 CSS 只有在 frame 包住 dock 时才有意义；少一层 wrapper 就退回
    // 贴左（0.17.0 的缺陷）。这里用桩 React 渲染一次组件，检查元素树。
    let component
    const fakeCtx = {
      slots: {
        inject(name, callback) { callback(); return () => {} },
        register(definition, render) { component = render; return () => {} },
      },
      locale: { register() { return () => {} } },
      remote: { workspaceFiles: { read() {} }, commands: { execute() {} } },
      effect(fn) { fn(); return () => {} },
      on() { return () => {} },
    }
    exports.apply(fakeCtx)
    const tree = component({
      t: (key) => key,
      sessionId: 'sess-1',
      readMode: () => Promise.resolve({ mode: 'auto' }),
      switchMode: () => Promise.resolve({ ok: true }),
      subscribe: () => undefined,
    })
    assert.equal(tree?.type, 'div')
    assert.equal(tree?.props?.className, 'ddp-frame', 'the component root is the frame')
    const inner = tree?.props?.children?.[0]
    assert.equal(inner?.props?.className, 'ddp-dock', 'the card-width row lives inside the frame')
  } finally {
    // 桩只活在这个用例里：其它用例依赖真实的宿主环境。
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

// ---------------------------------------------------------------------------
// 0.18.0 — 控件未激活态与激活按钮（spec
// `2026-11-18-dispatch-dock-activation-design.md` §3/§5）。

/**
 * Minimal hooks runtime: the dock is a plain function component, so
 * useState/useRef/useEffect is all a stub needs to mount, re-render and click.
 * @returns `{ api, render(component, props) }`; `render` returns the tree and the
 *   effects collected on that render (run them only for the first render).
 */
function hookReact() {
  const states = []
  const refs = []
  let stateIndex = 0
  let refIndex = 0
  let effects = []
  const api = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => {
      const index = stateIndex++
      if (states[index] === undefined) states[index] = { value: initial }
      return [states[index].value, (next) => { states[index].value = next }]
    },
    useRef: (initial) => {
      const index = refIndex++
      if (refs[index] === undefined) refs[index] = { current: initial }
      return refs[index]
    },
    useEffect: (fn) => { effects.push(fn) },
  }
  return {
    api,
    render(component, props) {
      stateIndex = 0
      refIndex = 0
      effects = []
      const tree = component(props)
      const mount = effects
      effects = []
      return { tree, mount }
    },
  }
}

/** Dictionary lookup with `{name}` interpolation, mirroring the host `t`. */
function translate(dict) {
  return (key, params) => {
    let text = typeof dict[key] === 'string' ? dict[key] : key
    for (const [name, value] of Object.entries(params ?? {})) text = text.split('{' + name + '}').join(value)
    return text
  }
}

/** Every element in a rendered tree, including ones nested inside arrays. */
function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.props?.children ?? []) elementsOf(child, out)
  return out
}

/** Every text node of a rendered tree, in render order. */
function textsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  for (const child of node.props?.children ?? []) textsOf(child, out)
  return out
}

/** Flush the pending promise chain of one dock interaction. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('0.18.0: dockStateOf maps one read outcome to initialized / mode / unknown', () => {
  // §3.1：未初始化只在 `workspace-file/not-found` 时成立；坏文件仍是已初始化
  // （宿主按 auto 兜底），其它读失败保持 0.14 的「未知」。
  const previousWindow = globalThis.window
  let captured
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()
    const exports = captured.factory((id) => {
      if (id === 'react') return { createElement: () => null }
      throw new Error(`client.js required an unexpected module: ${id}`)
    })
    const state = exports.pure.dockStateOf

    assert.deepEqual(state({ ok: true, value: { text: '{"mode":"shadow"}\n' } }),
      { initialized: true, mode: 'shadow' })
    assert.deepEqual(state({ ok: true, value: { text: '{"enabled":true}' } }),
      { initialized: true, mode: 'full' })
    assert.deepEqual(state({ ok: true, value: { text: '{oops' } }),
      { initialized: true, mode: 'auto' },
      'a bad marker is still initialized; the mode falls back to auto like lib/project.mjs')
    assert.deepEqual(state({ ok: false, error: { code: 'workspace-file/not-found' } }),
      { initialized: false, mode: undefined },
      'no marker means the project was never initialized')
    assert.deepEqual(state({ ok: false, error: { code: 'workspace-file/too-large', message: 'nope' } }),
      { initialized: undefined, mode: undefined, detail: 'workspace-file/too-large: nope' })
    assert.deepEqual(state(null), { initialized: undefined, mode: undefined, detail: 'unknown' },
      'an unreadable outcome keeps the 0.14 unknown state, never 未激活')

    const zh = JSON.parse(readFileSync(new URL('./locale/zh.json', import.meta.url), 'utf8'))
    const en = JSON.parse(readFileSync(new URL('./locale/en.json', import.meta.url), 'utf8'))
    for (const key of ['inactive', 'activate', 'activateHint', 'activateFailed']) {
      assert.equal(exports.dictionaries.zh[key], zh.ui[key], `zh dictionary mirrors locale/zh.json (${key})`)
      assert.equal(exports.dictionaries.en[key], en.ui[key], `en dictionary mirrors locale/en.json (${key})`)
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('0.18.0: an uninitialized project renders 未激活 + 激活 and no mode chips', async () => {
  // §3.2：标签保留（说明插件开启），但没有档位值、没有四档按钮；点激活走注入
  // 的 activate 服务（session 作用域传当前 SessionId）。
  const previousWindow = globalThis.window
  let captured
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()
    const runtime = hookReact()
    const exports = captured.factory((id) => {
      if (id === 'react') return runtime.api
      throw new Error(`client.js required an unexpected module: ${id}`)
    })

    let component
    exports.apply({
      slots: {
        inject(name, callback) { callback(); return () => {} },
        register(definition, render) { component = render; return () => {} },
      },
      locale: { register() { return () => {} } },
      remote: { workspaceFiles: { read() {} }, commands: { execute() {} } },
      effect(fn) { fn(); return () => {} },
      on() { return () => {} },
    })

    const activated = []
    const props = {
      t: translate(exports.dictionaries.zh),
      sessionId: 'sess-1',
      readMode: () => Promise.resolve({ initialized: false, mode: undefined }),
      switchMode: () => Promise.resolve({ ok: false }),
      activate: (sessionId) => { activated.push(sessionId); return Promise.resolve({ ok: true }) },
      subscribe: () => undefined,
    }

    const first = runtime.render(component, props)
    for (const effect of first.mount) effect()
    await flush()
    const { tree } = runtime.render(component, props)

    assert.deepEqual(textsOf(tree), ['派发纪律', '未激活', '激活'],
      'the row keeps the plugin label and offers activation')
    const elements = elementsOf(tree)
    assert.equal(elements.some((node) => typeof node.props?.className === 'string'
      && node.props.className.includes('ddp-mode')), false,
    'no mode chip is rendered before the project is initialized')
    const buttons = elements.filter((node) => node.type === 'button')
    assert.equal(buttons.length, 1, 'activation is the only action in the uninitialized state')
    assert.equal(buttons[0].props.className, 'ddp-activate')

    buttons[0].props.onClick()
    await flush()
    assert.deepEqual(activated, ['sess-1'], 'activation goes through the injected activate service')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('0.18.0: apply passes activate and runs /dispatch init through the command surface', async () => {
  // §3.3：激活与切档共用同一条宿主命令 admission 路径，只是一个拼 init、一个
  // 拼 mode；两个服务都在 slot props 上，客户端不直接写文件。
  const previousWindow = globalThis.window
  let captured
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()
    const exports = captured.factory((id) => {
      if (id === 'react') return { createElement: () => null }
      throw new Error(`client.js required an unexpected module: ${id}`)
    })

    const calls = []
    let registered
    exports.apply({
      slots: {
        inject(name, callback) { callback(); return () => {} },
        register(definition, render) { registered = { definition, render }; return () => {} },
      },
      locale: { register() { return () => {} } },
      remote: {
        workspaceFiles: { read() {} },
        commands: {
          execute(sessionId, line, attachments) {
            calls.push({ sessionId, line, attachments })
            return Promise.resolve({ ok: true, value: { result: { kind: 'success', text: 'ok' } } })
          },
        },
      },
      effect(fn) { fn(); return () => {} },
      on() { return () => {} },
    })

    const props = registered.definition.inject('sess-1')
    assert.equal(typeof props.activate, 'function', 'the slot props carry the activation service')
    assert.deepEqual(await props.activate('sess-1'), { ok: true })
    assert.deepEqual(await props.switchMode('sess-1', 'shadow'), { ok: true })
    assert.deepEqual(calls, [
      { sessionId: 'sess-1', line: '/dispatch init', attachments: [] },
      { sessionId: 'sess-1', line: '/dispatch shadow', attachments: [] },
    ])
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('0.18.0: activation failure reports the Host text unless a concurrent init won', async () => {
  // §3.3：失败先把状态重读一次——宿主「已存在…未覆盖」在并发场景下其实是
  // 成功；只有重读仍为未初始化时才把宿主文案显示在行内。
  const previousWindow = globalThis.window
  let captured
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()
    const failure = '已存在 dispatch/protocol.json，未覆盖；先查看或删除该文件后再 /dispatch init'
    const mount = async (runtime, component, props) => {
      const first = runtime.render(component, props)
      for (const effect of first.mount) effect()
      await flush()
      return props
    }
    const clickActivate = async (runtime, component, props) => {
      const tree = runtime.render(component, props).tree
      const button = elementsOf(tree).find((node) => node.props?.className === 'ddp-activate')
      assert.ok(button, 'the inactive row offers activation')
      button.props.onClick()
      await flush()
      return runtime.render(component, props).tree
    }

    // (a) still uninitialized after the failed command: show the Host text inline.
    const runtimeA = hookReact()
    const exportsA = captured.factory((id) => {
      if (id === 'react') return runtimeA.api
      throw new Error(`client.js required an unexpected module: ${id}`)
    })
    let componentA
    exportsA.apply({
      slots: {
        inject(name, callback) { callback(); return () => {} },
        register(definition, render) { componentA = render; return () => {} },
      },
      locale: { register() { return () => {} } },
      remote: { workspaceFiles: { read() {} }, commands: { execute() {} } },
      effect(fn) { fn(); return () => {} },
      on() { return () => {} },
    })
    const failing = await mount(runtimeA, componentA, {
      t: translate(exportsA.dictionaries.zh),
      sessionId: 'sess-1',
      readMode: () => Promise.resolve({ initialized: false, mode: undefined }),
      switchMode: () => Promise.resolve({ ok: true }),
      activate: () => Promise.resolve({ ok: false, reason: 'handler', detail: failure }),
      subscribe: () => undefined,
    })
    const treeA = await clickActivate(runtimeA, componentA, failing)
    assert.ok(textsOf(treeA).includes(`激活失败：${failure}`),
      'the Host error text is surfaced when the project is still uninitialized')
    assert.equal(textsOf(treeA).filter((text) => text === '激活失败：' + failure).length, 1,
      'one activation failure produces one notice')

    // (b) another Session won the race: the Host refuses to overwrite, and the
    // re-read proves initialized — render the four-mode control, no error.
    const runtimeB = hookReact()
    const exportsB = captured.factory((id) => {
      if (id === 'react') return runtimeB.api
      throw new Error(`client.js required an unexpected module: ${id}`)
    })
    let componentB
    exportsB.apply({
      slots: {
        inject(name, callback) { callback(); return () => {} },
        register(definition, render) { componentB = render; return () => {} },
      },
      locale: { register() { return () => {} } },
      remote: { workspaceFiles: { read() {} }, commands: { execute() {} } },
      effect(fn) { fn(); return () => {} },
      on() { return () => {} },
    })
    let reads = 0
    const racing = await mount(runtimeB, componentB, {
      t: translate(exportsB.dictionaries.zh),
      sessionId: 'sess-2',
      readMode: () => {
        reads += 1
        return Promise.resolve(reads === 1
          ? { initialized: false, mode: undefined }
          : { initialized: true, mode: 'full' })
      },
      switchMode: () => Promise.resolve({ ok: true }),
      activate: () => Promise.resolve({ ok: false, reason: 'handler', detail: failure }),
      subscribe: () => undefined,
    })
    const treeB = await clickActivate(runtimeB, componentB, racing)
    assert.equal(textsOf(treeB).includes(`激活失败：${failure}`), false,
      'a concurrent init is success, not an activation failure')
    assert.equal(textsOf(treeB)[1], 'full', 'the value shows the mode the concurrent init wrote')
    assert.ok(elementsOf(treeB).some((node) => node.props?.className === 'ddp-modes'),
      'the row switches to the four-mode control')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

// ---------------------------------------------------------------------------
// 0.15.0 项目策略文件：`readProjectPolicy`（spec `2026-11-17-project-policy-
// design.md` §2.1/§2.2）+ `business` 规则预设（§2.4）。用例全部只碰临时目录。

test('0.15.0: readProjectPolicy returns only the fields the file validly carries', () => {
  // §2.1/§2.2 / §5-A：缺省字段不出现（由调用方回落 config），坏的整个文件只回 mode。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-'))
  try {
    const config = resolveConfig({}).projectSwitch
    const project = (name, body) => {
      const cwd = join(dir, name)
      mkdirSync(cwd, { recursive: true })
      if (body !== undefined) writeProjectMarker(cwd, body)
      return cwd
    }

    assert.deepEqual(readProjectPolicy(project('missing'), config), { mode: 'auto' },
      'no marker file → auto, no policy fields (0.16.0)')
    assert.deepEqual(readProjectPolicy(project('empty-file', ''), config), { mode: 'auto' })
    assert.deepEqual(readProjectPolicy(project('bad-json', '{oops'), config), { mode: 'auto' })
    assert.deepEqual(readProjectPolicy(project('array', '[]'), config), { mode: 'auto' })
    assert.deepEqual(readProjectPolicy(project('null', 'null'), config), { mode: 'auto' })

    // mode / enabled 的 0.13 判定顺序不变；没有 mode 的普通策略文件默认 auto。
    assert.deepEqual(readProjectPolicy(project('mode-shadow', '{"mode":"shadow"}'), config), { mode: 'shadow' })
    assert.deepEqual(readProjectPolicy(project('enabled-false', '{"enabled":false}'), config), { mode: 'off' })
    assert.deepEqual(readProjectPolicy(project('enabled-true', '{"enabled":true}'), config), { mode: 'full' })
    assert.deepEqual(readProjectPolicy(project('unknown-mode', '{"mode":"loud"}'), config), { mode: 'auto' })
    assert.deepEqual(readProjectPolicy(project('mode-off-rules', '{"mode":"off","rules":"business"}'), config),
      { mode: 'off', rules: 'business' },
      'mode and rules are independent fields')

    // 全部字段有效时逐字段投影，数组形状与文件一致；0.17.0 删除的闸门字段
    // （controlPlanePatterns / verify / contract / docs）出现在文件里也只是忽略。
    const full = {
      mode: 'shadow',
      enabled: true,
      rules: 'business',
      allowlist: ['dispatch/', 'docs/design/'],
      controlPlanePatterns: ['dispatch/', 'docs/design/'],
      verify: { commands: ['pnpm -w test', 'pnpm -w typecheck'] },
      contract: { patterns: ['src/types/', 'prisma/schema.prisma'] },
      docs: { patterns: ['.md', 'docs/'] },
    }
    assert.deepEqual(readProjectPolicy(project('full', JSON.stringify(full)), config), {
      mode: 'shadow',
      rules: 'business',
      allowlist: ['dispatch/', 'docs/design/'],
    }, '0.17.0: only mode/rules/allowlist are read; gate-only fields are ignored')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.15.0: an invalid policy field falls back alone, keeping the other fields and the mode', () => {
  // §2.1：字段级 fail-open——某字段类型/内容非法 → 该字段不出现，其它字段与 mode 不受影响。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-fields-'))
  try {
    const config = resolveConfig({}).projectSwitch
    const project = (name, body) => {
      const cwd = join(dir, name)
      mkdirSync(cwd, { recursive: true })
      writeProjectMarker(cwd, body)
      return cwd
    }
    // 0.17.0：策略只剩 mode / rules / allowlist；闸门字段无论写什么都读不到。
    const base = {
      mode: 'shadow',
      rules: 'business',
      allowlist: ['dispatch/'],
    }
    const expected = {
      mode: 'shadow',
      rules: 'business',
      allowlist: ['dispatch/'],
    }
    const without = (...dropped) => {
      const policy = structuredClone(expected)
      for (const field of dropped) delete policy[field]
      return policy
    }
    const policyOf = (name, patch) => readProjectPolicy(
      project(name, JSON.stringify({ ...base, ...patch })), config)

    assert.deepEqual(policyOf('rules-unknown', { rules: 'x' }), without('rules'))
    assert.deepEqual(policyOf('rules-number', { rules: 1 }), without('rules'))
    assert.deepEqual(policyOf('allowlist-empty', { allowlist: [] }), without('allowlist'))
    assert.deepEqual(policyOf('allowlist-string', { allowlist: 'a' }), without('allowlist'))
    assert.deepEqual(policyOf('allowlist-number-item', { allowlist: ['a', 2] }), without('allowlist'))
    assert.deepEqual(policyOf('allowlist-empty-item', { allowlist: ['a', ''] }), without('allowlist'))
    // 0.17.0 回归：旧闸门字段即使写得完整也不改变返回对象。
    assert.deepEqual(policyOf('legacy-gates', {
      controlPlanePatterns: ['src/notes/'],
      verify: { commands: ['pnpm test'] },
      contract: { patterns: ['src/types/'] },
      docs: { patterns: ['.md'] },
    }), expected, '0.17.0: gate-only fields are ignored, not projected')

    // 缓存里只有解析结果，返回的数组不与缓存共享：改返回值不影响下一次读取。
    const isolation = project('isolation', JSON.stringify(base))
    readProjectPolicy(isolation, config).allowlist.push('src/')
    assert.deepEqual(readProjectPolicy(isolation, config).allowlist, ['dispatch/'],
      'the memoized document is never handed out as a mutable policy object')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.15.0: readProjectMode is exactly readProjectPolicy(...).mode and never throws', () => {
  // §2.2：`readProjectMode` 保留为薄封装，0.13 调用面与可观察行为逐例不变。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-mode-parity-'))
  try {
    const config = resolveConfig({}).projectSwitch
    const project = (name, body) => {
      const cwd = join(dir, name)
      mkdirSync(cwd, { recursive: true })
      if (body !== undefined) writeProjectMarker(cwd, body)
      return cwd
    }
    const cases = [
      ['missing', undefined],
      ['bad-json', '{oops'],
      ['array', '[]'],
      ['null', 'null'],
      ['empty-object', '{}'],
      ['enabled-false', '{"enabled":false}'],
      ['enabled-true-mode-shadow', '{"enabled":true,"mode":"shadow"}'],
      ['mode-off', '{"mode":"off"}'],
      ['mode-full', '{"mode":"full"}'],
      ['unknown-mode', '{"mode":"loud"}'],
      ['policy-fields', '{"mode":"shadow","rules":"business","allowlist":["dispatch/"]}'],
      ['bad-policy-fields', '{"mode":"off","rules":"x","allowlist":[],"verify":{"commands":[]}}'],
    ]
    for (const [name, body] of cases) {
      const cwd = project(name, body)
      assert.equal(readProjectMode(cwd, config), readProjectPolicy(cwd, config).mode,
        `readProjectMode and readProjectPolicy disagree on ${name}`)
    }

    // fail-open 的全部入口形态：缺 cwd、空 cwd、开关关闭、路径逃逸。
    assert.deepEqual(readProjectPolicy(undefined, config), { mode: 'full' })
    assert.deepEqual(readProjectPolicy('', config), { mode: 'full' })
    assert.deepEqual(readProjectPolicy('   ', config), { mode: 'full' })
    assert.deepEqual(readProjectPolicy(project('switch-disabled', '{"rules":"business"}'),
      { enabled: false, path: 'dispatch/protocol.json' }), { mode: 'full' },
    'projectSwitch.enabled === false wins over any policy content')
    assert.deepEqual(readProjectPolicy(project('escaping-path', '{"rules":"business"}'),
      { enabled: true, path: '../outside.json' }), { mode: 'full' },
    'a path escaping the cwd is not a marker file')
    assert.deepEqual(readProjectPolicy(project('custom-path', '{"mode":"full"}'),
      { enabled: true, path: 'dispatch/custom.json' }), { mode: 'auto' },
    'the default marker path is only read when projectSwitch.path says so; the missing custom file is auto')
    assert.deepEqual(readProjectMode(undefined), 'full', 'no projectSwitch at all still fails open')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.15.0: the business preset is six non-empty rules and one short footer', (t) => {
  // §2.4/§5-A：条款数与长度是可断言的契约，实际值进失败信息（也进诊断行）。
  const total = BUSINESS_RULES.reduce((sum, rule) => sum + rule.length, 0)
  t.diagnostic(`BUSINESS_RULES ${BUSINESS_RULES.length} 条 / ${total} 字符；BUSINESS_FOOTER ${BUSINESS_FOOTER.length} 字符`)
  assert.equal(BUSINESS_RULES.length, 6, 'the preset keeps six skeleton rules')
  BUSINESS_RULES.forEach((rule, index) => {
    assert.equal(typeof rule, 'string', `rule ${index + 1} must be a string`)
    assert.ok(rule.trim() !== '', `rule ${index + 1} must be non-empty`)
  })
  // §2.4 正文逐字冻结，实测六条合计 900 字符（派发稿的 1200–1800 区间是按
  // 「约 1.5K」估的，与逐字正文不符；以冻结正文为准，下界取实测值，上限保留
  // 派发稿的 1800，任何正文字数漂移都会在这里报出实际值）。
  assert.ok(total >= 900 && total <= 1800,
    `BUSINESS_RULES is ${total} characters (frozen §2.4 text = 900, expected 900-1800)`)
  assert.ok(BUSINESS_RULES.every(rule => !/^\d+\.\s/.test(rule)),
    'numbering is the renderer\'s job, so the preset stores bare rules')
  assert.equal(typeof BUSINESS_FOOTER, 'string')
  assert.ok(BUSINESS_FOOTER.trim() !== '', 'BUSINESS_FOOTER must be non-empty')
  assert.ok(BUSINESS_FOOTER.length < 400,
    `BUSINESS_FOOTER is ${BUSINESS_FOOTER.length} characters (expected < 400)`)

  // 预设必须删掉本仓库专属细节，否则 business 项目会去跑不存在的脚本。
  const joined = [...BUSINESS_RULES, BUSINESS_FOOTER].join('\n')
  assert.ok(!joined.includes('docs-check'), 'the business preset names no repo-specific script')
  assert.ok(!joined.includes('superpowers/specs'), 'the business preset names no repo-specific spec path')
  assert.ok(!joined.includes('断言表'), 'the business preset carries no assertion-table clause')
})

test('0.15.0: resolveRulesPreset is pure and picks the preset by name', () => {
  const config = resolveConfig({})
  const plugin = resolveRulesPreset('plugin', config)
  assert.equal(plugin.rules, config.rules, 'plugin keeps the configured rules object')
  assert.equal(plugin.footer, config.footer)
  assert.equal(resolveRulesPreset(undefined, config).rules, config.rules,
    'a missing rules value falls back to the profile config')
  assert.equal(resolveRulesPreset('other', config).footer, config.footer)

  const custom = { rules: ['r'], footer: 'f' }
  assert.equal(resolveRulesPreset('plugin', custom).rules, custom.rules)
  assert.equal(resolveRulesPreset('plugin', custom).footer, custom.footer)
  const business = resolveRulesPreset('business', custom)
  assert.equal(business.rules, BUSINESS_RULES, 'business returns the frozen preset array')
  assert.equal(business.footer, BUSINESS_FOOTER)
  assert.deepEqual(custom, { rules: ['r'], footer: 'f' }, 'the preset choice never mutates the config')

  // 纯函数且不抛错：没有 config 也回落默认值，而不是抛 TypeError。
  assert.deepEqual(resolveRulesPreset('plugin', undefined),
    { rules: DEFAULT_RULES, footer: config.footer })

  // 0.15.0 不改 `resolveConfig` 的返回对象：`text` 仍按 profile 的 rules/footer 渲染。
  assert.deepEqual(resolveConfig({}), config)
  assert.equal(resolveConfig({}).text, [
    '## 派发纪律（DSH）',
    '',
    DEFAULT_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n'),
    '',
    config.footer,
  ].join('\n'), 'the default rendered text is unchanged by 0.15.0')
})

// ---------------------------------------------------------------------------
// 0.15.0 批 B：策略字段接线（spec §2.3）与 `/dispatch init`（§2.5）。
//
// 每个用例先写 `<cwd>/dispatch/protocol.json` 自带策略，再走 harness 的真实
// 判定路径（守卫 / 闸门 / 提示词段 / 命令），断言「策略生效」并且「回落原值」。

test('0.15.0: the write guard uses the project allowlist and still honours the override', () => {
  // §2.3 写入守卫行 / §5-B：命中放行、未命中拦截、override 仍生效。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-guard-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeProjectMarker(cwd, JSON.stringify({ mode: 'full', allowlist: ['dispatch/', 'src/'] }))

    const h = harness()
    plugin.apply(h.ctx, { log })
    const root = h.main('session-policy-guard', [], {}, 'session-policy-guard', cwd)

    assert.equal(h.guard({ agent: root, name: 'write', arguments: { file_path: 'src/app.ts' } }), undefined,
      'a project allowlist entry admits the write')
    assert.equal(h.guard({ agent: root, name: 'edit', arguments: { file_path: 'dispatch/state/x.md' } }), undefined,
      'the other listed prefix still works')

    const denied = h.guard({ agent: root, name: 'write', arguments: { file_path: 'tests/x.test.ts' } })
    assert.equal(typeof denied, 'string', 'a path outside the project allowlist is denied')
    assert.match(denied, /tests\/x\.test\.ts/, 'the rejected path is named')
    assert.ok(denied.includes('dispatch/、src/'), 'the rejection names the project allowlist, not the profile one')
    assert.doesNotMatch(denied, /docs\/superpowers\/specs\//, 'the profile allowlist is replaced, not merged')

    // override 仍生效：豁免凭据与名单是两个独立机制（§5-B）。
    const overrideDir = join(cwd, 'dispatch')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'override.json'), JSON.stringify({ reason: '用户要求直接修这 4 行' }))
    assert.equal(h.guard({ agent: root, name: 'edit', arguments: { file_path: 'server/src/y.ts' } }), undefined,
      'a fresh override still releases a project-denied write')

    const rows = readRows(log)
    assert.ok(rows.some(row => row.decision === 'denied' && row.file === 'tests/x.test.ts'),
      'the denial is logged')
    assert.ok(rows.some(row => row.decision === 'allowed' && row.reason === 'override' && row.file === 'server/src/y.ts'),
      'the override is logged')
    assert.equal(rows.some(row => row.file === 'src/app.ts'), false, 'an allowlist hit is not logged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.15.0: the prompt section switches to the business preset by rules', () => {
  // §2.3 提示词段行 / §5-B：business 文本出现、plugin 文本不出现，off 仍旧为空。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-prompt-'))
  try {
    const businessCwd = join(dir, 'business')
    mkdirSync(businessCwd, { recursive: true })
    writeProjectMarker(businessCwd, '{"mode":"full","rules":"business"}')
    const pluginCwd = join(dir, 'plugin')
    mkdirSync(pluginCwd, { recursive: true })
    writeProjectMarker(pluginCwd, '{"mode":"full","rules":"plugin"}')
    const offCwd = join(dir, 'off')
    mkdirSync(offCwd, { recursive: true })
    writeProjectMarker(offCwd, '{"mode":"off","rules":"business"}')

    const h = harness()
    plugin.apply(h.ctx, {})
    const section = h.rawSections[0]
    const config = resolveConfig({})
    const context = cwd => ({ agent: { session: { cwd } } })

    const businessText = section.text(context(businessCwd))
    const expected = [
      '## 派发纪律（DSH）',
      '',
      BUSINESS_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n'),
      '',
      BUSINESS_FOOTER,
    ].join('\n')
    assert.equal(businessText, expected, 'the business preset uses the frozen body and the resolveConfig layout')
    assert.ok(businessText.includes('结论以项目自己的 CI 为准'), 'the business footer is rendered')
    assert.ok(!businessText.includes('docs-check'), 'the business preset names no repo-specific script')
    assert.ok(!businessText.includes('superpowers/specs'), 'the business preset names no repo-specific spec path')

    const pluginText = section.text(context(pluginCwd))
    assert.equal(pluginText, config.text, 'rules: "plugin" falls back to the profile text byte for byte')
    assert.ok(pluginText.includes('docs-check'), 'the profile text is the long form')
    assert.equal(section.text(context(offCwd)), '', 'off still drops the section')
    assert.equal(section.text({ agent: { session: {} } }), config.text,
      'a cwd-less context falls back to the profile text')

    // 自定义 profile 正文在 business 项目里让位给冻结预设（§2.3 回退列）。
    const custom = harness()
    plugin.apply(custom.ctx, { rules: ['profile rule'], footer: 'profile footer' })
    assert.equal(custom.rawSections[0].text(context(businessCwd)), expected,
      'the project preset wins over the profile rules/footer')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.15.0: /dispatch init writes the detected policy and never overwrites', () => {
  // §2.5 / §5-B：生成预期 JSON（scripts 检测 + dsh.bundle → plugin），已存在不覆盖。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-init-plugin-'))
  try {
    const cwd = join(dir, 'plugin-project')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'some-dsh-plugin',
      scripts: { test: 'node test.mjs', typecheck: 'tsc --noEmit', build: 'vite build' },
      dsh: { bundle: { id: 'some-dsh-plugin' } },
    }))
    mkdirSync(join(cwd, 'docs'))
    mkdirSync(join(cwd, 'src', 'types'), { recursive: true })
    writeFileSync(join(cwd, 'prisma-schema-placeholder.txt'), '')

    const h = harness()
    plugin.apply(h.ctx, quiet)
    const agent = h.main('agent-init', [], {}, 'session-init', cwd)
    const result = runCommand(h, 'init', agent)

    assert.equal(result.kind, 'success', result.text)
    const file = join(cwd, 'dispatch', 'protocol.json')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      mode: 'full',
      rules: 'plugin',
      allowlist: ['dispatch/', 'docs/'],
    }, '0.17.0: the generated file carries mode/rules/allowlist only')
    assert.match(result.text, /dispatch\/protocol\.json/)
    assert.match(result.text, /preset: plugin/)
    assert.match(result.text, /白名单 2 项/)
    assert.match(result.text, /\/dispatch off\|auto\|shadow\|full/)

    // 已存在不覆盖：返回错误文案且文件逐字节不变。
    const before = readFileSync(file, 'utf8')
    const again = runCommand(h, 'init', agent)
    assert.equal(again.kind, 'error')
    assert.match(again.text, /已存在 dispatch\/protocol\.json/)
    assert.match(again.text, /未覆盖/)
    assert.equal(readFileSync(file, 'utf8'), before, 'an existing policy file is never overwritten')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.15.0: /dispatch init defaults to the business preset and reads other ecosystems', () => {
  // §2.5 第 1 步：无 dsh.bundle/client → business；文档目录决定 allowlist。
  // 0.17.0：验证命令 / 契约面 / 文档口径随五个收尾闸门删除，生成文件只剩
  // mode / rules / allowlist。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-init-business-'))
  try {
    const cwd = join(dir, 'business-project')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }))
    writeFileSync(join(cwd, 'package-lock.json'), '{}')
    writeFileSync(join(cwd, 'pyproject.toml'), '')

    const h = harness()
    plugin.apply(h.ctx, quiet)
    const result = runCommand(h, 'init', h.main('agent-init-biz', [], {}, 'session-init-biz', cwd))

    assert.equal(result.kind, 'success', result.text)
    const written = JSON.parse(readFileSync(join(cwd, 'dispatch', 'protocol.json'), 'utf8'))
    assert.deepEqual(written, {
      mode: 'full',
      rules: 'business',
      allowlist: ['dispatch/'],
    }, '0.17.0: a project without dsh.bundle/client gets the business preset and no gate fields')
    assert.match(result.text, /preset: business/)

    // 检测到的文件必须能被 readProjectPolicy 原样读回（字段形状合法）。
    const policy = readProjectPolicy(cwd, resolveConfig({}).projectSwitch)
    assert.deepEqual(policy, { mode: 'full', rules: 'business', allowlist: ['dispatch/'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.15.0: switching mode preserves the other policy fields', () => {
  // §2.3 新条款（关键回归）：文件里先有策略 → `/dispatch off` → 只有 mode 变。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-policy-switch-'))
  try {
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeProjectMarker(cwd, JSON.stringify({
      mode: 'full',
      rules: 'business',
      allowlist: ['dispatch/', 'docs/design/'],
      verify: { commands: ['pnpm test'] },
      custom: { keep: true },
    }))

    const h = harness()
    plugin.apply(h.ctx, quiet)
    const agent = h.main('agent-switch', [], {}, 'session-switch', cwd)
    const result = runCommand(h, 'off', agent)

    assert.deepEqual(result, { kind: 'success', text: '已切换为 off（dispatch/protocol.json）' })
    const written = JSON.parse(readFileSync(join(cwd, 'dispatch', 'protocol.json'), 'utf8'))
    assert.deepEqual(written, {
      mode: 'off',
      rules: 'business',
      allowlist: ['dispatch/', 'docs/design/'],
      verify: { commands: ['pnpm test'] },
      custom: { keep: true },
    }, 'only the mode changes; every other policy field survives')
    assert.equal(readProjectPolicy(cwd, resolveConfig({}).projectSwitch).rules, 'business',
      'the reader still finds the preserved preset')

    // 文件缺失 / 坏 JSON 仍是 0.14 行为：只写 {"mode":"…"}。
    const bare = join(dir, 'bare')
    mkdirSync(bare, { recursive: true })
    runCommand(h, 'shadow', h.main('agent-switch-bare', [], {}, 'session-switch-bare', bare))
    assert.equal(readFileSync(join(bare, 'dispatch', 'protocol.json'), 'utf8'), '{"mode":"shadow"}\n')

    const broken = join(dir, 'broken')
    mkdirSync(broken, { recursive: true })
    writeProjectMarker(broken, '{oops')
    runCommand(h, 'full', h.main('agent-switch-broken', [], {}, 'session-switch-broken', broken))
    assert.equal(readFileSync(join(broken, 'dispatch', 'protocol.json'), 'utf8'), '{"mode":"full"}\n',
      'a broken file still gets the 0.14 single-field rewrite')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.15.0: the unknown-argument error mentions init so the subcommand is discoverable', () => {
  // §2.5 第 4 条：hint 与用法串都加了 init，未知参数的报错必须跟着带上它，
  // 否则 `/dispatch init` 只能靠翻代码或 spec 才知道。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-usage-init-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, quiet)
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })

    const result = runCommand(h, 'loud', h.main('agent-usage', [], {}, 'session-usage', cwd))

    assert.equal(result.kind, 'error')
    assert.match(result.text, /init/, 'the usage error advertises the init subcommand')
    assert.match(result.text, /\/dispatch \[off\|auto\|shadow\|full\|init\]/)
    assert.equal(existsSync(join(cwd, 'dispatch')), false, 'an unknown argument still writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ---------------------------------------------------------------------------
// 0.16.0 — auto 默认档 + dispatch_upgrade_full（spec
// `2026-11-18-dispatch-auto-mode-design.md` §2.1-§2.5）

test('0.16.0: a project with no marker defaults to auto and does not enforce', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-auto-default-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    const root = h.main('session-auto-default', [], {}, 'session-auto-default', cwd)

    assert.equal(readProjectMode(cwd, resolveConfig({}).projectSwitch), 'auto',
      'no marker file means auto')
    assert.equal(h.guard({ agent: root, name: 'write', arguments: { file_path: 'src/x.ts' } }), undefined,
      'auto never blocks a root write')
    assert.equal(existsSync(log), false, 'auto writes no decision line')

    const section = h.rawSections[0]
    assert.equal(section.text({ agent: { session: { cwd } } }), AUTO_TEXT,
      'the auto prompt is the frozen escalation hint')
    assert.match(AUTO_TEXT, /dispatch_upgrade_full/, 'the hint names the upgrade tool')
    assert.match(AUTO_TEXT, /每需求最多问一次/, 'the hint bounds the asking')
    assert.match(AUTO_TEXT, /四件事上真正改变结果/, 'the hint explains what full actually buys')
    assert.match(AUTO_TEXT, /执行面一律派发/, 'the hint discloses the control/execution split')
    assert.match(AUTO_TEXT, /会不会从上面四件事中的至少一件显著受益/,
      'the model judges by benefit, not by a file-count checklist')
    assert.doesNotMatch(AUTO_TEXT, /≥2 个文件|≥3 个文件/,
      'no hard file-count trigger: a two-file small change must not ask')

    assert.equal(h.registered.length, 1, 'the upgrade tool is registered')
    const { definition, options } = h.registered[0]
    assert.equal(definition.name, 'dispatch_upgrade_full')
    assert.equal(options.when({ agent: root }), true, 'visible to the root agent in auto')
    assert.equal(options.when({ agent: h.child('child-auto-default', 'session-auto-default', '实现 A') }),
      false, 'never visible to a subagent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.16.0: auto silences the checkpoint and the observation rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-auto-silent-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, quiet)
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    const parent = h.main('parent-auto-silent', [
      call(1, 'list_agents', {}, 'poll-1'),
      call(1, 'list_agents', {}, 'poll-2'),
      call(1, 'list_agents', {}, 'poll-3'),
      call(1, 'list_agents', {}, 'poll-4'),
      call(1, 'list_agents', {}, 'poll-5'),
      call(1, 'list_agents', {}, 'poll-6'),
      call(2, 'edit', { file_path: 'a.ts' }, 'write-auto'),
    ], {}, 'session-auto-silent', cwd)
    h.created(parent)
    h.created(h.child('child-auto-silent', 'parent-auto-silent', '实现 A',
      [call(1, 'write', { file_path: 'a.ts' })]))
    h.ended({ childId: 'child-auto-silent', stopReason: 'completed' })
    h.turnStopping(parent, 1)
    h.turnStopping(parent, 2)

    assert.equal(parent.messages.length, 0, 'no checkpoint in auto')
    assert.equal(existsSync(join(cwd, 'dispatch', 'runs')), false,
      'auto writes no observation row and creates no runs directory')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.16.0: dispatch_upgrade_full is confirmed, auto-only and preserves policy fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-auto-upgrade-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeProjectMarker(cwd, JSON.stringify({ mode: 'auto', rules: 'business', allowlist: ['dispatch/', 'src/'] }))
    const root = h.main('session-upgrade', [], {}, 'session-upgrade', cwd)
    const { definition, options } = h.registered[0]

    await assert.rejects(definition.execute({ confirmed: false }, { agent: root }),
      /user confirmation is required/)
    await assert.rejects(definition.execute({ confirmed: true }, {}),
      /working directory/)

    const offCwd = join(dir, 'off')
    mkdirSync(offCwd, { recursive: true })
    writeProjectMarker(offCwd, '{"mode":"off"}')
    const offAgent = h.main('session-off', [], {}, 'session-off', offCwd)
    assert.equal(options.when({ agent: offAgent }), false)
    await assert.rejects(definition.execute({ confirmed: true }, { agent: offAgent }),
      /only auto can be upgraded/)

    const text = await definition.execute({ confirmed: true }, { agent: root })
    assert.match(text, /已切换为 full/)
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'dispatch', 'protocol.json'), 'utf8')),
      { mode: 'full', rules: 'business', allowlist: ['dispatch/', 'src/'] },
      'only the mode changes; policy fields survive')
    assert.equal(readProjectPolicy(cwd, resolveConfig({}).projectSwitch).mode, 'full')
    const row = readRows(log).find(entry => entry.kind === 'project' && entry.decision === 'switched')
    assert.ok(row, 'the switch is recorded')
    assert.equal(row.reason, 'user-confirmed')
    assert.equal(row.mode, 'full')
    assert.equal(options.when({ agent: root }), false, 'once full the tool disappears')

    const fullCwd = join(dir, 'full')
    mkdirSync(fullCwd, { recursive: true })
    writeProjectMarker(fullCwd, '{"mode":"full"}')
    const fullAgent = h.main('session-full', [], {}, 'session-full', fullCwd)
    assert.equal(await definition.execute({ confirmed: true }, { agent: fullAgent }),
      '已是 full，无需切换', 'a full project is idempotent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.16.0: client.js exposes auto and mirrors the locale key', () => {
  const previousWindow = globalThis.window
  let captured
  try {
    globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
    new Function(readFileSync(new URL('./client.js', import.meta.url), 'utf8'))()
    const exports = captured.factory((id) => {
      if (id === 'react') return { createElement: () => null }
      throw new Error(`client.js required an unexpected module: ${id}`)
    })

    assert.deepEqual(exports.pure.MODES, ['off', 'auto', 'shadow', 'full'])
    assert.equal(exports.pure.modeLabelKey('auto'), 'modeAuto')
    assert.equal(exports.pure.modeOfText(undefined), 'auto')
    assert.equal(exports.pure.modeOfText('{"enabled":true}'), 'full')
    assert.equal(exports.pure.modeOfText('{"enabled":false}'), 'off')

    const zh = JSON.parse(readFileSync(new URL('./locale/zh.json', import.meta.url), 'utf8'))
    const en = JSON.parse(readFileSync(new URL('./locale/en.json', import.meta.url), 'utf8'))
    assert.equal(zh.ui.modeAuto, '自动')
    assert.equal(en.ui.modeAuto, 'Auto')
    assert.equal(exports.dictionaries.zh.modeAuto, zh.ui.modeAuto,
      'the bundle dictionary mirrors locale/zh.json')
    assert.equal(exports.dictionaries.en.modeAuto, en.ui.modeAuto,
      'the bundle dictionary mirrors locale/en.json')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

// ---------------------------------------------------------------------------
// 0.19.0 — AUTO_TEXT 重框架（spec `2026-11-22-dispatch-auto-text-reframe.md`）

test('0.19.0: AUTO_TEXT uses a neutral frame and names positive escalation examples', () => {
  assert.doesNotMatch(AUTO_TEXT, /默认不启用派发纪律/,
    'the opening no longer frames the default as "discipline off"')
  assert.match(AUTO_TEXT, /当前项目处于自动档/,
    'the opening states the current mode neutrally')
  assert.match(AUTO_TEXT, /典型受益的情形/,
    'the hint carries a positive-example list, not only negative guidance')
  assert.match(AUTO_TEXT, /契约面（schema\/类型\/接口\/路由\/权限\/迁移）/,
    'example one: contract-surface changes with multiple callers')
  assert.match(AUTO_TEXT, /多个并行或先后批次/,
    'example two: multi-batch work needing independent review')
  assert.doesNotMatch(AUTO_TEXT, /哪怕文件不少/,
    'the strongest negative sentence of 0.16.0 is gone')
  assert.match(AUTO_TEXT, /dispatch_upgrade_full/, 'the hint still names the upgrade tool')
  assert.match(AUTO_TEXT, /每需求最多问一次/, 'the hint still bounds the asking')
})

// ---------------------------------------------------------------------------
// 0.20.0 — 请示的证据门槛（spec `2026-11-22-dispatch-auto-evidence-gate.md`）

test('0.20.0: AUTO_TEXT gates asking on evidence instead of mandating a survey flow', () => {
  assert.match(AUTO_TEXT, /请示只在你能说出具体受益点（哪个契约面、哪些调用方、几个批次）时提出/,
    'asking is legitimate only with a concrete benefit point')
  assert.match(AUTO_TEXT, /说不出就不要问，直接做/,
    'no evidence means do it directly')
  assert.doesNotMatch(AUTO_TEXT, /摸清波及面|先勘察|先.*读相关代码/,
    'no survey-flow wording: the prompt must not mandate a pipeline step')
  assert.doesNotMatch(AUTO_TEXT, /在收到需求时判断/,
    'the entry-timing phrase is gone; judgment is not pinned to intake')
  assert.match(AUTO_TEXT, /被拒后除非范围实质扩大，不再问/,
    'the permissive mid-task re-ask clause is retained verbatim')
  assert.match(AUTO_TEXT, /会不会从上面四件事中的至少一件显著受益/,
    'the benefit question survives the rewrite')
})

// ---------------------------------------------------------------------------
// 0.21.0 — 只读评审 preset（spec `2026-11-23-dispatch-readonly-preset-design.md`）：
// 机制面（cordis.patch.yml 两行 insert）与纪律文本面（规则 1/4、footer、business
// 规则 4）同版冻结。`AUTO_TEXT` 保持原样——auto 档不引用只有 full 档才会注入的
// 工具名，否则 auto 项目会看到一个不存在的工具。

test('0.21.0: cordis.patch.yml declares the readonly preset and its delegation tool', () => {
  // 结构断言全部走行级文本：仓库不引 YAML 依赖（与 verify-install.mjs 同口径）。
  const yml = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yml, /^\s*- id: preset-dispatch-readonly\s*$/m, 'the readonly preset is inserted')
  assert.match(yml, /^\s*- id: tool-subagent-readonly\s*$/m, 'the Host-global delegation tool is inserted')
  for (const line of [
    /^\s*provider: spawn\s*$/m,
    /^\s*toolName: subagent_readonly\s*$/m,
    /^\s*agentPreset: dispatch-readonly\s*$/m,
    /^\s*modelSelection: false\s*$/m,
    /^\s*write: false\s*$/m,
    /^\s*edit: false\s*$/m,
  ]) assert.match(yml, line)

  // 工具面强制：preset 块内不得出现 shell 工具；检索面只留只读的 grep/glob。
  const lines = yml.split(/\r?\n/)
  const start = lines.findIndex(line => /- id: preset-dispatch-readonly/.test(line))
  const end = lines.findIndex(line => /- id: tool-subagent-readonly/.test(line))
  assert.ok(start >= 0 && end > start, 'the preset block precedes the tool instance')
  const presetBlock = lines.slice(start, end).join('\n')
  assert.doesNotMatch(presetBlock, /tool-pwsh|tool-bash/,
    'the readonly preset carries no shell — build/test re-runs are impossible at the tool surface')
  assert.match(presetBlock, /tool-fs-search/, 'grep/glob stay available for read-only review')
  assert.doesNotMatch(presetBlock, /tool-fs[\s\S]*?read: false/,
    'read stays available: only write/edit are switched off')
})

test('0.21.0: review and recon are bound to subagent_readonly in the default text', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /勘察一律用 `subagent_readonly`/,
    'rule 1 dispatches recon through the read-only tool')
  assert.match(text, /一律用 `subagent_readonly` 派发；其组合无写工具与 shell/,
    'rule 4 names the tool and why the dispatcher must land the diff first')
  assert.match(text, /`subagent_readonly` 管工具面/,
    'the footer splits the label prefix (routing/sandbox) from the tool surface')
  assert.match(text, /只读 spike 要跑命令实测，不得用它，仍走普通 subagent/,
    'the spike exception stays on the normal subagent')
  assert.match(text, /label 仍以「勘察\/只读」开头/,
    'the label prefix still drives routing and the read-only sandbox')

  assert.match(BUSINESS_RULES[3], /评审一律用 `subagent_readonly` 派发/,
    'the business preset binds review to the tool as well')
  assert.match(BUSINESS_RULES[3], /diff 与集成输出由派发方落盘 `dispatch\/` 后交其读取/,
    'the business preset carries the dispatcher landing duty')
  assert.match(BUSINESS_RULES[0], /一律用 `subagent_readonly` 派发/,
    'the business preset binds recon to the tool as well')
  assert.doesNotMatch(AUTO_TEXT, /subagent_readonly/,
    'AUTO_TEXT names no full-only tool: auto injects no mechanism text')
})

test('0.21.0: the default text grew by a bounded amount', (t) => {
  // 0.20.0 实测基线：六条规则 3216 字符 + footer 615 字符。0.21.0 只改规则 1/4
  // 与 footer，预算全文增量 ≤200 字符；实测 197（规则 110 + footer 87）。区间
  // 上下界留出措辞微调余量，超出时把实际增量报进失败信息。
  const body = DEFAULT_RULES.reduce((sum, rule) => sum + rule.length, 0)
  const delta = (body - 3216) + (DEFAULT_FOOTER.length - 615)
  t.diagnostic(`DEFAULT_RULES ${body} 字符 / footer ${DEFAULT_FOOTER.length} 字符 / 0.21.0 增量 ${delta}`)
  assert.ok(delta >= 190 && delta <= 200,
    `0.21.0 text delta is ${delta} characters (0.20.0 baseline = 3216 body + 615 footer, budget <= 200)`)
  assert.equal(DEFAULT_RULES.length, 6, 'the binding lands inside existing rules, never a seventh clause')
})

// ---------------------------------------------------------------------------
function call(turn, name, args, id) {
  return { type: 'tool/call', data: { turn, step: 1, callId: id ?? `call-${turn}-${name}`, name, arguments: JSON.stringify(args ?? {}) } }
}

/** One committed `tool/result` record; `isError` marks a refused call. */
function result(turn, callId, isError) {
  return { type: 'tool/result', data: { turn, step: 1, message: { isError, toolCallId: callId, content: [] } } }
}

/** 0.13.0: write `<cwd>/dispatch/protocol.json` (the project-switch marker). */
function writeProjectMarker(cwd, body) {
  mkdirSync(join(cwd, 'dispatch'), { recursive: true })
  writeFileSync(join(cwd, 'dispatch', 'protocol.json'), body)
}

/**
 * 0.16.0: opt a fixture cwd into the full discipline. Since 0.16.0 a cwd with no
 * marker resolves to `auto`, so every case that asserts full-mode guard or
 * observation behaviour must say so explicitly.
 * @param cwd - the fixture working directory.
 * @returns the same cwd, for use inline in `h.main(...)`.
 */
function fullProject(cwd) {
  writeProjectMarker(cwd, '{"mode":"full"}')
  return cwd
}

/** Read a decision log as parsed rows. */
function readRows(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
}

/** One committed `assistant/message` record: the model's prose for a step. */
function assistantMessage(turn, text) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    },
  }
}

/** One `agent/inbox/spliced` record: a child report delivered into the parent. */
function splice(childId, target = 'next-step') {
  return {
    type: 'agent/inbox/spliced',
    data: { target, inserted: [{ role: 'user', content: [{ type: 'text', text: `Agent ${childId} sent a message: 完成` }] }] },
  }
}

/**
 * One `user/message` settle notice (D1): the runtime-owned report a parent sees
 * when a child settles. Closing-message children produce this and no splice.
 */
function settleNotice(childId) {
  const source = {
    kind: 'subagent-settled', form: 'notice', summary: '子代理已完成', stopReason: 'completed', senderSessionId: childId,
  }
  return {
    type: 'user/message',
    data: {
      message: { role: 'user', content: [{ type: 'text', text: '子代理已完成' }] },
      source,
    },
  }
}

/**
 * 0.14.0: invoke the registered `/dispatch` command's handler.
 * @param h - the harness that applied the plugin.
 * @param rawInput - the raw argument string the host passes to the handler.
 * @param agent - the agent scope the command runs in (may be undefined).
 * @returns the handler result `{ kind, text }`.
 */
function runCommand(h, rawInput, agent) {
  const definition = h.commands[0]
  assert.equal(definition?.name, 'dispatch', 'the /dispatch command must be registered')
  return definition.handler({ agent, rawInput })
}

/** Build a fake host context: prompt registry, tools guard, agents registry, event bus. */
function harness(options = {}) {
  const sections = []
  /** 0.13.0: the registered sections as-is (`text` may be a function). */
  const rawSections = []
  /** Registered `ctx.tools.guard(fn)` functions, in registration order. */
  const guards = []
  /** 0.16.0: `ctx.tools.register(definition, options)` records, in order. */
  const registered = []
  /** 0.14.0: definitions registered through `ctx.inject(['commands'], …)`. */
  const commands = []
  const events = new Map()
  const agents = new Map()
  const agentHooks = new Map()

  const ctx = {
    systemPrompt: {
      section(section) {
        rawSections.push(section)
        // 0.13.0: project switch turns `text` into `(context) => string`. The
        // default context has no session cwd, so the section evaluates to
        // `config.text` — every pre-0.13.0 `h.sections[i].text` assertion keeps
        // reading a string. New cases call `h.rawSections[i].text({ agent })`.
        sections.push({
          ...section,
          text: typeof section.text === 'function' ? section.text({}) : section.text,
        })
        return () => {}
      },
    },
    // 0.9.0 write guard: `guard(fn)` is sync and returns a disposer.
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
      // 0.16.0 conditional tool registration; the harness records the definition
      // and its `when` so tests can drive visibility and execute directly.
      register(definition, options = {}) {
        registered.push({ definition, options })
        return () => {}
      },
    },
    agents: { get: id => agents.get(id) },
    on(name, listener) {
      const list = events.get(name) ?? []
      list.push(listener)
      events.set(name, list)
      return () => {}
    },
    effect(run) {
      return run()
    },
  }

  // 0.14.0 optional-service injection: the plugin registers `/dispatch` through
  // `ctx.inject(['commands'], …)`. The default harness exposes it and calls back
  // with a child context whose `commands.register` records the definition. Two
  // host shapes are testable: `inject: false` (no inject at all) and
  // `injectCallsBack: false` (service missing, so the callback never runs).
  if (options.inject !== false) {
    ctx.inject = (services, callback) => {
      if (options.injectCallsBack === false) return undefined
      return callback({
        commands: {
          register(definition) {
            commands.push(definition)
            return () => {}
          },
        },
        effect(run) {
          return run()
        },
      })
    }
  }

  /** Record one delivered message, flattening content blocks to `text`. */
  const record = (messages) => (message) => {
    const text = typeof message?.text === 'string'
      ? message.text
      : (message?.content ?? []).map(block => block?.text ?? '').join('')
    messages.push({ ...message, text })
  }

  return {
    ctx,
    sections,
    rawSections,
    guards,
    /** 0.16.0: conditional tool registrations `{ definition, options }`. */
    registered,
    /** 0.14.0: definitions registered through the optional `commands` service. */
    commands,
    /**
     * Replay one tool call through every registered guard. The host rejects a
     * call on the first non-empty string; `undefined` means the call proceeds.
     * @param exec - `{ agent?, name?, arguments? }`.
     * @returns the rejection text, or undefined.
     */
    guard(exec) {
      for (const fn of guards) {
        const verdict = fn(exec)
        if (typeof verdict === 'string' && verdict !== '') return verdict
      }
      return undefined
    },
    parent(id) {
      const messages = []
      const agent = { id, messages, followup: record(messages), steer: record(messages) }
      agents.set(id, agent)
      return agent
    },
    child(id, parentId, label, sessionEvents = []) {
      return {
        id,
        session: {
          header: { origin: 'subagent', parentSession: parentId, delegationDepth: 1 },
          snapshotEvents: () => [{ type: 'subagent/descriptor', data: { label } }, ...sessionEvents],
        },
      }
    },
    /**
     * A live top-level agent with its own hook scope and session log.
     * `sessionId` defaults to `id`; pass a distinct value to model a host where
     * the agent handle and the session it belongs to are not the same string.
     * `cwd` feeds the observation rows and the write-policy path judgement
     * (absent = observation skips and the guard cannot resolve control-plane
     * prefixes); `createdAt` is the session start the override freshness check
     * compares against, defaulting to now.
     */
    main(id, sessionEvents = [], header = {}, sessionId = id, cwd, createdAt = Date.now()) {
      const messages = []
      const hooks = new Map()
      const agent = {
        id,
        messages,
        session: {
          id: sessionId,
          cwd,
          createdAt,
          header: { origin: header.origin, parentSession: header.parentSession, delegationDepth: header.origin === 'subagent' ? 1 : 0 },
          snapshotEvents: () => sessionEvents,
        },
        ctx: {
          on(name, listener) {
            const list = hooks.get(name) ?? []
            list.push(listener)
            hooks.set(name, list)
            return () => {}
          },
          effect(run) {
            return run()
          },
        },
        steer: record(messages),
        inject: record(messages),
        followup: record(messages),
      }
      agentHooks.set(agent, hooks)
      agents.set(sessionId, agent)
      return agent
    },
    created(agent) {
      for (const listener of events.get('agent/created') ?? []) listener({ agent })
    },
    ended(info) {
      for (const listener of events.get('subagent/end') ?? []) listener(info)
    },
    /** Fire the agent-scoped `agent/turn-stopping` hook for one turn. */
    turnStopping(agent, turn) {
      for (const listener of agentHooks.get(agent)?.get('agent/turn-stopping') ?? []) {
        listener({ agent, turn, signal: new AbortController().signal })
      }
    },
  }
}
