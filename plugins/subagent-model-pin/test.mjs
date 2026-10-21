// Offline regression for plugin.mjs — no DSH process, no dependencies.
//
//   node test.mjs
//
// The harness fakes the two extension points the plugin uses:
//   - `tools/execute`  (waterfall around a delegation tool call)
//   - `agent/created` + per-agent `agent/request` (waterfall returning the route)
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from './plugin.mjs'

const PIN = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', effort: 'high' }
const PARENT_ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' }

/**
 * Build a fake host context around the plugin.
 * @param overrides - extra plugin config merged over the pin defaults.
 */
function createHarness(overrides = {}) {
  const rootEvents = new Map()
  const sessions = new Map()

  const ctx = {
    on(name, listener) {
      const list = rootEvents.get(name) ?? []
      list.push(listener)
      rootEvents.set(name, list)
      return () => {}
    },
    get(name) {
      return name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined
    },
  }

  plugin.apply(ctx, {
    provider: PIN.provider,
    model: PIN.model,
    reasoningEffort: PIN.effort,
    ...overrides,
  })

  const session = ({ events = [], parentRoute } = {}) => ({
    snapshotEvents: () => events,
    requestHeader: () => (parentRoute === undefined ? undefined : { config: parentRoute }),
  })

  return {
    sessions,
    session,

    /** Run one tool call through the `tools/execute` listeners; returns its final arguments. */
    async execute(name, args) {
      const exec = { name, arguments: args }
      for (const listener of rootEvents.get('tools/execute') ?? []) {
        await listener(exec, async () => 'executed')
      }
      return exec.arguments
    },

    /** Create a child agent, then expose its `agent/request` result for a resolved route. */
    async createChild({ id = 'child-1', header = { origin: 'subagent', parentSession: 'parent' }, events = [] } = {}) {
      const listeners = new Map()
      const agent = {
        id,
        session: { header, snapshotEvents: () => events },
        ctx: {
          on(name, listener) {
            const list = listeners.get(name) ?? []
            list.push(listener)
            listeners.set(name, list)
            return () => {}
          },
          effect(fn) {
            fn()
            return () => {}
          },
        },
      }
      for (const listener of rootEvents.get('agent/created') ?? []) await listener({ agent })
      return {
        agent,
        async request(resolved) {
          const chain = listeners.get('agent/request') ?? []
          assert.ok(chain.length <= 1, 'expected at most one agent/request listener')
          if (chain.length === 0) return resolved
          return chain[0]({}, async () => resolved)
        },
      }
    },
  }
}

const descriptor = (label) => [{ type: 'subagent/descriptor', data: { label } }]
const delegationCall = (description, args = {}) => [{
  type: 'tool/call',
  data: { name: 'subagent', arguments: JSON.stringify({ description, ...args }) },
}]

test('injects the pin route into a delegation call that omitted a route', async () => {
  const h = createHarness()
  const args = await h.execute('subagent', { description: 'plain', prompt: 'p' })
  assert.deepEqual(args, {
    description: 'plain',
    prompt: 'p',
    provider: PIN.provider,
    model: PIN.model,
    reasoning_effort: PIN.effort,
  })
})

test('keeps an explicit route on the delegation call', async () => {
  const h = createHarness()
  const args = await h.execute('subagent', {
    description: 'upgrade',
    prompt: 'p',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoning_effort: 'high',
  })
  assert.equal(args.provider, 'deepseek-official')
  assert.equal(args.model, 'deepseek-flash')
  assert.equal(args.description, 'upgrade')
})

test('ignores tools that are not delegation tools', async () => {
  const h = createHarness()
  const args = await h.execute('read', { file_path: 'x' })
  assert.deepEqual(args, { file_path: 'x' })
})

test('injectDelegationDefaults:false leaves delegation arguments untouched', async () => {
  const h = createHarness({ injectDelegationDefaults: false })
  const args = await h.execute('subagent', { description: 'plain', prompt: 'p' })
  assert.deepEqual(args, { description: 'plain', prompt: 'p' })
})

test('pins the request route when the child merely inherited the parent route', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('plain') })

  const resolved = await child.request({ ...PARENT_ROUTE, reasoningEffort: 'high', maxTokens: 256000 })
  assert.deepEqual(resolved, {
    provider: PIN.provider,
    model: PIN.model,
    reasoningEffort: PIN.effort,
    maxTokens: 256000,
  })
})

test('keeps an explicit upgrade that happens to equal the parent route', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({
    events: delegationCall('upgrade', { provider: PARENT_ROUTE.provider, model: PARENT_ROUTE.model, reasoning_effort: 'high' }),
    parentRoute: PARENT_ROUTE,
  }))
  const child = await h.createChild({ events: descriptor('upgrade') })

  const resolved = await child.request({ ...PARENT_ROUTE, reasoningEffort: 'high' })
  assert.equal(resolved.provider, PARENT_ROUTE.provider)
  assert.equal(resolved.model, PARENT_ROUTE.model)
})

test('pins when the delegation call explicitly asked for nothing', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ events: delegationCall('inherit'), parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('inherit') })

  const resolved = await child.request({ ...PARENT_ROUTE, reasoningEffort: 'high' })
  assert.equal(resolved.provider, PIN.provider)
  assert.equal(resolved.model, PIN.model)
})

test('keeps a differing route when no matching delegation call exists (workflow / cold resume)', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('workflow child 1') })

  const resolved = await child.request({ provider: 'somewhere', model: 'other-model' })
  assert.equal(resolved.provider, 'somewhere')
  assert.equal(resolved.model, 'other-model')
})

test('force:true pins even an explicit choice', async () => {
  const h = createHarness({ force: true })
  h.sessions.set('parent', h.session({
    events: delegationCall('upgrade', { provider: PARENT_ROUTE.provider, model: PARENT_ROUTE.model }),
    parentRoute: PARENT_ROUTE,
  }))
  const child = await h.createChild({ events: descriptor('upgrade') })

  const resolved = await child.request({ ...PARENT_ROUTE, reasoningEffort: 'high' })
  assert.equal(resolved.provider, PIN.provider)
  assert.equal(resolved.model, PIN.model)
})

test('drops an inherited reasoning effort when the route is pinned', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('plain') })

  const resolved = await child.request({ ...PARENT_ROUTE, reasoningEffort: 'minimal' })
  assert.equal(resolved.reasoningEffort, PIN.effort)
})

test('a non-subagent agent is left alone', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ header: {}, events: [] })

  const resolved = await child.request({ ...PARENT_ROUTE })
  assert.deepEqual(resolved, PARENT_ROUTE)
})
