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
// exclusion / notification edges / throttle / merge / pill position / drag
// gesture / panel placement) is a pure exported function under `pure`, so
// test.mjs covers it in node with zero dependencies.
//
// Pill position (spec §12 gesture, §13 storage): free placement inside the
// viewport (no snapping), persisted as a UI preference in
// localStorage["pending-sessions/pill-position"] as fractions of the movable
// range ({ fx, fy }, 1/1 = bottom-right), the one explicit exception to "no
// self-made persistent state". Every render converts the fraction back to
// pixels with the current viewport + measured pill box, so a resize or a
// maximize re-anchors the pill to the same relative spot. The expanded panel
// follows the pill's converted pixel position.

window.__ModuleLoader__.load({
  id: 'pending-sessions',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

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
      dragHint: '长按拖动换位',
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
      dragHint: 'Long-press to drag',
    }

    // Injected exactly like the official css modules: one style tag per bundle,
    // themed through the same --dsw-alias-* custom properties. The overlay layer
    // is `position:absolute; inset:0; pointer-events:none` with auto pointer
    // events on children (dsh-client-ui-layout/lib/client.js:73), so the bar
    // anchors to the frame's bottom-right corner.
    const CSS = [
      // The overlay host is `absolute; inset:0`; the base rule deliberately has no
      // right/bottom anchor so inline {left,top} can win. Before the first measure
      // the renderer supplies the old right:18/bottom:18 anchor inline instead.
      '.psess-root{position:absolute;z-index:5;font-size:13px;line-height:1.5}',
      '.psess-pill{display:inline-flex;align-items:center;gap:7px;padding:6px 13px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 6px 18px rgba(0,0,0,.18);cursor:pointer;font-family:inherit;font-size:13px;touch-action:none;transition:box-shadow .15s ease,transform .15s ease}',
      '.psess-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.psess-pillAlert{border-color:var(--dsw-alias-state-warn-primary)}',
      '.psess-pillLow{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);box-shadow:0 4px 12px rgba(0,0,0,.12);font-size:12px;padding:4px 11px}',
      '.psess-pillLow:hover{color:var(--dsw-alias-label-secondary)}',
      '.psess-pillIdle{cursor:default}',
      '.psess-pillIdle:hover{background:var(--dsw-alias-bg-layer-2)}',
      // Long-press / drag feedback: the pill lifts off the surface (spec §12.1).
      '.psess-pillDragging{box-shadow:0 16px 36px rgba(0,0,0,.32);transform:translateY(-2px);cursor:grabbing;user-select:none}',
      '.psess-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}',
      '.psess-pillAlert .psess-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.psess-pillLow .psess-dot{background:var(--dsw-alias-label-tertiary);opacity:.55}',
      '.psess-pillRunning .psess-dot{animation:psess-pulse 1.6s ease-in-out infinite}',
      '@keyframes psess-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.78)}}',
      '@media (prefers-reduced-motion: reduce){.psess-pillRunning .psess-dot{animation:none}.psess-pill{transition:none}.psess-pillDragging{transform:none}}',
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
     * Top-level sessions that are waiting for their subagents (spec §14).
     * A parent is waiting when it is unread (a finished turn, no interaction of
     * its own) and any descendant subagent is still active. Activity is
     * `running === true` in either snapshot or a pending interaction; it
     * propagates up through nested subagents. Orphan rows (no parentSessionId,
     * or a parent that is not in the list) never suppress anything: the plugin
     * prefers an extra row over a lost top-level session.
     * @param input - { statuses, sessions } snapshots.
     * @returns Set of waiting top-level parent session ids.
     */
    function waitingParentIdsOf(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      const statuses = source.statuses instanceof Map ? source.statuses : new Map(Object.entries(source.statuses ?? {}))
      const sessions = source.sessions !== null && typeof source.sessions === 'object' ? source.sessions : {}
      const byId = sessions.byId !== null && typeof sessions.byId === 'object' ? sessions.byId : {}
      const summaryOf = (sessionId) => {
        const summary = byId[sessionId]
        return summary !== null && typeof summary === 'object' ? summary : undefined
      }
      // parentId -> child ids, from the frozen origin/parentSessionId fields.
      const childrenOf = new Map()
      for (const sessionId of Object.keys(byId)) {
        const summary = summaryOf(sessionId)
        if (summary === undefined || summary.origin !== 'subagent') continue
        const parentId = summary.parentSessionId
        if (typeof parentId !== 'string' || parentId.length === 0) continue
        if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
        childrenOf.get(parentId).push(sessionId)
      }
      const activeOf = (sessionId) => {
        const status = statuses.get(sessionId)
        if (status !== null && typeof status === 'object') {
          if (status.running === true) return true
          if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) return true
        }
        const summary = summaryOf(sessionId)
        return summary !== undefined && summary.running === true
      }
      // Memoized descendant activity; a node already on the stack is assumed
      // inactive, so a malformed parent cycle terminates instead of recursing.
      const memo = new Map()
      const visiting = new Set()
      const hasActiveDescendant = (sessionId) => {
        if (memo.has(sessionId)) return memo.get(sessionId)
        if (visiting.has(sessionId)) return false
        visiting.add(sessionId)
        let active = false
        for (const childId of childrenOf.get(sessionId) ?? []) {
          if (activeOf(childId) || hasActiveDescendant(childId)) {
            active = true
            break
          }
        }
        visiting.delete(sessionId)
        memo.set(sessionId, active)
        return active
      }
      const waiting = new Set()
      for (const [sessionId, status] of statuses) {
        if (pendingKindOf(status) !== 'unread') continue
        const summary = summaryOf(sessionId)
        if (summary === undefined || summary.origin === 'subagent') continue
        if (hasActiveDescendant(sessionId)) waiting.add(sessionId)
      }
      return waiting
    }

    /**
     * Fold the waiting suppression into the pending set (spec §14.1).
     * A previous waiting id survives only while it is still unread, so a parent
     * that becomes a blocking interaction is actionable again immediately.
     * `fresh` excludes waiting ids, so a parent does not notify while it waits
     * for its subagents.
     * @param input - { previousPending, previousWaiting, topPending, unreadTop,
     *   waitingNow } (sets or arrays).
     * @returns { waiting, pending, fresh } — three fresh Sets/array.
     */
    function nextPendingState(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      const toSet = (value) => (value instanceof Set ? value : new Set(value ?? []))
      const previousPending = toSet(source.previousPending)
      const previousWaiting = toSet(source.previousWaiting)
      const topPending = toSet(source.topPending)
      const unreadTop = toSet(source.unreadTop)
      const waitingNow = toSet(source.waitingNow)
      const waiting = new Set()
      for (const sessionId of previousWaiting) if (unreadTop.has(sessionId)) waiting.add(sessionId)
      for (const sessionId of waitingNow) waiting.add(sessionId)
      const pending = new Set()
      for (const sessionId of topPending) if (!waiting.has(sessionId)) pending.add(sessionId)
      const fresh = []
      for (const sessionId of pending) if (!previousPending.has(sessionId)) fresh.push(sessionId)
      return { waiting, pending, fresh }
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

    /**
     * Whether a fresh pending edge should auto-expand the panel (spec §15.1).
     * - `primed !== true` → false: the first snapshot is a baseline, not an edge
     *   observed while the user was looking at the page.
     * - `collapsedBefore === true` → false: the user temporarily collapsed the
     *   list; the edge only restores the pill count / warning colour (§11.2).
     * - otherwise at least one fresh id must be visible: `excludeMain` and the
     *   waiting-parent filter can both drop a fresh id, and an empty panel is
     *   not worth popping.
     * Malformed input never throws; it just answers false.
     * @param input - { primed, collapsedBefore, fresh, visibleIds }.
     *   `fresh` is an array of session ids; `visibleIds` is a Set or an array.
     * @returns {boolean} true when the edge should expand the panel.
     */
    function autoOpenOf(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      if (source.primed !== true) return false
      if (source.collapsedBefore === true) return false
      const fresh = Array.isArray(source.fresh) ? source.fresh : []
      if (fresh.length === 0) return false
      const visible = source.visibleIds instanceof Set
        ? source.visibleIds
        : Array.isArray(source.visibleIds) ? new Set(source.visibleIds) : new Set()
      for (const id of fresh) if (visible.has(id)) return true
      return false
    }

    // --- position & drag (spec §12 gesture, §13 fraction storage) ----------

    /** localStorage key for the pill position preference (UI preference, not session state). */
    const POSITION_KEY = 'pending-sessions/pill-position'
    /** Storage schema marker: 2 = { fx, fy } fractions; absent = legacy { left, top } pixels. */
    const POSITION_VERSION = 2
    /** Gap kept between the pill/panel and every viewport edge. */
    const EDGE_MARGIN = 8
    /** Default anchor mirrors the old CSS right:18px / bottom:18px. */
    const DEFAULT_MARGIN = 18
    /** Long-press threshold; crossing it also raises the visual feedback. */
    const HOLD_DRAG_MS = 400
    /** Pressed movement beyond this starts the drag immediately. */
    const MOVE_DRAG_PX = 10
    /** Panel width (mirrors CSS) and the pill-to-panel gap. */
    const PANEL_WIDTH = 324
    const PANEL_GAP = 8
    /** The panel never grows past this share of the viewport height (mirrors CSS 60vh). */
    const PANEL_MAX_RATIO = 0.6

    /** True only for real, finite numbers (keeps NaN/Infinity/strings out). */
    function isFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    /**
     * Clamp the pill's top-left into the viewport, keeping EDGE_MARGIN free on
     * every side. Free placement otherwise: no snapping to edges (spec §12.1).
     * Non-finite coordinates fall back to the bottom-right default anchor.
     * @param pos - { left, top } in overlay coordinates (anything tolerated).
     * @param viewport - { width, height } of the overlay host.
     * @param size - { width, height } of the pill.
     * @returns a fresh clamped { left, top }.
     */
    function clampPosition(pos, viewport, size) {
      const source = pos !== null && typeof pos === 'object' ? pos : {}
      const view = viewport !== null && typeof viewport === 'object' ? viewport : {}
      const box = size !== null && typeof size === 'object' ? size : {}
      const viewWidth = Math.max(0, isFiniteNumber(view.width) ? view.width : 0)
      const viewHeight = Math.max(0, isFiniteNumber(view.height) ? view.height : 0)
      const boxWidth = Math.max(0, isFiniteNumber(box.width) ? box.width : 0)
      const boxHeight = Math.max(0, isFiniteNumber(box.height) ? box.height : 0)
      // When the box is wider than the viewport, the left edge still stays on the
      // 8px margin instead of pushing the pill off-screen to the right.
      const maxLeft = Math.max(EDGE_MARGIN, viewWidth - boxWidth - EDGE_MARGIN)
      const maxTop = Math.max(EDGE_MARGIN, viewHeight - boxHeight - EDGE_MARGIN)
      const rawLeft = isFiniteNumber(source.left) ? source.left : maxLeft
      const rawTop = isFiniteNumber(source.top) ? source.top : maxTop
      return {
        left: Math.min(maxLeft, Math.max(EDGE_MARGIN, rawLeft)),
        top: Math.min(maxTop, Math.max(EDGE_MARGIN, rawTop)),
      }
    }

    /**
     * First-run position: the right:18 / bottom:18 anchor translated to
     * left/top from the viewport and the measured pill box (then clamped).
     * @returns { left, top }.
     */
    function defaultPosition(viewport, size) {
      const view = viewport !== null && typeof viewport === 'object' ? viewport : {}
      const box = size !== null && typeof size === 'object' ? size : {}
      const viewWidth = Math.max(0, isFiniteNumber(view.width) ? view.width : 0)
      const viewHeight = Math.max(0, isFiniteNumber(view.height) ? view.height : 0)
      const boxWidth = Math.max(0, isFiniteNumber(box.width) ? box.width : 0)
      const boxHeight = Math.max(0, isFiniteNumber(box.height) ? box.height : 0)
      return clampPosition({ left: viewWidth - boxWidth - DEFAULT_MARGIN, top: viewHeight - boxHeight - DEFAULT_MARGIN }, viewport, size)
    }

    /**
     * Movable range behind the fraction coordinates (spec §13): viewport minus
     * the pill box minus both EDGE_MARGINs. Zero when the pill does not fit; the
     * pill then stays on the 8px margin and every fraction resolves to it.
     * @param viewport - { width, height } of the overlay host.
     * @param size - { width, height } of the pill.
     * @returns { width, height } of the movable range (never negative).
     */
    function fractionRange(viewport, size) {
      const view = viewport !== null && typeof viewport === 'object' ? viewport : {}
      const box = size !== null && typeof size === 'object' ? size : {}
      const viewWidth = Math.max(0, isFiniteNumber(view.width) ? view.width : 0)
      const viewHeight = Math.max(0, isFiniteNumber(view.height) ? view.height : 0)
      const boxWidth = Math.max(0, isFiniteNumber(box.width) ? box.width : 0)
      const boxHeight = Math.max(0, isFiniteNumber(box.height) ? box.height : 0)
      return {
        width: Math.max(0, viewWidth - boxWidth - EDGE_MARGIN * 2),
        height: Math.max(0, viewHeight - boxHeight - EDGE_MARGIN * 2),
      }
    }

    /**
     * Pixel top-left -> fraction of the movable range (spec §13). fx = fy = 1 is
     * the bottom-right corner. Non-finite coordinates and a range <= 0 both
     * collapse to the pinned corner (EDGE_MARGIN on the cramped axis), so the
     * pill can never be placed outside the viewport.
     * @param pos - { left, top } in overlay coordinates (anything tolerated).
     * @param viewport - { width, height } of the overlay host.
     * @param size - { width, height } of the pill.
     * @returns { fx, fy } with both values inside 0..1.
     */
    function positionToFraction(pos, viewport, size) {
      const source = pos !== null && typeof pos === 'object' ? pos : {}
      const range = fractionRange(viewport, size)
      const left = isFiniteNumber(source.left) ? source.left : EDGE_MARGIN + range.width
      const top = isFiniteNumber(source.top) ? source.top : EDGE_MARGIN + range.height
      return {
        fx: range.width > 0 ? Math.min(1, Math.max(0, (left - EDGE_MARGIN) / range.width)) : 1,
        fy: range.height > 0 ? Math.min(1, Math.max(0, (top - EDGE_MARGIN) / range.height)) : 1,
      }
    }

    /**
     * Fraction of the movable range -> pixel top-left for the current viewport
     * (spec §13). Every render funnels the stored fraction through this, so a
     * resize/maximize re-anchors the pill without any clamp pass. Malformed
     * fractions fall back to the bottom-right corner; a range <= 0 pins the
     * margin instead of producing a negative coordinate.
     * @param fraction - { fx, fy } (anything tolerated).
     * @param viewport - { width, height } of the overlay host.
     * @param size - { width, height } of the pill.
     * @returns { left, top } inside the 8px margins.
     */
    function fractionToPosition(fraction, viewport, size) {
      const source = fraction !== null && typeof fraction === 'object' ? fraction : {}
      const range = fractionRange(viewport, size)
      const fx = isFiniteNumber(source.fx) ? Math.min(1, Math.max(0, source.fx)) : 1
      const fy = isFiniteNumber(source.fy) ? Math.min(1, Math.max(0, source.fy)) : 1
      return { left: EDGE_MARGIN + range.width * fx, top: EDGE_MARGIN + range.height * fy }
    }

    /** True when both the viewport and the pill box are measured enough to migrate. */
    function measurable(viewport, size) {
      return viewport !== null && typeof viewport === 'object' && size !== null && typeof size === 'object'
        && isFiniteNumber(viewport.width) && isFiniteNumber(viewport.height) && viewport.width > 0 && viewport.height > 0
        && isFiniteNumber(size.width) && isFiniteNumber(size.height) && size.width > 0 && size.height > 0
    }

    /**
     * Read the persisted pill position, always normalized to fractions (spec §13).
     * - new format { v: 2, fx, fy }: returned as-is;
     * - legacy { left, top } pixels: converted once with the current viewport +
     *   pill box and written back; without a measurement it returns undefined so
     *   the caller retries after the first render;
     * - missing / malformed / unknown version: undefined, so the caller falls
     *   back to the bottom-right default and the pill never lands off-window.
     * @param storageLike - a Storage-like { getItem, setItem } or anything.
     * @param viewport - current overlay host { width, height } (for migration).
     * @param size - current pill { width, height } (for migration).
     * @returns { fx, fy } or undefined.
     */
    function readPosition(storageLike, viewport, size) {
      if (storageLike === null || typeof storageLike !== 'object' || typeof storageLike.getItem !== 'function') return undefined
      let raw
      try {
        raw = storageLike.getItem(POSITION_KEY)
      } catch {
        return undefined
      }
      if (typeof raw !== 'string' || raw.length === 0) return undefined
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return undefined
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      if (parsed.v !== undefined && parsed.v !== POSITION_VERSION) return undefined
      if (isFiniteNumber(parsed.fx) && isFiniteNumber(parsed.fy)) return { fx: parsed.fx, fy: parsed.fy }
      if (!isFiniteNumber(parsed.left) || !isFiniteNumber(parsed.top)) return undefined
      // Legacy pixels need a real viewport + pill box; the first render has no
      // measurement yet, so the caller asks again once the pill is measured.
      if (!measurable(viewport, size)) return undefined
      const migrated = positionToFraction({ left: parsed.left, top: parsed.top }, viewport, size)
      writePosition(storageLike, migrated)
      return migrated
    }

    /**
     * Persist the pill position as fractions of the movable range (spec §13).
     * Storage failures (private mode, quota, no localStorage) are silent: the
     * in-memory position still works for this session (spec §12.2).
     * @param storageLike - a Storage-like { setItem } or anything.
     * @param fraction - { fx, fy }.
     * @returns true when the write went through.
     */
    function writePosition(storageLike, fraction) {
      if (storageLike === null || typeof storageLike !== 'object' || typeof storageLike.setItem !== 'function') return false
      if (fraction === null || typeof fraction !== 'object' || !isFiniteNumber(fraction.fx) || !isFiniteNumber(fraction.fy)) return false
      try {
        storageLike.setItem(POSITION_KEY, JSON.stringify({ v: POSITION_VERSION, fx: fraction.fx, fy: fraction.fy }))
        return true
      } catch {
        return false
      }
    }

    /**
     * Classify a pressed pointer from its hold time and total movement (spec
     * §12.1): either threshold starts a drag; a release before either of them
     * keeps the original click behaviour.
     * @param input - { heldMs?, movedPx?, released? }.
     * @returns 'drag' | 'pending' | 'click'.
     */
    function dragGestureOf(input) {
      const source = input !== null && typeof input === 'object' ? input : {}
      const heldMs = isFiniteNumber(source.heldMs) && source.heldMs > 0 ? source.heldMs : 0
      const movedPx = isFiniteNumber(source.movedPx) && source.movedPx > 0 ? source.movedPx : 0
      if (movedPx > MOVE_DRAG_PX) return 'drag'
      if (heldMs >= HOLD_DRAG_MS) return 'drag'
      return source.released === true ? 'click' : 'pending'
    }

    /**
     * Where the expanded panel goes relative to the pill (spec §12.3).
     * The pill's vertical half decides the direction; the panel's right edge
     * hugs the pill's right edge and the whole panel stays inside the viewport.
     * @param pos - pill top-left plus its measured { width, height }.
     * @param viewport - { width, height } of the overlay host.
     * @param panelSize - { width, height } of the panel (height is advisory).
     * @returns { direction, left, offsetLeft, maxWidth, maxHeight } where
     *   direction is 'up' | 'down', left is the panel's overlay-space left,
     *   offsetLeft is the value to render on the panel inside the root, and
     *   maxWidth/maxHeight bound an oversized panel on a small window.
     */
    function panelPlacement(pos, viewport, panelSize) {
      const source = pos !== null && typeof pos === 'object' ? pos : {}
      const view = viewport !== null && typeof viewport === 'object' ? viewport : {}
      const panel = panelSize !== null && typeof panelSize === 'object' ? panelSize : {}
      const viewWidth = Math.max(0, isFiniteNumber(view.width) ? view.width : 0)
      const viewHeight = Math.max(0, isFiniteNumber(view.height) ? view.height : 0)
      const pillLeft = isFiniteNumber(source.left) ? source.left : 0
      const pillTop = isFiniteNumber(source.top) ? source.top : 0
      const pillWidth = Math.max(0, isFiniteNumber(source.width) ? source.width : 0)
      const pillHeight = Math.max(0, isFiniteNumber(source.height) ? source.height : 0)
      const panelWidth = Math.max(0, isFiniteNumber(panel.width) ? panel.width : PANEL_WIDTH)
      const maxWidth = Math.max(0, viewWidth - EDGE_MARGIN * 2)
      const maxLeft = Math.max(EDGE_MARGIN, viewWidth - panelWidth - EDGE_MARGIN)
      // Right edges touch, then the pair is pulled back inside the viewport.
      const aligned = pillLeft + pillWidth - panelWidth
      const left = Math.min(maxLeft, Math.max(EDGE_MARGIN, aligned))
      // Lower half opens upwards, upper half (and the exact middle) downwards.
      const direction = pillTop + pillHeight / 2 > viewHeight / 2 ? 'up' : 'down'
      const room = direction === 'up'
        ? pillTop - PANEL_GAP - EDGE_MARGIN
        : viewHeight - (pillTop + pillHeight) - PANEL_GAP - EDGE_MARGIN
      const maxHeight = Math.max(0, Math.min(room, viewHeight * PANEL_MAX_RATIO))
      return { direction, left, offsetLeft: left - pillLeft, maxWidth, maxHeight }
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
        this.store = createStore({ items: [], pending: 0, blocking: 0, running: 0, collapsed: false, collapsedCount: 0, notification: 'unknown', position: undefined, autoOpenSeq: 0 })
        this.unsubscribers = []
        this.pendingIds = new Set()
        // Parents currently waiting for their subagents (spec §14.2): memory
        // only, never written to disk. Filtered out of every published
        // projection; recalculated only on sessionStatus changes.
        this.waitingIds = new Set()
        // Temporary collapse lives in memory only (spec §11.2): a page refresh
        // starts from an empty set, exactly like the notification episodes.
        this.collapsedIds = new Set()
        // Pill position is a UI preference, not session state (spec §12.2):
        // persisted in localStorage as fractions of the movable range (§13) and
        // kept across connection/reset. Undefined means "bottom-right default":
        // the renderer keeps the CSS anchor until a stored fraction is adopted.
        this.position = undefined
        // Pixel preview owned by an active drag (spec §13: the drag follows the
        // pointer in pixels; release converts it to a fraction and persists).
        this.livePosition = undefined
        // One-shot guard for the legacy-pixel migration (needs a measurement).
        this.positionChecked = false
        // Monotonic auto-open signal consumed by the renderer (spec §15.2): a
        // visible fresh edge bumps it, and `reset()` deliberately keeps it so a
        // remount can never replay an already-consumed sequence.
        this.autoOpenSeq = 0
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
        // `sessions` rides along for the waiting-parent check (spec §14.2).
        return { statuses, sessions, subagentIds: subagentIdsOf(sessions), all: buildItems({ statuses, sessions, workspaces }), mainSessionId }
      }

      /**
       * Visible projection shared by publish() and the auto-open check
       * (spec §15.2): drop the main-view session, then the waiting parents.
       * @param data - the collect() result.
       * @returns the visible item array.
       */
      project(data) {
        // Main-view sessions are already in front of the user; waiting parents
        // are suppressed from every derived count (spec §14.2). The `running`
        // count in publish() deliberately keeps every session.
        return excludeMain(data.all, data.mainSessionId).filter((item) => !this.waitingIds.has(item.sessionId))
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
        // Waiting parents are suppressed from every derived count (spec §14.2);
        // the running count below deliberately keeps every session.
        const visible = this.project(data)
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
          position: this.position,
          livePosition: this.livePosition,
          autoOpenSeq: this.autoOpenSeq,
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
        const { current } = detectFresh(this.pendingIds, collected.statuses, collected.subagentIds)
        const statuses = collected.statuses instanceof Map ? collected.statuses : new Map(Object.entries(collected.statuses ?? {}))
        // Only a plain finished turn can wait for subagents; an interaction of
        // the parent's own must surface immediately (spec §14.1).
        const unreadTop = new Set()
        for (const sessionId of current) if (pendingKindOf(statuses.get(sessionId)) === 'unread') unreadTop.add(sessionId)
        const waitingNow = waitingParentIdsOf({ statuses, sessions: collected.sessions })
        const next = nextPendingState({
          previousPending: this.pendingIds,
          previousWaiting: this.waitingIds,
          topPending: current,
          unreadTop,
          waitingNow,
        })
        this.waitingIds = next.waiting
        this.pendingIds = next.pending
        // Temporary collapse is a client-only fold: prune ids that left pending,
        // then auto-restore when a session outside the set newly entered. The
        // baseline snapshot is not an edge, so it never collapses or restores.
        // Waiting parents are already gone from `pending` and `fresh`.
        // Sample the collapse set *before* the fold: auto-restore clears it on
        // the very edge we are about to judge (spec §15.1).
        const collapsedBefore = this.collapsedIds.size > 0
        const fold = nextCollapsed(this.collapsedIds, { pending: next.pending, fresh: this.primed ? next.fresh : [] })
        this.collapsedIds = fold.collapsed
        // A fresh edge that will actually be shown auto-expands the panel
        // (spec §15.2); hidden fresh ids (main view / waiting parent) must not
        // pop an empty panel. The visible set matches publish() exactly.
        const visibleIds = new Set(this.project(collected).map((item) => item.sessionId))
        if (autoOpenOf({ primed: this.primed, collapsedBefore, fresh: next.fresh, visibleIds })) this.autoOpenSeq += 1
        this.publish(collected)
        if (!this.primed) {
          // First snapshot is the baseline: sessions already pending when the
          // page opens are not an edge we observed.
          this.primed = true
          return
        }
        if (next.fresh.length === 0) return
        const byId = new Map(collected.all.map((item) => [item.sessionId, item]))
        const freshItems = next.fresh.map((sessionId) => byId.get(sessionId)).filter((item) => item !== undefined)
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

      /** localStorage, or undefined when unavailable (private mode, disabled). */
      storage() {
        try {
          return typeof window !== 'undefined' && window.localStorage !== undefined && window.localStorage !== null ? window.localStorage : undefined
        } catch {
          return undefined
        }
      }

      /**
       * Adopt the stored position once the real viewport + pill box are known
       * (spec §13). The legacy { left, top } pixel format can only be converted
       * against a measurement, so the renderer calls this after its first
       * measure; the fraction format was already read by start().
       */
      ensurePosition(viewport, size) {
        if (this.disposed || this.positionChecked) return
        this.positionChecked = true
        if (this.position !== undefined) return
        const stored = readPosition(this.storage(), viewport, size)
        if (stored === undefined) return
        this.position = stored
        this.publish()
      }

      /** Live drag preview in pixels (spec §13); equality-guarded against render loops. */
      moveTo(left, top) {
        if (this.disposed) return
        if (!isFiniteNumber(left) || !isFiniteNumber(top)) return
        const live = this.livePosition
        if (live !== undefined && live.left === left && live.top === top) return
        this.livePosition = { left, top }
        this.publish()
      }

      /**
       * Release a drag: convert the last pixel position to a fraction of the
       * movable range and persist it (spec §13). Storage failures are silent.
       * @returns true when the write went through.
       */
      persistPosition(viewport, size) {
        if (this.disposed) return false
        if (this.livePosition !== undefined) {
          this.position = positionToFraction(this.livePosition, viewport, size)
          this.livePosition = undefined
          this.publish()
        }
        if (this.position === undefined) return false
        return writePosition(this.storage(), this.position)
      }

      start() {
        if (this.disposed) return
        if (this.position === undefined) this.position = readPosition(this.storage())
        this.positionChecked = false
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
        this.waitingIds = new Set()
        this.collapsedIds = new Set()
        this.primed = false
        this.notification = 'unknown'
        this.start()
      }

      dispose() {
        if (this.disposed) return
        this.disposed = true
        this.waitingIds = new Set()
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

    /** Size of the overlay host the pill lives in; falls back to the window. */
    function hostViewportOf(node) {
      try {
        const root = node !== null && node !== undefined ? node.parentElement : null
        const host = root !== null ? root.parentElement : null
        if (host !== null) {
          const rect = host.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height }
        }
      } catch {
        // measurement is best-effort
      }
      const width = typeof window !== 'undefined' && isFiniteNumber(window.innerWidth) ? window.innerWidth : 0
      const height = typeof window !== 'undefined' && isFiniteNumber(window.innerHeight) ? window.innerHeight : 0
      return { width, height }
    }

    /** Measured pill box; zeroes when the node is gone. */
    function pillSizeOf(node) {
      try {
        if (node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function') {
          const rect = node.getBoundingClientRect()
          return { width: rect.width, height: rect.height }
        }
      } catch {
        // measurement is best-effort
      }
      return { width: 0, height: 0 }
    }

    /** Root style: pixel position converted from the fraction, else the CSS bottom-right anchor. */
    function rootStyle(position) {
      if (position === undefined || position === null) return { right: DEFAULT_MARGIN + 'px', bottom: DEFAULT_MARGIN + 'px' }
      return { left: position.left + 'px', top: position.top + 'px' }
    }

    function PendingSessionsOverlay(props) {
      const snapshot = props.usePendingSessions((state) => state)
      const [expanded, setExpanded] = useState(false)
      const [dragging, setDragging] = useState(false)
      // Measured pill box + host viewport (spec §13). Each render converts the
      // stored fraction through this layout, so a resize/maximize re-anchors the
      // pill to the same relative spot; no clamping pass is involved anymore.
      const [layout, setLayout] = useState(null)
      const pillRef = React.useRef(null)
      const gestureRef = React.useRef(null)
      const suppressClickRef = React.useRef(false)
      const metricsRef = React.useRef(null)
      const layoutRef = React.useRef(null)
      // Last consumed auto-open sequence (spec §15.2): -1 = not recorded yet.
      const openSeqRef = React.useRef(-1)
      const stored = snapshot.position
      const fraction = stored !== null && typeof stored === 'object' && isFiniteNumber(stored.fx) && isFiniteNumber(stored.fy)
        ? { fx: stored.fx, fy: stored.fy }
        : undefined
      const liveStored = snapshot.livePosition
      const live = liveStored !== null && typeof liveStored === 'object' && isFiniteNumber(liveStored.left) && isFiniteNumber(liveStored.top)
        ? { left: liveStored.left, top: liveStored.top }
        : undefined
      // The live drag preview wins; otherwise the fraction is re-anchored to the
      // viewport measured for this render. Undefined = CSS bottom-right anchor
      // until the first measurement (never a zero-size conversion).
      const position = live !== undefined
        ? live
        : fraction !== undefined && layout !== null
          ? fractionToPosition(fraction, layout.viewport, layout.size)
          : undefined

      // Measure the pill box and its host while collapsed. A changed box or
      // viewport re-renders so the fraction lands on the new geometry; an
      // expanded panel locks the position, so measurement skips it.
      useEffect(() => {
        if (expanded) return
        const node = pillRef.current
        if (node === null || node === undefined) return
        const size = pillSizeOf(node)
        const viewport = hostViewportOf(node)
        metricsRef.current = size
        const previous = layoutRef.current
        if (previous === null
          || previous.viewport.width !== viewport.width || previous.viewport.height !== viewport.height
          || previous.size.width !== size.width || previous.size.height !== size.height) {
          const next = { viewport, size }
          layoutRef.current = next
          setLayout(next)
        }
        // A legacy pixel preference needs this first measurement to become a
        // fraction; the controller makes it a one-shot (spec §13).
        props.ensurePosition(viewport, size)
      })

      // Window changes only trigger a re-measure + re-render: the fraction is
      // the anchor, so there is no clamp semantics left here (spec §13).
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onResize = () => {
          const node = pillRef.current
          if (node === null || node === undefined) return
          const viewport = hostViewportOf(node)
          const size = pillSizeOf(node)
          metricsRef.current = size
          const previous = layoutRef.current
          if (previous !== null
            && previous.viewport.width === viewport.width && previous.viewport.height === viewport.height
            && previous.size.width === size.width && previous.size.height === size.height) return
          const next = { viewport, size }
          layoutRef.current = next
          setLayout(next)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // A long-press timer must never outlive the overlay.
      useEffect(() => () => {
        const gesture = gestureRef.current
        if (gesture !== null) clearTimeout(gesture.timer)
        gestureRef.current = null
      }, [])

      // A fresh pending edge bumped the controller's monotonic counter: expand
      // the panel (spec §15.2). Deliberately no dependency array, matching the
      // measuring effects above. The -1 sentinel makes the first render
      // record-only, so a page load / connection reset baseline never pops the
      // panel; a smaller or equal sequence (a stale snapshot) is a no-op.
      useEffect(() => {
        const seq = Number.isFinite(snapshot.autoOpenSeq) ? snapshot.autoOpenSeq : 0
        if (openSeqRef.current === -1) {
          openSeqRef.current = seq
          return
        }
        if (seq > openSeqRef.current) {
          openSeqRef.current = seq
          setExpanded(true)
        }
      })

      const enterDrag = (gesture) => {
        if (gesture.dragging === true) return
        gesture.dragging = true
        setDragging(true)
      }

      const onPointerDown = (event) => {
        if (event === null || typeof event !== 'object') return
        if (isFiniteNumber(event.button) && event.button !== 0) return
        const node = event.currentTarget
        const size = pillSizeOf(node)
        const viewport = hostViewportOf(node)
        metricsRef.current = size
        suppressClickRef.current = false
        const start = position === undefined ? defaultPosition(viewport, size) : clampPosition(position, viewport, size)
        const gesture = {
          pointerId: event.pointerId,
          startX: isFiniteNumber(event.clientX) ? event.clientX : 0,
          startY: isFiniteNumber(event.clientY) ? event.clientY : 0,
          startLeft: start.left,
          startTop: start.top,
          lastLeft: start.left,
          lastTop: start.top,
          size,
          viewport,
          downAt: Date.now(),
          dragging: false,
          timer: undefined,
        }
        gesture.timer = setTimeout(() => {
          if (gestureRef.current === gesture) enterDrag(gesture)
        }, HOLD_DRAG_MS)
        gestureRef.current = gesture
        if (isFiniteNumber(event.pointerId) && typeof node.setPointerCapture === 'function') {
          try {
            node.setPointerCapture(event.pointerId)
          } catch {
            // pointer capture is best-effort
          }
        }
      }

      const onPointerMove = (event) => {
        const gesture = gestureRef.current
        if (gesture === null || event === null || typeof event !== 'object') return
        if (event.pointerId !== undefined && event.pointerId !== gesture.pointerId) return
        const dx = (isFiniteNumber(event.clientX) ? event.clientX : gesture.startX) - gesture.startX
        const dy = (isFiniteNumber(event.clientY) ? event.clientY : gesture.startY) - gesture.startY
        const movedPx = Math.sqrt(dx * dx + dy * dy)
        const heldMs = Date.now() - gesture.downAt
        if (gesture.dragging !== true && dragGestureOf({ heldMs, movedPx }) === 'drag') enterDrag(gesture)
        if (gesture.dragging !== true) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const next = clampPosition({ left: gesture.startLeft + dx, top: gesture.startTop + dy }, gesture.viewport, gesture.size)
        gesture.lastLeft = next.left
        gesture.lastTop = next.top
        props.moveTo(next.left, next.top)
      }

      const finishGesture = (event) => {
        const gesture = gestureRef.current
        if (gesture === null) return
        if (event !== null && typeof event === 'object' && event.pointerId !== undefined && event.pointerId !== gesture.pointerId) return
        clearTimeout(gesture.timer)
        gestureRef.current = null
        if (event !== null && typeof event === 'object') {
          const node = event.currentTarget
          if (node !== null && node !== undefined && typeof node.releasePointerCapture === 'function') {
            try {
              if (typeof node.hasPointerCapture !== 'function' || node.hasPointerCapture(gesture.pointerId)) node.releasePointerCapture(gesture.pointerId)
            } catch {
              // capture release is best-effort
            }
          }
        }
        if (gesture.dragging !== true) return
        // A finished drag must not also expand the panel: swallow the synthetic click.
        suppressClickRef.current = true
        setDragging(false)
        const next = clampPosition({ left: gesture.lastLeft, top: gesture.lastTop }, gesture.viewport, gesture.size)
        props.moveTo(next.left, next.top)
        // Release converts the pixel drop point into the stored fraction (spec §13).
        props.persistPosition(gesture.viewport, gesture.size)
      }

      const onClick = (event) => {
        if (suppressClickRef.current === true) {
          suppressClickRef.current = false
          return
        }
        if (event !== null && typeof event === 'object' && event.currentTarget !== null && event.currentTarget !== undefined) {
          metricsRef.current = pillSizeOf(event.currentTarget)
        }
        // A muted pill restores first, then opens; otherwise it just opens.
        // Key on the snapshot flag, not pill.mode: running outranks collapsed
        // in pillStateOf, so a running+collapsed pill must restore too
        // (spec §11.2: click the muted pill = restore + open).
        if (collapsed) props.restore()
        setExpanded(true)
      }

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
        if (dragging) pillClasses.push('psess-pillDragging')
        const pillTitle = hint === undefined ? props.t('dragHint') : hint + ' · ' + props.t('dragHint')
        // Drag handlers are mounted only on the collapsed pill, never on the
        // expanded panel (spec §12.1); the idle pill can be moved as well.
        const pillProps = {
          className: pillClasses.join(' '),
          title: pillTitle,
          'aria-label': ariaLabel,
          ref: pillRef,
          onPointerDown,
          onPointerMove,
          onPointerUp: finishGesture,
          onPointerCancel: finishGesture,
        }
        if (interactive) {
          pillProps.type = 'button'
          pillProps.onClick = onClick
        } else {
          pillProps.role = 'status'
        }
        return h('div', { className: 'psess-root', style: rootStyle(position) },
          h(interactive ? 'button' : 'div', pillProps,
            h('span', { className: 'psess-dot' }),
            ...pillText))
      }

      const summary = summaryOf({ running, pending, collapsed })
        .map((part) => props.t(part.key, { count: part.count }))
        .join(' · ')

      // Panel follows the pill (spec §12.3, §13): anchored to the pill's pixel
      // position derived from the stored fraction for the current viewport.
      const viewport = layout !== null ? layout.viewport : { width: 0, height: 0 }
      const pillSize = layout !== null
        ? layout.size
        : metricsRef.current !== null
          ? metricsRef.current
          : { width: 0, height: 0 }
      const anchor = position !== undefined ? position : defaultPosition(viewport, pillSize)
      const placement = panelPlacement({ left: anchor.left, top: anchor.top, width: pillSize.width, height: pillSize.height }, viewport, { width: PANEL_WIDTH, height: 0 })
      const panelStyle = {
        position: 'absolute',
        left: placement.offsetLeft + 'px',
        maxWidth: placement.maxWidth + 'px',
        maxHeight: placement.maxHeight + 'px',
      }
      // The root box collapses to zero height while expanded, so `bottom: 100%`
      // resolves to the pill's top edge; downwards uses the measured pill height.
      if (placement.direction === 'up') panelStyle.bottom = 'calc(100% + ' + PANEL_GAP + 'px)'
      else panelStyle.top = pillSize.height + PANEL_GAP + 'px'

      return h('div', { className: 'psess-root', style: rootStyle(anchor) },
        h('div', { className: blocking ? 'psess-panel psess-panelAlert' : 'psess-panel', style: panelStyle },
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
          moveTo: (left, top) => controller.moveTo(left, top),
          persistPosition: (viewport, size) => controller.persistPosition(viewport, size),
          ensurePosition: (viewport, size) => controller.ensurePosition(viewport, size),
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
    }
    return module.exports
  },
})
