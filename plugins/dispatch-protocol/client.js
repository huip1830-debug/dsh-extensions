// dispatch-protocol — browser half (0.16.0): the session-zone mode control.
//
// Hand-written lazy-CJS registration script: the Host serves this file as-is
// (no build, no transpile), so it must stay plain JS with `createElement` only.
// The module `id` must equal the npm package name. Runtime `require` is limited
// to platform seed modules; only `react` is used here.
//
// Spec: docs/superpowers/specs/2026-11-17-dispatch-ui-design.md §3.2.
//
// Signal surfaces consumed (verified against the shipped desktop build):
//   - Slot `conversation.input.dock`: a `list` slot of `scope: 'session'`,
//     "Full-width entries above the composer card"
//     (dsh-client-ui-conversation/src/client/contract/slots.ts:301-305). The
//     Host renders it as soon as `session` and `inputState` are ready — with no
//     hero/composer condition — so a freshly created blank Session shows it too
//     (same package, src/client/skeleton/ConversationContent.tsx:86-87, :169).
//     0.14.x used `conversation.composer.dock`, which the Host renders only for
//     `variant === 'composer'`
//     (dsh-client-ui-conversation/src/client/skeleton/InputBar.tsx:596-599);
//     new Sessions land in the hero state
//     (same package, src/client/skeleton/ConversationMainPanel.tsx:32-35), so
//     that whole row vanished — the defect 0.15.1 fixes. A session-scope
//     entry's `inject` is called with the SessionId, so the component takes the
//     current Session from props and never reads owner props
//     (dsh-client-ui-renderer/src/client/scoped-slots.tsx:175-190).
//   - Read: `remote.workspaceFiles.read(sessionId, path, range, signal)`
//     resolves a workspace-root-relative path and answers `RemoteResult`
//     (dsh-api-workspace-files/src/client/index.ts:19,
//     dsh-api-workspace-files/README.md:29, :42, :89). `workspace-file/not-found`
//     means "no marker", which the Host treats as `auto`
//     (lib/project.mjs:99-105).
//   - Write: `remote.commands.execute(sessionId, line, attachments)` is the
//     same admission path the `/` menu uses (dsh-client-ui-commands/src/client/
//     service.ts:420-435); it resolves `{ ok: true, value: { result } }` where
//     `result.kind` is `'success' | 'error'` (same file :427-433).
//   - Refresh: `command/executed` is a local Cordis event emitted after an
//     admitted Host command (dsh-client-ui-commands/src/client/service.ts:48-61,
//     :437-452); listeners are shared across plugin contexts because every
//     child context inherits one EventsService (cordis/src/context.ts:80-84).
//
// The marker file is the only source of truth: this dock, `/dispatch`, and a
// hand edit are three views of `<cwd>/dispatch/protocol.json`.

