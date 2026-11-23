# 只读角色路由钉死与结构化沙箱（dispatch-protocol 0.22.0）

> 日期：2026-11-23。派发方：主控。状态：设计已获用户确认（「实施」）。
> 延续 0.21.0 的方向：把评审/勘察角色的剩余文本匹配
> （label 前缀管路由与沙箱）替换为结构键。预期收益口径与 0.21.0 相同——
> 便宜的结构性保险，不承诺提速省钱。

## 1. 背景与问题

0.21.0 把评审/复审/勘察的**工具面**钉进 `dispatch-readonly` preset 与
`subagent_readonly` 工具，但仍有两处靠 label 字面前缀匹配
（model-pin `roles` 表，前缀「只读」/「勘察」）：

1. **路由**：roles 表按前缀把只读角色路由到低成本模型；
2. **沙箱**：roles 表按前缀把子会话沙箱收窄为 `read-only`。

字面前缀是已验证的脆弱点
（G8：中文 label 不命中英文前缀；P1：角色表漂移导致 40/40 评审子代理跑在 `danger-full-access`）。
DSH 0.2.2 提供了两个结构键，可以替掉这两处文本匹配：

- `dsh-tool-subagent` 的 `agentOptions` 配置：子代理路由在**创建时**钉死——
  descriptor 一致、adapter 预检、不经会话白名单。白名单只约束模型在调用时显式
  选择的路由；配置的 `agentOptions` 只过 adapter 预检。
  源码依据：`dsh-tool-subagent/lib/index.js` 的 `requestedAgentOptions`——
  无显式路由字段时直接返回 configured；
- 子代理会话的 `agent-preset/selected` 事件与 `header.agentPreset`：运行时
  在子会话建立时持久记录所选 preset id（`dsh-subagent/lib/index.js` L1946），
  沙箱收窄可以按 preset 判定，不再需要 label。

## 2. 范围

**做**（同属 dispatch-protocol 0.22.0）：

- `cordis.patch.yml`：`tool-subagent-readonly` 增加 `agentOptions`
  （`opencode-go` / `deepseek-v4.1-flash` / `high`），评审角色路由在创建时
  钉死，不再依赖 label 前缀命中；
- `plugin.mjs` 新增 `readonlySandbox` 机制：`agent/created` 时按子会话的
  preset（`header.agentPreset` ?? `agent-preset/selected` 事件）把沙箱收窄
  为 `read-only`（追加 `sandbox/mode` 事件，与 model-pin 同款 last-wins 写路径）；
  配置段 `readonlySandbox: { enabled, presets, mode }`；
- 纪律文本改词：规则 1 与 footer 中「前缀管路由与沙箱」改为「preset 管
  工具面/路由/沙箱；label 前缀只服务 spike 的沙箱收窄」；
- `verify-install.mjs` 的 `readonly-tool` 检查补 `agentOptions` 三个字段。

**不做**（边界）：

- 不删 profile 的 roles 表：spike 走普通 `subagent`、要跑命令实测、无独立 preset，
  它的沙箱收窄仍由 roles 表提供，这是 roles 表剩下的唯一职责；
- 不动 model-pin 代码：roles 功能保留（非 dispatch-protocol 宿主仍可用），
  仅 README  amended 其定位（0.3.1，文档-only）；
- 不建 `dispatch-implement` preset：执行面继承父 preset 自动跟随 standard
  演进，复制一份插件清单只会制造漂移源；执行面默认路由已有 model-pin 兜底
  pin 覆盖。

## 3. 机制

### 3.1 路由钉死（agentOptions）

```yaml
- id: tool-subagent-readonly
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent_readonly
    agentPreset: dispatch-readonly
    modelSelection: false
    agentOptions:
      provider: opencode-go
      model: deepseek-v4.1-flash
      reasoningEffort: high
```

语义（`dsh-tool-subagent` README 与源码）：

- 创建时生效：`subagent/descriptor.agentModel`、首请求、冷恢复三者一致，
  不再需要 model-pin 在 `agent/created` 时补 select；
