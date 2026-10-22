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
      const appended = []
      const agent = {
        id,
        session: {
          header,
          snapshotEvents: () => events,
          append: (type, data) => {
            appended.push({ type, data })
            events.push({ type, data })
          },
        },
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
        appended,
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

const SURVEY_ROLE = { match: 'Survey', provider: 'deepseek-official', model: 'deepseek-flash' }

test('roles route a delegation by description prefix and fall back to the default route', async () => {
  const h = createHarness({ roles: [SURVEY_ROLE] })

  const survey = await h.execute('subagent', { description: 'Survey W14 code', prompt: 'p' })
  assert.equal(survey.provider, 'deepseek-official')
  assert.equal(survey.model, 'deepseek-flash')

  const impl = await h.execute('subagent', { description: 'Implement W14', prompt: 'p' })
  assert.equal(impl.provider, PIN.provider)
  assert.equal(impl.model, PIN.model)
})

test('role matching ignores case and leading whitespace', async () => {
  const h = createHarness({ roles: [{ ...SURVEY_ROLE, match: 'survey' }] })
  const args = await h.execute('subagent', { description: '  SURVEY the code', prompt: 'p' })
  assert.equal(args.model, 'deepseek-flash')
})

test('a role route overrides the inherited-parent-route heuristic at request time', async () => {
  const h = createHarness({ roles: [{ match: 'Review', provider: 'deepseek-official', model: 'deepseek-flash' }] })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))

  const child = await h.createChild({ events: descriptor('Review Task 1') })
  const resolved = await child.request({ ...PARENT_ROUTE, reasoningEffort: 'high' })

  assert.equal(resolved.provider, 'deepseek-official')
  assert.equal(resolved.model, 'deepseek-flash')
})

test('an explicit route still beats a role route', async () => {
  const h = createHarness({ roles: [SURVEY_ROLE] })
  const args = await h.execute('subagent', {
    description: 'Survey explicit',
    prompt: 'p',
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  })
  assert.equal(args.provider, 'opencode-go')
  assert.equal(args.model, 'deepseek-v4.1-flash')
})

test('invalid role configuration fails at load', () => {
  assert.throws(() => createHarness({ roles: [{ match: '', provider: 'p', model: 'm' }] }), /roles/)
  assert.throws(() => createHarness({ roles: [{ match: 'X', provider: 'p' }] }), /model/)
  assert.throws(() => createHarness({ roles: 'nope' }), /roles/)
})

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

// --- role sandbox -----------------------------------------------------------

const SANDBOX_ROLE = { ...SURVEY_ROLE, sandbox: 'read-only' }

test('roles[].sandbox narrows the matching child before its first tool call', async () => {
  const h = createHarness({ roles: [SANDBOX_ROLE] })
  const child = await h.createChild({ events: descriptor('Survey the repo') })

  assert.deepEqual(child.appended, [{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
})

test('no sandbox event for an unmatched label or a role without sandbox', async () => {
  const h = createHarness({ roles: [SANDBOX_ROLE] })
  const impl = await h.createChild({ events: descriptor('Implement something') })
  assert.deepEqual(impl.appended, [])

  const h2 = createHarness({ roles: [SURVEY_ROLE] })
  const survey = await h2.createChild({ events: descriptor('Survey something') })
  assert.deepEqual(survey.appended, [])
})

test('sandbox is not re-appended when the child already sits in that mode', async () => {
  const h = createHarness({ roles: [SANDBOX_ROLE] })
  const child = await h.createChild({
    events: [...descriptor('Survey settled'), { type: 'sandbox/mode', data: { mode: 'read-only' } }],
  })
  assert.deepEqual(child.appended, [])
})

test('unknown sandbox modes fail at load', () => {
  assert.throws(() => createHarness({ roles: [{ ...SURVEY_ROLE, sandbox: 'nope' }] }), /sandbox/)
  assert.throws(() => createHarness({ sandbox: 'nope' }), /sandbox/)
})

