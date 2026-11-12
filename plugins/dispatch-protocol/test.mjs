// Offline regression for the dispatch-protocol plugin — no DSH process, no dependencies.
//
//   node test.mjs
//
// The harness fakes the extension points the plugin uses:
//   - `ctx.systemPrompt.section(section)` (the system-prompt registry)
//   - `ctx.tools.guard(fn)` (0.9.0 write guard; `h.guard(exec)` replays a call)
//   - `agent/created` / `subagent/end` (root event bus)
//   - `agent.ctx.on('agent/turn-stopping')` + `agent.steer` (checkpoint and gates)
//   - `session.snapshotEvents()` (committed `tool/call` records)
//   - `session.cwd` / `session.createdAt` (write-policy path and freshness)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from './plugin.mjs'
import { resolveConfig, DEFAULT_RULES } from './lib/config.mjs'
import {
  ARTIFACT, callTouchesFile, classifyPath, DEFAULT_CONTROL_PLANE_PATTERNS, DEFAULT_PWSH_MUTATION_PATTERN,
  DEFAULT_PWSH_SHELL_PATTERN, summarizeTurn,
} from './lib/tool-calls.mjs'
import {
  DEFAULT_ALLOWLIST, DEFAULT_OVERRIDE_PATH, DEFAULT_WRITE_POLICY_MODE, resolveWritePolicy,
} from './lib/write-policy.mjs'
import {
  analyzeVerification, DEFAULT_DOC_PATTERNS, evaluateReviewGate, evaluateVerifyGate, isRestoreCommand,
  matchesVerifyCommand, renderGateText, renderReviewGate, renderVerifyGate, resolveGates,
} from './lib/gates.mjs'

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
  assert.match(text, /勘察批一律只读/, 'the first batch is a read-only survey')
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

test('a child that kept writing after the report is still reminded', () => {
  const h = harness()
  plugin.apply(h.ctx, quiet)

  const parent = h.main('parent-3', [splice('child-11'), call(1, 'read', { file_path: 'a.ts' })])
  const child = h.child('child-11', 'parent-3', '实现 Task 11', [
    call(1, 'send_message', { agent_id: 'parent-3' }),
    call(1, 'write', { file_path: 'a.ts' }),
  ])
  h.created(child)

  h.ended({ childId: 'child-11', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 1, 'a report followed by writes is not a settled child')
})

test('a read-only survey child does not trigger a checkpoint', () => {
  const h = harness()
  // 0.7.0 HandoffGate 默认开启；本用例的父回合没有工具/正文，只验证 checkpoint
  // 对只读子代理的跳过，因此隔离新闸门，断言保持 0.3.3 原样。
  plugin.apply(h.ctx, { ...quiet, gates: { handoff: { enabled: false } } })

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
  plugin.apply(h.ctx, { ...quiet, gates: { handoff: { enabled: false } } })

  const parent = h.main('parent-5', [splice('child-13')])
  h.created(h.child('child-13', 'parent-5', '零工具子代理'))

  h.ended({ childId: 'child-13', stopReason: 'completed' })
  assert.equal(parent.messages.length, 0, 'settling only registers the checkpoint')

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 0)
})

test('a skipped read-only child stays deduplicated across repeated settlement events', () => {
  const h = harness()
  plugin.apply(h.ctx, { ...quiet, gates: { handoff: { enabled: false } } })

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
  plugin.apply(h.ctx, { ...quiet, gates: { handoff: { enabled: false } } })

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
// 0.4.0 — one checkpoint message per wave, one decision line per child

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
    ], {}, 'session-59', dir)
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

    const parent = h.main('parent-60', [call(1, 'edit', { file_path: 'a.ts' })], {}, 'session-60', dir)
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
    ], {}, 'session-63', dir)
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
    ], {}, 'session-64', dir)
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
// 0.6.0 — 状态闸门：WaitGate + VerifyGate（契约 §7）

test('session-92f462d1 replay: six status polls with no write, dispatch or verify earn one wait gate', () => {
  // 92f462d1 的轮询形态：一回合 66 次状态查询，子代理状态没变，主控却为每次
  // 查询付了一整步模型步进。这里用 6 次 list_agents 复现最小形状。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-wait-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })

    const parent = h.main('session-92f462d1', [
      call(1, 'list_agents', {}, 'poll-1'),
      call(1, 'list_agents', {}, 'poll-2'),
      call(1, 'list_agents', {}, 'poll-3'),
      call(1, 'list_agents', {}, 'poll-4'),
      call(1, 'list_agents', {}, 'poll-5'),
      call(1, 'list_agents', {}, 'poll-6'),
    ])
    h.created(parent)
    h.turnStopping(parent, 1)
    h.turnStopping(parent, 1) // steer 后同回合再收尾一次，闸门仍只发一条

    assert.equal(parent.messages.length, 1, 'one gate message per turn')
    assert.match(parent.messages[0].text, /本回合 6 次状态查询/)
    assert.match(parent.messages[0].text, /list_agents/)
    assert.match(parent.messages[0].text, /结束回合等完成事件/)

    const rows = readRows(log).filter(row => row.kind === 'gate')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].gate, 'wait')
    assert.equal(rows[0].decision, 'delivered')
    assert.equal(rows[0].observations, 6)
    assert.equal(rows[0].turn, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a writing turn is not a waiting turn: six polls plus one write stay silent', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('session-gate-write', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
    call(1, 'list_agents', {}, 'poll-4'),
    call(1, 'list_agents', {}, 'poll-5'),
    call(1, 'list_agents', {}, 'poll-6'),
    call(1, 'write', { file_path: 'a.ts' }, 'write-1'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0, 'a turn that wrote produced evidence and is not polling')
})

test('status polls below the threshold stay silent', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('session-gate-below', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'job_list', {}, 'poll-2'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0)
})

test('session-92f462d1 replay: a write after the last successful verification and before present earns one verify gate', () => {
  // 92f462d1 的收口形态：最后一次集成命令（事件 1112）之后 diff 又被写入，
  // 主控却已经准备 present。验证状态来自整个 session 的事件序，不看单回合。
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-verify-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })

    const parent = h.main('session-92f462d1-verify', [
      call(1, 'pwsh', { command: 'npm test' }, 'verify-1'),
      resultWithText(1, 'verify-1', 'Tests 79 passed\nexit code: 0'),
      call(2, 'write', { file_path: 'gates.mjs' }, 'write-1'),
      result(2, 'write-1', false),
      call(2, 'present', { file_path: 'report.md' }, 'present-1'),
    ])
    h.created(parent)

    h.turnStopping(parent, 1)
    assert.equal(parent.messages.length, 0, 'the verification turn itself is not a closure')

    h.turnStopping(parent, 2)
    assert.equal(parent.messages.length, 1, 'the dirty closure turn earns exactly one gate')
    assert.match(parent.messages[0].text, /准备 present\/commit/)
    assert.match(parent.messages[0].text, /先跑一次集成命令并留存退出码/)

    const rows = readRows(log).filter(row => row.kind === 'gate')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].gate, 'verify')
    assert.equal(rows[0].decision, 'delivered')
    assert.equal(rows[0].changes, 1)
    assert.equal(rows[0].lastVerify, 'npm test')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a verification that is the last write keeps present silent', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('session-gate-clean', [
    call(1, 'write', { file_path: 'a.ts' }, 'write-1'),
    call(2, 'pwsh', { command: 'npm test' }, 'verify-1'),
    resultWithText(2, 'verify-1', 'exit code: 0'),
    call(3, 'present', { file_path: 'report.md' }, 'present-1'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)
  h.turnStopping(parent, 2)
  h.turnStopping(parent, 3)

  assert.equal(parent.messages.length, 0, 'the diff is clean after the last successful verification')
})

