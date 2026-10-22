// Offline regression for the dispatch-protocol plugin — no DSH process, no dependencies.
//
//   node test.mjs
//
// The harness fakes the extension points the plugin uses:
//   - `ctx.systemPrompt.section(section)` (the system-prompt registry)
//   - `agent/created` / `subagent/end` (root event bus)
//   - `agent.ctx.on('agent/turn-stopping')` + `agent.steer` (the nudge check)
//   - `session.snapshotEvents()` (committed `tool/call` records)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from './plugin.mjs'
import { resolveConfig, DEFAULT_RULES } from './lib/config.mjs'
import { renderNudge, resolveNudge, shouldNudge, summarizeTurn } from './lib/nudge.mjs'

test('registers one prompt section with literal text and a stable order', () => {
  const h = harness()
  plugin.apply(h.ctx, {})

  assert.equal(h.sections.length, 1)
  const [section] = h.sections
  assert.equal(section.name, 'dispatch-protocol')
  assert.equal(section.order, 500)
  assert.equal(section.interpolate, false, '{{…}} in project text must stay literal')
})

test('the default text states all five dispatch rules', () => {
  const h = harness()
  plugin.apply(h.ctx, {})
  const text = h.sections[0].text

  assert.match(text, /勘察/)
  assert.match(text, /白名单/)
  assert.match(text, /复跑/)
  assert.match(text, /提交权/)
  assert.match(text, /并行/)
  assert.match(text, /单文件/, 'the closing paragraph states the exemption')
})

test('configured rules replace the default text', () => {
  const h = harness()
  plugin.apply(h.ctx, { rules: ['第一条', '第二条'] })
  const text = h.sections[0].text

  assert.match(text, /第一条/)
  assert.match(text, /第二条/)
  // The closing paragraph stays: replacing `rules` replaces the numbered rules
  // only. `白名单` belongs to default rule 1, so its absence is what proves the
  // default rules are gone.
  assert.doesNotMatch(text, /白名单/)
  assert.match(text, /成本与豁免/, 'the closing paragraph is independent of the rules')
})

test('a disabled plugin registers nothing', () => {
  const h = harness()
  plugin.apply(h.ctx, { enabled: false })
  assert.equal(h.sections.length, 0)
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

  assert.match(text, /成本与豁免/, 'cost split and exemption are one paragraph')
  assert.match(text, /单文件且纯文案/, 'the small-change exemption survives')
  assert.match(text, /默认派给子代理/, 'mechanical volume defaults to children')
  assert.match(text, /拆批/, 'uncertainty must map to batching')
  assert.match(text, /只读勘察批次/, 'the first batch is a read-only survey')
  assert.match(text, /可多批陆续派发/, 'several batches are allowed')
  assert.match(text, /不许整包留给自己/, 'the fallback-to-self trap must be named')
  assert.match(text, /缺计划类 skill/, 'the missing-plan-skill path must be named')

  // No magic numbers: the whitelist is bounded by "one batch, one verification
  // command" and the task list by "one entry = one decision or one batch".
  assert.doesNotMatch(text, /≤3 个/, 'the whitelist is not capped by file count')
  assert.doesNotMatch(text, /≤7 条/, 'the task list is not capped by item count')
  assert.match(text, /逐条列名/, 'the whitelist is enumerated, not counted')
  assert.match(text, /一批只对应一条验证命令/, 'the batch bound is the verification command')
  assert.match(text, /每条 = 一个决策点或一批派发/, 'task-list entries map to decisions or batches')

  const dropped = harness()
  plugin.apply(dropped.ctx, { footer: '' })
  assert.doesNotMatch(dropped.sections[0].text, /成本与豁免/)

  assert.throws(() => resolveConfig({ footer: 42 }), /footer/)
})

test('a completed child triggers exactly one checkpoint message to its parent', () => {
  const h = harness()
  plugin.apply(h.ctx, {})

  const parent = h.parent('parent-1')
  const child = h.child('child-1', 'parent-1', '实现 Task 1')
  h.created(child)

  h.ended({ childId: 'child-1', stopReason: 'completed' })
  h.ended({ childId: 'child-1', stopReason: 'completed' })

  assert.equal(parent.messages.length, 1, 'the checkpoint is delivered once')
  assert.match(parent.messages[0].text, /child-1/)
  assert.match(parent.messages[0].text, /复跑/)
  assert.match(parent.messages[0].text, /diff/)
})

test('a failed or aborted child does not trigger a checkpoint', () => {
  const h = harness()
  plugin.apply(h.ctx, {})

  const parent = h.parent('parent-1')
  h.created(h.child('child-2', 'parent-1', '实现 Task 2'))

  h.ended({ childId: 'child-2', stopReason: 'error' })
  h.ended({ childId: 'child-2', stopReason: 'aborted' })

  assert.equal(parent.messages.length, 0)
})

