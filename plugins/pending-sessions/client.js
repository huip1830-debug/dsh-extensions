// pending-sessions — browser half: a global floating bar that lists sessions
// waiting for the user, plus best-effort OS notifications while the window is
// unfocused.
//
// Hand-written lazy-CJS registration script: the Host serves this file as-is
// (no build, no transpile), so it must stay plain JS with `createElement` only.
// The module `id` must equal the npm package name. Runtime `require` is limited
// to platform seed modules; only `react` is used here.
//
// Signals consumed (verified against the desktop build):
//   - uiSession.sessionStatus: Map<sessionId, { running, pendingInteraction,
//     completionUnread }>; pendingInteraction.kind is one of approval /
//     plan-review / question
//     (dsh-client-ui-session/lib/client.js:782-992,
//      dsh-client-ui-approval/lib/client.js:180,
//      dsh-client-ui-user-questions/lib/client.js:185).
//   - sessions.list: { phase, ids, byId }; rows carry title / updatedAt /
//     origin / retainedBy.mainView (dsh-client-ui-workspace/lib/client.js:
//     1059-1073). origin === 'subagent' marks subagent children, the same field
//     the official sidebar hides on (same file 964-965).
//   - workspaces.list: { items[] }; items carry workspaceId / title / path /
//     sessionIds (dsh-client-ui-workspace/lib/client.js:1027-1046).
//   - uiWorkspace.selection: snapshot store { sessionId, subagentAddress? }
//     written by replaceMain (dsh-client-ui-workspace/lib/client.js:1369,
//     1652-1675). retainedBy.mainView is the fallback for the current session id
//     (same file 3544; dsh-client-ui-session/lib/client.js:973-975).
//
// Everything decision-shaped (filter / sort / workspace mapping / main-view
// exclusion / notification edges / throttle / merge) is a pure exported
// function under `pure`, so test.mjs covers it in node with zero dependencies.