test('present with no successful verification ever earns the verify gate', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  // 契约 §11-A：必须至少有一次写入，否则纯只读 present 不算「有 diff 可验」。
  const parent = h.main('session-gate-never', [
    call(1, 'write', { file_path: 'a.ts' }, 'write-1'),
    result(1, 'write-1', false),
    call(1, 'present', { file_path: 'report.md' }, 'present-1'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 1)
  assert.match(parent.messages[0].text, /（或从未跑过）/)
})

test('a read-only present with no writes is not gated', () => {
  // 契约 §11-A：present 一份报告/计划、整会话零写入时没有 diff 可验，
  // 提醒只会让模型为空命令多花一步。
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('session-gate-read-only-present', [
    call(1, 'present', { file_path: 'report.md' }, 'present-1'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0)
})

test('a failed verification does not count, so a later write plus present is gated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-failed-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })

    const parent = h.main('session-gate-failed', [
      call(1, 'pwsh', { command: 'npm test' }, 'verify-1'),
      resultWithText(1, 'verify-1', '1 failing\nexit code: 1'),
      call(2, 'write', { file_path: 'a.ts' }, 'write-1'),
      call(2, 'present', { file_path: 'report.md' }, 'present-1'),
    ])
    h.created(parent)
    h.turnStopping(parent, 1)
    h.turnStopping(parent, 2)

    assert.equal(parent.messages.length, 1, 'a red verification is not a verification')
    const verifyRow = readRows(log).find(row => row.kind === 'gate')
    assert.equal(verifyRow.lastVerify, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a git commit with no successful verification earns the verify gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-commit-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })

    const parent = h.main('session-gate-commit', [
      call(1, 'write', { file_path: 'a.ts' }, 'write-1'),
      result(1, 'write-1', false),
      call(2, 'pwsh', { command: 'git commit -m "收口"' }, 'commit-1'),
      result(2, 'commit-1', false),
    ])
    h.created(parent)
    h.turnStopping(parent, 1)
    h.turnStopping(parent, 2)

    assert.equal(parent.messages.length, 1, 'commit is a closure action too')
    assert.match(parent.messages[0].text, /准备 present\/commit/)
    const verifyRow = readRows(log).find(row => row.kind === 'gate')
    assert.equal(verifyRow.gate, 'verify')
    assert.equal(verifyRow.lastVerify, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gates can be disabled wholesale, and wait can be disabled alone', () => {
  const off = harness()
  plugin.apply(off.ctx, { log: false, gates: { enabled: false } })
  const quietParent = off.main('session-gate-off', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
  ])
  off.created(quietParent)
  off.turnStopping(quietParent, 1)
  assert.equal(quietParent.messages.length, 0, 'gates.enabled:false silences both gates')

  const waitOff = harness()
  plugin.apply(waitOff.ctx, { log: false, gates: { wait: { enabled: false } } })
  const parent = waitOff.main('session-gate-wait-off', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
    // 契约 §11-A 之后纯只读 present 不再触发 verify，这里补一次写入让
    // 「只关 wait、verify 仍开」的断言继续成立。
    call(2, 'write', { file_path: 'a.ts' }, 'write-1'),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ])
  waitOff.created(parent)
  waitOff.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 0, 'gates.wait.enabled:false leaves the wait turn alone')
  waitOff.turnStopping(parent, 2)
  assert.equal(parent.messages.length, 1, 'the verify gate is still on')
  assert.match(parent.messages[0].text, /准备 present\/commit/)
})

test('a delivered checkpoint keeps the same turn to itself, so no gate fires', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('parent-gate-checkpoint', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
  ])
  h.created(parent)
  h.created(h.child('child-gate-checkpoint', 'parent-gate-checkpoint', '实现 Task', [
    call(1, 'write', { file_path: 'a.ts' }),
  ]))
  h.ended({ childId: 'child-gate-checkpoint', stopReason: 'completed' })
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 1)
  assert.match(parent.messages[0].text, /已完成/)
  assert.doesNotMatch(parent.messages[0].text, /状态查询/, 'checkpoint owns the turn, the gate yields')
})

test('gates config rejects values that would silently never fire', () => {
  assert.throws(() => resolveConfig({ gates: { wait: { threshold: 0 } } }), /gates\.wait\.threshold/)
  assert.throws(() => resolveConfig({ gates: { wait: { tools: [] } } }), /gates\.wait\.tools/)
  assert.throws(() => resolveConfig({ gates: { verify: { commands: [] } } }), /gates\.verify\.commands/)
  assert.throws(() => resolveConfig({ gates: { verify: { commitPattern: '(' } } }), /gates\.verify\.commitPattern/)
  assert.throws(() => resolveConfig({ gates: { wait: { text: '' } } }), /gates\.wait\.text/)
  assert.throws(() => resolveConfig({ gates: { verify: { text: '' } } }), /gates\.verify\.text/)
  assert.throws(() => resolveConfig({ gates: 42 }), /dispatch-protocol: gates/)

  const gates = resolveConfig({}).gates
  assert.equal(gates.enabled, true)
  assert.equal(gates.wait.threshold, 3)
  assert.deepEqual(gates.wait.tools, ['list_agents', 'job_list', 'schedule_list', 'get_goal'])
  assert.deepEqual(gates.verify.commands,
    ['npm test', 'npm run build', 'dotnet test', 'jest', 'tsc', 'prisma migrate deploy', 'node test', 'test.mjs'])
  assert.equal(gates.verify.commitRegExp.test('git -C "G:\\repo" commit -m x'), true)
  assert.equal(gates.verify.commitRegExp.test('git status --short'), false)
})

test('verify commands recognise node <path>/test.mjs invocations', () => {
  const commands = resolveConfig({}).gates.verify.commands

  // 仓库根带路径、`& $node` 变量拼装、无路径三种写法都算跑过集成命令。
  for (const command of [
    'node test.mjs',
    'node plugins/dispatch-protocol/test.mjs',
    '& $node plugins/x/test.mjs',
  ]) {
    assert.equal(matchesVerifyCommand(command, commands), true, command)
  }

  // 反例：窄跑一个 spec 文件不该被新增的 `test.mjs` 片段误命中。注意整表仍会命中，
  // 因为既有的 `node test` 片段本就覆盖 `node tests/...`（旧口径，本次不动）。
  assert.equal(matchesVerifyCommand('node tests/foo.spec.ts', commands.filter(f => f === 'test.mjs')), false)
  // 整表反例：普通脚本不是集成命令。
  assert.equal(matchesVerifyCommand('node scripts/seed.ts', commands), false)
})

test('gates only judge root-agent turns', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  // 子代理自己的写操作已经记在父回合里，且它不能再派发/提交；若闸门对子代理
  // 生效，只会重复父回合的提醒（契约 §5）。
  const child = h.main('session-gate-child', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ], { origin: 'subagent', parentSession: 'parent-gate-root' })
  h.created(child)

  h.turnStopping(child, 1)
  h.turnStopping(child, 2)
  assert.equal(child.messages.length, 0)
})

// ---------------------------------------------------------------------------
// 0.6.0 amendment（契约 §11-E）：边界、让位与去重

test('exactly threshold status polls already trigger the wait gate', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('session-gate-boundary', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 1, 'threshold is inclusive')
  assert.match(parent.messages[0].text, /本回合 3 次状态查询/)
})

test('a delivered gate owns the turn, so a write turn gets one reminder', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('session-gate-yield', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
    call(1, 'write', { file_path: 'a.ts' }, 'write-1'),
    call(1, 'write', { file_path: 'b.ts' }, 'write-2'),
    call(1, 'present', { file_path: 'report.md' }, 'present-1'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 1, 'the gate owns the turn')
  assert.match(parent.messages[0].text, /准备 present\/commit/)
})

