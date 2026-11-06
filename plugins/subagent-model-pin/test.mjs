// Offline regression for plugin.mjs — no DSH process, no dependencies.
//
//   node test.mjs
//
// The harness fakes the two extension points the plugin uses:
//   - `tools/execute`   (waterfall around a delegation tool call)
//   - `agent/created`   (per-child setup)
// plus the per-agent `agent.model` (AgentModel) the created handler pins:
// `current()`, `select()`, and the durable `model/selection` events a select
// appends. The `llm` service is faked too, because the plugin asks
// `listProviders()` before selecting a route.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'

import * as plugin from './plugin.mjs'

const PIN = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', effort: 'high' }
const PARENT_ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' }

/**
 * Build a fake host context around the plugin.
 * @param overrides - extra plugin config merged over the pin defaults.
 * @param options - harness options (`providers`, `llm`), see `createHarnessWith`.
 */
function createHarness(overrides = {}, options = {}) {
  return createHarnessWith({
    provider: PIN.provider,
    model: PIN.model,
    reasoningEffort: PIN.effort,
    ...overrides,
  }, options)
}

/**
 * Build a harness whose config comes from the real schemastery `Config` schema,
 * so volatile fields arrive as the `{ get() }` references cordis would supply.
 * @param overrides - raw config passed through `plugin.Config`.
 * @returns the harness plus the validated `config` (for `updateVolatile`).
 */
function createSchemaHarness(overrides = {}) {
  const config = plugin.Config({
    provider: PIN.provider,
    model: PIN.model,
    reasoningEffort: PIN.effort,
    ...overrides,
  })
  return { config, ...createHarnessWith(config) }
}

