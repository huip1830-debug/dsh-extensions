// Offline regression for the dispatch-guard plugin — no DSH process, no dependencies.
//
//   node test.mjs
//
// The harness fakes the extension points the plugin uses:
//   - root `agent/created` / `subagent/end`
//   - per-child `agent/request-error`, `tools/post-execute`, `agent/pre-step`
//   - `ctx.agents.get(parentId)` returning an agent with steer/followup/inject
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from './plugin.mjs'
import { createFailureTracker } from './lib/failure.mjs'
import { createStallTracker, isWriteActivity } from './lib/stall.mjs'
import { renderNotice } from './lib/notice.mjs'
import { resolveConfig } from './lib/config.mjs'
import { isReadOnlyDelegation } from './lib/exempt.mjs'

const BASE = {
  failure: { maxAttempts: 2, codes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] },
  stall: {
    nudgeAfterSteps: 12,
    blockAfterSteps: 20,
    writeTools: ['write', 'edit', 'str_replace_editor'],
    writeCommandPatterns: ['New-Item', 'Set-Content', 'Out-File', 'Remove-Item'],
  },
}

test('failure tracker blocks on the maxAttempts-th matching failure and ignores other codes', () => {
  const tracker = createFailureTracker({ maxAttempts: 2, codes: ['RATE_LIMIT'] })

  assert.equal(tracker.observe('c1', 'RATE_LIMIT'), 'retry')
  assert.equal(tracker.observe('c1', 'EMPTY_RESPONSE'), 'retry', 'non-matching code never counts')
  assert.equal(tracker.observe('c1', 'RATE_LIMIT'), 'block')
  assert.equal(tracker.attemptsOf('c1'), 2)

  assert.equal(tracker.observe('c2', 'RATE_LIMIT'), 'retry', 'counters are per child')
})

test('stall tracker nudges once at the soft threshold and blocks at the hard threshold', () => {
  const tracker = createStallTracker({ nudgeAfterSteps: 3, blockAfterSteps: 5 })

  assert.equal(tracker.beginStep('c1'), 'ok')
  assert.equal(tracker.beginStep('c1'), 'ok')
  assert.equal(tracker.beginStep('c1'), 'nudge')
  assert.equal(tracker.beginStep('c1'), 'ok', 'the nudge fires once per stall run')
  assert.equal(tracker.beginStep('c1'), 'block')

  tracker.recordActivity('c2', false)
  assert.equal(tracker.beginStep('c2'), 'ok')
  tracker.recordActivity('c2', true)
  assert.equal(tracker.stepsWithoutWrite('c2'), 0, 'a write resets the stall counter')
})

test('write activity recognises write tools and writing shell commands', () => {
  const stall = BASE.stall
  assert.equal(isWriteActivity({ name: 'write', arguments: {} }, stall), true)
  assert.equal(isWriteActivity({ name: 'read', arguments: {} }, stall), false)
  assert.equal(isWriteActivity({ name: 'pwsh', arguments: { command: 'New-Item -ItemType Directory x' } }, stall), true)
  assert.equal(isWriteActivity({ name: 'pwsh', arguments: { command: 'Get-Content a.txt' } }, stall), false)
})

test('notice names the child, the failure, the budget evidence and the next action', () => {
  const text = renderNotice({
    childId: 'child-1',
    label: '实现 Task 1',
    reason: 'error',
    failureCode: 'RATE_LIMIT',
    failureMessage: '429: Upstream request failed',
    steps: 7,
    writes: 0,
  })

  assert.match(text, /child-1/)
  assert.match(text, /实现 Task 1/)
  assert.match(text, /RATE_LIMIT/)
  assert.match(text, /429/)
  assert.match(text, /7/)
  assert.match(text, /无副作用/, 'no writes means the parent is told a retry is safe')
  assert.match(text, /不要再用 send_message/)
})

test('config rejects a nudge threshold that cannot fire before the hard stop', () => {
  assert.throws(() => resolveConfig({ stall: { nudgeAfterSteps: 20, blockAfterSteps: 12 } }), /nudgeAfterSteps/)
  assert.throws(() => resolveConfig({ failure: { maxAttempts: 0 } }), /maxAttempts/)
  const resolved = resolveConfig({})
  assert.equal(resolved.stall.nudgeAfterSteps, 12)
  assert.equal(resolved.failure.maxAttempts, 2)
})

