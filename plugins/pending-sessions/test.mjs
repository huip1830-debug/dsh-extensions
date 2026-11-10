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
  waitingParentIdsOf,
  nextPendingState,
  shouldNotify,
  formatNotification,
  pillStateOf,
  summaryOf,
  nextCollapsed,
  autoOpenOf,
  clampPosition,
  defaultPosition,
  positionToFraction,
  fractionToPosition,
  readPosition,
  writePosition,
  dragGestureOf,
  panelPlacement,
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
// sidebar sessionVisible() hides on the same field). Subagent rows also carry
// parentSessionId, the frozen parent link used by the waiting check (§14.1).
const subagentRow = (id, title, updatedAt, extra = {}) => ({ ...row(id, title, updatedAt), origin: 'subagent', ...extra })

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

test('the always-visible pill derives tone, pulse and classified counts', () => {
  // Blocking while another session runs: yellow wins, the running pulse stays,
  // and the classified counts are shown (spec §16.1 / §16.4).
  assert.deepEqual(
    pillStateOf({ running: 1, blocking: 1, unread: 0 }),
    { mode: 'running', tone: 'blocking', pulse: true, showPendingCount: true },
  )
  // Running plus unread only: colour follows running, unread survives as a count.
  assert.deepEqual(
    pillStateOf({ running: 2, blocking: 0, unread: 1 }),
    { mode: 'running', tone: 'running', pulse: true, showPendingCount: true },
  )
  // Unread only: green.
  assert.deepEqual(
    pillStateOf({ running: 0, blocking: 0, unread: 2 }),
    { mode: 'pending', tone: 'done', pulse: false, showPendingCount: false },
  )
  // Blocking only: yellow.
  assert.deepEqual(
    pillStateOf({ running: 0, blocking: 1, unread: 0 }),
    { mode: 'pending', tone: 'blocking', pulse: false, showPendingCount: false },
  )
  // Blocking + unread with nothing running: yellow outranks green.
  assert.deepEqual(
    pillStateOf({ running: 0, blocking: 1, unread: 3 }),
    { mode: 'pending', tone: 'blocking', pulse: false, showPendingCount: false },
  )
  // Idle.
  assert.deepEqual(
    pillStateOf({ running: 0, blocking: 0, unread: 0 }),
    { mode: 'idle', tone: 'idle', pulse: false, showPendingCount: false },
  )
  // Collapsed without running: quiet grey, no pending colour, no counts.
  assert.deepEqual(
    pillStateOf({ running: 0, blocking: 1, unread: 1, collapsed: true }),
    { mode: 'collapsed', tone: 'idle', pulse: false, showPendingCount: false },
  )
  // Collapsed with running: the running pulse survives, counts stay hidden.
  assert.deepEqual(
    pillStateOf({ running: 1, blocking: 1, unread: 1, collapsed: true }),
    { mode: 'running', tone: 'running', pulse: true, showPendingCount: false },
  )
  // Malformed input falls back to idle instead of throwing.
  assert.deepEqual(pillStateOf(undefined), { mode: 'idle', tone: 'idle', pulse: false, showPendingCount: false })
  assert.deepEqual(
    pillStateOf({ running: -1, blocking: 'x', unread: Number.NaN }),
    { mode: 'idle', tone: 'idle', pulse: false, showPendingCount: false },
  )
})

test('the header summary lists classified counts', () => {
  // Each class on its own.
  assert.deepEqual(summaryOf({ running: 2, blocking: 0, unread: 0 }), [{ key: 'pillRunning', count: 2 }])
  assert.deepEqual(summaryOf({ running: 0, blocking: 1, unread: 0 }), [{ key: 'summaryPending', count: 1 }])
  assert.deepEqual(summaryOf({ running: 0, blocking: 0, unread: 3 }), [{ key: 'summaryUnread', count: 3 }])
  // Mixed: running, blocking, unread — in that order (spec §16.3).
  assert.deepEqual(summaryOf({ running: 1, blocking: 2, unread: 3 }), [
    { key: 'pillRunning', count: 1 },
    { key: 'summaryPending', count: 2 },
    { key: 'summaryUnread', count: 3 },
  ])
  // Collapsed with pending appends the collapsed marker last.
  assert.deepEqual(summaryOf({ running: 0, blocking: 1, unread: 1, collapsed: true }), [
    { key: 'summaryPending', count: 1 },
    { key: 'summaryUnread', count: 1 },
    { key: 'pillCollapsed', count: 0 },
  ])
  // Nothing at all falls back to idle.
  assert.deepEqual(summaryOf({ running: 0, blocking: 0, unread: 0 }), [{ key: 'pillIdle', count: 0 }])
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

// --- auto expand (spec §15) -------------------------------------------------

test('autoOpenOf expands on a fresh edge that is visible (Set visibleIds)', () => {
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: false, fresh: ['a'], visibleIds: new Set(['a', 'b']) }), true)
  // Any visible fresh id is enough, not just the first one.
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: false, fresh: ['hidden', 'b'], visibleIds: new Set(['b']) }), true)
})

