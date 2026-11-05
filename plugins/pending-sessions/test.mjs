// Offline regression for client.js — no DSH process, no dependencies.
//
//   node test.mjs
//
// client.js is a lazy-CJS registration script (`window.__ModuleLoader__.load`),
// so the harness fakes the loader, captures the factory, and calls it with a
// minimal `react` seed. The decision core (filter / map / sort / main-view
// exclusion / notification edges, throttle, merge) is pure and fully covered
// here; the mounting guard of apply() and the package/locale manifests are
// checked too. Rendering needs the real slot host and is covered by the README
// acceptance steps instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const readJson = (relative) => JSON.parse(readFileSync(join(here, relative), 'utf8'))

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registrations.push(entry)
    },
  },
}

await import('./client.js')

test('client.js registers itself once under the package id', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'pending-sessions')
  assert.equal(typeof registrations[0].factory, 'function')
})

const plugin = registrations[0].factory((specifier) => {
  if (specifier === 'react') {
    return {
      createElement: () => null,
      useEffect: () => {},
      useState: () => [false, () => {}],
    }
  }
  throw new Error(`unexpected require('${specifier}')`)
})

const {
  pendingKindOf,
  runningCountOf,
  subagentIdsOf,
  buildItems,
  excludeMain,
  pickMainSessionId,
  detectFresh,
  shouldNotify,
  formatNotification,
  pillStateOf,
  summaryOf,
  nextCollapsed,
} = plugin.pure

// --- fixtures ---------------------------------------------------------------

const idle = (extra = {}) => ({
  running: false,
  pendingInteraction: undefined,
  completionUnread: false,
  ...extra,
})

const running = (extra = {}) => idle({ running: true, ...extra })

const row = (id, title, updatedAt) => ({ id, title, updatedAt, retainedBy: {} })

// Frozen signal: sessions.list.byId[id].origin === 'subagent' (official
// sidebar sessionVisible() hides on the same field).
const subagentRow = (id, title, updatedAt) => ({ ...row(id, title, updatedAt), origin: 'subagent' })

const list = (rows, extra = {}) => ({
  phase: 'ready',
  ids: rows.map((entry) => entry.id),
  byId: Object.fromEntries(rows.map((entry) => [entry.id, entry])),
  ...extra,
})

const workspaceList = (...items) => ({ phase: 'ready', items })

const workspace = (workspaceId, title, path, sessionIds) => ({ workspaceId, title, path, sessionIds })

// --- filter -----------------------------------------------------------------

test('approval, question and plan-review interactions all count as blocking', () => {
  const statuses = new Map([
    ['s-approval', idle({ pendingInteraction: { kind: 'approval' } })],
    ['s-question', idle({ pendingInteraction: { kind: 'question' } })],
    ['s-plan', idle({ pendingInteraction: { kind: 'plan-review' } })],
  ])
  const items = buildItems({
    statuses,
    sessions: list([row('s-approval', 'A', 1), row('s-question', 'B', 2), row('s-plan', 'C', 3)]),
    workspaces: workspaceList(),
  })
  const kinds = Object.fromEntries(items.map((item) => [item.sessionId, item.kind]))
  assert.deepEqual(kinds, { 's-approval': 'approval', 's-question': 'question', 's-plan': 'plan-review' })
  assert.ok(items.every((item) => item.blocking === true))
})

test('only a finished turn with an unread reply counts as unread', () => {
  const statuses = new Map([
    ['unread', idle({ completionUnread: true })],
    ['running', running()],
    ['read', idle()],
    ['stale', idle({ completionUnread: false })],
  ])
  const items = buildItems({
    statuses,
    sessions: list([row('unread', 'U', 10), row('running', 'R', 20), row('read', 'D', 30), row('stale', 'S', 40)]),
    workspaces: workspaceList(),
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].sessionId, 'unread')
  assert.equal(items[0].kind, 'unread')
  assert.equal(items[0].blocking, false)
})

test('pendingInteraction wins over completionUnread and unknown kinds stay blocking', () => {
  assert.equal(pendingKindOf(undefined), undefined)
  assert.equal(pendingKindOf(null), undefined)
  assert.equal(pendingKindOf(idle()), undefined)
  assert.equal(
    pendingKindOf(idle({ pendingInteraction: { kind: 'approval' }, completionUnread: true })),
    'approval',
  )
  assert.equal(pendingKindOf(idle({ pendingInteraction: { kind: 'question' }, completionUnread: true })), 'question')
  assert.equal(pendingKindOf(idle({ pendingInteraction: { kind: 'something-new' } })), 'pending')
  assert.equal(pendingKindOf(idle({ pendingInteraction: {} })), 'pending')
  assert.equal(pendingKindOf(idle({ completionUnread: true })), 'unread')
})