- 不受会话白名单（`allowedModels`）约束：白名单校验只在模型调用时显式传
  `provider`/`model` 才执行；配置的 `agentOptions` 只过 adapter 预检
  （`llm.resolveCallConfig`），路由写错在委派调用时即报错；
- `modelSelection: false` 保持不变：模型不能在该工具上改路由，评审角色
  恒走钉死的低成本模型；
- 与 model-pin 共存：roles 表命中同一路由时 `sameRoute` 跳过 select，
  无事件噪音；profile 可按 id 整段覆盖该行以换路由。

### 3.2 结构化沙箱（readonlySandbox）

`agent/created` 时（与既有检查点同一个事件面）：

1. 只处理 `origin === 'subagent'` 的子代理；
2. 读 preset：`session.header.agentPreset`，缺省回扫 `snapshotEvents()` 里
   最后一条 `agent-preset/selected` 的 `data.agentPreset`；
3. 命中 `readonlySandbox.presets`（默认 `['dispatch-readonly']`）→ 若当前
   最后一条 `sandbox/mode` 不是目标 mode，追加
   `sandbox/mode { mode: 'read-only' }`。子会话权限在委派开始时固定、只能从
   外部收窄，追加即生效（model-pin 已验证的同款写路径）；
4. 全程 try/catch fail-open；判定写决定日志，kind 为 `readonly-sandbox`，
   decision 为 `applied` / `suppressed`，reason 区分 `already`。

与 model-pin roles 的交互：两者监听同一事件、写同一 mode 值，监听顺序
任意——先执行的一方追加后，另一方 `current === mode` 跳过；评审子代理最终
恒为 `read-only`，双保险语义不变。

### 3.3 配置段

```yaml
readonlySandbox:
  enabled: true                      # 总开关
  presets: ['dispatch-readonly']     # 收窄哪些 preset 的子代理
  mode: read-only                    # read-only | workspace-write | danger-full-access
```

加载期校验（与既有段落同口径，非法即抛错不静默降级）：`enabled` 非布尔、
`presets` 空数组或含空白串、`mode` 不在三值之内。

### 3.4 文本改词

- 规则 1：「label 仍以「勘察/只读」开头（前缀管路由与沙箱收窄）」→
  「（spike 走普通 subagent 时按此前缀收窄沙箱）」；
- footer：「前缀（model-pin）管路由与沙箱，`subagent_readonly` 管工具面」→
  「`subagent_readonly` 的 preset 管工具面、路由与沙箱（结构钉死，不靠 label）；
  label 前缀只服务 spike 的沙箱收窄」。

label 约定（只读类 label 以「只读」/「勘察」开头、执行类不得以此开头）
保留：它仍是 spike 沙箱的触发键，也是人读台账时的分类线索。

## 4. 验证

| 检查 | 期望 |
|---|---|
| `node plugins/dispatch-protocol/test.mjs` | 既有用例适配后全绿 + 新增 0.22.0 用例（patch 结构 agentOptions / resolveConfig 段默认与校验 / created 时按 preset 收窄与跳过 / 文本改词） |
| `node plugins/dispatch-protocol/scripts/docs-check.mjs` | `fail=0` |
| `node plugins/dispatch-protocol/scripts/check-anchors.mjs` | `fail=0` |
| 真机（发布后） | 新会话派「只读评审：…」：子会话日志 `subagent/descriptor.agentModel` = 钉死路由（创建时一致）、`sandbox/mode read-only` 存在、`agent-preset/selected` = `dispatch-readonly` |

## 5. 回滚

- 插件页禁用 dispatch-protocol，或 profile patch 给
  `preset-dispatch-readonly` / `tool-subagent-readonly` 写 `disabled: true`；
- 单关沙箱机制：profile 覆盖 `readonlySandbox: { enabled: false }`；
- 单退路钉：profile 按 id 整段覆盖 `tool-subagent-readonly` 删掉
  `agentOptions`（退回 model-pin created-select 兜底）。