test('autoOpenOf accepts a plain array of visible ids', () => {
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: false, fresh: ['a'], visibleIds: ['a'] }), true)
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: false, fresh: ['a'], visibleIds: ['b', 'a'] }), true)
})

test('the baseline snapshot never auto-opens (primed must be exactly true)', () => {
  // Page load / connection reset: primed is false, so even a non-empty fresh
  // list is a baseline, not an edge (spec §15.1).
  assert.equal(autoOpenOf({ primed: false, collapsedBefore: false, fresh: ['a'], visibleIds: new Set(['a']) }), false)
  assert.equal(autoOpenOf({ collapsedBefore: false, fresh: ['a'], visibleIds: new Set(['a']) }), false)
  // Only the literal boolean true primes the check.
  assert.equal(autoOpenOf({ primed: 'true', collapsedBefore: false, fresh: ['a'], visibleIds: new Set(['a']) }), false)
})

test('a user temporary collapse suppresses auto-open', () => {
  // The controller samples collapsedBefore *before* nextCollapsed: the
  // auto-restore on this same edge clears the set, so judging after the fold
  // would never see the user's collapse (spec §15.1 timing).
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: true, fresh: ['a'], visibleIds: new Set(['a']) }), false)
  // A different, perfectly visible fresh id changes nothing while collapsed.
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: true, fresh: ['b', 'c'], visibleIds: new Set(['b', 'c']) }), false)
})

test('malformed or empty fresh never auto-opens', () => {
  const base = { primed: true, collapsedBefore: false, visibleIds: new Set(['a']) }
  assert.equal(autoOpenOf({ ...base, fresh: [] }), false)
  assert.equal(autoOpenOf({ ...base, fresh: undefined }), false)
  assert.equal(autoOpenOf({ ...base, fresh: 'a' }), false)
  // A Set is not the array contract: only arrays are consumed.
  assert.equal(autoOpenOf({ ...base, fresh: new Set(['a']) }), false)
  assert.equal(autoOpenOf(base), false)
})

test('fresh ids hidden from the visible projection do not open an empty panel', () => {
  // Main-view id or waiting-parent id: the fresh edge exists but nothing would
  // be shown, so the panel stays closed (spec §15.1).
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: false, fresh: ['main'], visibleIds: new Set(['other']) }), false)
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: false, fresh: ['main'], visibleIds: new Set() }), false)
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: false, fresh: ['main'], visibleIds: [] }), false)
  // One visible id among hidden ones is still a real edge.
  assert.equal(autoOpenOf({ primed: true, collapsedBefore: false, fresh: ['main', 'b'], visibleIds: new Set(['b']) }), true)
})

test('malformed visibleIds answer false instead of throwing', () => {
  const base = { primed: true, collapsedBefore: false, fresh: ['a'] }
  assert.equal(autoOpenOf({ ...base, visibleIds: undefined }), false)
  assert.equal(autoOpenOf({ ...base, visibleIds: null }), false)
  assert.equal(autoOpenOf({ ...base, visibleIds: 'a' }), false)
  assert.equal(autoOpenOf({ ...base, visibleIds: { a: true } }), false)
  assert.equal(autoOpenOf({ ...base, visibleIds: 42 }), false)
})

test('autoOpenOf answers false for null / undefined / non-object input', () => {
  assert.equal(autoOpenOf(null), false)
  assert.equal(autoOpenOf(undefined), false)
  assert.equal(autoOpenOf('edge'), false)
  assert.equal(autoOpenOf(0), false)
})

// --- pill position / drag / panel placement (spec §12, fraction storage §13) -