// --- subagent filter --------------------------------------------------------

test('subagentIdsOf reads only the frozen origin signal', () => {
  assert.deepEqual([...subagentIdsOf(list([row('top', 'T', 1), subagentRow('child', 'C', 2)]))], ['child'])
  assert.deepEqual([...subagentIdsOf(list([row('a', 'A', 1), { ...row('b', 'B', 2), origin: 'main' }]))], [])
  assert.deepEqual([...subagentIdsOf(undefined)], [])
  assert.deepEqual([...subagentIdsOf({ phase: 'pending', ids: [], byId: {} })], [])
  assert.deepEqual([...subagentIdsOf({ ids: [] })], [])
})

test('buildItems drops subagent sessions from the list and the count', () => {
  const statuses = new Map([
    ['top-approval', idle({ pendingInteraction: { kind: 'approval' } })],
    ['child-question', idle({ pendingInteraction: { kind: 'question' } })],
    ['child-unread', idle({ completionUnread: true })],
  ])
  const items = buildItems({
    statuses,
    sessions: list([
      row('top-approval', 'Top', 1),
      subagentRow('child-question', 'Child Q', 2),
      subagentRow('child-unread', 'Child U', 3),
    ]),
    workspaces: workspaceList(workspace('w1', 'ws', 'C:\\p\\ws', ['top-approval', 'child-question', 'child-unread'])),
  })
  assert.deepEqual(items.map((item) => item.sessionId), ['top-approval'])
})

test('a subagent id that left the list is still dropped while its row is present', () => {
  const items = buildItems({
    statuses: new Map([
      ['child', idle({ pendingInteraction: { kind: 'approval' } })],
      ['top', idle({ completionUnread: true })],
    ]),
    // ids does not list the child, but byId still carries its origin.
    sessions: { phase: 'ready', ids: ['top'], byId: { child: subagentRow('child', 'C', 5), top: row('top', 'T', 1) } },
    workspaces: workspaceList(),
  })
  assert.deepEqual(items.map((item) => item.sessionId), ['top'])
})

test('an orphan id (status without a list row) is kept, never guessed a subagent', () => {
  const items = buildItems({
    statuses: new Map([
      ['orphan', idle({ pendingInteraction: { kind: 'approval' } })],
      ['child', idle({ completionUnread: true })],
    ]),
    sessions: list([subagentRow('child', 'C', 1)]),
    workspaces: workspaceList(),
  })
  assert.deepEqual(items.map((item) => item.sessionId), ['orphan'])
})

// --- sort -------------------------------------------------------------------

test('blocking entries lead and each group is newest-first', () => {
  const statuses = new Map([
    ['unread-newest', idle({ completionUnread: true })],
    ['blocking-old', idle({ pendingInteraction: { kind: 'approval' } })],
    ['unread-old', idle({ completionUnread: true })],
    ['blocking-new', idle({ pendingInteraction: { kind: 'plan-review' } })],
  ])
  const items = buildItems({
    statuses,
    sessions: list([
      row('unread-newest', 'U1', 400),
      row('blocking-old', 'B1', 100),
      row('unread-old', 'U2', 200),
      row('blocking-new', 'B2', 300),
    ]),
    workspaces: workspaceList(),
  })
  assert.deepEqual(items.map((item) => item.sessionId), ['blocking-new', 'blocking-old', 'unread-newest', 'unread-old'])
})

test('missing updatedAt sorts as oldest and ties break on session id', () => {
  const statuses = new Map([
    ['b', idle({ pendingInteraction: { kind: 'approval' } })],
    ['a', idle({ pendingInteraction: { kind: 'approval' } })],
    ['c', idle({ pendingInteraction: { kind: 'approval' } })],
  ])
  const items = buildItems({
    statuses,
    sessions: {
      phase: 'ready',
      ids: ['b', 'a', 'c'],
      byId: { b: { id: 'b', title: 'B', updatedAt: 5 }, a: { id: 'a', title: 'A' }, c: { id: 'c', title: 'C', updatedAt: 5 } },
    },
    workspaces: workspaceList(),
  })
  assert.deepEqual(items.map((item) => item.sessionId), ['b', 'c', 'a'])
})