test('checkpoint messages can be disabled by config', () => {
  const h = harness()
  plugin.apply(h.ctx, { checkpoint: { enabled: false } })

  const parent = h.parent('parent-1')
  h.created(h.child('child-3', 'parent-1', '实现 Task 3'))
  h.ended({ childId: 'child-3', stopReason: 'completed' })

  assert.equal(parent.messages.length, 0)
})

// ---------------------------------------------------------------------------
// Missed-dispatch nudge

test('summarizeTurn counts only the requested turn\'s writes and files', () => {
  const config = resolveNudge({})
  const events = [
    call(1, 'write', { file_path: 'a.ts' }),
    call(1, 'edit', { file_path: 'b.ts' }),
    call(1, 'read', { file_path: 'c.ts' }),
    call(1, 'subagent', { description: '勘察' }),
    call(2, 'write', { file_path: 'd.ts' }),
  ]

  const summary = summarizeTurn(events, 1, config)
  assert.equal(summary.writes, 2)
  assert.deepEqual(summary.files, ['a.ts', 'b.ts'])
  assert.equal(summary.delegations, 1)
  assert.equal(shouldNudge(summary, config), false, 'a delegation means the dispatch happened')

  const second = summarizeTurn(events, 2, config)
  assert.equal(second.writes, 1)
  assert.equal(second.delegations, 0)
})

test('a multi-write turn without delegation is reminded exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-'))
  try {
    const log = join(dir, 'nudge.jsonl')
    const h = harness()
    plugin.apply(h.ctx, { nudge: { log, threshold: 2 } })

    const agent = h.main('session-1', [
      call(1, 'write', { file_path: 'x.xaml' }),
      call(1, 'edit', { file_path: 'y.xaml' }),
    ])
    h.created(agent)

    h.turnStopping(agent, 1)
    h.turnStopping(agent, 1)

    assert.equal(agent.messages.length, 1, 'the nudge costs one step, once per turn')
    assert.match(agent.messages[0].text, /派发 0 次/)
    assert.match(agent.messages[0].text, /改了 2 个文件/)
    assert.match(agent.messages[0].text, /2 次写入/)
    assert.match(agent.messages[0].text, /x\.xaml/)
    assert.equal(agent.messages[0].role, 'user', 'the provider requires a user-role message')

    const lines = readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0])
    assert.equal(record.turn, 1)
    assert.equal(record.writes, 2)
    assert.equal(record.delegations, 0)
    assert.deepEqual(record.files, ['x.xaml', 'y.xaml'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repeated writes to one file stay inside the small-change exemption', () => {
  const h = harness()
  plugin.apply(h.ctx, { nudge: { log: false, threshold: 2 } })

  const agent = h.main('session-2b', [
    call(1, 'edit', { file_path: 'same.mjs' }),
    call(1, 'edit', { file_path: 'same.mjs' }),
    call(1, 'edit', { file_path: 'same.mjs' }),
  ])
  h.created(agent)
  h.turnStopping(agent, 1)

  assert.equal(agent.messages.length, 0, 'three writes to one file count as one file')
})

test('enough distinct files are reminded even when each is written once', () => {
  const h = harness()
  plugin.apply(h.ctx, { nudge: { log: false, threshold: 3 } })

  const agent = h.main('session-2c', [
    call(1, 'write', { file_path: 'a.txt' }),
    call(1, 'write', { file_path: 'b.txt' }),
    call(1, 'write', { file_path: 'c.txt' }),
    call(1, 'write', { file_path: 'd.txt' }),
  ])
  h.created(agent)
  h.turnStopping(agent, 1)

  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /改了 4 个文件/)
  assert.match(agent.messages[0].text, /4 次写入/)
})

test('a single write keeps the small-change exemption and is not reminded', () => {
  const h = harness()
  plugin.apply(h.ctx, { nudge: { log: false } })

  const agent = h.main('session-2', [call(1, 'write', { file_path: 'only.txt' })])
  h.created(agent)
  h.turnStopping(agent, 1)

  assert.equal(agent.messages.length, 0)
})

test('writes below the configured threshold are not reminded', () => {
  const h = harness()
  plugin.apply(h.ctx, { nudge: { log: false, threshold: 3 } })

  const agent = h.main('session-3', [
    call(1, 'write', { file_path: 'a.txt' }),
    call(1, 'write', { file_path: 'b.txt' }),
  ])
  h.created(agent)
  h.turnStopping(agent, 1)

  assert.equal(agent.messages.length, 0)
})