const POSITION_KEY = 'pending-sessions/pill-position'

// Minimal Storage stand-in: getItem returns null for a missing key, setItem
// stringifies like the real thing.
const makeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value))
    },
  }
}

test('the default position mirrors the old right:18 / bottom:18 anchor', () => {
  assert.deepEqual(defaultPosition({ width: 1000, height: 700 }, { width: 120, height: 32 }), { left: 862, top: 650 })
  // Degenerate viewport: still inside the 8px margin instead of negative.
  assert.deepEqual(defaultPosition({ width: 0, height: 0 }, { width: 120, height: 32 }), { left: 8, top: 8 })
  assert.deepEqual(defaultPosition(undefined, undefined), { left: 8, top: 8 })
})

test('clampPosition keeps the whole pill inside the viewport with an 8px margin', () => {
  const viewport = { width: 1000, height: 700 }
  const size = { width: 120, height: 32 }
  // Free placement inside the margins: no snapping (spec §12.1).
  assert.deepEqual(clampPosition({ left: 200, top: 300 }, viewport, size), { left: 200, top: 300 })
  assert.deepEqual(clampPosition({ left: -50, top: -5 }, viewport, size), { left: 8, top: 8 })
  assert.deepEqual(clampPosition({ left: 5000, top: 5000 }, viewport, size), { left: 872, top: 660 })
  // The fold never aliases or mutates its input.
  const input = { left: -50, top: 5000 }
  const clamped = clampPosition(input, viewport, size)
  assert.equal(clamped === input, false)
  assert.deepEqual(input, { left: -50, top: 5000 })
})

test('clampPosition treats malformed input as "use the default corner"', () => {
  assert.deepEqual(clampPosition({ left: 'left', top: NaN }, { width: 640, height: 480 }, { width: 100, height: 30 }), { left: 532, top: 442 })
  assert.deepEqual(clampPosition(undefined, undefined, undefined), { left: 8, top: 8 })
  // A pill wider than the viewport keeps its left edge on the margin.
  assert.deepEqual(clampPosition({ left: 100, top: 10 }, { width: 50, height: 100 }, { width: 200, height: 30 }), { left: 8, top: 10 })
})

test('readPosition accepts a well-formed fraction preference', () => {
  assert.deepEqual(readPosition(makeStorage({ [POSITION_KEY]: JSON.stringify({ v: 2, fx: 0.25, fy: 0.75 }) })), { fx: 0.25, fy: 0.75 })
  // Extra fields are ignored and 0/1 are valid fractions.
  assert.deepEqual(readPosition(makeStorage({ [POSITION_KEY]: '{"fx":0,"fy":1,"zoom":2}' })), { fx: 0, fy: 1 })
  assert.equal(readPosition(makeStorage()), undefined)
  assert.equal(readPosition(undefined), undefined)
  assert.equal(readPosition({}), undefined)
})

test('readPosition degrades to undefined for malformed or hostile storage', () => {
  const raw = (value) => makeStorage({ [POSITION_KEY]: value })
  assert.equal(readPosition(raw('not json')), undefined)
  assert.equal(readPosition(raw('null')), undefined)
  assert.equal(readPosition(raw('[]')), undefined)
  assert.equal(readPosition(raw('"text"')), undefined)
  assert.equal(readPosition(raw(JSON.stringify({ fx: '1', fy: 2 }))), undefined)
  assert.equal(readPosition(raw(JSON.stringify({ fx: 1 }))), undefined)
  assert.equal(readPosition(raw(JSON.stringify({ v: 3, fx: 0.5, fy: 0.5 }))), undefined)
  assert.equal(readPosition(raw(JSON.stringify({ left: '1', top: 2 }))), undefined)
  assert.equal(readPosition(raw(JSON.stringify({ left: 1 }))), undefined)
  assert.equal(readPosition(raw('')), undefined)
  assert.equal(readPosition({ getItem() { throw new Error('denied') } }), undefined)
})