// --- workspace mapping ------------------------------------------------------

test('workspace membership is reverse-looked-up through sessionIds', () => {
  const statuses = new Map([['s1', idle({ completionUnread: true })], ['s2', idle({ pendingInteraction: { kind: 'question' } })]])
  const items = buildItems({
    statuses,
    sessions: list([row('s1', 'One', 1), row('s2', 'Two', 2)]),
    workspaces: workspaceList(workspace('w1', 'scale-03', 'C:\\p\\scale-03', ['s1', 's2'])),
  })
  assert.deepEqual(items.map((item) => [item.sessionId, item.workspace]), [['s2', 'scale-03'], ['s1', 'scale-03']])
  assert.ok(items.every((item) => item.workspaceKnown === true))
})

test('a session outside every workspace reports no workspace and does not crash', () => {
  const statuses = new Map([['stray', idle({ pendingInteraction: { kind: 'approval' } })]])
  const items = buildItems({
    statuses,
    sessions: list([row('stray', 'Stray', 1)]),
    workspaces: workspaceList(workspace('w1', 'somewhere', 'C:\\p\\somewhere', ['other'])),
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].workspace, '')
  assert.equal(items[0].workspaceKnown, false)
})

test('default-workspace falls back to the path basename, else the caller localizes it', () => {
  const statuses = new Map([['d1', idle({ completionUnread: true })], ['d2', idle({ completionUnread: true })]])
  const items = buildItems({
    statuses,
    sessions: list([row('d1', 'D1', 1), row('d2', 'D2', 2)]),
    workspaces: workspaceList(
      workspace('w0', 'default-workspace', 'C:\\Users\\me', ['d1']),
      workspace('w1', 'default-workspace', '', ['d2']),
    ),
  })
  assert.deepEqual(items.map((item) => [item.sessionId, item.workspace, item.workspaceKnown]), [['d2', '', true], ['d1', 'me', true]])
})

test('a status-only session (not yet in the list) still surfaces', () => {
  const items = buildItems({
    statuses: new Map([['ghost', idle({ pendingInteraction: { kind: 'approval' } })]]),
    sessions: { phase: 'pending', ids: [], byId: {} },
    workspaces: workspaceList(),
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].sessionId, 'ghost')
  assert.equal(items[0].title, '')
  assert.equal(items[0].updatedAt, 0)
})

// --- main-view exclusion ----------------------------------------------------

test('the current main-view session is excluded from the list', () => {
  const statuses = new Map([
    ['main', idle({ pendingInteraction: { kind: 'approval' } })],
    ['other', idle({ completionUnread: true })],
  ])
  const items = buildItems({
    statuses,
    sessions: list([row('main', 'Main', 9), row('other', 'Other', 1)]),
    workspaces: workspaceList(),
  })
  assert.deepEqual(excludeMain(items, 'main').map((item) => item.sessionId), ['other'])
  assert.deepEqual(excludeMain(items, 'missing').map((item) => item.sessionId), ['main', 'other'])
  assert.deepEqual(excludeMain(items, undefined).map((item) => item.sessionId), ['main', 'other'])
})

test('main session id prefers uiWorkspace.selection and falls back to retainedBy.mainView', () => {
  const sessions = list([{ ...row('from-retain', 'R', 1), retainedBy: { mainView: 1 } }, row('x', 'X', 2)])
  assert.equal(pickMainSessionId({ sessionId: 'from-selection' }, sessions), 'from-selection')
  assert.equal(pickMainSessionId({}, sessions), 'from-retain')
  assert.equal(pickMainSessionId(undefined, sessions), 'from-retain')
  assert.equal(pickMainSessionId({}, { phase: 'ready', ids: [], byId: {} }), undefined)
})

// --- empty list -------------------------------------------------------------

test('empty inputs produce an empty list', () => {
  assert.deepEqual(buildItems({ statuses: new Map(), sessions: { phase: 'pending', ids: [], byId: {} }, workspaces: { phase: 'pending', items: [] } }), [])
  assert.deepEqual(buildItems({}), [])
})

// --- running count / three-state pill ---------------------------------------