test('a failing child is stopped early and the parent receives exactly one notice', async () => {
  const h = createHarness()
  const parent = h.agent({ id: 'parent-1', origin: 'main' })
  const child = h.agent({ id: 'child-1', origin: 'subagent', parent: 'parent-1', label: '实现 Task 1' })

  h.created(child)

  let downstream = 0
  const next = async () => {
    downstream += 1
    return 'delegate'
  }

  const first = await child.fire('agent/request-error', { failure: { code: 'RATE_LIMIT', message: '429 too many' } }, next)
  assert.equal(first, 'delegate', 'the first attempt still reaches the retry policy')
  assert.equal(downstream, 1)

  const second = await child.fire('agent/request-error', { failure: { code: 'RATE_LIMIT', message: '429 too many' } }, next)
  assert.equal(second, undefined, 'the second attempt is terminal')
  assert.equal(downstream, 1, 'the retry policy never sees the blocking attempt')

  await h.ended({ childId: 'child-1', stopReason: 'error' })
  await h.ended({ childId: 'child-1', stopReason: 'error' })

  const notices = parent.messages.filter(m => m.text.includes('[dispatch-guard]'))
  assert.equal(notices.length, 1, 'the settlement notice is delivered once')
  assert.match(notices[0].text, /child-1/)
})

test('a child that stops writing is reminded at the soft threshold and blocked at the hard one', async () => {
  const h = createHarness({ stall: { nudgeAfterSteps: 2, blockAfterSteps: 3 } })
  h.agent({ id: 'parent-1', origin: 'main' })
  const child = h.agent({ id: 'child-2', origin: 'subagent', parent: 'parent-1', label: '勘察' })
  h.created(child)

  const step = async () => child.fire('agent/pre-step', { agent: child, messages: [], turn: 1, step: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))

  assert.deepEqual(await step(), { kind: 'enter', messages: [] })
  await step()
  assert.match(child.messages.at(-1).text, /无写/, 'the soft threshold nudges the child')

  const blocked = await step()
  assert.deepEqual(blocked, { kind: 'reject' }, 'the hard threshold rejects the step')
  assert.equal(child.messages.filter(m => m.text.includes('无写')).length, 1, 'the nudge is not repeated')
})