test('send_message and dispatch calls are not waiting', () => {
  const withMessage = harness()
  plugin.apply(withMessage.ctx, { log: false })
  const messageParent = withMessage.main('session-gate-send-message', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
    call(1, 'list_agents', {}, 'poll-4'),
    call(1, 'list_agents', {}, 'poll-5'),
    call(1, 'list_agents', {}, 'poll-6'),
    call(1, 'send_message', { agent_id: 'child-1' }, 'send-1'),
  ])
  withMessage.created(messageParent)
  withMessage.turnStopping(messageParent, 1)
  assert.equal(messageParent.messages.length, 0, 'a delivered message is an action')

  const withDispatch = harness()
  plugin.apply(withDispatch.ctx, { log: false })
  const dispatchParent = withDispatch.main('session-gate-dispatch', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
    call(1, 'list_agents', {}, 'poll-4'),
    call(1, 'list_agents', {}, 'poll-5'),
    call(1, 'list_agents', {}, 'poll-6'),
    call(1, 'subagent', { description: '实现 X' }, 'dispatch-1'),
  ])
  withDispatch.created(dispatchParent)
  withDispatch.turnStopping(dispatchParent, 1)
  assert.equal(dispatchParent.messages.length, 0, 'a dispatch is an action')
})

test('gates validation still runs when the gates are disabled', () => {
  assert.throws(() => resolveConfig({ gates: { enabled: false, wait: { threshold: 0 } } }),
    /gates\.wait\.threshold/, 'a typo must fail at load time even when disabled')
})

test('wait gate deduplicates tool names and joins them with commas', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('session-gate-dedupe', [
    call(1, 'list_agents', {}, 'poll-1'),
    call(1, 'list_agents', {}, 'poll-2'),
    call(1, 'list_agents', {}, 'poll-3'),
    call(1, 'job_list', {}, 'poll-4'),
    call(1, 'job_list', {}, 'poll-5'),
    call(1, 'job_list', {}, 'poll-6'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 1)
  assert.match(parent.messages[0].text, /（list_agents, job_list）/)
})

// ---------------------------------------------------------------------------
// 0.7.0 — ContractGate / ReviewGate / HandoffGate（契约 §8）

test('contract gate fires when a contract file is written while a child is active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-contract-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log, checkpoint: { enabled: false } })

    const parent = h.main('session-contract-active', [
      call(1, 'write', { file_path: 'tmp/fix-contract.md' }, 'write-1'),
    ])
    h.created(parent)
    h.created(h.child('child-contract-active', 'session-contract-active', '实现 A'))
    h.turnStopping(parent, 1)

    assert.equal(parent.messages.length, 1)
    assert.match(parent.messages[0].text, /契约文件/)
    assert.match(parent.messages[0].text, /tmp\/fix-contract\.md/)
    const row = readRows(log).find(entry => entry.kind === 'gate')
    assert.equal(row.gate, 'contract')
    assert.deepEqual(row.files, ['tmp/fix-contract.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('contract gate stays silent when no child is active', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false, checkpoint: { enabled: false } })

  const parent = h.main('session-contract-idle', [
    call(1, 'write', { file_path: 'fix-contract.md' }, 'write-1'),
  ])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0)
})

test('contract gate stays silent after the child has ended', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false, checkpoint: { enabled: false } })

  const parent = h.main('session-contract-ended', [
    call(1, 'write', { file_path: 'fix-contract.md' }, 'write-1'),
  ])
  h.created(parent)
  h.created(h.child('child-contract-ended', 'session-contract-ended', '实现 B'))
  h.ended({ childId: 'child-contract-ended', stopReason: 'completed' })
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0, 'the active set is judged at turn close')
})

test('contract gate ignores non-contract files', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false, checkpoint: { enabled: false } })

  const parent = h.main('session-contract-other', [
    call(1, 'write', { file_path: 'src/a.ts' }, 'write-1'),
  ])
  h.created(parent)
  h.created(h.child('child-contract-other', 'session-contract-other', '实现 C'))
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0)
})

test('contract gate stays silent when an active child exists but nothing was written', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false, checkpoint: { enabled: false } })

  const parent = h.main('session-contract-read', [
    call(1, 'read', { file_path: 'fix-contract.md' }, 'read-1'),
  ])
  h.created(parent)
  h.created(h.child('child-contract-read', 'session-contract-read', '实现 D'))
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0)
})

test('review gate fires when the parent writes after a completed read-only review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-review-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const events = []
    const h = harness()
    plugin.apply(h.ctx, {
      log, checkpoint: { enabled: false }, gates: { handoff: { enabled: false } },
    })

    const parent = h.main('session-review-write', events)
    h.created(parent)
    h.created(h.child('review-1', 'session-review-write', '只读评审：diff'))
    h.ended({ childId: 'review-1', stopReason: 'completed' })
    events.push(
      call(2, 'write', { file_path: 'src/a.ts' }, 'write-1'),
      result(2, 'write-1', false),
    )
    h.turnStopping(parent, 2)

    assert.equal(parent.messages.length, 1)
    assert.match(parent.messages[0].text, /只读评审之后又改动了工作区/)
    assert.match(parent.messages[0].text, /src\/a\.ts/)
    const row = readRows(log).find(entry => entry.kind === 'gate')
    assert.equal(row.gate, 'review')
    assert.deepEqual(row.files, ['src/a.ts'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('review gate warns only once in the same review round', () => {
  const events = []
  const h = harness()
  plugin.apply(h.ctx, {
    log: false, checkpoint: { enabled: false }, gates: { handoff: { enabled: false } },
  })

  const parent = h.main('session-review-once', events)
  h.created(parent)
  h.created(h.child('review-2', 'session-review-once', '只读评审：diff'))
  h.ended({ childId: 'review-2', stopReason: 'completed' })
  events.push(call(2, 'write', { file_path: 'src/a.ts' }, 'write-1'), result(2, 'write-1', false))
  h.turnStopping(parent, 2)
  assert.equal(parent.messages.length, 1)

  events.push(call(3, 'write', { file_path: 'src/b.ts' }, 'write-2'), result(3, 'write-2', false))
  h.turnStopping(parent, 3)
  assert.equal(parent.messages.length, 1, 'warned=true until a new review round starts')
})

test('review gate fires again after a new read-only review starts', () => {
  const events = []
  const h = harness()
  plugin.apply(h.ctx, {
    log: false, checkpoint: { enabled: false }, gates: { handoff: { enabled: false } },
  })

  const parent = h.main('session-review-rounds', events)
  h.created(parent)
  h.created(h.child('review-3', 'session-review-rounds', '只读评审：round 1'))
  h.ended({ childId: 'review-3', stopReason: 'completed' })
  events.push(call(2, 'write', { file_path: 'src/a.ts' }, 'write-1'), result(2, 'write-1', false))
  h.turnStopping(parent, 2)
  assert.equal(parent.messages.length, 1)

  h.created(h.child('review-4', 'session-review-rounds', '只读评审：round 2'))
  h.ended({ childId: 'review-4', stopReason: 'completed' })
  events.push(call(4, 'write', { file_path: 'src/c.ts' }, 'write-2'), result(4, 'write-2', false))
  h.turnStopping(parent, 4)
  assert.equal(parent.messages.length, 2, 'a new review round resets warned')
  assert.match(parent.messages[1].text, /src\/c\.ts/)
})

test('non-review child completion does not arm the review gate', () => {
  const events = []
  const h = harness()
  plugin.apply(h.ctx, {
    log: false, checkpoint: { enabled: false }, gates: { handoff: { enabled: false } },
  })

  const parent = h.main('session-review-impl', events)
  h.created(parent)
  h.created(h.child('impl-1', 'session-review-impl', '实现 Task 1'))
  h.ended({ childId: 'impl-1', stopReason: 'completed' })
  events.push(call(2, 'write', { file_path: 'src/a.ts' }, 'write-1'), result(2, 'write-1', false))
  h.turnStopping(parent, 2)

  assert.equal(parent.messages.length, 0)
})

test('review gate stays silent when nothing was written after the review', () => {
  const h = harness()
  plugin.apply(h.ctx, {
    log: false, checkpoint: { enabled: false }, gates: { handoff: { enabled: false } },
  })

  const parent = h.main('session-review-clean', [])
  h.created(parent)
  h.created(h.child('review-5', 'session-review-clean', '只读评审：diff'))
  h.ended({ childId: 'review-5', stopReason: 'completed' })
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0)
})

test('handoff gate fires on the first empty turn by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-handoff-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })

    const parent = h.main('session-handoff-default', [])
    h.created(parent)
    h.turnStopping(parent, 1)

    assert.equal(parent.messages.length, 1)
    assert.match(parent.messages[0].text, /没有任何产出/)
    assert.match(parent.messages[0].text, /dispatch\/state\/<需求>\.md/,
      '0.9.1: the handoff text names the per-requirement ledger')
    const row = readRows(log).find(entry => entry.kind === 'gate')
    assert.equal(row.gate, 'handoff')
    assert.equal(row.emptyTurns, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff gate ignores a turn that has text', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const parent = h.main('session-handoff-text', [assistantMessage(1, '正在处理，稍后汇报。')])
  h.created(parent)
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 0)
})

test('handoff gate with emptyTurns:2 waits for the second consecutive empty turn', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false, gates: { handoff: { emptyTurns: 2 } } })

  const parent = h.main('session-handoff-two', [])
  h.created(parent)

  h.turnStopping(parent, 1)
  assert.equal(parent.messages.length, 0, 'one empty turn is below the configured threshold')
  h.turnStopping(parent, 2)
  assert.equal(parent.messages.length, 1)
  assert.match(parent.messages[0].text, /没有任何产出/)
})