test('a turn that delegated is never reminded', () => {
  const h = harness()
  plugin.apply(h.ctx, { nudge: { log: false } })

  const agent = h.main('session-4', [
    call(1, 'write', { file_path: 'a.txt' }),
    call(1, 'write', { file_path: 'b.txt' }),
    call(1, 'subagent', { description: '实现 Task 1' }),
  ])
  h.created(agent)
  h.turnStopping(agent, 1)

  assert.equal(agent.messages.length, 0)
})

test('a subagent is never nudged, even with many writes', () => {
  const h = harness()
  plugin.apply(h.ctx, { nudge: { log: false } })

  const child = h.main('child-9', [
    call(1, 'write', { file_path: 'a.txt' }),
    call(1, 'write', { file_path: 'b.txt' }),
  ], { origin: 'subagent', parentSession: 'session-5' })
  h.created(child)
  h.turnStopping(child, 1)

  assert.equal(child.messages.length, 0)
})

test('the nudge can be disabled without touching the checkpoint', () => {
  const h = harness()
  plugin.apply(h.ctx, { nudge: { enabled: false } })

  const agent = h.main('session-6', [
    call(1, 'write', { file_path: 'a.txt' }),
    call(1, 'write', { file_path: 'b.txt' }),
  ])
  h.created(agent)
  h.turnStopping(agent, 1)

  assert.equal(agent.messages.length, 0)

  const parent = h.parent('parent-6')
  h.created(h.child('child-6', 'parent-6', '实现 Task 6'))
  h.ended({ childId: 'child-6', stopReason: 'completed' })
  assert.equal(parent.messages.length, 1, 'the checkpoint still runs')
})

test('a log path of false records nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-protocol-'))
  try {
    const h = harness()
    plugin.apply(h.ctx, { nudge: { log: false } })

    const agent = h.main('session-7', [
      call(1, 'write', { file_path: 'a.txt' }),
      call(1, 'write', { file_path: 'b.txt' }),
    ])
    h.created(agent)
    h.turnStopping(agent, 1)

    assert.equal(agent.messages.length, 1, 'the reminder still reaches the model')
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nudge config rejects values that would silently never fire', () => {
  assert.throws(() => resolveNudge({ threshold: 0 }), /threshold/)
  assert.throws(() => resolveNudge({ threshold: 1.5 }), /threshold/)
  assert.throws(() => resolveNudge({ text: '   ' }), /text/)
  assert.throws(() => resolveNudge({ writeTools: 'write' }), /writeTools/)
  assert.throws(() => resolveNudge({ delegationTools: [] }), /delegationTools/)
  assert.throws(() => resolveConfig({ nudge: { threshold: -1 } }), /threshold/)

  const defaults = resolveNudge({})
  assert.equal(defaults.threshold, 2)
  assert.equal(defaults.enabled, true)
  assert.match(defaults.log, /dispatch-protocol-nudge\.jsonl$/)
})

test('renderNudge fills the placeholders and truncates a long file list', () => {
  const text = renderNudge('w={writes} f={files} t={turn} c={fileCount}', {
    writes: 7,
    files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    turn: 3,
  })

  assert.match(text, /w=7/)
  assert.match(text, /t=3/)
  assert.match(text, /c=7/, 'fileCount is the number of distinct files')
  assert.match(text, /等 7 个/)
  assert.match(renderNudge('{files}', { writes: 0, files: [], turn: 1 }), /未记录路径/)
  assert.match(renderNudge('{fileCount}', { writes: 0, files: [], turn: 1 }), /^0$/)
})

// ---------------------------------------------------------------------------

/** One committed `tool/call` record, shaped like the session log stores it. */
function call(turn, name, args) {
  return { type: 'tool/call', data: { turn, step: 1, callId: `call-${turn}-${name}`, name, arguments: JSON.stringify(args ?? {}) } }
}

/** Build a fake host context: prompt registry, agents registry, event bus. */
function harness() {
  const sections = []
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
    parent(id) {
      const messages = []
      const agent = { id, messages, followup: record(messages), steer: record(messages) }
      agents.set(id, agent)
      return agent
    },
    child(id, parentId, label) {
      return {
        id,
        session: {
          header: { origin: 'subagent', parentSession: parentId, delegationDepth: 1 },
          snapshotEvents: () => [{ type: 'subagent/descriptor', data: { label } }],
        },
      }
    },
    /** A live top-level agent with its own hook scope and session log. */
    main(id, sessionEvents = [], header = {}) {
      const messages = []
      const hooks = new Map()
      const agent = {
        id,
        messages,
        session: {
          id,
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
      agents.set(id, agent)
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