test('readPosition migrates the legacy { left, top } preference once the viewport is known', () => {
  const viewport = { width: 1000, height: 700 }
  const size = { width: 120, height: 32 }
  const legacy = { left: 862, top: 650 }
  const storage = makeStorage({ [POSITION_KEY]: JSON.stringify(legacy) })
  // Without a measurement the legacy value is deferred, never guessed against a zero box.
  assert.equal(readPosition(storage), undefined)
  const migrated = readPosition(storage, viewport, size)
  assert.equal(migrated.fx, 854 / 864)
  assert.equal(migrated.fy, 642 / 652)
  // Migration writes the new format back once, so later reads are direct.
  assert.equal(storage.data.get(POSITION_KEY), JSON.stringify({ v: 2, fx: migrated.fx, fy: migrated.fy }))
  assert.deepEqual(readPosition(storage), migrated)
  // An off-window legacy value collapses into the corner instead of escaping.
  const off = makeStorage({ [POSITION_KEY]: JSON.stringify({ left: 5000, top: 5000 }) })
  assert.deepEqual(readPosition(off, viewport, size), { fx: 1, fy: 1 })
})

test('positionToFraction and fractionToPosition round-trip inside the 8px margins', () => {
  const viewport = { width: 1000, height: 700 }
  const size = { width: 120, height: 32 }
  const pixel = { left: 200, top: 300 }
  const fraction = positionToFraction(pixel, viewport, size)
  assert.equal(fraction.fx, (200 - 8) / 864)
  assert.equal(fraction.fy, (300 - 8) / 652)
  const back = fractionToPosition(fraction, viewport, size)
  assert.ok(Math.abs(back.left - pixel.left) < 1e-9)
  assert.ok(Math.abs(back.top - pixel.top) < 1e-9)
  // The corners map to the margins and to the far edge of the movable range.
  assert.deepEqual(fractionToPosition({ fx: 0, fy: 0 }, viewport, size), { left: 8, top: 8 })
  assert.deepEqual(fractionToPosition({ fx: 1, fy: 1 }, viewport, size), { left: 872, top: 660 })
  assert.deepEqual(positionToFraction({ left: 8, top: 660 }, viewport, size), { fx: 0, fy: 1 })
})

test('the same fraction keeps the same relative position after a resize or maximize', () => {
  const size = { width: 120, height: 32 }
  const fraction = { fx: 0.5, fy: 0.25 }
  const small = { width: 600, height: 400 }
  const large = { width: 1000, height: 700 }
  const inSmall = fractionToPosition(fraction, small, size)
  const inLarge = fractionToPosition(fraction, large, size)
  assert.equal(inSmall.left, 240) // 8 + (600 - 120 - 16) * 0.5
  assert.equal(inLarge.left, 440) // 8 + (1000 - 120 - 16) * 0.5
  assert.equal(inSmall.top, 96) // 8 + (400 - 32 - 16) * 0.25
  assert.equal(inLarge.top, 171) // 8 + (700 - 32 - 16) * 0.25
  // fx = fy = 1 always hugs the right/bottom margin, at any viewport size.
  assert.deepEqual(fractionToPosition({ fx: 1, fy: 1 }, small, size), { left: 472, top: 360 })
  assert.deepEqual(fractionToPosition({ fx: 1, fy: 1 }, large, size), { left: 872, top: 660 })
  // A stored fraction round-trips through the two viewports unchanged.
  const stored = positionToFraction(inLarge, large, size)
  assert.ok(Math.abs(stored.fx - fraction.fx) < 1e-9)
  assert.ok(Math.abs(stored.fy - fraction.fy) < 1e-9)
})

test('fraction helpers defend against a movable range <= 0 and malformed values', () => {
  // Pill wider than the viewport: the horizontal range collapses to zero.
  const cramped = { width: 50, height: 100 }
  const wide = { width: 200, height: 30 }
  assert.deepEqual(positionToFraction({ left: 100, top: 35 }, cramped, wide), { fx: 1, fy: 0.5 })
  assert.deepEqual(fractionToPosition({ fx: 0.3, fy: 0.75 }, cramped, wide), { left: 8, top: 48.5 })
  // Not measurable at all: bottom-right margin, never a negative coordinate.
  assert.deepEqual(fractionToPosition(undefined, undefined, undefined), { left: 8, top: 8 })
  assert.deepEqual(positionToFraction(undefined, undefined, undefined), { fx: 1, fy: 1 })
  // Out-of-range values are clamped; NaN falls back to the default corner.
  assert.deepEqual(fractionToPosition({ fx: 2, fy: -1 }, { width: 1000, height: 700 }, { width: 120, height: 32 }), { left: 872, top: 8 })
  assert.deepEqual(positionToFraction({ left: 'x', top: NaN }, { width: 1000, height: 700 }, { width: 120, height: 32 }), { fx: 1, fy: 1 })
})

