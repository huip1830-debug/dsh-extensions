// dispatch-protocol — browser half (0.16.0): the session-zone mode control.
//
// Hand-written lazy-CJS registration script: the Host serves this file as-is
// (no build, no transpile), so it must stay plain JS with `createElement` only.
// The module `id` must equal the npm package name. Runtime `require` is limited
// to platform seed modules; only `react` is used here.
//
// Spec: docs/superpowers/specs/2026-11-17-dispatch-ui-design.md §3.2.
// 0.18.0 adds the activation state (spec
// docs/superpowers/specs/2026-11-18-dispatch-dock-activation-design.md §3): a
// project with no `dispatch/protocol.json` renders `未激活` + an Activate button
// that runs `/dispatch init` through the Host command. The mode chips only show
// once the marker file exists — the Host still falls back to `auto`, but the dock
// must not look like the project opted in.
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
      inactive: '未激活',
      activate: '激活',
      activateHint: '在项目里写入 dispatch/protocol.json（mode: full），激活后可用四档',
      activateFailed: '激活失败：{detail}',
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
      inactive: 'Not activated',
      activate: 'Activate',
      activateHint: 'Write dispatch/protocol.json in this project (mode: full) to enable the four modes',
      activateFailed: 'Activation failed: {detail}',
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
    //
    // 0.17.1 width contract: the slot outlet is `display:contents`
    // (dsh-client-ui-renderer/src/client/skeleton/scoped-slots.tsx:306-312), so
    // our root becomes a direct flex child of the host's `.composerStack`, which
    // spans the whole conversation column. The host centers only the composer
    // card (`.GRgSLq_card{max-width:var(--dsh-composer-card-max-width)}` inside
    // `.GRgSLq_root{padding:0 var(--dsh-composer-side-clearance);
    // align-items:center}`) — an unconstrained dock row therefore sticks to the
    // column's left edge, far left of the card (0.17.0 shipped exactly that).
    //
    // So the root reproduces the host's own two-level geometry instead of a
    // single calc: `.ddp-frame` mirrors `.GRgSLq_root` (same side clearance,
    // column + centered items) and `.ddp-dock` mirrors `.GRgSLq_card`
    // (`width:100%` capped by the card max-width). A one-element
    // `width:calc(100% - 2×clearance)` happens to match in the normal variant,
    // but NOT in the embedded one (the right-sidebar subagent Conversation):
    // there `--dsh-composer-card-max-width` is itself a percentage
    // (`min(calc(100% - 16px), 952px)`), so it resolves against whichever
    // element uses it — the card resolves it against the padded root, our root
    // resolves it against the column, and the row ends up 8px wide per side.
    // With the mirrored frame both resolve against the same content box, and
    // every window width (including the 680/920px clamp boundaries, the hero
    // stack's `min(card + 2×clearance, 100%)` width, and the ≤640px media
    // query) keeps the row exactly on the card's edges.
    const CSS = [
      '.ddp-frame{box-sizing:border-box;padding:0 var(--dsh-composer-side-clearance,16px);display:flex;flex-direction:column;align-items:center}',
      '.ddp-dock{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,952px);display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:2px var(--dsh-composer-dock-inset,8px);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
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
      // 0.18.0: the Activate button shares the chip geometry but never joins the
      // narrow-screen rule — an uninitialized project must keep its only action.
      '.ddp-activate{border:0;background:0 0;padding:1px 8px;border-radius:999px;cursor:pointer;font-family:inherit;font-size:11px;color:var(--dsw-alias-label-primary);line-height:1.6;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}',
      '.ddp-activate:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ddp-activate:disabled{cursor:default;opacity:.55}',
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

    /**
     * Project one `workspaceFiles.read` outcome into the dock state (0.18.0).
     *
     * - a readable marker (bad JSON included) means the project was initialized;
     *   the mode falls back to `auto` exactly like `lib/project.mjs` does;
     * - `workspace-file/not-found` means "no marker": the Host still runs the
     *   `auto` fallback, but the dock renders 未激活 + an Activate button instead
     *   of the mode chips (the project never opted in);
     * - every other outcome keeps the 0.14 "未知" behaviour and carries a detail.
     * @param result - the RemoteResult from `workspaceFiles.read`.
     * @returns `{ initialized, mode?, detail? }`.
     */
    function dockStateOf(result) {
      if (result === null || typeof result !== 'object') {
        return { initialized: undefined, mode: undefined, detail: 'unknown' }
      }
      if (result.ok === true) {
        const value = result.value
        return { initialized: true, mode: modeOfText(typeof value?.text === 'string' ? value.text : undefined) }
      }
      const code = result?.error?.code
      const message = result?.error?.message
      if (code === 'workspace-file/not-found') return { initialized: false, mode: undefined }
      const detail = [code, message].filter((part) => typeof part === 'string' && part !== '').join(': ')
      return { initialized: undefined, mode: undefined, detail: detail === '' ? 'unknown' : detail }
    }

    // --- services -----------------------------------------------------------

    /**
     * Read the marker file once and hand the outcome to `dockStateOf`.
     * `initialized:false` means the default marker does not exist; other read
     * failures stay `undefined` so the dock keeps showing 未知 without offering
     * a write action it cannot verify.
     * @param ctx - the plugin context.
     * @param sessionId - the SessionId the dock belongs to.
     * @returns `{ initialized, mode?, detail? }` (see `dockStateOf`).
     */
    function readModeOf(ctx, sessionId) {
      return (async () => {
        try {
          // Declared above in `inject`: resolved statically, not via `ctx.get`.
          const files = ctx.remote.workspaceFiles
          if (files === undefined || files === null || typeof files.read !== 'function') {
            return { initialized: undefined, mode: undefined, detail: 'no-remote' }
          }
          return dockStateOf(await files.read(sessionId, MARKER_PATH, {}))
        } catch (error) {
          return { initialized: undefined, mode: undefined, detail: String(error?.message ?? error) }
        }
      })()
    }

    /**
     * Run one Host command through the same admission path the `/` menu uses.
     * Returns `{ ok: true }` or `{ ok: false, reason, detail? }`; never throws.
     * @param ctx - the plugin context.
     * @param sessionId - the SessionId the command targets.
     * @param line - the command line, e.g. `/dispatch full`.
     */
    function commandOf(ctx, sessionId, line) {
      return (async () => {
        try {
          // Same rule as the read path: the dotted face is a declared injection.
          const commands = ctx.remote.commands
          if (commands === undefined || commands === null || typeof commands.execute !== 'function') {
            return { ok: false, reason: 'unsupported' }
          }
          const result = await commands.execute(sessionId, line, [])
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

    /** Switch to one mode through `/dispatch <mode>` (same Host entry as the `/` menu). */
    function switchModeOf(ctx, sessionId, mode) {
      return commandOf(ctx, sessionId, '/dispatch ' + mode)
    }

    /**
     * Initialize this project through `/dispatch init` (0.18.0): the Host scans
     * the project, writes `dispatch/protocol.json` with `mode:"full"`, the
     * detected preset and the allowlist, and refuses to overwrite an existing
     * file. The client never writes the marker itself.
     * @param ctx - the plugin context.
     * @param sessionId - the SessionId the activation belongs to.
     */
    function activateProjectOf(ctx, sessionId) {
      return commandOf(ctx, sessionId, '/dispatch init')
    }

    // --- renderer -----------------------------------------------------------

    function DispatchDock(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const sessionId = props.sessionId
      const [view, setView] = useState({ initialized: undefined, mode: undefined, detail: undefined })
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
          setView(next === null || typeof next !== 'object'
            ? { initialized: undefined, mode: undefined, detail: 'unknown' }
            : next)
        }, (error) => {
          if (!mounted.current || token !== revision.current) return
          setView({ initialized: undefined, mode: undefined, detail: String(error?.message ?? error) })
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

      /** Readable cause for a refused switch/activation. */
      const failureDetail = (result) => {
        if (result?.reason === 'unsupported') return t('unsupported')
        const detail = detailOf(result)
        return detail === 'unknown' ? t('unreadable') : detail
      }

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
          setNotice(t('writeFailed', { detail: failureDetail(result) }))
        }, (error) => {
          busyRef.current = false
          if (!mounted.current) return
          setBusy(false)
          setNotice(t('writeFailed', { detail: String(error?.message ?? error) }))
        })
      }

      /**
       * Activate an uninitialized project: run `/dispatch init` through the Host
       * and re-read afterwards. The Host refuses to overwrite an existing marker,
       * so a failure is re-checked once — a concurrent activation means "now
       * initialized", not "activation failed" (spec 2026-11-18 §3.3).
       */
      const activate = () => {
        if (busyRef.current) return
        if (typeof props.activate !== 'function') {
          setNotice(t('activateFailed', { detail: t('unsupported') }))
          return
        }
        busyRef.current = true
        setBusy(true)
        setNotice(undefined)
        Promise.resolve(props.activate(sessionId)).then((result) => {
          busyRef.current = false
          if (!mounted.current) return
          setBusy(false)
          if (result !== null && typeof result === 'object' && result.ok === true) {
            loadRef.current()
            return
          }
          // Another Session may have initialized the project between the read
          // and the click; the Host's "already exists" error then means success.
          Promise.resolve(props.readMode(sessionId)).then((next) => {
            if (!mounted.current) return
            if (next !== null && typeof next === 'object' && next.initialized === true) {
              loadRef.current()
              return
            }
            setNotice(t('activateFailed', { detail: failureDetail(result) }))
          }, () => {
            if (!mounted.current) return
            setNotice(t('activateFailed', { detail: failureDetail(result) }))
          })
        }, (error) => {
          busyRef.current = false
          if (!mounted.current) return
          setBusy(false)
          setNotice(t('activateFailed', { detail: String(error?.message ?? error) }))
        })
      }

      const initialized = view !== null && typeof view === 'object' ? view.initialized : undefined
      const mode = view !== null && typeof view === 'object' ? view.mode : undefined
      const known = MODES.includes(mode)
      const detail = view !== null && typeof view === 'object' && typeof view.detail === 'string' ? view.detail : undefined
      const valueText = known ? mode : t('modeUnknown')
      const valueTitle = known ? undefined : t('unknownHint', { detail: detail === undefined ? t('unreadable') : detail })
      const noticeNode = notice === undefined ? null : h('span', { className: 'ddp-notice', role: 'status' }, notice)

      // `.ddp-frame` mirrors the host composer root (side padding + centered
      // items); `.ddp-dock` mirrors the card (100%, capped by the card width).
      const frame = (children) => h('div', { className: 'ddp-frame' },
        h('div', { className: 'ddp-dock', role: 'group', 'aria-label': t('title') }, children))

      if (initialized === false) {
        // No marker yet: the Host still runs its `auto` fallback, but the dock
        // must not show mode chips for a project that never opted in (0.18.0).
        return frame([
          h('span', { className: 'ddp-label' }, t('title')),
          h('span', { className: 'ddp-value ddp-valueUnknown', title: t('activateHint') }, t('inactive')),
          h('button', {
            type: 'button',
            className: 'ddp-activate',
            disabled: busy,
            title: t('activateHint'),
            onClick: activate,
          }, t('activate')),
          noticeNode,
        ])
      }

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

      return frame([
        h('span', { className: 'ddp-label' }, t('title')),
        h('span', {
          className: known ? 'ddp-value' : 'ddp-value ddp-valueUnknown',
          title: valueTitle,
        }, valueText),
        h('span', { className: 'ddp-modes' }, buttons),
        noticeNode,
      ])
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
        activate: (sessionId) => activateProjectOf(ctx, sessionId),
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
          activate: api.activate,
          subscribe: api.subscribe,
        }),
      }, DispatchDock)), 'dispatch-protocol: input dock')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    // Exposed for the offline regression: locale/*.json must mirror these.
    exports.dictionaries = { zh, en }
    exports.pure = { modeOfText, modeLabelKey, detailOf, dockStateOf, MARKER_PATH, MODES }
    return module.exports
  },
})