/** Detach one selection the way the runtime's `toSelection` does. */
function selection(provider, model, reasoningEffort) {
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/**
 * Minimal AgentModel: `current()` projects `pending ?? lastUsed ?? options` and
 * `select()` appends a durable `model/selection` event unless the selection is
 * already the recorded one — exactly what dsh-agent's implementation does.
 * @param options - creation-time route (`{ provider, model, reasoningEffort? }`).
 * @param recorded - a selection already on the books (simulates resume, where
 *   the descriptor route was selected during setup before `agent/created`).
 * @param append - sink for appended events (the fake session).
 */
function createAgentModel({ options, recorded, append }) {
  let pending = recorded === undefined ? null : selection(recorded.provider, recorded.model, recorded.reasoningEffort)
  let lastUsed = null
  const sameSelection = (left, right) => left !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
  return {
    current() {
      const recordedSelection = pending ?? lastUsed
      if (recordedSelection !== null) return { ...recordedSelection }
      const { provider, model, reasoningEffort } = options ?? {}
      return typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0
        ? selection(provider, model, reasoningEffort)
        : undefined
    },
    select(next) {
      const chosen = selection(next.provider, next.model, next.reasoningEffort)
      if (sameSelection(pending ?? lastUsed, chosen)) return
      pending = chosen
      append('model/selection', chosen)
    },
  }
}

/**
 * Build a fake host context around the plugin from a ready-made config.
 * @param config - the exact config object handed to `plugin.apply`.
 * @param options - `providers`: provider ids the fake llm reports from
 *   `listProviders()` (empty = runtime cannot answer, the plugin must not
 *   block); `llm: false` removes the llm service entirely.
 */
function createHarnessWith(config, { providers = [], llm = true } = {}) {
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
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'llm' && llm) {
        return { listProviders: () => providers.map((id) => ({ id, name: id })) }
      }
      return undefined
    },
  }

  plugin.apply(ctx, config)

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

    /**
     * Create a child agent, run the `agent/created` listeners, and report what
     * the plugin did to it.
     * @param options - child id, session header, pre-existing session events,
     *   creation-time route (`options`) and an already-recorded selection
     *   (`recorded`, for resume).
     */
    async createChild({
      id = 'child-1',
      header = { origin: 'subagent', parentSession: 'parent' },
      events = [],
      options,
      recorded,
    } = {}) {
      const listeners = new Map()
      const appended = []
      const sink = (type, data) => {
        appended.push({ type, data })
        events.push({ type, data })
      }
      const agent = {
        id,
        session: {
          header,
          snapshotEvents: () => events,
          append: sink,
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
        model: createAgentModel({ options, recorded, append: sink }),
      }
      for (const listener of rootEvents.get('agent/created') ?? []) await listener({ agent })
      // Contract C4: the plugin pins through agent.model, never agent/request.
      assert.equal(listeners.get('agent/request')?.length ?? 0, 0, 'the plugin must not register agent/request')
      return {
        agent,
        appended,
        /** Route selections the plugin appended, in order. */
        selections: appended.filter((event) => event.type === 'model/selection').map((event) => event.data),
        /** Current route after the created handlers ran. */
        current: () => agent.model.current(),
        /** Always empty; kept so the workflow case can state it explicitly. */
        requestListeners: () => listeners.get('agent/request') ?? [],
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
/** A role whose route differs from both the pin and the parent route. */
const ROLE_ROUTE = { match: 'Survey', provider: 'deepseek-official', model: 'deepseek-reasoner' }

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

test('an explicit route still beats a role route', async () => {
  // The role matches the label, so only the explicit delegation arguments can
  // keep the stronger route — this is the injection-path counterpart of R3
  // outranking R4. The explicit route differs from the role route *and* from the
  // pin route, so an injector that overrode it (with either) would show up here.
  const h = createHarness({ roles: [SURVEY_ROLE] })
  const args = await h.execute('subagent', {
    description: 'Survey upgrade',
    prompt: 'p',
    provider: 'somewhere',
    model: 'strong-model',
    reasoning_effort: 'high',
  })
  assert.equal(args.provider, 'somewhere')
  assert.equal(args.model, 'strong-model')
  assert.equal(args.description, 'Survey upgrade')
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

// --- behaviour matrix R1-R6 (agent/created select) ---------------------------

test('R1: a non-subagent agent is left alone', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ header: {}, events: [], options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [])
  assert.deepEqual(child.current(), PARENT_ROUTE)
})

test('R1: only the configured delegation depth is pinned', async () => {
  const h = createHarness({ depth: 2 })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))

  const shallow = await h.createChild({
    header: { origin: 'subagent', parentSession: 'parent', delegationDepth: 1 },
    options: { ...PARENT_ROUTE },
  })
  assert.deepEqual(shallow.selections, [])

  const deep = await h.createChild({
    id: 'child-2',
    header: { origin: 'subagent', parentSession: 'parent', delegationDepth: 2 },
    options: { ...PARENT_ROUTE },
  })
  assert.deepEqual(deep.selections, [selection(PIN.provider, PIN.model, PIN.effort)])
})

test('R2: force:true selects the pin route even over an explicit choice', async () => {
  const h = createHarness({ force: true })
  h.sessions.set('parent', h.session({
    events: delegationCall('upgrade', { provider: PARENT_ROUTE.provider, model: PARENT_ROUTE.model }),
    parentRoute: PARENT_ROUTE,
  }))
  const child = await h.createChild({ events: descriptor('upgrade'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [selection(PIN.provider, PIN.model, PIN.effort)])
})

test('R3: keeps an explicit upgrade that happens to equal the parent route', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({
    events: delegationCall('upgrade', { provider: PARENT_ROUTE.provider, model: PARENT_ROUTE.model, reasoning_effort: 'high' }),
    parentRoute: PARENT_ROUTE,
  }))
  const child = await h.createChild({ events: descriptor('upgrade'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [])
  assert.deepEqual(child.current(), PARENT_ROUTE)
})

test('R3: keeps an explicit route that differs from both pin and parent', async () => {
  const explicit = { provider: 'somewhere', model: 'strong-model' }
  // The label also hits a role, so this anchors the matrix order: an explicit
  // choice wins over R4 as well, and the created handler selects nothing.
  const h = createHarness({ roles: [SURVEY_ROLE] })
  h.sessions.set('parent', h.session({
    events: delegationCall('Survey audit', { provider: explicit.provider, model: explicit.model }),
    parentRoute: PARENT_ROUTE,
  }))
  const child = await h.createChild({ events: descriptor('Survey audit'), options: { ...explicit } })

  assert.deepEqual(child.selections, [])
  assert.deepEqual(child.current(), explicit)
})

test('R4: a role route is selected over the inherited parent route', async () => {
  const h = createHarness({ roles: [ROLE_ROUTE] })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('Survey Task 1'), options: { ...PARENT_ROUTE } })

  // The role names no effort, so it inherits the default pin effort.
  assert.deepEqual(child.selections, [selection(ROLE_ROUTE.provider, ROLE_ROUTE.model, PIN.effort)])
})

test('R4: a role route already in place produces no selection event', async () => {
  const h = createHarness({ roles: [ROLE_ROUTE] })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({
    events: descriptor('Survey settled'),
    options: { provider: ROLE_ROUTE.provider, model: ROLE_ROUTE.model },
  })

  assert.deepEqual(child.selections, [])
})

test('R5: keeps a differing current route when no delegation call matches (workflow / cold resume)', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({
    events: descriptor('workflow child 9'),
    options: { provider: 'somewhere', model: 'other-model' },
  })

  assert.deepEqual(child.selections, [])
})

