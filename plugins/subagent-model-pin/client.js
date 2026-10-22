// subagent-model-pin — browser half: a config card on the Plugins page.
//
// Hand-written lazy-CJS registration script: the Host serves this file as-is
// (no build, no transpile), so it must stay plain JS with `createElement` only.
// The module `id` must equal the npm package name. Runtime `require` is limited
// to platform seed modules; only `react` is used here.
//
// The card edits the four `.volatile()` fields of the Host plugin's Config
// (provider / model / reasoningEffort / debug) through the settings transport.
// Everything else (roles, force, depth, sandbox, injectDelegationDefaults) is
// not volatile and therefore unreachable from this card by construction.
//
// The dictionaries below mirror the `card` section of locale/*.json (plugin
// inventory reads meta.* from those files; the card itself only sees what this
// bundle carries). Keep both copies in sync.

window.__ModuleLoader__.load({
  id: 'subagent-model-pin',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useEffect } = React

    /** Dictionary namespace owned by this card. */
    const NS = 'subagentModelPin'
    /** Settings namespace: the Host plugin entry id in cordis.patch.yml. */
    const SETTINGS_NS = 'subagent-model-pin'

    const zh = {
      summaryFallback: '未配置路由',
      overriddenBadge: '界面覆盖',
      notice: '保存立即写入配置；debug 开关立即生效。pin 路由的改动作用于此后的委派，但需新开会话，且新路由须在「允许 Agent 为子智能体选择模型」的白名单内。',
      providerLabel: 'Provider',
      modelLabel: '模型',
      effortLabel: '推理强度',
      effortDefault: '跟随模型默认',
      effortUnsupported: '该模型不支持推理档位',
      debugLabel: '调试日志',
      debugHelp: '写入 %TEMP%\\subagent-model-pin.log（可用环境变量 SUBAGENT_MODEL_PIN_LOG 改路径）',
      save: '保存',
      saving: '保存中…',
      discard: '放弃',
      reset: '恢复 YAML 配置',
      resetting: '恢复中…',
      resetConfirm: '将清除界面对 provider / 模型 / 推理强度 / debug 的全部覆盖，回到 cordis.patch.yml 里的值。确定？',
      conflict: '配置已在别处修改，请确认后重试。',
      failed: '保存失败，已刷新为最新值，请重试。',
      catalogLoading: '模型目录加载中…',
      catalogError: '模型目录加载失败',
      catalogPartial: '部分 provider 拉取失败，选项可能不全。',
      retry: '重试',
      notInCatalog: '（不在当前目录）',
      statusLoading: '配置加载中…',
      statusUnavailable: 'Host 未提供该配置命名空间——请先把插件升级到新版本。',
      readOnly: '当前配置不可写。',
    }

    const en = {
      summaryFallback: 'no route configured',
      overriddenBadge: 'UI override',
      notice: 'Saving writes immediately; the debug switch applies instantly. Pin-route changes affect later delegations but need a fresh session, and the new route must sit in the "allow agents to pick subagent models" allowlist.',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      effortLabel: 'Reasoning effort',
      effortDefault: 'Follow the model default',
      effortUnsupported: 'This model has no effort levels',
      debugLabel: 'Debug log',
      debugHelp: 'Writes %TEMP%\\subagent-model-pin.log (override with the SUBAGENT_MODEL_PIN_LOG env var)',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      reset: 'Restore YAML config',
      resetting: 'Restoring…',
      resetConfirm: 'Clear every UI override of provider / model / effort / debug and return to the values in cordis.patch.yml?',
      conflict: 'The config changed elsewhere; review and retry.',
      failed: 'Save failed; refreshed to the latest values, please retry.',
      catalogLoading: 'Loading the model catalog…',
      catalogError: 'Failed to load the model catalog',
      catalogPartial: 'Some providers failed to load; options may be incomplete.',
      retry: 'Retry',
      notInCatalog: ' (not in the current catalog)',
      statusLoading: 'Loading config…',
      statusUnavailable: 'The Host serves no config namespace for this plugin — upgrade the plugin first.',
      readOnly: 'The config is read-only right now.',
    }

    // Injected exactly like the official css modules: one style tag per bundle,
    // themed through the same --dsw-alias-* custom properties.
    const CSS = [
      '.smp-card{gap:10px;display:grid}',
      '.smp-summary{gap:6px;align-items:center;display:inline-flex}',
      '.smp-badge{color:var(--dsw-alias-brand-primary);border:.5px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-md);padding:0 6px;font-size:11px;line-height:18px}',
      '.smp-notice,.smp-help{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.smp-field{gap:4px;display:grid}',
      '.smp-label{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.smp-select{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:6px 8px;font-size:13px;max-width:420px}',
      '.smp-select:disabled{opacity:.55}',
      '.smp-toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:center;gap:16px;font-size:13px;display:flex;max-width:420px}',
      '.smp-actions{gap:8px;align-items:center;display:flex}',
      '.smp-button{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:5px 14px;font-size:13px}',
      '.smp-button:disabled{opacity:.55;cursor:default}',
      '.smp-buttonPrimary{color:var(--dsw-alias-bg-layer-1);background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.smp-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}',
      '.smp-catalogError{color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:center;gap:12px;font-size:12px;display:flex}',
      '.smp-catalogError button{color:var(--dsw-alias-brand-primary);cursor:pointer;background:0 0;border:0;padding:0;font-size:12px}',
    ].join('\n')
    const cssTagId = 'subagent-model-pin/card.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'subagent-model-pin'
      tag.dataset.pluginCss = cssTagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

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

    const ROUTE_FIELDS = ['provider', 'model', 'reasoningEffort', 'debug']

    /** The four volatile fields as plain values; missing pieces default like the schema does. */
    function plainValues(section) {
      const source = section !== null && typeof section === 'object' ? section : {}
      return {
        provider: typeof source.provider === 'string' ? source.provider : '',
        model: typeof source.model === 'string' ? source.model : '',
        reasoningEffort: typeof source.reasoningEffort === 'string' ? source.reasoningEffort : '',
        debug: source.debug === true,
      }
    }

    /** True when the settings document holds a value that differs from the YAML layers. */
    function isOverridden(user, base) {
      const u = plainValues(user)
      const b = plainValues(base)
      const raw = user !== null && typeof user === 'object' ? user : {}
      return ROUTE_FIELDS.some((field) => raw[field] !== undefined && u[field] !== b[field])
    }

    /**
     * Bridges the bound config form and the live model catalog onto the card.
     * Mirrors the official settings pages: staged draft + revision-checked save.
     */
    class PinCardController {
      constructor(scope, ctx) {
        this.scope = scope
        this.ctx = ctx
        this.catalogGroups = []
        this.catalogPartial = false
        this.catalogStatus = 'idle'
        this.catalogGeneration = 0
        this.draft = undefined
        this.draftRevision = undefined
        this.saving = false
        this.failed = false
        this.conflicted = false
        this.disposed = false
        this.saveGeneration = 0
        this.store = createStore(this.projection())
        this.unsubscribe = scope.subscribe(() => {
          if (!this.saving && this.draft !== undefined && this.scope.getSnapshot().revision !== this.draftRevision) {
            this.conflicted = true
          }
          this.publish()
        })
      }

      dispose() {
        this.disposed = true
        this.saveGeneration += 1
        this.catalogGeneration += 1
        this.unsubscribe()
      }

      /** Renderer face: the snapshot hook plus the card actions. */
      inject() {
        return {
          hooks: { pinCard: this.store },
          editDraft: (field, value) => this.editDraft(field, value),
          save: () => this.save(),
          discard: () => this.discard(),
          resetToYaml: () => this.resetToYaml(),
          toggleDebug: (value) => this.toggleDebug(value),
          ensureCatalog: () => this.ensureCatalog(),
          retryCatalog: () => this.loadCatalog(),
        }
      }

      current() {
        return plainValues(this.scope.getSnapshot().value)
      }

      effectiveDraft() {
        return this.draft ?? this.current()
      }

      dirty() {
        if (this.draft === undefined) return false
        const current = this.current()
        return this.draft.provider !== current.provider
          || this.draft.model !== current.model
          || this.draft.reasoningEffort !== current.reasoningEffort
      }

      projection() {
        const snapshot = this.scope.getSnapshot()
        return {
          status: snapshot.status,
          writable: snapshot.writable === true,
          value: this.current(),
          overridden: isOverridden(snapshot.user, snapshot.base),
          draft: this.draft,
          dirty: this.dirty(),
          saving: this.saving,
          failed: this.failed,
          conflicted: this.conflicted,
          catalogStatus: this.catalogStatus,
          catalogGroups: this.catalogGroups,
          catalogPartial: this.catalogPartial,
        }
      }

      publish() {
        this.store.set(this.projection())
      }

      beginDraft() {
        if (this.draft === undefined) {
          const current = this.current()
          this.draft = {
            provider: current.provider,
            model: current.model,
            reasoningEffort: current.reasoningEffort,
          }
          this.draftRevision = this.scope.getSnapshot().revision
        }
        return this.draft
      }

      editDraft(field, value) {
        if (this.disposed || this.saving) return
        const snapshot = this.scope.getSnapshot()
        if (snapshot.status !== 'ready' || !snapshot.writable) return
        const draft = this.beginDraft()
        if (field === 'provider') {
          draft.provider = value
          const group = this.catalogGroups.find((candidate) => candidate.id === value)
          draft.model = group !== undefined && group.models.length > 0 ? group.models[0].id : ''
          draft.reasoningEffort = ''
        } else if (field === 'model') {
          draft.model = value
          draft.reasoningEffort = ''
        } else if (field === 'reasoningEffort') {
          draft.reasoningEffort = value
        } else {
          return
        }
        this.failed = false
        this.conflicted = false
        this.publish()
      }

      discard() {
        if (this.saving) return
        this.draft = undefined
        this.draftRevision = undefined
        this.failed = false
        this.conflicted = false
        this.publish()
      }

      async save() {
        const snapshot = this.scope.getSnapshot()
        if (this.disposed || !this.dirty() || this.saving || snapshot.status !== 'ready' || !snapshot.writable) return
        const desired = { ...this.draft }
        if (desired.provider.length === 0 || desired.model.length === 0) return
        if (snapshot.revision !== this.draftRevision) {
          this.conflicted = true
          this.publish()
          return
        }
        const generation = this.saveGeneration
        this.saving = true
        this.failed = false
        this.conflicted = false
        this.publish()
        // effort '' is saved explicitly: it means "no pinned effort", whereas an
        // unset would restore the YAML value.
        await this.scope.mutate([
          { op: 'set', path: ['provider'], value: desired.provider },
          { op: 'set', path: ['model'], value: desired.model },
          { op: 'set', path: ['reasoningEffort'], value: desired.reasoningEffort },
        ], this.draftRevision)
        if (generation !== this.saveGeneration) return
        const landed = (() => {
          const current = this.current()
          return current.provider === desired.provider && current.model === desired.model && current.reasoningEffort === desired.reasoningEffort
        })()
        this.saving = false
        this.failed = !landed
        if (landed) {
          this.draft = undefined
          this.draftRevision = undefined
        }
        this.publish()
      }

      /** Clear every UI override: unset all four volatile fields (Host restores YAML values). */
      async resetToYaml() {
        const snapshot = this.scope.getSnapshot()
        if (this.disposed || this.saving || snapshot.status !== 'ready' || !snapshot.writable) return
        const generation = this.saveGeneration
        this.saving = true
        this.failed = false
        this.conflicted = false
        this.publish()
        await this.scope.mutate(ROUTE_FIELDS.map((field) => ({ op: 'unset', path: [field] })), snapshot.revision)
        if (generation !== this.saveGeneration) return
        this.saving = false
        this.draft = undefined
        this.draftRevision = undefined
        this.publish()
      }

      /** Debug applies immediately, outside the draft/save cycle. */
      async toggleDebug(value) {
        if (this.disposed || !this.scope.getSnapshot().writable) return
        await this.scope.set('debug', value === true)
        this.publish()
      }

      ensureCatalog() {
        if (this.catalogStatus === 'idle') this.loadCatalog()
      }

      refreshCatalog() {
        if (this.disposed) return
        this.catalogGeneration += 1
        this.catalogStatus = 'idle'
        this.catalogPartial = false
        this.loadCatalog()
      }

      resetConnection() {
        if (this.disposed) return
        this.saveGeneration += 1
        this.saving = false
        this.draft = undefined
        this.draftRevision = undefined
        this.catalogGroups = []
        this.refreshCatalog()
      }

      async loadCatalog() {
        if (this.disposed || this.catalogStatus === 'loading') return
        const generation = this.catalogGeneration
        this.catalogStatus = 'loading'
        this.publish()
        const response = await this.ctx.remote.session.modelCatalog()
        if (generation !== this.catalogGeneration) return
        if (response.ok) {
          this.catalogGroups = response.value.groups
          this.catalogPartial = response.value.failures.length > 0
          this.catalogStatus = 'ready'
        } else {
          this.catalogStatus = 'error'
        }
        this.publish()
      }
    }

    function SummaryView(props) {
      const { t, snap } = props
      const text = snap.value.provider.length > 0
        ? snap.value.provider + ' / ' + snap.value.model + (snap.value.reasoningEffort.length > 0 ? ' · ' + snap.value.reasoningEffort : '')
        : t('summaryFallback')
      return h('span', { className: 'smp-summary' },
        text,
        snap.overridden ? h('span', { className: 'smp-badge' }, t('overriddenBadge')) : null)
    }

    function Field(props) {
      return h('label', { className: 'smp-field' },
        h('span', { className: 'smp-label' }, props.label),
        h('select', {
          className: 'smp-select',
          value: props.value,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        }, props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        props.help !== undefined ? h('p', { className: 'smp-help' }, props.help) : null)
    }

    function PageView(props) {
      const { t, snap } = props
      useEffect(() => {
        props.ensureCatalog()
      }, [])

      if (snap.status === 'loading') return h('p', { className: 'smp-notice' }, t('statusLoading'))
      if (snap.status === 'unavailable') return h('p', { className: 'smp-error' }, t('statusUnavailable'))

      const shown = snap.draft ?? snap.value
      const group = snap.catalogGroups.find((candidate) => candidate.id === shown.provider)
      const models = group?.models ?? []
      const model = models.find((candidate) => candidate.id === shown.model)
      const efforts = model?.reasoning?.efforts ?? []
      const disabled = !snap.writable || snap.saving

      const providerOptions = snap.catalogGroups.map((candidate) => ({ value: candidate.id, label: candidate.name }))
      if (shown.provider.length > 0 && group === undefined) {
        providerOptions.push({ value: shown.provider, label: shown.provider + t('notInCatalog') })
      }
      const modelOptions = models.map((candidate) => ({ value: candidate.id, label: candidate.name }))
      if (shown.model.length > 0 && model === undefined) {
        modelOptions.push({ value: shown.model, label: shown.model + t('notInCatalog') })
      }
      const defaultEffort = model?.reasoning?.defaultEffort
      const effortOptions = [{
        value: '',
        label: t('effortDefault') + (typeof defaultEffort === 'string' ? '（' + defaultEffort + '）' : ''),
      }].concat(efforts.map((effort) => ({
        value: effort.id,
        label: effort.name + (typeof effort.description === 'string' ? ' — ' + effort.description : ''),
      })))
      if (shown.reasoningEffort.length > 0 && !efforts.some((effort) => effort.id === shown.reasoningEffort)) {
        effortOptions.push({ value: shown.reasoningEffort, label: shown.reasoningEffort + t('notInCatalog') })
      }

      return h('div', { className: 'smp-card' },
        h('p', { className: 'smp-notice' }, t('notice')),
        snap.catalogPartial ? h('p', { className: 'smp-notice' }, t('catalogPartial')) : null,
        snap.catalogStatus === 'loading' ? h('p', { className: 'smp-notice' }, t('catalogLoading')) : null,
        snap.catalogStatus === 'error'
          ? h('div', { className: 'smp-catalogError' },
              h('span', null, t('catalogError')),
              h('button', { type: 'button', onClick: () => props.retryCatalog() }, t('retry')))
          : null,
        h(Field, {
          label: t('providerLabel'),
          value: shown.provider,
          options: providerOptions,
          disabled: disabled || snap.catalogStatus !== 'ready',
          onChange: (value) => props.editDraft('provider', value),
        }),
        h(Field, {
          label: t('modelLabel'),
          value: shown.model,
          options: modelOptions,
          disabled: disabled || snap.catalogStatus !== 'ready',
          onChange: (value) => props.editDraft('model', value),
        }),
        h(Field, {
          label: t('effortLabel'),
          value: shown.reasoningEffort,
          options: effortOptions,
          disabled: disabled || model === undefined,
          help: model !== undefined && model.reasoning === undefined ? t('effortUnsupported') : undefined,
          onChange: (value) => props.editDraft('reasoningEffort', value),
        }),
        h('div', { className: 'smp-toggleRow' },
          h('span', null, t('debugLabel')),
          h('input', {
            type: 'checkbox',
            checked: snap.value.debug,
            disabled: !snap.writable,
            onChange: (event) => props.toggleDebug(event.target.checked),
          })),
        h('p', { className: 'smp-help' }, t('debugHelp')),
        snap.conflicted ? h('p', { className: 'smp-error' }, t('conflict')) : null,
        snap.failed ? h('p', { className: 'smp-error' }, t('failed')) : null,
        !snap.writable ? h('p', { className: 'smp-notice' }, t('readOnly')) : null,
        h('div', { className: 'smp-actions' },
          h('button', {
            type: 'button',
            className: 'smp-button smp-buttonPrimary',
            disabled: disabled || !snap.dirty,
            onClick: () => props.save(),
          }, snap.saving && snap.dirty ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'smp-button',
            disabled: snap.saving || !snap.dirty,
            onClick: () => props.discard(),
          }, t('discard')),
          h('button', {
            type: 'button',
            className: 'smp-button',
            disabled: disabled || !snap.overridden,
            onClick: () => {
              if (typeof window === 'undefined' || window.confirm(t('resetConfirm'))) props.resetToYaml()
            },
          }, snap.saving && !snap.dirty ? t('resetting') : t('reset'))))
    }

    function PinConfigCard(props) {
      const snap = props.usePinCard((snapshot) => snapshot)
      if (props.view === 'summary') return h(SummaryView, { t: props.t, snap })
      return h(PageView, {
        t: props.t,
        snap,
        editDraft: props.editDraft,
        save: props.save,
        discard: props.discard,
        resetToYaml: props.resetToYaml,
        toggleDebug: props.toggleDebug,
        ensureCatalog: props.ensureCatalog,
        retryCatalog: props.retryCatalog,
      })
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

    /**
     * Mount the card into the Plugins page while the Host serves our namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'subagent-model-pin: dictionaries')
      const controller = new PinCardController(ctx.configForms.get(SETTINGS_NS), ctx)
      ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => controller.refreshCatalog()), 'subagent-model-pin: adapter invalidations')
      ctx.effect(() => ctx.remote.$on('settings/document-updated', () => controller.refreshCatalog()), 'subagent-model-pin: settings invalidations')
      ctx.effect(() => ctx.on('connection/reset', () => controller.resetConnection()), 'subagent-model-pin: connection generation')
      ctx.effect(() => () => {
        controller.dispose()
      }, 'subagent-model-pin: controller')
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'subagent-model-pin',
        locale: NS,
        inject: () => controller.inject(),
      }, PinConfigCard))), 'subagent-model-pin: config card')
    }

    exports.NS = NS
    exports.SETTINGS_NS = SETTINGS_NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