test('handoff gate never fires for a subagent turn', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false })

  const child = h.main('session-handoff-child', [], { origin: 'subagent', parentSession: 'parent-handoff' })
  h.created(child)
  h.turnStopping(child, 1)

  assert.equal(child.messages.length, 0)
})

test('new gate config rejects values that would silently never fire', () => {
  assert.throws(() => resolveConfig({ gates: { contract: { patterns: [] } } }), /gates\.contract\.patterns/)
  assert.throws(() => resolveConfig({ gates: { review: { labelPrefixes: [] } } }), /gates\.review\.labelPrefixes/)
  assert.throws(() => resolveConfig({ gates: { handoff: { emptyTurns: 0 } } }), /gates\.handoff\.emptyTurns/)
  assert.throws(() => resolveConfig({ gates: { contract: { text: '' } } }), /gates\.contract\.text/)
  assert.throws(() => resolveConfig({ gates: { review: { text: '' } } }), /gates\.review\.text/)
  assert.throws(() => resolveConfig({ gates: { handoff: { text: '' } } }), /gates\.handoff\.text/)
  assert.throws(() => resolveConfig({ gates: { contract: 42 } }), /gates\.contract must be an object/)
  assert.throws(() => resolveConfig({ gates: { review: [] } }), /gates\.review must be an object/)
  assert.throws(() => resolveConfig({ gates: { handoff: 'x' } }), /gates\.handoff must be an object/)
})

test('new gate defaults are the documented ones', () => {
  const gates = resolveConfig({}).gates
  assert.deepEqual(gates.contract.patterns, ['contract'])
  assert.deepEqual(gates.review.labelPrefixes, ['只读评审', '只读复审'])
  assert.equal(gates.handoff.emptyTurns, 1)
  assert.equal(gates.contract.enabled, true)
  assert.equal(gates.review.enabled, true)
  assert.equal(gates.handoff.enabled, true)
})

// ---------------------------------------------------------------------------
// 0.7.0 amendment（契约 §11-A/B/E）

test('a turn that already delivered a checkpoint cannot also deliver a gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-single-steer-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { log })

    const parent = h.main('session-single-steer', [
      call(1, 'write', { file_path: 'a.ts' }, 'write-1'),
    ])
    h.created(parent)
    h.created(h.child('child-single-steer', 'session-single-steer', '实现 Task', [
      call(1, 'write', { file_path: 'b.ts' }),
    ]))
    h.ended({ childId: 'child-single-steer', stopReason: 'completed' })

    h.turnStopping(parent, 1)
    assert.equal(parent.messages.length, 1)
    assert.match(parent.messages[0].text, /已完成/, 'close#1 delivers the checkpoint')

    // 同一回合追加 present：若不检查 lastDeliveredTurn，第二次收尾会再发 verify。
    parent.session.snapshotEvents().push(call(1, 'present', { file_path: 'report.md' }, 'present-1'))
    h.turnStopping(parent, 1)

    assert.equal(parent.messages.length, 1, 'one steer per turn, including across close#1/close#2')
    assert.equal(readRows(log).filter(row => row.kind === 'gate').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second completed review slice re-arms the gate with a new baseline', () => {
  const events = []
  const h = harness()
  plugin.apply(h.ctx, {
    log: false, checkpoint: { enabled: false }, gates: { handoff: { enabled: false } },
  })

  const parent = h.main('session-review-parallel', events)
  h.created(parent)
  h.created(h.child('review-a', 'session-review-parallel', '只读评审：A'))
  h.created(h.child('review-b', 'session-review-parallel', '只读评审：B'))

  h.ended({ childId: 'review-a', stopReason: 'completed' })
  events.push(call(2, 'write', { file_path: 'src/a.ts' }, 'write-1'), result(2, 'write-1', false))
  h.turnStopping(parent, 2)
  assert.equal(parent.messages.length, 1)

  // 第二个评审切片完成：基线推进到当前父事件长度，且 warned 被重置。
  h.ended({ childId: 'review-b', stopReason: 'completed' })
  events.push(call(3, 'write', { file_path: 'src/b.ts' }, 'write-2'), result(3, 'write-2', false))
  h.turnStopping(parent, 3)
  assert.equal(parent.messages.length, 2, 'a later completed review re-arms the warning')
  assert.match(parent.messages[1].text, /src\/b\.ts/)
  assert.doesNotMatch(parent.messages[1].text, /src\/a\.ts/, 'since advanced past the first slice write')
})

test('a duplicate settle of the same review child does not re-arm the gate', () => {
  const events = []
  const h = harness()
  plugin.apply(h.ctx, {
    log: false, checkpoint: { enabled: false }, gates: { handoff: { enabled: false } },
  })

  const parent = h.main('session-review-duplicate', events)
  h.created(parent)
  h.created(h.child('review-dup', 'session-review-duplicate', '只读评审：dup'))
  h.ended({ childId: 'review-dup', stopReason: 'completed' })
  events.push(call(2, 'write', { file_path: 'src/a.ts' }, 'write-1'), result(2, 'write-1', false))
  h.turnStopping(parent, 2)
  assert.equal(parent.messages.length, 1)

  // 同一 childId 的重复 settle 不应把 warned 重置成 false（契约 §12-B）。
  h.ended({ childId: 'review-dup', stopReason: 'completed' })
  events.push(call(3, 'write', { file_path: 'src/b.ts' }, 'write-2'), result(3, 'write-2', false))
  h.turnStopping(parent, 3)
  assert.equal(parent.messages.length, 1, 'a duplicate settle must not re-arm the warning')
})

test('writes before a review completes are not dirty', () => {
  const events = [
    call(1, 'write', { file_path: 'src/old.ts' }, 'write-1'),
    result(1, 'write-1', false),
  ]
  const h = harness()
  plugin.apply(h.ctx, {
    log: false,
    checkpoint: { enabled: false },
    gates: { verify: { enabled: false }, handoff: { enabled: false } },
  })

  const parent = h.main('session-review-before', events)
  h.created(parent)
  h.created(h.child('review-before', 'session-review-before', '只读评审：x'))
  h.ended({ childId: 'review-before', stopReason: 'completed' })
  events.push(call(2, 'present', { file_path: 'report.md' }, 'present-1'))
  h.turnStopping(parent, 2)

  assert.equal(parent.messages.length, 0, 'only writes after `since` count as review-dirty')
})