window.__ModuleLoader__.load({
  id: 'dispatch-protocol',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    /** Dictionary namespace owned by this bundle. */
    const NS = 'dispatchProtocol'

    /** Marker path, cwd relative — mirrors `DEFAULT_PROJECT_SWITCH.path` (lib/project.mjs:30). */
    const MARKER_PATH = 'dispatch/protocol.json'

    /** Allowed modes, in display order off → auto → shadow → full (lib/project.mjs:42). */
    const MODES = ['off', 'auto', 'shadow', 'full']

    // Mirrors locale/*.json `ui` (the plugin inventory reads meta.* there; the
    // bundle only sees what it carries). Keep both copies in sync.
    const zh = {
      title: '派发纪律',
      modeOff: '关闭',
      modeAuto: '自动',
      modeShadow: '只记',
      modeFull: '全部',
      modeUnknown: '未知',
      unknownHint: '读不到标记文件：{detail}',
      writeFailed: '切换失败：{detail}',
      unsupported: '当前宿主没有客户端命令执行面',
      switchTo: '切换为「{label}」',
      unreadable: '未知原因',
    }

    const en = {
      title: 'Dispatch discipline',
      modeOff: 'Off',
      modeAuto: 'Auto',
      modeShadow: 'Shadow',
      modeFull: 'Full',
      modeUnknown: 'Unknown',
      unknownHint: 'Cannot read the marker file: {detail}',
      writeFailed: 'Switch failed: {detail}',
      unsupported: 'This host has no client command surface',
      switchTo: 'Switch to "{label}"',
      unreadable: 'unknown reason',
    }

    // Injected exactly like the official css modules: one style tag per bundle,
    // themed through the --dsw-alias-* custom properties. The dock is an
    // ambient row above the composer card (0.15.1 `input.dock`), so it stays a
    // single line of chips.
    const CSS = [
      '.ddp-dock{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:2px 4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.ddp-label{color:var(--dsw-alias-label-secondary);font-weight:600}',
      '.ddp-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.ddp-valueUnknown{color:var(--dsw-alias-label-tertiary)}',
      '.ddp-modes{display:inline-flex;align-items:center;gap:2px;margin-left:2px;padding:1px;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}',
      '.ddp-mode{border:0;background:0 0;padding:1px 8px;border-radius:999px;cursor:pointer;font-family:inherit;font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.6}',
      '.ddp-mode:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ddp-mode:disabled{cursor:default;opacity:.55}',
      '.ddp-modeCurrent{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}',
      '.ddp-modeCurrent{background:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}',
      '.ddp-modeCurrent:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);color:var(--dsw-alias-label-primary)}',
      '.ddp-notice{color:var(--dsw-alias-state-warn-label)}',
      // Narrow screens keep only the current mode on screen (spec §3.2).
      '@media (max-width:640px){.ddp-mode{display:none}.ddp-modeCurrent{display:inline-block}}',
      '@media (prefers-reduced-motion: reduce){.ddp-mode{transition:none}}',
    ].join('\n')
    const cssTagId = 'dispatch-protocol/dock.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dispatch-protocol'
      tag.dataset.pluginCss = cssTagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- pure core (exported for offline checks) ----------------------------

    /** Dictionary key for one mode; unknown modes keep the generic label. */
    function modeLabelKey(mode) {
      if (mode === 'off') return 'modeOff'
      if (mode === 'auto') return 'modeAuto'
      if (mode === 'shadow') return 'modeShadow'
      return 'modeFull'
    }

    /**
     * Parse marker-file text into a mode, mirroring the Host reader
     * (lib/project.mjs:63-88): a bad file is "not configured", which is `auto`
     * since 0.16.0. `enabled:true` keeps the 0.13 meaning of full.
     * @param text - the file's text, or anything else.
     * @returns `'off' | 'auto' | 'shadow' | 'full'`.
     */
    function modeOfText(text) {
      if (typeof text !== 'string') return 'auto'
      let data
      try {
        data = JSON.parse(text)
      } catch {
        return 'auto'
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'auto'
      if (typeof data.mode === 'string' && MODES.includes(data.mode)) return data.mode
      if (data.enabled === false) return 'off'
      if (data.enabled === true) return 'full'
      return 'auto'
    }

    /** Readable cause for a failed RPC outcome; never throws. */
    function detailOf(outcome) {
      if (outcome === null || typeof outcome !== 'object') return 'unknown'
      if (typeof outcome.detail === 'string' && outcome.detail !== '') return outcome.detail
      if (typeof outcome.reason === 'string' && outcome.reason !== '') return outcome.reason
      return 'unknown'
    }

    // --- services -----------------------------------------------------------

    /** Marker read result: `mode` is undefined when the read failed. */
    function readModeOf(ctx, sessionId) {
      return (async () => {
        try {
          // Declared above in `inject`: resolved statically, not via `ctx.get`.
          const files = ctx.remote.workspaceFiles
          if (files === undefined || files === null || typeof files.read !== 'function') {
            return { mode: undefined, detail: 'no-remote' }
          }
          const result = await files.read(sessionId, MARKER_PATH, {})
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            const code = result?.error?.code
            const message = result?.error?.message
            // No marker in this workspace root: the Host's default is auto (0.16.0).
            if (code === 'workspace-file/not-found') return { mode: 'auto' }
            const detail = [code, message].filter((part) => typeof part === 'string' && part !== '').join(': ')
            return { mode: undefined, detail: detail === '' ? 'unknown' : detail }
          }
          const value = result.value
          return { mode: modeOfText(typeof value?.text === 'string' ? value.text : undefined) }
        } catch (error) {
          return { mode: undefined, detail: String(error?.message ?? error) }
        }
      })()
    }

    /**
     * Write one mode through the Host command, the same admission path the `/`
     * menu uses. Returns `{ ok: true }` or `{ ok: false, reason, detail? }`.
     */
    function switchModeOf(ctx, sessionId, mode) {
      return (async () => {
        try {
          // Same rule as the read path: the dotted face is a declared injection.
          const commands = ctx.remote.commands
          if (commands === undefined || commands === null || typeof commands.execute !== 'function') {
            return { ok: false, reason: 'unsupported' }
          }
          const result = await commands.execute(sessionId, '/dispatch ' + mode, [])
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            const code = result?.error?.code
            const message = result?.error?.message
            const detail = [code, message].filter((part) => typeof part === 'string' && part !== '').join(': ')
            return { ok: false, reason: 'rpc', detail: detail === '' ? 'unknown' : detail }
          }
          const payload = result.value
          if (payload === undefined || payload === null) return { ok: false, reason: 'unknown-command' }
          const outcome = payload.result
          if (outcome !== null && typeof outcome === 'object' && outcome.kind === 'error') {
            return { ok: false, reason: 'handler', detail: typeof outcome.text === 'string' ? outcome.text : undefined }
          }
          return { ok: true }
        } catch (error) {
          return { ok: false, reason: 'exception', detail: String(error?.message ?? error) }
        }
      })()
    }

    // --- renderer -----------------------------------------------------------

    function DispatchDock(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const sessionId = props.sessionId
      const [view, setView] = useState({ mode: undefined, detail: undefined })
      // `busy` (state) only drives the disabled look: two clicks in the same tick
      // both read the old state, so the ref is the actual synchronous gate.
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(undefined)
      const revision = useRef(0)
      const mounted = useRef(true)
      const busyRef = useRef(false)
      const loadRef = useRef(undefined)

      /** Re-read the marker; a stale answer (older revision) is dropped. */
      const load = () => {
        const token = ++revision.current
        Promise.resolve(props.readMode(sessionId)).then((next) => {
          if (!mounted.current || token !== revision.current) return
          setView(next === null || typeof next !== 'object' ? { mode: undefined, detail: 'unknown' } : next)
        }, (error) => {
          if (!mounted.current || token !== revision.current) return
          setView({ mode: undefined, detail: String(error?.message ?? error) })
        })
      }
      loadRef.current = load

      // First read + every refresh trigger: `command/executed`, window focus,
      // tab visibility, and the Session switch that remounts this binding.
      useEffect(() => {
        mounted.current = true
        loadRef.current()
        const stop = typeof props.subscribe === 'function' ? props.subscribe(() => loadRef.current()) : undefined
        const onFocus = () => loadRef.current()
        const onVisibility = () => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') loadRef.current()
        }
        const scope = typeof window !== 'undefined' ? window : undefined
        if (scope !== undefined && typeof scope.addEventListener === 'function') {
          scope.addEventListener('focus', onFocus)
          scope.addEventListener('pageshow', onFocus)
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility)
        }
        return () => {
          mounted.current = false
          if (typeof stop === 'function') stop()
          if (scope !== undefined && typeof scope.removeEventListener === 'function') {
            scope.removeEventListener('focus', onFocus)
            scope.removeEventListener('pageshow', onFocus)
          }
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }
      }, [sessionId])

      const choose = (mode) => {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
        setNotice(undefined)
        Promise.resolve(props.switchMode(sessionId, mode)).then((result) => {
          busyRef.current = false
          if (!mounted.current) return
          setBusy(false)
          if (result !== null && typeof result === 'object' && result.ok === true) {
            loadRef.current()
            return
          }
          const reason = result?.reason
          const detail = reason === 'unsupported' ? t('unsupported') : (detailOf(result) === 'unknown' ? t('unreadable') : detailOf(result))
          setNotice(t('writeFailed', { detail }))
        }, (error) => {
          busyRef.current = false
          if (!mounted.current) return
          setBusy(false)
          setNotice(t('writeFailed', { detail: String(error?.message ?? error) }))
        })
      }

      const mode = view !== null && typeof view === 'object' ? view.mode : undefined
      const known = MODES.includes(mode)
      const detail = view !== null && typeof view === 'object' && typeof view.detail === 'string' ? view.detail : undefined
      const valueText = known ? mode : t('modeUnknown')
      const valueTitle = known ? undefined : t('unknownHint', { detail: detail === undefined ? t('unreadable') : detail })

      const buttons = MODES.map((candidate) => {
        const className = 'ddp-mode' + (candidate === mode ? ' ddp-modeCurrent' : '')
        return h('button', {
          key: candidate,
          type: 'button',
          className,
          disabled: busy,
          title: t('switchTo', { label: t(modeLabelKey(candidate)) }),
          'aria-pressed': candidate === mode ? 'true' : 'false',
          onClick: () => choose(candidate),
        }, candidate)
      })

      return h('div', { className: 'ddp-dock', role: 'group', 'aria-label': t('title') },
        h('span', { className: 'ddp-label' }, t('title')),
        h('span', {
          className: known ? 'ddp-value' : 'ddp-value ddp-valueUnknown',
          title: valueTitle,
        }, valueText),
        h('span', { className: 'ddp-modes' }, buttons),
        notice === undefined ? null : h('span', { className: 'ddp-notice', role: 'status' }, notice))
    }

    // --- plugin -------------------------------------------------------------

    /**
     * Required services: slots, locale, and the Remote namespace with its two
     * faces (`remote.commands`, `remote.workspaceFiles` are child services, so
     * each needs its own entry; `ctx.remote.*` without one throws) — `inject`
     * resolves before `apply`, so the guard only covers a wiring gap.
     */
    const inject = ['slots', 'locale', 'remote', 'remote.commands', 'remote.workspaceFiles']

    function apply(ctx) {
      const remote = ctx.remote
      const present = { slots: ctx.slots, locale: ctx.locale, remote, 'remote.commands': remote?.commands, 'remote.workspaceFiles': remote?.workspaceFiles }
      const missing = Object.keys(present).filter((name) => present[name] === undefined || present[name] === null)
      if (missing.length > 0) {
        console.warn('dispatch-protocol: missing services ' + missing.join(', ') + '; the dock stays inactive')
        return
      }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dispatch-protocol: dictionaries')

      /** Refresh subscribers (mounted docks). */
      const listeners = new Set()
      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // A dock that throws while refreshing must not break the others.
          }
        }
      }
      const api = {
        notify,
        readMode: (sessionId) => readModeOf(ctx, sessionId),
        switchMode: (sessionId, mode) => switchModeOf(ctx, sessionId, mode),
        subscribe: (listener) => {
          if (typeof listener !== 'function') return undefined
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }

      // A `/dispatch` typed in the composer reaches us through this local
      // acknowledgment; `connection/reset` re-seeds after a carrier restart.
      ctx.effect(() => ctx.on('command/executed', () => notify()), 'dispatch-protocol: command/executed')
      ctx.effect(() => ctx.on('connection/reset', () => notify()), 'dispatch-protocol: connection generation')

      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'dispatch-protocol.dock',
        order: 10,
        locale: NS,
        inject: (sessionId) => ({
          sessionId,
          readMode: api.readMode,
          switchMode: api.switchMode,
          subscribe: api.subscribe,
        }),
      }, DispatchDock)), 'dispatch-protocol: input dock')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    // Exposed for the offline regression: locale/*.json must mirror these.
    exports.dictionaries = { zh, en }
    exports.pure = { modeOfText, modeLabelKey, detailOf, MARKER_PATH, MODES }
    return module.exports
  },
})