test('R6: pins when the delegation call explicitly asked for nothing', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ events: delegationCall('inherit'), parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('inherit'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [selection(PIN.provider, PIN.model, PIN.effort)])
  assert.deepEqual(child.current(), selection(PIN.provider, PIN.model, PIN.effort))
})

test('R6: a resumed child already on the pin route selects nothing', async () => {
  const h = createHarness()
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({
    events: [...descriptor('plain'), { type: 'model/selection', data: selection(PIN.provider, PIN.model, PIN.effort) }],
    options: { ...PARENT_ROUTE },
    recorded: selection(PIN.provider, PIN.model, PIN.effort),
  })

  assert.deepEqual(child.selections, [])
})

test('workflow child with an uncommitted parent call is pinned and never touches agent/request', async () => {
  const h = createHarness()
  // Parent session exists but carries no delegated `tool/call` for this label.
  h.sessions.set('parent', h.session({ events: [], parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('workflow child 1'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [selection(PIN.provider, PIN.model, PIN.effort)])
  assert.deepEqual(child.requestListeners(), [])
})

test('select carries the configured reasoning effort', async () => {
  const h = createHarness({ reasoningEffort: 'minimal' })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('plain'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [selection(PIN.provider, PIN.model, 'minimal')])
})

test('an empty configured effort produces a selection without an effort field', async () => {
  const h = createHarness({ reasoningEffort: '' })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('plain'), options: { ...PARENT_ROUTE } })

  assert.equal(child.selections.length, 1)
  assert.equal(child.selections[0].provider, PIN.provider)
  assert.equal(child.selections[0].model, PIN.model)
  assert.equal('reasoningEffort' in child.selections[0], false)
})

// --- route validity (llm.listProviders) -------------------------------------

test('selects when the pin provider is registered with the llm service', async () => {
  const h = createHarness({}, { providers: [PIN.provider, PARENT_ROUTE.provider] })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('plain'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [selection(PIN.provider, PIN.model, PIN.effort)])
})

test('skips the pin when no adapter serves the configured provider', async () => {
  const h = createHarness({}, { providers: [PARENT_ROUTE.provider] })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('plain'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [])
  assert.deepEqual(child.current(), PARENT_ROUTE)
})

test('selects anyway when the runtime cannot answer the provider question', async () => {
  const h = createHarness({}, { llm: false })
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('plain'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [selection(PIN.provider, PIN.model, PIN.effort)])
})

// --- role sandbox -----------------------------------------------------------

const SANDBOX_ROLE = { ...SURVEY_ROLE, sandbox: 'read-only' }

const sandboxEvents = (child) => child.appended.filter((event) => event.type === 'sandbox/mode')

test('roles[].sandbox narrows the matching child before its first tool call', async () => {
  const h = createHarness({ roles: [SANDBOX_ROLE] })
  const child = await h.createChild({ events: descriptor('Survey the repo') })

  assert.deepEqual(sandboxEvents(child), [{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
})

test('no sandbox event for an unmatched label or a role without sandbox', async () => {
  const h = createHarness({ roles: [SANDBOX_ROLE] })
  const impl = await h.createChild({ events: descriptor('Implement something') })
  assert.deepEqual(sandboxEvents(impl), [])

  const h2 = createHarness({ roles: [SURVEY_ROLE] })
  const survey = await h2.createChild({ events: descriptor('Survey something') })
  assert.deepEqual(sandboxEvents(survey), [])
})

test('sandbox is not re-appended when the child already sits in that mode', async () => {
  const h = createHarness({ roles: [SANDBOX_ROLE] })
  const child = await h.createChild({
    events: [...descriptor('Survey settled'), { type: 'sandbox/mode', data: { mode: 'read-only' } }],
  })
  assert.deepEqual(sandboxEvents(child), [])
})

test('unknown sandbox modes fail at load', () => {
  assert.throws(() => createHarness({ roles: [{ ...SURVEY_ROLE, sandbox: 'nope' }] }), /sandbox/)
  assert.throws(() => createHarness({ sandbox: 'nope' }), /sandbox/)
})

// --- volatile fields (the Plugins-page config card) -------------------------

const GUI_ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' }

test('a volatile route swap takes effect on the next delegation without re-activation', async () => {
  const { config, execute } = createSchemaHarness()

  const before = await execute('subagent', { description: 'plain', prompt: 'p' })
  assert.equal(before.provider, PIN.provider)
  assert.equal(before.model, PIN.model)

  // What the Host does when the settings document changes: swap the volatile
  // references in place, keeping the same config object and plugin instance.
  updateVolatile(config.provider, createVolatile(GUI_ROUTE.provider))
  updateVolatile(config.model, createVolatile(GUI_ROUTE.model))
  updateVolatile(config.reasoningEffort, createVolatile(GUI_ROUTE.effort))

  const after = await execute('subagent', { description: 'plain again', prompt: 'p' })
  assert.equal(after.provider, GUI_ROUTE.provider)
  assert.equal(after.model, GUI_ROUTE.model)
  assert.equal(after.reasoning_effort, GUI_ROUTE.effort)
})

test('a volatile route swap also changes the route selected at agent/created', async () => {
  const swapped = { provider: 'opencode-go', model: 'deepseek-v4.1-pro', effort: 'low' }
  const { config } = createSchemaHarness()
  updateVolatile(config.provider, createVolatile(swapped.provider))
  updateVolatile(config.model, createVolatile(swapped.model))
  updateVolatile(config.reasoningEffort, createVolatile(swapped.effort))

  const h = createHarnessWith(config)
  h.sessions.set('parent', h.session({ parentRoute: PARENT_ROUTE }))
  const child = await h.createChild({ events: descriptor('plain'), options: { ...PARENT_ROUTE } })

  assert.deepEqual(child.selections, [selection(swapped.provider, swapped.model, swapped.effort)])
})

test('resetting a volatile field back to the YAML value restores the old route', async () => {
  const { config, execute } = createSchemaHarness()
  updateVolatile(config.provider, createVolatile(GUI_ROUTE.provider))
  updateVolatile(config.model, createVolatile(GUI_ROUTE.model))
  updateVolatile(config.provider, createVolatile(PIN.provider))
  updateVolatile(config.model, createVolatile(PIN.model))

  const args = await execute('subagent', { description: 'plain', prompt: 'p' })
  assert.equal(args.provider, PIN.provider)
  assert.equal(args.model, PIN.model)
})

test("an empty volatile effort means 'no pinned effort' again", async () => {
  const { config, execute } = createSchemaHarness()
  updateVolatile(config.reasoningEffort, createVolatile(''))

  const args = await execute('subagent', { description: 'plain', prompt: 'p' })
  assert.equal(args.provider, PIN.provider)
  assert.equal('reasoning_effort' in args, false)
})

test('a role route still beats the volatile default route', async () => {
  const { config, execute } = createSchemaHarness({ roles: [SURVEY_ROLE] })
  updateVolatile(config.provider, createVolatile(GUI_ROUTE.provider))
  updateVolatile(config.model, createVolatile(GUI_ROUTE.model))

  const survey = await execute('subagent', { description: 'Survey W14', prompt: 'p' })
  assert.equal(survey.model, SURVEY_ROLE.model)
  const plain = await execute('subagent', { description: 'Implement W14', prompt: 'p' })
  assert.equal(plain.provider, GUI_ROUTE.provider)
})

test('schema-built config still refuses an empty provider/model at apply', () => {
  assert.throws(() => createSchemaHarness({ provider: '', model: '' }), /provider/)
})

test('debug toggles live: log writes follow the volatile flag', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-log-'))
  const logFile = join(dir, 'pin.log')
  process.env.SUBAGENT_MODEL_PIN_LOG = logFile
  t.after(() => {
    delete process.env.SUBAGENT_MODEL_PIN_LOG
    rmSync(dir, { recursive: true, force: true })
  })

  const { config, execute } = createSchemaHarness({ debug: false })
  await execute('subagent', { description: 'quiet', prompt: 'p' })
  assert.throws(() => readFileSync(logFile), /ENOENT/)

  updateVolatile(config.debug, createVolatile(true))
  await execute('subagent', { description: 'loud', prompt: 'p' })
  const text = readFileSync(logFile, 'utf8')
  assert.match(text, /inject/)
  assert.match(text, /loud/)

  updateVolatile(config.debug, createVolatile(false))
  writeFileSync(logFile, '')
  await execute('subagent', { description: 'quiet again', prompt: 'p' })
  assert.equal(readFileSync(logFile, 'utf8'), '')
})