test('contract gate lists at most three files', () => {
  const h = harness()
  plugin.apply(h.ctx, { log: false, checkpoint: { enabled: false } })

  const parent = h.main('session-contract-three', [
    call(1, 'write', { file_path: 'fix-contract.md' }, 'write-1'),
    call(1, 'write', { file_path: 'a-contract-b.ts' }, 'write-2'),
    call(1, 'write', { file_path: 'contract-c.md' }, 'write-3'),
    call(1, 'write', { file_path: 'src/contracts.ts' }, 'write-4'),
  ])
  h.created(parent)
  h.created(h.child('child-contract-three', 'session-contract-three', '实现 E'))
  h.turnStopping(parent, 1)

  assert.equal(parent.messages.length, 1)
  assert.match(parent.messages[0].text, /fix-contract\.md, a-contract-b\.ts, contract-c\.md/)
  assert.doesNotMatch(parent.messages[0].text, /src\/contracts\.ts/, '{files} caps at three paths')
})

// ---------------------------------------------------------------------------
// 0.9.0 — 计数工具复用写入守卫口径（原 0.8.2 控制面豁免）

test('control-plane writes are not execution work in the shared counter', () => {
  const events = [
    call(1, 'write', { file_path: 'dispatch/ledger/x.md' }),
    call(1, 'write', { file_path: 'docs/superpowers/specs/y.md' }),
    call(1, 'write', { file_path: 'src/a.ts' }),
    call(1, 'edit', { file_path: 'src/b.ts' }, 'call-b'),
    result(1, 'call-b', true),
    call(1, 'subagent', { description: '实现 X' }),
  ]

  const summary = summarizeTurn(events, 1, {
    writeTools: ['write', 'edit'],
    delegationTools: ['subagent', 'subagent_fork', 'workflow'],
    controlPlanePatterns: DEFAULT_ALLOWLIST,
    cwd: 'G:\\repo',
  })
  assert.equal(summary.writes, 1, '0.9.0: the counter uses the write-policy allowlist')
  assert.deepEqual(summary.files, ['src/a.ts'], 'only the source file is execution work')
  assert.equal(summary.failedWrites, 1, 'a refused write is counted as failed, not as a write')
  assert.equal(summary.delegations, 1)

  const second = summarizeTurn([...events, call(1, 'write', { file_path: 'src/c.ts' })], 1, { cwd: 'G:\\repo' })
  assert.deepEqual(second.files, ['src/a.ts', 'src/c.ts'],
    'the default control-plane patterns still drop dispatch/ and spec files')
  assert.equal(second.writes, 2)

  // 0.11.0 D1-6：没有 cwd 时控制面判定失败，写入按执行工作计数（保守方向）。
  const noCwd = summarizeTurn(events, 1, {})
  assert.equal(noCwd.writes, 3, 'without cwd the control-plane writes count as execution work')

  const nullOptions = summarizeTurn([
    call(1, 'write', { file_path: 'src/a.ts' }),
    call(1, 'subagent', { description: '实现 X' }),
  ], 1, null)
  assert.equal(nullOptions.writes, 1, 'null options fall back to the defaults instead of throwing')
  assert.equal(nullOptions.delegations, 1)
})

test('a control-plane edit after a successful verification leaves the verify gate silent', () => {
  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const events = [
    call(1, 'pwsh', { command: 'npm test' }, 'verify-1'),
    resultWithText(1, 'verify-1', 'exit code: 0'),
    call(2, 'edit', { file_path: 'dispatch/ledger/x.md' }, 'edit-1'),
  ]

  assert.equal(evaluateVerifyGate(events, 2, gates, cwd), null,
    '0.8.2: a control-plane write is not a dirty working-tree change')

  // 0.9.1: 新台账目录（dispatch/state/<需求>.md）同样不计脏改动。
  events.push(call(2, 'edit', { file_path: 'dispatch/state/x.md' }, 'edit-state-dir'))
  events.push(call(2, 'present', { file_path: 'report.md' }, 'present-1'))
  assert.equal(evaluateVerifyGate(events, 2, gates, cwd), null,
    '0.9.1: writing dispatch/state/<需求>.md after the verification does not gate')

  const dirtyEvents = [
    ...events.slice(0, 4),
    call(2, 'edit', { file_path: 'src/a.ts' }, 'edit-2'),
    events[4],
  ]
  const dirty = evaluateVerifyGate(dirtyEvents, 2, gates, cwd)
  assert.notEqual(dirty, null, 'a source edit after the verification still gates')
  assert.equal(dirty.changes, 1)
  assert.equal(dirty.lastVerify, 'npm test')
})

test('a control-plane write after a review does not invalidate it', () => {
  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const state = { pending: true, warned: false, since: 0 }
  const events = [
    call(2, 'write', { file_path: 'dispatch/ledger/x.md' }, 'write-1'),
    call(2, 'write', { file_path: 'dispatch/state/x.md' }, 'write-2'),
    call(2, 'edit', { file_path: 'dispatch/state.md' }, 'write-3'),
  ]

  assert.equal(evaluateReviewGate(events, gates, state, cwd), null,
    '0.8.2/0.9.1: replaying a ledger file is a legal control-plane action')

  events.push(call(2, 'write', { file_path: 'src/a.ts' }, 'write-4'))
  const review = evaluateReviewGate(events, gates, state, cwd)
  assert.notEqual(review, null)
  assert.deepEqual(review.files, ['src/a.ts'], 'the ledger path is not listed as a review-dirty file')
})

test('controlPlanePatterns is configurable on the gate sections and validated', () => {
  const gates = resolveGates({ controlPlanePatterns: ['dispatch/notes/'] })
  assert.deepEqual(gates.controlPlanePatterns, ['dispatch/notes/'])
  assert.deepEqual(gates.verify.controlPlanePatterns, ['dispatch/notes/'], 'verify carries the same list')
  assert.deepEqual(gates.review.controlPlanePatterns, ['dispatch/notes/'], 'review carries the same list')

  const cwd = 'G:\\repo'
  const state = { pending: true, warned: false, since: 0 }
  const reviewEvents = [call(2, 'edit', { file_path: 'dispatch/notes/y.md' }, 'write-1')]
  assert.equal(evaluateReviewGate(reviewEvents, gates, state, cwd), null, 'the custom fragment is exempt')
  reviewEvents.push(call(2, 'edit', { file_path: 'src/a.ts' }, 'write-2'))
  assert.notEqual(evaluateReviewGate(reviewEvents, gates, state, cwd), null, 'other paths still count')

  assert.equal(classifyPath('dispatch\\ledger\\x.md', { cwd }), ARTIFACT.CONTROL,
    'backslashes are normalized')
  assert.equal(classifyPath('src\\a.ts', { cwd }), ARTIFACT.CODE)
  assert.equal(classifyPath('dispatch/state/x.md', { cwd }), ARTIFACT.CONTROL,
    '0.9.1: the per-requirement ledger directory is the control plane')
  assert.equal(classifyPath('dispatch/state.md', { cwd }), ARTIFACT.CONTROL,
    '0.9.1: the legacy single-file ledger stays control plane (read-only)')
  assert.equal(classifyPath('src/app/dispatch/state.ts', { cwd }), ARTIFACT.CODE,
    '0.11.0 A1: a same-named source path is code, not control plane')
  assert.deepEqual(DEFAULT_CONTROL_PLANE_PATTERNS,
    ['dispatch/', 'docs/superpowers/specs/'], '0.10.0 C1: aligned with the write-policy allowlist')
  assert.deepEqual(DEFAULT_CONTROL_PLANE_PATTERNS, DEFAULT_ALLOWLIST,
    '0.10.0 C1: the gate list and the write-guard list are the same value')

  assert.throws(() => resolveGates({ controlPlanePatterns: [] }), /dispatch-protocol: gates\.controlPlanePatterns/)
  assert.throws(() => resolveGates({ controlPlanePatterns: ['ok', null] }), /dispatch-protocol: gates\.controlPlanePatterns/)
})

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
    const root = h.main('session-policy-deny', [], {}, 'session-policy-deny', dir)

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
    const root = h.main('session-policy-allow', [], {}, 'session-policy-allow', dir)

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
    const root = h.main('session-policy-override', [], {}, 'session-policy-override', dir, createdAt)

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
    const root = h.main('session-policy-stale', [], {}, 'session-policy-stale', dir, createdAt)

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
    const root = h.main('session-policy-invalid', [], {}, 'session-policy-invalid', dir)

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
    const root = h.main('session-policy-noreason', [], {}, 'session-policy-noreason', dir)

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
    const root = h.main('session-policy-shadow', [], {}, 'session-policy-shadow', dir)

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
    const root = h.main('session-policy-exempt', [], {}, 'session-policy-exempt', dir)

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
    const root = h.main('session-policy-outside', [], {}, 'session-policy-outside', dir)

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
    const root = { session: { id: 'session-policy-unbounded', header: { origin: 'root' }, cwd: dir } }

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
    const root = h.main('session-policy-dotdot', [], {}, 'session-policy-dotdot', dir)

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
    const root = h.main('session-policy-boundary', [], {}, 'session-policy-boundary', dir)

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
    delegationTools: ['subagent', 'subagent_fork', 'workflow'],
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
// 0.10.0 — 守卫按改动类型分级（spec §2 C1–C5 / §4 断言 1–6）