test('writePosition persists the fraction pair and storage failures stay silent', () => {
  const storage = makeStorage()
  assert.equal(writePosition(storage, { fx: 0.25, fy: 1 }), true)
  assert.equal(storage.data.get(POSITION_KEY), JSON.stringify({ v: 2, fx: 0.25, fy: 1 }))
  assert.deepEqual(readPosition(storage), { fx: 0.25, fy: 1 })
  assert.equal(writePosition({ setItem() { throw new Error('quota') } }, { fx: 1, fy: 1 }), false)
  assert.equal(writePosition({}, { fx: 1, fy: 1 }), false)
  assert.equal(writePosition(undefined, { fx: 1, fy: 1 }), false)
  assert.equal(writePosition(storage, { fx: NaN, fy: 1 }), false)
})

test('dragGestureOf enters a drag at 400ms of hold or beyond 10px of movement', () => {
  assert.equal(dragGestureOf({ heldMs: 0, movedPx: 0 }), 'pending')
  assert.equal(dragGestureOf({ heldMs: 399, movedPx: 10 }), 'pending')
  assert.equal(dragGestureOf({ heldMs: 400, movedPx: 0 }), 'drag')
  assert.equal(dragGestureOf({ heldMs: 0, movedPx: 11 }), 'drag')
  assert.equal(dragGestureOf({ heldMs: 1200, movedPx: 11 }), 'drag')
})

test('a release before either threshold keeps the original click behaviour', () => {
  assert.equal(dragGestureOf({ heldMs: 120, movedPx: 3, released: true }), 'click')
  assert.equal(dragGestureOf({ heldMs: 120, movedPx: 3 }), 'pending')
  // Releasing after a threshold is still a drag, not a click.
  assert.equal(dragGestureOf({ heldMs: 800, movedPx: 0, released: true }), 'drag')
  assert.equal(dragGestureOf({ heldMs: 0, movedPx: 11, released: true }), 'drag')
  // Malformed input never starts a drag on its own.
  assert.equal(dragGestureOf(undefined), 'pending')
  assert.equal(dragGestureOf({ heldMs: '400', movedPx: NaN }), 'pending')
  assert.equal(dragGestureOf({ heldMs: -5, movedPx: -5, released: true }), 'click')
})

test('panelPlacement opens upwards in the lower half and downwards in the upper half', () => {
  const viewport = { width: 1000, height: 700 }
  const panel = { width: 324, height: 300 }
  assert.equal(panelPlacement({ left: 600, top: 500, width: 90, height: 30 }, viewport, panel).direction, 'up')
  assert.equal(panelPlacement({ left: 600, top: 100, width: 90, height: 30 }, viewport, panel).direction, 'down')
  // The exact middle counts as the upper half (opens downwards).
  assert.equal(panelPlacement({ left: 600, top: 335, width: 90, height: 30 }, viewport, panel).direction, 'down')
})

test('panelPlacement hugs the pill right edge and clamps inside the viewport', () => {
  const viewport = { width: 1000, height: 700 }
  const panel = { width: 324, height: 300 }
  const aligned = panelPlacement({ left: 600, top: 300, width: 100, height: 30 }, viewport, panel)
  assert.equal(aligned.left, 376) // 600 + 100 - 324
  assert.equal(aligned.offsetLeft, -224) // 376 - 600
  const leftEdge = panelPlacement({ left: 100, top: 300, width: 100, height: 30 }, viewport, panel)
  assert.equal(leftEdge.left, 8) // pulled back to the 8px margin
  assert.equal(leftEdge.offsetLeft, -92)
  const rightEdge = panelPlacement({ left: 900, top: 300, width: 100, height: 30 }, viewport, panel)
  assert.equal(rightEdge.left, 668) // 1000 - 324 - 8
  const narrow = panelPlacement({ left: 10, top: 300, width: 100, height: 30 }, { width: 300, height: 700 }, panel)
  assert.equal(narrow.left, 8)
  assert.equal(narrow.maxWidth, 284)
})