test('runningCountOf counts every running session, subagent children included', () => {
  const statuses = new Map([
    ['top-running', running()],
    ['child-running', running()],
    ['idle', idle()],
    ['unread-only', idle({ completionUnread: true })],
  ])
  const sessions = list([
    row('top-running', 'Top', 1),
    subagentRow('child-running', 'Child', 2),
    row('idle', 'Idle', 3),
    row('unread-only', 'Unread', 4),
  ])
  // The pending list filters the child out; the activity count deliberately
  // keeps it (spec §11.1).
  assert.equal(subagentIdsOf(sessions).has('child-running'), true)
  assert.equal(runningCountOf(statuses), 2)
  assert.equal(runningCountOf(new Map()), 0)
  assert.equal(runningCountOf(undefined), 0)
  assert.equal(runningCountOf({ a: running(), b: idle(), c: null }), 1)
})

test('the always-visible pill prioritises running over pending over idle', () => {
  assert.deepEqual(pillStateOf({ running: 2, pending: 1, blocking: true }), { mode: 'running', pulse: true, alert: false, showPendingCount: true })
  assert.deepEqual(pillStateOf({ running: 0, pending: 1, blocking: true }), { mode: 'pending', pulse: false, alert: true, showPendingCount: true })
  assert.deepEqual(pillStateOf({ running: 0, pending: 2, blocking: false }), { mode: 'pending', pulse: false, alert: false, showPendingCount: true })
  assert.deepEqual(pillStateOf({ running: 0, pending: 0 }), { mode: 'idle', pulse: false, alert: false, showPendingCount: false })
  // Collapsed: no pending count, no warning colour; the running animation is
  // unaffected (spec §11.2).
  assert.deepEqual(
    pillStateOf({ running: 0, pending: 2, blocking: true, collapsed: true }),
    { mode: 'collapsed', pulse: false, alert: false, showPendingCount: false },
  )
  assert.deepEqual(
    pillStateOf({ running: 1, pending: 2, collapsed: true }),
    { mode: 'running', pulse: true, alert: false, showPendingCount: false },
  )
  assert.deepEqual(pillStateOf(undefined), { mode: 'idle', pulse: false, alert: false, showPendingCount: false })
})

test('the header summary mirrors the three states', () => {
  assert.deepEqual(summaryOf({ running: 2, pending: 1 }), [{ key: 'pillRunning', count: 2 }, { key: 'summaryPending', count: 1 }])
  assert.deepEqual(summaryOf({ running: 0, pending: 0 }), [{ key: 'pillIdle', count: 0 }])
  assert.deepEqual(summaryOf({ running: 0, pending: 1, collapsed: true }), [{ key: 'summaryPending', count: 1 }, { key: 'pillCollapsed', count: 0 }])
  assert.deepEqual(summaryOf({ running: 1, pending: 0, collapsed: true }), [{ key: 'pillRunning', count: 1 }])
  assert.deepEqual(summaryOf(undefined), [{ key: 'pillIdle', count: 0 }])
})

// --- temporary collapse -----------------------------------------------------

test('collapsing stores every pending id in memory and manual restore forgets it', () => {
  const fold = nextCollapsed(new Set(), { pending: new Set(['a', 'b']), action: 'collapse' })
  assert.deepEqual([...fold.collapsed].sort(), ['a', 'b'])
  assert.equal(fold.restored, false)
  assert.equal(fold.changed, true)

  const restored = nextCollapsed(fold.collapsed, { action: 'restore' })
  assert.deepEqual([...restored.collapsed], [])
  assert.equal(restored.restored, true)

  // Nothing collapsed: manual restore is a no-op.
  assert.deepEqual(
    nextCollapsed(new Set(), { action: 'restore' }),
    { collapsed: new Set(), restored: false, changed: false },
  )
})

test('a fresh session outside the collapsed set auto-restores the list', () => {
  const collapsed = new Set(['a'])
  const fold = nextCollapsed(collapsed, { pending: new Set(['a', 'b']), fresh: ['b'] })
  assert.deepEqual([...fold.collapsed], [])
  assert.equal(fold.restored, true)

  // A fresh id already inside the set is the same episode: no restore.
  const same = nextCollapsed(collapsed, { pending: new Set(['a']), fresh: ['a'] })
  assert.deepEqual([...same.collapsed], ['a'])
  assert.equal(same.restored, false)
  assert.equal(same.changed, false)
})