test('C1: dispatch/ subtree writes after a successful verification do not gate', () => {
  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const events = [
    call(1, 'pwsh', { command: 'npm test' }, 'verify-1'),
    resultWithText(1, 'verify-1', 'exit code: 0'),
    call(2, 'write', { file_path: 'dispatch/override.json' }, 'write-1'),
    result(2, 'write-1', false),
    call(2, 'write', { file_path: 'dispatch/recon/a.md' }, 'write-2'),
    result(2, 'write-2', false),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ]

  assert.equal(evaluateVerifyGate(events, 2, gates, cwd), null,
    'C1: dispatch/override.json and dispatch/recon/* are control-plane writes')
  assert.equal(analyzeVerification(events, gates.verify, cwd).changes, 0,
    'C1: control-plane writes are not counted as dirty changes')
})

test('C2: a docs-only change after the last verification skips the gate, code still gates', () => {
  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const prefix = [
    call(1, 'pwsh', { command: 'npm test' }, 'verify-1'),
    resultWithText(1, 'verify-1', 'exit code: 0'),
  ]
  const docs = [
    ...prefix,
    call(2, 'write', { file_path: 'AGENTS.md' }, 'write-1'),
    result(2, 'write-1', false),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ]
  assert.equal(evaluateVerifyGate(docs, 2, gates, cwd), null, 'C2: AGENTS.md is documentation')

  const code = [
    ...docs.slice(0, 2),
    call(2, 'write', { file_path: 'server/src/x.ts' }, 'write-1'),
    result(2, 'write-1', false),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ]
  const state = evaluateVerifyGate(code, 2, gates, cwd)
  assert.notEqual(state, null, 'C2: a code write still gates')
  assert.equal(state.docOnly, false)
  const text = renderVerifyGate(gates.verify.text, state)
  assert.match(text, /server\/src\/x\.ts/, 'C5: the text names the dirty file')
  assert.match(text, /代码改动/, 'C5: the text names the change kind')

  // C2：「从未跑过」分支同样适用——只有文档时静默。
  const never = [
    call(1, 'write', { file_path: 'AGENTS.md' }, 'write-1'),
    result(1, 'write-1', false),
    call(1, 'present', { file_path: 'report.md' }, 'present-1'),
  ]
  assert.equal(evaluateVerifyGate(never, 1, gates, cwd), null,
    'C2: the never-verified branch exempts documentation too')
})

test('C2 boundary: a write without a path is not documentation and still gates', () => {
  const gates = resolveGates({})
  const events = [
    call(1, 'write', {}, 'write-1'),
    result(1, 'write-1', false),
    call(1, 'present', { file_path: 'report.md' }, 'present-1'),
  ]

  const state = evaluateVerifyGate(events, 1, gates)
  assert.notEqual(state, null, 'C2: a path-less write cannot be proven documentation')
  assert.equal(state.docOnly, false)
  assert.deepEqual(state.files, ['<shell>'], 'C2: an unlocatable dirty entry is <shell>')
})

test('C3: restoring the working tree to HEAD is not a dirty change', () => {
  assert.equal(isRestoreCommand('git checkout -- a.ts'), true)
  assert.equal(isRestoreCommand('git -C "G:\\repo" checkout -- a.ts b.ts'), true, 'git -C is skipped')
  assert.equal(isRestoreCommand('git restore x'), true)
  assert.equal(isRestoreCommand('git restore src/a.ts docs/b.md'), true)

  assert.equal(isRestoreCommand('git checkout main'), false)
  assert.equal(isRestoreCommand('git checkout -b y'), false)
  assert.equal(isRestoreCommand('git restore --source=HEAD~1 a.ts'), false)
  assert.equal(isRestoreCommand('git restore -s HEAD~1 a.ts'), false, 'the -s shorthand switches the tree')
  assert.equal(isRestoreCommand('git checkout --'), false, 'no path means nothing was restored')
  assert.equal(isRestoreCommand('git checkout -q -- a.ts'), false, 'an unmodelled option stays dirty')
  assert.equal(isRestoreCommand('git checkout -- a.ts; Remove-Item b.ts'), false,
    'a chained mutation is not a restore')
  assert.equal(isRestoreCommand('git status --short'), false)
  assert.equal(isRestoreCommand(''), false)
  assert.equal(isRestoreCommand(undefined), false)

  // 0.10.0 C3a：还原段 + 中性只读段（上游真实误报场景）不再按脏处理。
  assert.equal(isRestoreCommand('git checkout -- a.ts; git status --porcelain'), true,
    'C3a: a restore followed by a status self-check is still a restore')
  assert.equal(isRestoreCommand('git -C repo restore src/a.ts && git diff --stat'), true,
    'C3a: git -C restore plus a read-only diff is still a restore')
  assert.equal(isRestoreCommand('git checkout -- a.ts; git log --oneline -3'), true,
    'C3a: a read-only log segment is neutral')
  assert.equal(isRestoreCommand('git checkout -- a.ts > out.txt'), false,
    'C3a: a redirect may write to disk')
  assert.equal(isRestoreCommand('git checkout -- a.ts; git add -A'), false,
    'C3a: a non-neutral segment keeps the whole command dirty')
  assert.equal(isRestoreCommand('git status'), false,
    'C3a: read-only segments alone never make a restore')
  assert.equal(isRestoreCommand('git checkout -- a.ts; git status; git diff --stat'), true,
    'C3a: several neutral segments after a restore stay neutral')

  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const events = [
    call(1, 'write', { file_path: 'src/a.ts' }, 'write-1'),
    result(1, 'write-1', false),
    call(2, 'pwsh', { command: 'git checkout -- src/a.ts' }, 'restore-1'),
    result(2, 'restore-1', false),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ]
  const state = evaluateVerifyGate(events, 2, gates, cwd)
  assert.notEqual(state, null, 'the earlier code write still gates')
  assert.equal(state.changes, 1, 'C3: the restore adds no dirty change')
  assert.equal(state.files.includes('<shell>'), false, 'C3: the restore is not listed as a shell change')

  // C3a 端到端：`checkout -- …; status` 作为 pwsh 事件也不得算脏。
  const afterVerify = [
    call(1, 'write', { file_path: 'src/a.ts' }, 'write-2'),
    result(1, 'write-2', false),
    call(1, 'pwsh', { command: 'npm test' }, 'verify-2'),
    resultWithText(1, 'verify-2', 'exit code: 0'),
    call(2, 'pwsh', { command: 'git checkout -- src/a.ts; git status --porcelain' }, 'restore-2'),
    result(2, 'restore-2', false),
  ]
  const c3a = analyzeVerification(afterVerify, gates.verify, cwd)
  assert.equal(c3a.changes, 0, 'C3a: the restore-plus-status call adds no dirty change')
  assert.equal(c3a.files.includes('<shell>'), false, 'C3a: it is not listed as a shell change')
  assert.equal(c3a.dirty, false, 'C3a: a successful verification is still the latest state')
})