test('every delivered message is a complete user message the session layer accepts', async () => {
  const h = createHarness({ stall: { nudgeAfterSteps: 1, blockAfterSteps: 2 } })
  const parent = h.agent({ id: 'parent-2', origin: 'main' })
  const child = h.agent({ id: 'child-3', origin: 'subagent', parent: 'parent-2', label: '勘察' })
  h.created(child)

  await child.fire('agent/pre-step', { agent: child, messages: [], turn: 1, step: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  await child.fire('agent/request-error', { failure: { code: 'RATE_LIMIT', message: '429' } }, async () => 'delegate')
  await child.fire('agent/request-error', { failure: { code: 'RATE_LIMIT', message: '429' } }, async () => 'delegate')
  await h.ended({ childId: 'child-3', stopReason: 'error' })

  const delivered = [...child.messages, ...parent.messages]
  assert.ok(delivered.length >= 2, 'both the nudge and the notice were delivered')
  for (const message of delivered) {
    assert.equal(message.role, 'user', 'a bare {content} object is rejected by the provider as a message without a role')
    assert.equal(typeof message.id, 'string')
    assert.deepEqual(message.source, { kind: 'user' })
  }
})

test('read-only delegations are recognised from their label or an explicit prompt marker', () => {
  const exempt = { labels: ['只读勘察'], promptPatterns: ['【只读】', 'read-only', '不要写', '禁止写'] }

  assert.equal(isReadOnlyDelegation({ label: '只读勘察', prompt: '随便' }, exempt), true, 'an exempt label wins')
  assert.equal(isReadOnlyDelegation({ label: '统计', prompt: '【只读】数一下根目录 md' }, exempt), true)
  assert.equal(isReadOnlyDelegation({ label: '统计', prompt: '只读查看，不要写任何文件' }, exempt), true)
  assert.equal(isReadOnlyDelegation({ label: '实现 Task 1', prompt: '实现提示音，不要修改无关代码' }, exempt), false,
    '"不要修改" alone is not a read-only signal')
  assert.equal(isReadOnlyDelegation({ label: '实现 Task 1', prompt: '实现提示音并提交' }, exempt), false)
})

test('a read-only delegation is never blocked by the stall guard', async () => {
  const h = createHarness({ stall: { nudgeAfterSteps: 2, blockAfterSteps: 3 } })
  const parent = h.agent({ id: 'parent-3', origin: 'main' })
  await h.delegation(parent, { description: '只读统计', prompt: '只读统计根目录 md 数量，不要写任何文件' })

  const child = h.agent({ id: 'child-4', origin: 'subagent', parent: 'parent-3', label: '只读统计' })
  h.created(child)

  const step = async () => child.fire('agent/pre-step', { agent: child, messages: [], turn: 1, step: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  for (let i = 0; i < 5; i++) {
    assert.notDeepEqual(await step(), { kind: 'reject' }, 'an exempt child is never blocked')
  }
  assert.equal(child.messages.filter(m => m.text.includes('无写')).length, 0, 'no nudge for an exempt child')
})

test('a write delegation seen through the same channel is still guarded', async () => {
  const h = createHarness({ stall: { nudgeAfterSteps: 2, blockAfterSteps: 3 } })
  const parent = h.agent({ id: 'parent-4', origin: 'main' })
  await h.delegation(parent, { description: '实现 Task 9', prompt: '实现功能并提交' })

  const child = h.agent({ id: 'child-5', origin: 'subagent', parent: 'parent-4', label: '实现 Task 9' })
  h.created(child)

  const step = async () => child.fire('agent/pre-step', { agent: child, messages: [], turn: 1, step: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  await step()
  await step()
  assert.deepEqual(await step(), { kind: 'reject' })
})

// ---------------------------------------------------------------------------

/** Build a fake host context plus agent double factory over the plugin. */
function createHarness(config = {}) {
  const root = new Map()
  const agents = new Map()
  const ctx = {
    on(name, listener) {
      const list = root.get(name) ?? []
      list.push(listener)
      root.set(name, list)
      return () => {}
    },
    get() {
      return undefined
    },
    agents: { get: id => agents.get(id) },
  }
  plugin.apply(ctx, config)

  const agent = ({ id, origin, parent, label }) => {
    const scoped = new Map()
    const messages = []
    /** Record one delivered message, flattening content blocks to `text`. */
    const record = (message) => {
      const text = typeof message?.text === 'string'
        ? message.text
        : (message?.content ?? []).map(block => block?.text ?? '').join('')
      messages.push({ ...message, text })
    }
    const double = {
      id,
      messages,
      session: {
        header: { origin, parentSession: parent, delegationDepth: origin === 'subagent' ? 1 : 0 },
        snapshotEvents: () => (label === undefined ? [] : [{ type: 'subagent/descriptor', data: { label } }]),
      },
      ctx: {
        on(name, listener) {
          const list = scoped.get(name) ?? []
          list.push(listener)
          scoped.set(name, list)
          return () => {}
        },
        effect(run) {
          run()
        },
      },
      steer(message) {
        record(message)
      },
      followup(message) {
        record(message)
      },
      inject(message) {
        record(message)
      },
      async fire(name, ...args) {
        const list = scoped.get(name) ?? []
        let result
        for (const listener of list) result = await listener(...args)
        return result
      },
    }
    agents.set(id, double)
    return double
  }

  return {
    agent,
    created(agentDouble) {
      for (const listener of root.get('agent/created') ?? []) listener({ agent: agentDouble })
    },
    /** Run one delegation call through the root `tools/pre-execute` listeners. */
    async delegation(parentAgent, args) {
      const exec = { name: 'subagent', arguments: args, agent: parentAgent }
      let decision
      for (const listener of root.get('tools/pre-execute') ?? []) {
        decision = await listener(exec, async () => ({ kind: 'allow' }))
      }
      return decision
    },
    async ended(info) {
      for (const listener of root.get('subagent/end') ?? []) await listener(info)
    },
  }
}