test('a collapsed id that leaves pending is pruned, so its re-entry is a new episode', () => {
  const collapsed = new Set(['a'])
  const left = nextCollapsed(collapsed, { pending: new Set(), fresh: [] })
  assert.deepEqual([...left.collapsed], [])
  assert.equal(left.restored, false)

  // 'a' re-enters: it is no longer collapsed, so nothing suppresses the list.
  const again = nextCollapsed(left.collapsed, { pending: new Set(['a']), fresh: ['a'] })
  assert.deepEqual([...again.collapsed], [])

  // Enter -> leave -> re-enter is the existing episode semantics, so the
  // re-entry notifies like any new episode.
  const pendingStatus = new Map([['a', idle({ completionUnread: true })]])
  const first = detectFresh(new Set(), pendingStatus)
  assert.deepEqual(first.fresh, ['a'])
  const cleared = detectFresh(first.current, new Map([['a', idle()]]))
  assert.deepEqual(cleared.fresh, [])
  assert.deepEqual(detectFresh(cleared.current, pendingStatus).fresh, ['a'])
})

test('the collapse set starts empty on every mount (refresh resets it)', () => {
  // A fresh controller has no previous set: sessions already pending at mount
  // are not treated as collapsed.
  const mount = nextCollapsed(undefined, { pending: new Set(['a', 'b']), fresh: ['a', 'b'] })
  assert.equal(mount.collapsed instanceof Set, true)
  assert.deepEqual([...mount.collapsed], [])
  assert.equal(mount.restored, false)

  // The fold never aliases the caller's set: state is rebuilt, not mutated.
  const previous = new Set(['a'])
  const folded = nextCollapsed(previous, { pending: new Set(['a']) })
  assert.notEqual(folded.collapsed, previous)
  assert.deepEqual([...folded.collapsed], ['a'])
})

// --- notifications ----------------------------------------------------------

test('an edge fires once per pending episode', () => {
  const statuses = new Map([['s1', idle({ pendingInteraction: { kind: 'question' } })]])
  const first = detectFresh(new Set(), statuses)
  assert.deepEqual(first.fresh, ['s1'])
  assert.deepEqual([...first.current], ['s1'])

  const same = detectFresh(first.current, statuses)
  assert.deepEqual(same.fresh, [])

  const cleared = detectFresh(same.current, new Map([['s1', idle()]]))
  assert.deepEqual(cleared.fresh, [])
  assert.deepEqual([...cleared.current], [])

  const again = detectFresh(cleared.current, statuses)
  assert.deepEqual(again.fresh, ['s1'])
})

test('a batch of simultaneous entries reports every fresh session once', () => {
  const statuses = new Map([
    ['a', idle({ pendingInteraction: { kind: 'approval' } })],
    ['b', idle({ completionUnread: true })],
    ['c', running()],
  ])
  const { fresh, current } = detectFresh(new Set(), statuses)
  assert.deepEqual(fresh, ['a', 'b'])
  assert.deepEqual([...current], ['a', 'b'])
})

test('detectFresh drops excluded subagents from current and fresh', () => {
  const statuses = new Map([
    ['child', idle({ pendingInteraction: { kind: 'approval' } })],
    ['top', idle({ completionUnread: true })],
  ])
  const excluded = new Set(['child'])
  const first = detectFresh(new Set(), statuses, excluded)
  assert.deepEqual(first.fresh, ['top'])
  assert.deepEqual([...first.current], ['top'])

  // The child is already pending next round: still no edge, still no episode.
  const same = detectFresh(first.current, statuses, excluded)
  assert.deepEqual(same.fresh, [])
  assert.deepEqual([...same.current], ['top'])

  // Top-level session clears and re-enters: that is a new episode.
  const cleared = detectFresh(same.current, new Map([['child', idle({ pendingInteraction: { kind: 'approval' } })]]), excluded)
  assert.deepEqual(cleared.fresh, [])
  assert.deepEqual([...cleared.current], [])
  assert.deepEqual(detectFresh(cleared.current, statuses, excluded).fresh, ['top'])
})

test('detectFresh without the third argument keeps the old behaviour', () => {
  const statuses = new Map([['child', idle({ completionUnread: true })]])
  for (const excluded of [undefined, new Set()]) {
    const { current, fresh } = detectFresh(new Set(), statuses, excluded)
    assert.deepEqual([...current], ['child'])
    assert.deepEqual(fresh, ['child'])
  }
})