test('C4: a docs-only write after the review renders the doc-only action', () => {
  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const state = { pending: true, warned: false, since: 0 }
  const events = [
    call(2, 'write', { file_path: 'README.md' }, 'write-1'),
    call(2, 'edit', { file_path: 'dispatch/ledger/x.md' }, 'write-2'),
  ]
  const review = evaluateReviewGate(events, gates, state, cwd)
  assert.notEqual(review, null)
  assert.equal(review.docOnly, true, 'C4: markdown plus a control-plane ledger is documentation')
  assert.deepEqual(review.files, ['README.md'], 'the control-plane write is not listed')
  const text = renderReviewGate(gates.review.text, review)
  assert.match(text, /不必重开代码评审/, 'C4: the doc-only action is chosen')
  assert.doesNotMatch(text, /重开受影响切片/, 'C4: the code action must not leak into a doc-only change')
  assert.match(text, /README\.md/, 'C5: the doc-only text names the file')

  events.push(call(2, 'write', { file_path: 'src/a.ts' }, 'write-3'))
  const mixed = evaluateReviewGate(events, gates, state, cwd)
  assert.equal(mixed.docOnly, false, 'C4: a mixed batch is not doc-only')
  const mixedText = renderReviewGate(gates.review.text, mixed)
  assert.match(mixedText, /src\/a\.ts/,
    'C4/C5: the original text keeps the {files} placeholder filled')
  assert.match(mixedText, /重开受影响切片/, 'C4: a mixed batch asks for a re-review')
})