window.__ModuleLoader__.load({
  id: 'pending-sessions',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState } = React

    /** Dictionary namespace owned by this bundle. */
    const NS = 'pendingSessions'

    // Mirrors locale/*.json `ui` (plugin inventory reads meta.* there; the
    // bundle only sees what it carries). Keep both copies in sync.
    const zh = {
      title: '待处理会话',
      pillAria: '{count} 个会话待处理',
      collapse: '收起',
      untitled: '未命名会话',
      defaultWorkspace: '默认工作区',
      kindApproval: '等批准',
      kindQuestion: '等回答',
      kindPlanReview: '计划复核',
      kindUnread: '未读回复',
      kindPending: '待处理',
      pillRunning: '{count} 运行中',
      pillRunningAria: '{count} 个会话运行中',
      pillIdle: '全部空闲',
      pillIdleAria: '所有会话空闲',
      pillCollapsed: '已收起',
      pillCollapsedAria: '待处理已暂时收起',
      summaryPending: '{count} 待处理',
      collapsePending: '暂时收起',
      restorePending: '恢复',
      collapsedHint: '待处理已暂时收起，点「恢复」重新提醒',
      notificationDenied: '系统通知未授权',
      notificationUnsupported: '当前环境不支持系统通知',
      notifyDigestTitle: '{count} 个会话待处理',
      notifyDigestMore: '还有 {count} 个',
    }

    const en = {
      title: 'Pending sessions',
      pillAria: '{count} sessions need attention',
      collapse: 'Collapse',
      untitled: 'Untitled session',
      defaultWorkspace: 'Default workspace',
      kindApproval: 'Awaiting approval',
      kindQuestion: 'Awaiting answer',
      kindPlanReview: 'Plan review',
      kindUnread: 'Unread reply',
      kindPending: 'Pending',
      pillRunning: '{count} running',
      pillRunningAria: '{count} sessions running',
      pillIdle: 'All idle',
      pillIdleAria: 'All sessions are idle',
      pillCollapsed: 'Collapsed',
      pillCollapsedAria: 'Pending items are temporarily collapsed',
      summaryPending: '{count} pending',
      collapsePending: 'Collapse for now',
      restorePending: 'Restore',
      collapsedHint: 'Pending items are temporarily collapsed; choose Restore to bring them back',
      notificationDenied: 'System notifications not authorized',
      notificationUnsupported: 'System notifications unavailable in this environment',
      notifyDigestTitle: '{count} sessions need attention',
      notifyDigestMore: '+{count} more',
    }

    // Injected exactly like the official css modules: one style tag per bundle,
    // themed through the same --dsw-alias-* custom properties. The overlay layer
    // is `position:absolute; inset:0; pointer-events:none` with auto pointer
    // events on children (dsh-client-ui-layout/lib/client.js:73), so the bar
    // anchors to the frame's bottom-right corner.
    const CSS = [
      '.psess-root{position:absolute;right:18px;bottom:18px;z-index:5;font-size:13px;line-height:1.5}',
      '.psess-pill{display:inline-flex;align-items:center;gap:7px;padding:6px 13px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 6px 18px rgba(0,0,0,.18);cursor:pointer;font-family:inherit;font-size:13px}',
      '.psess-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.psess-pillAlert{border-color:var(--dsw-alias-state-warn-primary)}',
      '.psess-pillLow{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);box-shadow:0 4px 12px rgba(0,0,0,.12);font-size:12px;padding:4px 11px}',
      '.psess-pillLow:hover{color:var(--dsw-alias-label-secondary)}',
      '.psess-pillIdle{cursor:default}',
      '.psess-pillIdle:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.psess-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}',
      '.psess-pillAlert .psess-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.psess-pillLow .psess-dot{background:var(--dsw-alias-label-tertiary);opacity:.55}',
      '.psess-pillRunning .psess-dot{animation:psess-pulse 1.6s ease-in-out infinite}',
      '@keyframes psess-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.78)}}',
      '@media (prefers-reduced-motion: reduce){.psess-pillRunning .psess-dot{animation:none}}',
      '.psess-count{font-variant-numeric:tabular-nums}',
      '.psess-sep{color:var(--dsw-alias-label-tertiary)}',
      '.psess-mutedText{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.psess-panel{width:324px;max-height:60vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);box-shadow:0 12px 32px rgba(0,0,0,.22);overflow:hidden}',
      '.psess-panelAlert{border-color:var(--dsw-alias-state-warn-primary)}',
      '.psess-head{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l4)}',
      '.psess-headRow{display:flex;align-items:center;gap:8px}',
      '.psess-summary{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.psess-title{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.psess-total{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.psess-action{margin-left:auto;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:var(--dsw-radius-md)}',
      '.psess-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.psess-collapse{border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px}',
      '.psess-collapse:hover{color:var(--dsw-alias-label-primary)}',
      '.psess-note{padding:6px 12px 0;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.psess-hint{margin:0;padding:8px 12px 0;color:var(--dsw-alias-state-warn-label);font-size:12px}',
      '.psess-list{list-style:none;margin:0;padding:6px;overflow:auto;min-height:0}',
      '.psess-item{display:flex;align-items:flex-start;gap:7px;width:100%;text-align:left;padding:7px 8px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}',
      '.psess-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.psess-state{width:7px;height:7px;border-radius:50%;margin-top:6px;flex:none;background:var(--dsw-alias-brand-primary)}',
      '.psess-itemAlert .psess-state{background:var(--dsw-alias-state-warn-primary)}',
      '.psess-kind{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:1px}',
      '.psess-text{display:flex;flex-direction:column;min-width:0;gap:1px}',
      '.psess-ws,.psess-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.psess-ws{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.psess-name{color:var(--dsw-alias-label-primary);font-size:13px}',
    ].join('\n')
    const cssTagId = 'pending-sessions/bar.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'pending-sessions'
      tag.dataset.pluginCss = cssTagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- pure core (exported for test.mjs) ---------------------------------

    /** Kinds the official pending-interaction domains publish. */
    const PENDING_KINDS = new Set(['approval', 'plan-review', 'question'])

    /** Translate one kind into its dictionary key; unknown kinds stay generic. */
    const KIND_LABEL_KEYS = {
      approval: 'kindApproval',
      question: 'kindQuestion',
      'plan-review': 'kindPlanReview',
      unread: 'kindUnread',
      pending: 'kindPending',
    }

    /**
     * Classify one sessionStatus entry.
     * @param status - { pendingInteraction?, completionUnread? } or anything.
     * @returns a blocking kind ('approval' | 'question' | 'plan-review' |
     *   'pending'), 'unread', or undefined when the session needs nothing.
     */
    function pendingKindOf(status) {
      if (status === null || typeof status !== 'object') return undefined
      const interaction = status.pendingInteraction
      if (interaction !== undefined && interaction !== null) {
        const kind = typeof interaction.kind === 'string' ? interaction.kind : ''
        return PENDING_KINDS.has(kind) ? kind : 'pending'
      }
      return status.completionUnread === true ? 'unread' : undefined
    }

    /**
     * Count sessions that are actively running.
     * Deliberately counts every sessionStatus entry, subagents included: this is
     * the whole-client activity indicator (spec §11.1). The pending list and the
     * notifications filter subagents through subagentIdsOf instead; the two
     * directions are intentional.
     * @param statuses - uiSession.sessionStatus snapshot (Map or plain object).
     * @returns the number of entries whose `running === true`.
     */
    function runningCountOf(statuses) {
      const entries = statuses instanceof Map ? statuses : new Map(Object.entries(statuses ?? {}))
      let count = 0
      for (const status of entries.values()) {
        if (status !== null && typeof status === 'object' && status.running === true) count += 1
      }
      return count
    }

    /** Reverse-look-up the Workspace owning a Session (official same approach). */
    function workspaceOf(workspaces, sessionId) {
      const items = workspaces !== null && typeof workspaces === 'object' && Array.isArray(workspaces.items) ? workspaces.items : []
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue
        if (Array.isArray(item.sessionIds) && item.sessionIds.indexOf(sessionId) !== -1) return item
      }
      return undefined
    }

    /** Display name of one Workspace item, without localization (pure). */
    function workspaceNameOf(workspace) {
      if (workspace === undefined || workspace === null || typeof workspace !== 'object') return ''
      const title = typeof workspace.title === 'string' ? workspace.title.trim() : ''
      if (title.length > 0 && title !== 'default-workspace') return title
      const path = typeof workspace.path === 'string' ? workspace.path.replace(/[\\/]+$/, '') : ''
      const base = path.split(/[\\/]/).pop()
      return typeof base === 'string' && base.length > 0 ? base : ''
    }

    /**
     * Ids the session list marks as subagent children.
     * Frozen signal: sessions.list.byId[id].origin === 'subagent', the same
     * field the official sidebar's sessionVisible() hides on
     * (dsh-client-ui-workspace/lib/client.js:964-965). Ids absent from byId are
     * never excluded: an orphan status row cannot be proven a subagent, so it is
     * kept (one extra row beats a lost top-level session).
     * @param sessions - sessions.list snapshot or anything.
     * @returns Set of subagent session ids (empty for malformed input).
     */
    function subagentIdsOf(sessions) {
      const byId = sessions !== null && typeof sessions === 'object' && sessions.byId !== null && typeof sessions.byId === 'object' ? sessions.byId : {}
      const excluded = new Set()
      for (const sessionId of Object.keys(byId)) {
        const summary = byId[sessionId]
        if (summary !== null && typeof summary === 'object' && summary.origin === 'subagent') excluded.add(sessionId)
      }
      return excluded
    }

    /**
     * Build the pending list: filter, map, and sort.
     * Blocking entries come first; each group is newest-first by updatedAt.
     * Subagent sessions are dropped here so they neither list nor count.
     * @param input - { statuses, sessions, workspaces } snapshots.
     * @returns sorted item array (each item is plain data).
     */
    function buildItems(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      const statuses = source.statuses instanceof Map ? source.statuses : new Map(Object.entries(source.statuses ?? {}))
      const sessions = source.sessions !== null && typeof source.sessions === 'object' ? source.sessions : {}
      const byId = sessions.byId !== null && typeof sessions.byId === 'object' ? sessions.byId : {}
      const excluded = subagentIdsOf(sessions)
      const listed = Array.isArray(sessions.ids) ? sessions.ids : []
      const order = [...listed]
      const seen = new Set(listed)
      for (const sessionId of statuses.keys()) {
        if (seen.has(sessionId)) continue
        seen.add(sessionId)
        order.push(sessionId)
      }
      const items = []
      for (const sessionId of order) {
        if (excluded.has(sessionId)) continue
        const status = statuses.get(sessionId)
        const kind = pendingKindOf(status)
        if (kind === undefined) continue
        const summary = byId[sessionId] !== null && typeof byId[sessionId] === 'object' ? byId[sessionId] : undefined
        const workspace = workspaceOf(source.workspaces, sessionId)
        items.push({
          sessionId,
          kind,
          blocking: kind !== 'unread',
          workspace: workspaceNameOf(workspace),
          workspaceKnown: workspace !== undefined,
          title: summary !== undefined && typeof summary.title === 'string' ? summary.title.trim() : '',
          updatedAt: summary !== undefined && typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt) ? summary.updatedAt : 0,
        })
      }
      items.sort((left, right) => {
        if (left.blocking !== right.blocking) return left.blocking ? -1 : 1
        if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
        if (left.sessionId === right.sessionId) return 0
        return left.sessionId < right.sessionId ? -1 : 1
      })
      return items
    }

    /** Drop the session already on screen (no point listing what you see). */
    function excludeMain(items, mainSessionId) {
      if (typeof mainSessionId !== 'string' || mainSessionId.length === 0) return items
      return items.filter((item) => item.sessionId !== mainSessionId)
    }

    /**
     * Resolve the session shown in the main view.
     * uiWorkspace.selection is authoritative; retainedBy.mainView is the
     * fallback the official session/workspace bundles use.
     * @param selection - uiWorkspace.selection.getSnapshot() or anything.
     * @param sessions - sessions.list snapshot.
     * @returns the current main-view session id, or undefined.
     */
    function pickMainSessionId(selection, sessions) {
      const selected = selection !== null && typeof selection === 'object' ? selection.sessionId : undefined
      if (typeof selected === 'string' && selected.length > 0) return selected
      const byId = sessions !== null && typeof sessions === 'object' && sessions.byId !== null && typeof sessions.byId === 'object' ? sessions.byId : {}
      const listed = sessions !== null && typeof sessions === 'object' && Array.isArray(sessions.ids) ? sessions.ids : []
      const order = [...listed, ...Object.keys(byId).filter((id) => listed.indexOf(id) === -1)]
      for (const sessionId of order) {
        const summary = byId[sessionId]
        if (summary !== null && typeof summary === 'object' && (summary.retainedBy?.mainView ?? 0) > 0) return sessionId
      }
      return undefined
    }

    /**
     * Notification edge detection. A session notifies once when it *enters*
     * pending; it must leave and re-enter to notify again (one episode, one
     * notification).
     * @param previous - Set of pending session ids at the previous publish.
     * @param statuses - uiSession.sessionStatus snapshot.
     * @param excluded - optional subagent ids to ignore; they never enter
     *   `current`, so they neither notify nor occupy an episode. Omitted means
     *   no filtering (backward compatible).
     * @returns { current, fresh } where fresh lists newly pending ids.
     */
    function detectFresh(previous, statuses, excluded) {
      const before = previous instanceof Set ? previous : new Set(previous ?? [])
      const entries = statuses instanceof Map ? statuses : new Map(Object.entries(statuses ?? {}))
      const skip = excluded instanceof Set ? excluded : new Set(excluded ?? [])
      const current = new Set()
      const fresh = []
      for (const [sessionId, status] of entries) {
        if (skip.has(sessionId)) continue
        if (pendingKindOf(status) === undefined) continue
        current.add(sessionId)
        if (!before.has(sessionId)) fresh.push(sessionId)
      }
      return { current, fresh }
    }

    /**
     * Whether an edge should surface as a system notification.
     * @param input - { fresh, focused, permission }.
     * @returns true only for a fresh edge, an unfocused window, and a
     *   permission that is granted or still requestable.
     */
    function shouldNotify(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      if (!Array.isArray(source.fresh) || source.fresh.length === 0) return false
      if (source.focused === true) return false
      return source.permission === 'granted' || source.permission === 'default'
    }

    /**
     * Compose one notification payload; several fresh sessions merge into one
     * digest instead of a burst.
     * @param items - pending items (already sorted).
     * @param t - locale function.
     * @returns { title, body, sessionId } or undefined for an empty batch.
     */
    function formatNotification(items, t) {
      if (!Array.isArray(items) || items.length === 0) return undefined
      const describe = (item) => {
        const parts = [t(KIND_LABEL_KEYS[item.kind] ?? 'kindPending')]
        if (typeof item.workspace === 'string' && item.workspace.length > 0) parts.push(item.workspace)
        if (typeof item.title === 'string' && item.title.length > 0) parts.push(item.title)
        return parts.join(' · ')
      }
      if (items.length === 1) return { title: describe(items[0]), body: '', sessionId: items[0].sessionId }
      const more = items.length > 3 ? '\n' + t('notifyDigestMore', { count: items.length - 3 }) : ''
      return {
        title: t('notifyDigestTitle', { count: items.length }),
        body: items.slice(0, 3).map(describe).join('\n') + more,
        sessionId: items[0].sessionId,
      }
    }

    /** Normalize a count-ish input to a non-negative integer (pure helper). */
    function countOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
    }

    /**
     * Presentation state of the always-visible pill (spec §11.1).
     * Priority: running > pending > idle. A temporarily collapsed list keeps the
     * running animation but hides the pending count and the warning colour
     * (spec §11.2).
     * @param input - { running, pending, blocking?, collapsed? }.
     * @returns { mode, pulse, alert, showPendingCount } where mode is
     *   'running' | 'pending' | 'collapsed' | 'idle'.
     */
    function pillStateOf(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      const running = countOf(source.running)
      const pending = countOf(source.pending)
      const collapsed = source.collapsed === true && pending > 0
      if (running > 0) return { mode: 'running', pulse: true, alert: false, showPendingCount: pending > 0 && !collapsed }
      if (collapsed) return { mode: 'collapsed', pulse: false, alert: false, showPendingCount: false }
      if (pending > 0) return { mode: 'pending', pulse: false, alert: source.blocking === true, showPendingCount: true }
      return { mode: 'idle', pulse: false, alert: false, showPendingCount: false }
    }

    /**
     * Parts of the expanded panel's status summary line; the renderer localizes
     * each part and joins them with ' · '.
     * @param input - { running, pending, collapsed? }.
     * @returns [{ key, count }] — a single pillIdle part for the idle state.
     */
    function summaryOf(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      const running = countOf(source.running)
      const pending = countOf(source.pending)
      const parts = []
      if (running > 0) parts.push({ key: 'pillRunning', count: running })
      if (pending > 0) parts.push({ key: 'summaryPending', count: pending })
      if (source.collapsed === true && pending > 0) parts.push({ key: 'pillCollapsed', count: 0 })
      if (parts.length === 0) parts.push({ key: 'pillIdle', count: 0 })
      return parts
    }

    /**
     * Fold the in-memory temporary-collapse set (spec §11.2).
     * - `action: 'collapse'` stores every pending id (the panel's button).
     * - `action: 'restore'` forgets the whole set (manual restore).
     * - otherwise the set is pruned to ids that are still pending, then cleared
     *   when a session outside the set newly entered pending. Pruning runs
     *   first, so a collapsed session that leaves pending and later re-enters is
     *   no longer in the set: its new episode cannot be suppressed.
     * @param previous - Set of collapsed ids (undefined on a fresh mount).
     * @param input - { pending?, fresh?, action? }.
     * @returns { collapsed: Set, restored: boolean, changed: boolean }.
     */
    function nextCollapsed(previous, input) {
      const before = previous instanceof Set ? previous : Array.isArray(previous) ? new Set(previous) : new Set()
      const source = input !== null && typeof input === 'object' ? input : {}
      const pending = source.pending instanceof Set ? source.pending : new Set(source.pending ?? [])
      if (source.action === 'restore') {
        return { collapsed: new Set(), restored: before.size > 0, changed: before.size > 0 }
      }
      if (source.action === 'collapse') {
        let changed = pending.size !== before.size
        for (const id of pending) {
          if (changed) break
          if (!before.has(id)) changed = true
        }
        return { collapsed: new Set(pending), restored: false, changed }
      }
      const kept = new Set()
      for (const id of before) if (pending.has(id)) kept.add(id)
      const fresh = Array.isArray(source.fresh) ? source.fresh : []
      for (const id of fresh) {
        if (kept.has(id)) continue
        return { collapsed: new Set(), restored: kept.size > 0, changed: kept.size > 0 }
      }
      return { collapsed: kept, restored: false, changed: kept.size !== before.size }
    }

    // --- controller --------------------------------------------------------

    /** Minimal snapshot store with the { getSnapshot, subscribe } shape slots hooks expect. */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          if (next === snapshot) return
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * Owns the subscriptions, the derived snapshot, and the notification
     * episode bookkeeping. All reads go through the live stores; nothing is
     * copied into persistent state.
     */
    class PendingSessionsController {
      constructor(ctx) {
        this.ctx = ctx
        this.store = createStore({ items: [], pending: 0, blocking: 0, running: 0, collapsed: false, collapsedCount: 0, notification: 'unknown' })
        this.unsubscribers = []
        this.pendingIds = new Set()
        // Temporary collapse lives in memory only (spec §11.2): a page refresh
        // starts from an empty set, exactly like the notification episodes.
        this.collapsedIds = new Set()
        this.primed = false
        this.disposed = false
        this.notification = 'unknown'
      }

      /** Initial permission read; only denied / unsupported is surfaced as a hint. */
      probeNotification() {
        const Ctor = typeof window !== 'undefined' ? window.Notification : undefined
        if (typeof Ctor !== 'function') {
          this.notification = 'unsupported'
          return
        }
        this.notification = typeof Ctor.permission === 'string' ? Ctor.permission : 'default'
      }

      /** One consistent read of every source store. */
      collect() {
        const statuses = this.ctx.uiSession.sessionStatus.getSnapshot()
        const sessions = this.ctx.sessions.list.getSnapshot()
        const workspaces = this.ctx.workspaces.list.getSnapshot()
        const selection = this.ctx.uiWorkspace.selection !== undefined && typeof this.ctx.uiWorkspace.selection.getSnapshot === 'function'
          ? this.ctx.uiWorkspace.selection.getSnapshot()
          : undefined
        const mainSessionId = pickMainSessionId(selection, sessions)
        // Same consistent read: one subagent set feeds both the list filter
        // (buildItems derives its own copy from `sessions`) and the edge filter.
        return { statuses, subagentIds: subagentIdsOf(sessions), all: buildItems({ statuses, sessions, workspaces }), mainSessionId }
      }

      /** Publish the visible projection. Never exposes raw interaction objects. */
      publish(collected) {
        if (this.disposed) return
        let data = collected
        if (data === undefined) {
          try {
            data = this.collect()
          } catch (error) {
            console.warn('pending-sessions: cannot read session state', error)
            return
          }
        }
        const visible = excludeMain(data.all, data.mainSessionId)
        const collapsedCount = visible.filter((item) => this.collapsedIds.has(item.sessionId)).length
        this.store.set({
          items: visible,
          pending: visible.length,
          blocking: visible.filter((item) => item.blocking).length,
          // Running counts every observed session, subagents included (§11.1).
          running: runningCountOf(data.statuses),
          collapsed: collapsedCount > 0,
          collapsedCount,
          notification: this.notification,
        })
      }

      /** Status changed: publish, then decide whether this is a notification edge. */
      onStatus() {
        if (this.disposed) return
        let collected
        try {
          collected = this.collect()
        } catch (error) {
          console.warn('pending-sessions: cannot read session status', error)
          return
        }
        const { current, fresh } = detectFresh(this.pendingIds, collected.statuses, collected.subagentIds)
        this.pendingIds = current
        // Temporary collapse is a client-only fold: prune ids that left pending,
        // then auto-restore when a session outside the set newly entered. The
        // baseline snapshot is not an edge, so it never collapses or restores.
        const fold = nextCollapsed(this.collapsedIds, { pending: current, fresh: this.primed ? fresh : [] })
        this.collapsedIds = fold.collapsed
        this.publish(collected)
        if (!this.primed) {
          // First snapshot is the baseline: sessions already pending when the
          // page opens are not an edge we observed.
          this.primed = true
          return
        }
        if (fresh.length === 0) return
        const byId = new Map(collected.all.map((item) => [item.sessionId, item]))
        const freshItems = fresh.map((sessionId) => byId.get(sessionId)).filter((item) => item !== undefined)
        this.notify(freshItems)
      }

      /** Ask for permission on first use, then show one notification per edge batch. */
      async notify(items) {
        if (items.length === 0) return
        const focused = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : false
        const Ctor = typeof window !== 'undefined' ? window.Notification : undefined
        if (typeof Ctor !== 'function') {
          this.setNotification('unsupported')
          return
        }
        let permission = typeof Ctor.permission === 'string' ? Ctor.permission : 'default'
        if (permission === 'denied') this.setNotification('denied')
        if (!shouldNotify({ fresh: items, focused, permission })) return
        if (permission === 'default') {
          try {
            permission = await Ctor.requestPermission()
          } catch {
            permission = 'denied'
          }
          if (this.disposed) return
          this.setNotification(permission === 'granted' ? 'granted' : 'denied')
          if (permission !== 'granted') return
        }
        const payload = formatNotification(items.filter((item) => this.pendingIds.has(item.sessionId)), this.ctx.locale.bind(NS))
        if (payload === undefined) return
        try {
          const notification = new Ctor(payload.title, { body: payload.body, tag: 'pending-sessions' })
          notification.onclick = () => {
            try {
              this.ctx.uiWorkspace.openSession(payload.sessionId)
              if (typeof window !== 'undefined' && typeof window.focus === 'function') window.focus()
            } catch (error) {
              console.warn('pending-sessions: notification click failed', error)
            }
            try {
              if (typeof notification.close === 'function') notification.close()
            } catch {
              // closing is best-effort
            }
          }
        } catch (error) {
          console.warn('pending-sessions: notification failed', error)
        }
      }

      setNotification(value) {
        if (this.notification === value) return
        this.notification = value
        this.publish()
      }

      /** Temporarily collapse every pending session (memory only, no disk). */
      collapse() {
        if (this.disposed) return
        this.collapsedIds = nextCollapsed(this.collapsedIds, { pending: this.pendingIds, action: 'collapse' }).collapsed
        this.publish()
      }

      /** Manual restore: forget the collapse set and surface the list again. */
      restore() {
        if (this.disposed) return
        this.collapsedIds = nextCollapsed(this.collapsedIds, { action: 'restore' }).collapsed
        this.publish()
      }

      start() {
        if (this.disposed) return
        const track = (store, listener) => {
          if (store === undefined || store === null || typeof store.subscribe !== 'function') return
          const stop = store.subscribe(listener)
          if (typeof stop === 'function') this.unsubscribers.push(stop)
        }
        track(this.ctx.uiSession.sessionStatus, () => this.onStatus())
        track(this.ctx.sessions.list, () => this.publish())
        track(this.ctx.workspaces.list, () => this.publish())
        track(this.ctx.uiWorkspace.selection, () => this.publish())
        this.probeNotification()
        this.onStatus()
      }

      /** connection/reset: drop subscriptions and re-seed from the new generation. */
      reset() {
        if (this.disposed) return
        for (const stop of this.unsubscribers) {
          try {
            stop()
          } catch {
            // teardown is best-effort
          }
        }
        this.unsubscribers = []
        this.pendingIds = new Set()
        this.collapsedIds = new Set()
        this.primed = false
        this.notification = 'unknown'
        this.start()
      }

      dispose() {
        if (this.disposed) return
        this.disposed = true
        for (const stop of this.unsubscribers) {
          try {
            stop()
          } catch {
            // teardown is best-effort
          }
        }
        this.unsubscribers = []
      }

      /** Open a session exactly like a sidebar row click. */
      open(sessionId) {
        try {
          this.ctx.uiWorkspace.openSession(sessionId)
        } catch (error) {
          console.warn('pending-sessions: openSession failed', error)
        }
      }
    }

    // --- renderer ----------------------------------------------------------

    function kindLabel(kind, t) {
      return t(KIND_LABEL_KEYS[kind] ?? 'kindPending')
    }

    function PendingSessionsOverlay(props) {
      const snapshot = props.usePendingSessions((state) => state)
      const [expanded, setExpanded] = useState(false)
      const items = Array.isArray(snapshot.items) ? snapshot.items : []
      const pending = Number.isFinite(snapshot.pending) ? snapshot.pending : items.length
      const running = Number.isFinite(snapshot.running) ? snapshot.running : 0
      const collapsed = snapshot.collapsed === true
      const blocking = snapshot.blocking > 0
      const pill = pillStateOf({ running, pending, blocking, collapsed })
      const hint = snapshot.notification === 'denied'
        ? props.t('notificationDenied')
        : snapshot.notification === 'unsupported'
          ? props.t('notificationUnsupported')
          : undefined

      // The pill is always on screen (spec §11.1): running, pending, collapsed
      // pending, or the quiet idle state.
      const pillClasses = ['psess-pill']
      if (pill.alert) pillClasses.push('psess-pillAlert')
      if (pill.mode === 'running') pillClasses.push('psess-pillRunning')
      if (pill.mode === 'idle' || pill.mode === 'collapsed') pillClasses.push('psess-pillLow')
      if (pill.mode === 'idle') pillClasses.push('psess-pillIdle')

      const pillText = []
      if (pill.mode === 'running') {
        pillText.push(h('span', { key: 'running', className: 'psess-count' }, props.t('pillRunning', { count: running })))
        if (pill.showPendingCount) {
          pillText.push(h('span', { key: 'sep', className: 'psess-sep' }, '·'))
          pillText.push(h('span', { key: 'pending', className: 'psess-count' }, props.t('summaryPending', { count: pending })))
        }
      } else if (pill.mode === 'pending') {
        pillText.push(h('span', { key: 'pending', className: 'psess-count' }, pending))
      } else if (pill.mode === 'collapsed') {
        pillText.push(h('span', { key: 'collapsed', className: 'psess-mutedText' }, props.t('pillCollapsed')))
      } else {
        pillText.push(h('span', { key: 'idle', className: 'psess-mutedText' }, props.t('pillIdle')))
      }

      const ariaLabel = pill.mode === 'running'
        ? props.t('pillRunningAria', { count: running })
        : pill.mode === 'pending'
          ? props.t('pillAria', { count: pending })
          : pill.mode === 'collapsed'
            ? props.t('pillCollapsedAria')
            : props.t('pillIdleAria')

      if (!expanded || items.length === 0) {
        const interactive = pill.mode !== 'idle'
        const pillProps = { className: pillClasses.join(' '), title: hint, 'aria-label': ariaLabel }
        if (interactive) {
          pillProps.type = 'button'
          pillProps.onClick = () => {
            // A muted pill restores first, then opens; otherwise it just opens.
            if (pill.mode === 'collapsed') props.restore()
            setExpanded(true)
          }
        } else {
          pillProps.role = 'status'
        }
        return h('div', { className: 'psess-root' },
          h(interactive ? 'button' : 'div', pillProps,
            h('span', { className: 'psess-dot' }),
            ...pillText))
      }

      const summary = summaryOf({ running, pending, collapsed })
        .map((part) => props.t(part.key, { count: part.count }))
        .join(' · ')

      return h('div', { className: 'psess-root' },
        h('div', { className: blocking ? 'psess-panel psess-panelAlert' : 'psess-panel' },
          h('div', { className: 'psess-head' },
            h('div', { className: 'psess-headRow' },
              h('span', { className: 'psess-title' }, props.t('title')),
              h('span', { className: 'psess-total' }, items.length),
              collapsed
                ? h('button', {
                  type: 'button',
                  className: 'psess-action',
                  title: props.t('restorePending'),
                  onClick: () => props.restore(),
                }, props.t('restorePending'))
                : h('button', {
                  type: 'button',
                  className: 'psess-action',
                  title: props.t('collapsePending'),
                  onClick: () => {
                    props.collapse()
                    setExpanded(false)
                  },
                }, props.t('collapsePending')),
              h('button', {
                type: 'button',
                className: 'psess-collapse',
                title: props.t('collapse'),
                'aria-label': props.t('collapse'),
                onClick: () => setExpanded(false),
              }, '×')),
            h('span', { className: 'psess-summary' }, summary)),
          hint === undefined ? null : h('p', { className: 'psess-hint' }, hint),
          collapsed ? h('p', { className: 'psess-note' }, props.t('collapsedHint')) : null,
          h('ul', { className: 'psess-list' }, items.map((item) => h('li', { key: item.sessionId },
            h('button', {
              type: 'button',
              className: item.blocking ? 'psess-item psess-itemAlert' : 'psess-item',
              title: item.title.length > 0 ? item.title : props.t('untitled'),
              onClick: () => props.openSession(item.sessionId),
            },
            h('span', { className: 'psess-state' }),
            h('span', { className: 'psess-kind' }, kindLabel(item.kind, props.t)),
            h('span', { className: 'psess-text' },
              item.workspace.length > 0
                ? h('span', { className: 'psess-ws' }, item.workspace)
                : item.workspaceKnown
                  ? h('span', { className: 'psess-ws' }, props.t('defaultWorkspace'))
                  : null,
              h('span', { className: 'psess-name' }, item.title.length > 0 ? item.title : props.t('untitled')))))))))
    }

    // --- plugin ------------------------------------------------------------

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace']

    /**
     * Mount the floating bar while every required service exists.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const missing = inject.filter((name) => ctx.get(name) === undefined)
      if (missing.length > 0) {
        // Older DSH: stay inactive and quiet instead of breaking the host.
        console.warn('pending-sessions: missing services ' + missing.join(', ') + '; the bar stays inactive')
        return
      }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pending-sessions: dictionaries')
      const controller = new PendingSessionsController(ctx)
      ctx.effect(() => {
        controller.start()
        return () => controller.dispose()
      }, 'pending-sessions: subscriptions')
      ctx.effect(() => ctx.on('connection/reset', () => controller.reset()), 'pending-sessions: connection generation')
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'pending-sessions.pill',
        locale: NS,
        inject: () => ({
          hooks: { pendingSessions: controller.store },
          openSession: (sessionId) => controller.open(sessionId),
          collapse: () => controller.collapse(),
          restore: () => controller.restore(),
        }),
      }, PendingSessionsOverlay)), 'pending-sessions: overlay')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    // Exposed for the offline regression: locale/*.json must mirror these.
    exports.dictionaries = { zh, en }
    exports.pure = {
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
    }
    return module.exports
  },
})