test('notifications require an unfocused window, a fresh edge and usable permission', () => {
  assert.equal(shouldNotify({ fresh: ['a'], focused: false, permission: 'granted' }), true)
  assert.equal(shouldNotify({ fresh: ['a'], focused: false, permission: 'default' }), true)
  assert.equal(shouldNotify({ fresh: ['a'], focused: true, permission: 'granted' }), false)
  assert.equal(shouldNotify({ fresh: ['a'], focused: false, permission: 'denied' }), false)
  assert.equal(shouldNotify({ fresh: [], focused: false, permission: 'granted' }), false)
  assert.equal(shouldNotify(undefined), false)
})

const fakeT = (key, params) => (params === undefined ? key : key + ':' + JSON.stringify(params))

test('a single notification names kind, workspace and title', () => {
  const payload = formatNotification([{
    sessionId: 's1',
    kind: 'question',
    blocking: true,
    workspace: 'scale-03',
    workspaceKnown: true,
    title: '成本模块审查',
    updatedAt: 1,
  }], fakeT)
  assert.deepEqual(payload, { title: 'kindQuestion · scale-03 · 成本模块审查', body: '', sessionId: 's1' })
})

test('several fresh sessions merge into one digest notification', () => {
  const items = [
    { sessionId: 's1', kind: 'approval', blocking: true, workspace: 'w1', workspaceKnown: true, title: 'T1', updatedAt: 3 },
    { sessionId: 's2', kind: 'unread', blocking: false, workspace: '', workspaceKnown: false, title: 'T2', updatedAt: 2 },
  ]
  const payload = formatNotification(items, fakeT)
  assert.equal(payload.title, 'notifyDigestTitle:{"count":2}')
  assert.equal(payload.body, 'kindApproval · w1 · T1\nkindUnread · T2')
  assert.equal(payload.sessionId, 's1')
})

test('a large batch keeps the digest to three lines plus a remainder hint', () => {
  const kinds = ['approval', 'question', 'plan-review', 'unread', 'pending']
  const items = kinds.map((kind, index) => ({
    sessionId: 's' + index,
    kind,
    blocking: kind !== 'unread',
    workspace: '',
    workspaceKnown: false,
    title: 'T' + index,
    updatedAt: 10 - index,
  }))
  const payload = formatNotification(items, fakeT)
  assert.equal(payload.title, 'notifyDigestTitle:{"count":5}')
  assert.equal(payload.body.split('\n').length, 4)
  assert.match(payload.body, /notifyDigestMore:\{"count":2\}$/)
})

test('an empty batch produces no payload', () => {
  assert.equal(formatNotification([], fakeT), undefined)
  assert.equal(formatNotification(undefined, fakeT), undefined)
})

// --- wiring guards ----------------------------------------------------------

test('apply stays inactive and only warns when a required service is missing', () => {
  assert.equal(plugin.NS, 'pendingSessions')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace'])
  assert.equal(typeof plugin.apply, 'function')

  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    plugin.apply({
      get: () => undefined,
      effect: () => {
        throw new Error('must not activate')
      },
    })
  } finally {
    console.warn = original
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /pending-sessions: missing services/)
})

// --- manifests and locale docs ---------------------------------------------

test('package manifest advertises the Host row, the client bundle and the patch', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'pending-sessions')
  assert.equal(pkg.main, './plugin.mjs')
  assert.equal(pkg.exports['.'], './plugin.mjs')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const required of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-workspace']) {
    assert.ok(pkg.dsh.client.inject.includes(required), `dsh.client.inject must list ${required}`)
  }
})

test('locale docs parse and their ui sections mirror the bundle dictionaries', () => {
  const docs = { zh: readJson('locale/zh.json'), en: readJson('locale/en.json') }
  for (const language of ['zh', 'en']) {
    const doc = docs[language]
    assert.equal(typeof doc.meta.title, 'string')
    assert.ok(doc.meta.title.length > 0)
    assert.equal(typeof doc.meta.description, 'string')
    const bundle = plugin.dictionaries[language]
    assert.deepEqual(Object.keys(bundle).sort(), Object.keys(doc.ui).sort(), `${language} keys drifted`)
    for (const key of Object.keys(doc.ui)) assert.equal(bundle[key], doc.ui[key], `${language}.${key} drifted`)
  }
})