test('C4: the plugin picks the doc-only review text and logs docOnly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-review-doc-'))
  try {
    const log = join(dir, 'decisions.jsonl')
    const events = []
    const h = harness()
    plugin.apply(h.ctx, {
      log, checkpoint: { enabled: false }, gates: { handoff: { enabled: false } },
    })

    const parent = h.main('session-review-doc', events, {}, 'session-review-doc', dir)
    h.created(parent)
    h.created(h.child('review-doc', 'session-review-doc', '只读评审：diff'))
    h.ended({ childId: 'review-doc', stopReason: 'completed' })
    events.push(call(2, 'write', { file_path: 'docs/agent/notes.md' }, 'write-1'), result(2, 'write-1', false))
    h.turnStopping(parent, 2)

    assert.equal(parent.messages.length, 1)
    assert.match(parent.messages[0].text, /不必重开代码评审/)
    assert.doesNotMatch(parent.messages[0].text, /重开受影响切片/)
    assert.match(parent.messages[0].text, /docs\/agent\/notes\.md/)
    const row = readRows(log).find(entry => entry.kind === 'gate')
    assert.equal(row.gate, 'review')
    assert.equal(row.docOnly, true, 'C4: the decision log carries docOnly')
    assert.deepEqual(row.files, ['docs/agent/notes.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C5: the gate text caps files at three, counts the rest and names the kind', () => {
  const gates = resolveGates({})
  const info = {
    changes: 5,
    lastVerify: null,
    dirty: true,
    docOnly: false,
    files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
  }
  const text = renderVerifyGate(gates.verify.text, info)
  assert.match(text, /src\/a\.ts, src\/b\.ts, src\/c\.ts 等 5 个/, 'C5: three paths plus the total')
  assert.doesNotMatch(text, /src\/d\.ts/, 'C5: only three paths are shown')
  assert.match(text, /代码改动/)

  assert.equal(renderVerifyGate('{files}（{kind}）', { changes: 1, lastVerify: null, files: ['<shell>'] }),
    '<shell>（未知）', 'C5: a shell-only change is unknown, not code')
  assert.equal(renderVerifyGate('{files}', { changes: 0, lastVerify: null, files: [] }), '工作区',
    'C5: no path falls back to 工作区')
  assert.equal(renderVerifyGate('{changes}/{lastVerify}', { changes: 2, lastVerify: 'npm test' }), '2/npm test',
    'C5: the old placeholders still render')
  assert.equal(renderReviewGate('{files}', { files: [] }), '工作区')
})

test('0.10.0 §4-6: the new gate settings are validated and the old config still loads', () => {
  assert.throws(() => resolveGates({ verify: { docPatterns: [] } }),
    /dispatch-protocol: gates\.verify\.docPatterns/)
  assert.throws(() => resolveGates({ verify: { docPatterns: ['ok', 42] } }),
    /dispatch-protocol: gates\.verify\.docPatterns/)

  const gates = resolveGates({})
  assert.deepEqual(gates.verify.docPatterns,
    ['.md', '.mdx', 'docs/', 'dispatch/', 'LICENSE', '.gitignore', '.gitattributes'])
  assert.deepEqual(gates.review.docPatterns, gates.verify.docPatterns, 'review reuses the same doc list')
  assert.match(gates.review.text, /\{action\}/, '0.11.0 D4: review has a single {action} template')
  assert.equal('textDocOnly' in gates.review, false, '0.11.0 D3: the textDocOnly key is gone')
  assert.match(gates.verify.text, /\{files\}/)
  assert.match(gates.verify.text, /\{kind\}/)
  assert.match(gates.verify.text, /\{action\}/)

  // 旧配置（没有新键）仍加载，旧自定义文案不被新占位破坏。
  const legacy = resolveGates({
    verify: { text: '旧文案 {changes}/{lastVerify}' },
    review: { text: '旧文案 {files}' },
  })
  assert.equal(renderVerifyGate(legacy.verify.text, { changes: 1, lastVerify: null }), '旧文案 1/从未验证')
  assert.equal(renderReviewGate(legacy.review.text, { files: ['a.md'] }), '旧文案 a.md')
})

// ---------------------------------------------------------------------------
// 0.11.0 — 产物分类器（spec D1–D3）：一个分类器，闸门/观测只消费它的结果

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

test('D1-2a(g): a traversal write cannot bypass the verify gate', () => {
  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const events = [
    call(1, 'pwsh', { command: 'npm test' }, 'verify-1'),
    resultWithText(1, 'verify-1', 'exit code: 0'),
    call(2, 'write', { file_path: 'dispatch/../src/x.ts' }, 'write-1'),
    result(2, 'write-1', false),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ]
  const state = evaluateVerifyGate(events, 2, gates, cwd)
  assert.notEqual(state, null, 'the folded src path is dirty code, so the gate fires')
  assert.equal(state.docOnly, false, 'the traversal path is not documentation/control plane')
  assert.deepEqual(state.files, ['dispatch/../src/x.ts'], 'the raw path is shown, but classified as code')
})

test('D2/D3: the verify gate consumes the classifier with the session cwd', () => {
  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const prefix = [
    call(1, 'pwsh', { command: 'npm test' }, 'verify-1'),
    resultWithText(1, 'verify-1', 'exit code: 0'),
  ]
  const docs = [
    ...prefix,
    call(2, 'write', { file_path: 'AGENTS.md' }, 'write-1'),
    result(2, 'write-1', false),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ]
  assert.equal(analyzeVerification(docs, gates.verify, cwd).docOnly, true,
    'D3: AGENTS.md is documentation when cwd is known')
  assert.equal(evaluateVerifyGate(docs, 2, gates, cwd), null,
    'D2: a docs-only change after the verification is silent with cwd')

  // A1 回归（0.11.0 最重要的一条）：0.10.0 的子串口径把 src/**/dispatch/**
  // 连带豁免，本批起必须触发。
  const code = [
    ...prefix,
    call(2, 'write', { file_path: 'src/app/dispatch/x.ts' }, 'write-2'),
    result(2, 'write-2', false),
    call(2, 'present', { file_path: 'report.md' }, 'present-1'),
  ]
  const state = evaluateVerifyGate(code, 2, gates, cwd)
  assert.notEqual(state, null, 'A1: src/app/dispatch/x.ts must trigger the verify gate')
  assert.equal(state.docOnly, false, 'A1: the dirty entry is code, not documentation')
  assert.deepEqual(state.files, ['src/app/dispatch/x.ts'])

  // D1-6 / spec §2.4：没有 cwd 时分类退化为代码 —— 文档也要触发（保守）。
  assert.equal(analyzeVerification(docs, gates.verify).docOnly, false,
    'D1-6: without cwd even AGENTS.md is not proven documentation')
  assert.notEqual(evaluateVerifyGate(docs, 2, gates), null,
    'D1-6: without cwd the gate stays conservative and triggers')
})

test('D3: the review gate treats src/**/dispatch/** as code and docs as documentation', () => {
  const gates = resolveGates({})
  const cwd = 'G:\\repo'
  const state = { pending: true, warned: false, since: 0 }

  const docReview = evaluateReviewGate(
    [call(2, 'write', { file_path: 'AGENTS.md' }, 'write-1')], gates, state, cwd,
  )
  assert.equal(docReview.docOnly, true, 'D3: a doc write after the review is documentation')
  assert.deepEqual(docReview.files, ['AGENTS.md'])

  const codeReview = evaluateReviewGate(
    [call(2, 'write', { file_path: 'src/app/dispatch/x.ts' }, 'write-2')], gates, state, cwd,
  )
  assert.equal(codeReview.docOnly, false, 'A1: a same-named source path invalidates the review')

  assert.equal(evaluateReviewGate(
    [call(2, 'write', { file_path: 'dispatch/ledger/x.md' }, 'write-3')], gates, state, cwd,
  ), null, 'D3: control-plane writes still do not invalidate the review')
})

test('D2: the plugin passes the session cwd to the verify gate (A1 end-to-end)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-gate-cwd-'))
  try {
    const events = []
    const h = harness()
    plugin.apply(h.ctx, { log: false, checkpoint: { enabled: false } })
    const parent = h.main('session-gate-cwd', events, {}, 'session-gate-cwd', dir)
    h.created(parent)

    events.push(
      call(1, 'pwsh', { command: 'npm test' }, 'verify-1'),
      resultWithText(1, 'verify-1', 'exit code: 0'),
    )
    events.push(
      call(2, 'write', { file_path: 'AGENTS.md' }, 'write-doc'),
      result(2, 'write-doc', false),
      call(2, 'present', { file_path: 'report.md' }, 'present-doc'),
    )
    h.turnStopping(parent, 2)
    assert.equal(parent.messages.length, 0, 'a docs-only closure is silent when the session cwd is known')

    events.push(
      call(3, 'write', { file_path: 'src/app/dispatch/x.ts' }, 'write-code'),
      result(3, 'write-code', false),
      call(3, 'present', { file_path: 'report.md' }, 'present-code'),
    )
    h.turnStopping(parent, 3)
    assert.equal(parent.messages.length, 1, 'A1: the plugin still gates a src/**/dispatch/** change')
    assert.match(parent.messages[0].text, /src\/app\/dispatch\/x\.ts/)
    assert.match(parent.messages[0].text, /先跑一次集成命令并留存退出码/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 0.11.0 — 单一文案模型（spec D4）：一个模板 + 一个闸门给定的 {action}

test('D4-1: the verify default ends in {action} and renders the integration action', () => {
  const gates = resolveGates({})
  assert.match(gates.verify.text, /\{action\}$/, 'the default template ends in the action placeholder')
  const text = renderVerifyGate(gates.verify.text, {
    changes: 1, dirty: true, docOnly: false, lastVerify: null, files: ['src/a.ts'],
  })
  assert.match(text, /src\/a\.ts（代码改动）/, 'the file and kind placeholders still render')
  assert.match(text, /先跑一次集成命令并留存退出码，再收口。/,
    'D4: the verify action is the fixed integration command')
})

test('D4-2: a doc-only review renders the docs-check action, never the re-review one', () => {
  const gates = resolveGates({})
  assert.match(gates.review.text, /\{action\}$/, 'the default template ends in the action placeholder')
  const text = renderReviewGate(gates.review.text, { files: ['AGENTS.md'], docOnly: true })
  assert.match(text, /不必重开代码评审/, 'D4: a doc-only change does not invalidate the code slice')
  assert.match(text, /docs-check/, 'D4: a doc-only change points at the deterministic checker')
  assert.match(text, /断言 → 代码位置/, 'D4: it asks for the assertion → code-location table')
  assert.match(text, /1 次有界评审/, 'D4: a non-empty table buys one bounded review')
  assert.doesNotMatch(text, /重开受影响切片/, 'D4: the code action must not leak in')
  assert.match(text, /AGENTS\.md/)
})

test('D4-3: a code review renders the re-review action, never the machine-check one', () => {
  const gates = resolveGates({})
  const text = renderReviewGate(gates.review.text, { files: ['src/a.ts'], docOnly: false })
  assert.match(text, /评审已失效：重开受影响切片再收口。/, 'D4: code changes re-open the affected slice')
  assert.doesNotMatch(text, /不必重开代码评审/, 'D4: the doc-only action must not leak in')
})

test('D4-4: a custom template may place {action}; old and unknown placeholders survive', () => {
  const gates = resolveGates({
    verify: { text: 'V：{files}（{kind}）{action} [changes={changes}; last={lastVerify}]' },
    review: { text: 'R：{files} {action}' },
  })
  assert.equal(renderVerifyGate(gates.verify.text, {
    changes: 2, lastVerify: 'npm test', files: ['src/a.ts'],
  }), 'V：src/a.ts（代码）先跑一次集成命令并留存退出码，再收口。 [changes=2; last=npm test]',
  'D4: {action}, {changes} and {lastVerify} render in a custom template')
  assert.equal(renderReviewGate(gates.review.text, { files: ['a.md'], docOnly: true }),
    'R：a.md 这类改动不使代码切片失效：跑 docs-check，并按规则 1/4 交「断言 → 代码位置」表（表非空再由派发方派 1 次有界评审）即可，不必重开代码评审。',
    'D4: the doc-only action fills {action} in a custom review template')

  // 未知占位原样保留；没注入 action 时 {action} 不被抹掉。
  assert.equal(renderGateText('{files} {oops}', { files: ['a.ts'] }), 'a.ts {oops}')
  assert.equal(renderGateText('{action}', {}), '{action}')
  assert.equal(renderGateText('{action}', { action: 'X' }), 'X')
})

// ---------------------------------------------------------------------------
function call(turn, name, args, id) {
  return { type: 'tool/call', data: { turn, step: 1, callId: id ?? `call-${turn}-${name}`, name, arguments: JSON.stringify(args ?? {}) } }
}

/** One committed `tool/result` record; `isError` marks a refused call. */
function result(turn, callId, isError) {
  return { type: 'tool/result', data: { turn, step: 1, message: { isError, toolCallId: callId, content: [] } } }
}

/**
 * One `tool/result` record carrying text — the exit code a verification call
 * reports lives in the result content (0.6.0 gate tests).
 */
function resultWithText(turn, callId, text, isError = false) {
  return {
    type: 'tool/result',
    data: { turn, step: 1, message: { isError, toolCallId: callId, content: [{ type: 'text', text }] } },
  }
}

/** Read a decision log as parsed rows (0.6.0 gate assertions). */
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

/** Build a fake host context: prompt registry, tools guard, agents registry, event bus. */
function harness() {
  const sections = []
  /** Registered `ctx.tools.guard(fn)` functions, in registration order. */
  const guards = []
  const events = new Map()
  const agents = new Map()
  const agentHooks = new Map()

  const ctx = {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    // 0.9.0 write guard: `guard(fn)` is sync and returns a disposer.
    tools: {
      guard(fn) {
        guards.push(fn)
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
    guards,
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