test('panelPlacement bounds the panel height by the room on the chosen side', () => {
  const viewport = { width: 1000, height: 700 }
  const panel = { width: 324, height: 300 }
  // Room above = 500 - 8 - 8 = 484, capped at 60% of the viewport height.
  assert.equal(panelPlacement({ left: 600, top: 500, width: 90, height: 30 }, viewport, panel).maxHeight, 420)
  // Room below = 700 - 130 - 16 = 554, capped at 420.
  assert.equal(panelPlacement({ left: 600, top: 100, width: 90, height: 30 }, viewport, panel).maxHeight, 420)
  // Room above = 150 - 16 = 134, capped at 60% of 200 = 120.
  assert.equal(panelPlacement({ left: 10, top: 150, width: 80, height: 20 }, { width: 200, height: 200 }, panel).maxHeight, 120)
  assert.equal(panelPlacement({ left: 0, top: 0, width: 0, height: 0 }, { width: 0, height: 0 }, panel).maxHeight, 0)
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

// --- waiting for subagents (spec §14) ---------------------------------------

const unread = () => idle({ completionUnread: true })

test('a parent waits while its direct subagent runs', () => {
  const statuses = new Map([
    ['parent', unread()],
    ['child', running()],
  ])
  const sessions = list([row('parent', 'Parent', 1), subagentRow('child', 'Child', 2, { parentSessionId: 'parent' })])
  assert.deepEqual([...waitingParentIdsOf({ statuses, sessions })], ['parent'])
})

test('a running grandchild keeps the top-level parent waiting', () => {
  const statuses = new Map([
    ['parent', unread()],
    ['child', idle()],
    ['grandchild', running()],
  ])
  const sessions = list([
    row('parent', 'Parent', 1),
    subagentRow('child', 'Child', 2, { parentSessionId: 'parent' }),
    subagentRow('grandchild', 'Grandchild', 3, { parentSessionId: 'child' }),
  ])
  assert.deepEqual([...waitingParentIdsOf({ statuses, sessions })], ['parent'])
})

test('an unread subagent is not activity, so its parent surfaces normally', () => {
  const statuses = new Map([
    ['parent', unread()],
    ['child', idle({ completionUnread: true })],
  ])
  const sessions = list([row('parent', 'Parent', 1), subagentRow('child', 'Child', 2, { parentSessionId: 'parent' })])
  assert.deepEqual([...waitingParentIdsOf({ statuses, sessions })], [])
})

test('a subagent blocked on an interaction keeps its parent waiting', () => {
  const statuses = new Map([
    ['parent', unread()],
    ['child', idle({ pendingInteraction: { kind: 'approval' } })],
  ])
  const sessions = list([row('parent', 'Parent', 1), subagentRow('child', 'Child', 2, { parentSessionId: 'parent' })])
  assert.deepEqual([...waitingParentIdsOf({ statuses, sessions })], ['parent'])
})

test('a parent blocked on its own interaction is never suppressed', () => {
  // pendingKindOf is 'question', not 'unread': the parent must be actionable
  // even while a subagent runs (spec §14.1).
  const statuses = new Map([
    ['parent', idle({ pendingInteraction: { kind: 'question' }, completionUnread: true })],
    ['child', running()],
  ])
  const sessions = list([row('parent', 'Parent', 1), subagentRow('child', 'Child', 2, { parentSessionId: 'parent' })])
  assert.deepEqual([...waitingParentIdsOf({ statuses, sessions })], [])
})

test('a running parent is not a waiting candidate', () => {
  const statuses = new Map([
    ['parent', running()],
    ['child', running()],
  ])
  const sessions = list([row('parent', 'Parent', 1), subagentRow('child', 'Child', 2, { parentSessionId: 'parent' })])
  assert.deepEqual([...waitingParentIdsOf({ statuses, sessions })], [])
})

test('orphan rows and rows without parentSessionId never suppress', () => {
  const statuses = new Map([
    ['parent', unread()],
    ['child', running()],
  ])
  // No parentSessionId: the link cannot be proven.
  assert.deepEqual(
    [...waitingParentIdsOf({ statuses, sessions: list([row('parent', 'P', 1), subagentRow('child', 'C', 2)]) })],
    [],
  )
  // parentSessionId points at a session absent from the list.
  assert.deepEqual(
    [...waitingParentIdsOf({ statuses, sessions: list([row('parent', 'P', 1), subagentRow('child', 'C', 2, { parentSessionId: 'ghost' })]) })],
    [],
  )
  // A running id that only exists in statuses has no row to prove anything.
  const statusOnly = new Map([
    ['parent', unread()],
    ['ghost-child', running()],
  ])
  assert.deepEqual([...waitingParentIdsOf({ statuses: statusOnly, sessions: list([row('parent', 'P', 1)]) })], [])
})

test('each parent is judged on its own descendants', () => {
  const statuses = new Map([
    ['parent-a', unread()],
    ['parent-b', unread()],
    ['child-a', running()],
    ['child-b', idle()],
  ])
  const sessions = list([
    row('parent-a', 'A', 1),
    row('parent-b', 'B', 2),
    subagentRow('child-a', 'CA', 3, { parentSessionId: 'parent-a' }),
    subagentRow('child-b', 'CB', 4, { parentSessionId: 'parent-b' }),
  ])
  assert.deepEqual([...waitingParentIdsOf({ statuses, sessions })], ['parent-a'])
})

test('a malformed subagent cycle terminates and suppresses nothing', () => {
  const statuses = new Map([
    ['parent', unread()],
    ['a', idle()],
    ['b', idle()],
  ])
  const sessions = list([
    row('parent', 'P', 1),
    subagentRow('a', 'A', 2, { parentSessionId: 'b' }),
    subagentRow('b', 'B', 3, { parentSessionId: 'a' }),
  ])
  // The cycle is unreachable from a top-level candidate; the memo/visiting
  // guard still has to terminate instead of recursing forever.
  assert.deepEqual([...waitingParentIdsOf({ statuses, sessions })], [])
})

test('a waiting parent stays waiting while it is still unread, without a fresh edge', () => {
  const next = nextPendingState({
    previousPending: new Set(),
    previousWaiting: new Set(['parent']),
    topPending: new Set(['parent']),
    unreadTop: new Set(['parent']),
    waitingNow: new Set(),
  })
  assert.deepEqual([...next.waiting], ['parent'])
  assert.deepEqual([...next.pending], [])
  assert.deepEqual(next.fresh, [])
})

test('a parent that leaves the pending set leaves the waiting set', () => {
  const next = nextPendingState({
    previousPending: new Set(),
    previousWaiting: new Set(['parent']),
    topPending: new Set(),
    unreadTop: new Set(),
    waitingNow: new Set(),
  })
  assert.deepEqual([...next.waiting], [])
  assert.deepEqual([...next.pending], [])
  assert.deepEqual(next.fresh, [])
})

test('a waiting parent that turns into an interaction is actionable at once', () => {
  const next = nextPendingState({
    previousPending: new Set(),
    previousWaiting: new Set(['parent']),
    topPending: new Set(['parent']),
    unreadTop: new Set(), // pendingKindOf is now 'approval'
    waitingNow: new Set(),
  })
  assert.deepEqual([...next.waiting], [])
  assert.deepEqual([...next.pending], ['parent'])
  assert.deepEqual(next.fresh, ['parent'])
})

test('a new wait suppresses its own fresh edge', () => {
  const next = nextPendingState({
    previousPending: new Set(),
    previousWaiting: new Set(),
    topPending: new Set(['parent', 'other']),
    unreadTop: new Set(['parent']),
    waitingNow: new Set(['parent']),
  })
  assert.deepEqual([...next.waiting], ['parent'])
  assert.deepEqual([...next.pending], ['other'])
  assert.deepEqual(next.fresh, ['other'])
})

test('the final unread after the batch produces one fresh edge', () => {
  // While the parent ran it was not pending at all, so it left the waiting set.
  const runningRound = nextPendingState({
    previousPending: new Set(),
    previousWaiting: new Set(['parent']),
    topPending: new Set(),
    unreadTop: new Set(),
    waitingNow: new Set(),
  })
  assert.deepEqual([...runningRound.waiting], [])
  assert.deepEqual([...runningRound.pending], [])
  // The final turn ends with no active subagent: one fresh unread edge.
  const finished = nextPendingState({
    previousPending: runningRound.pending,
    previousWaiting: runningRound.waiting,
    topPending: new Set(['parent']),
    unreadTop: new Set(['parent']),
    waitingNow: new Set(),
  })
  assert.deepEqual([...finished.waiting], [])
  assert.deepEqual([...finished.pending], ['parent'])
  assert.deepEqual(finished.fresh, ['parent'])
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
