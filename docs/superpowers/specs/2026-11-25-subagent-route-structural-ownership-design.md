# 子代理路由与沙箱的结构化归属（roles 表退役 + spike 工具化 + select 收窄）

日期：2026-11-25
状态：待评审
涉及插件：`dispatch-protocol`（0.24.0 → 0.25.0）、`subagent-model-pin`（0.4.1 → 0.5.0）
前置 spec：`2026-11-23-dispatch-readonly-route-sandbox.md`（readonly 结构钉路钉沙箱）、`2026-11-24-subagent-watchdog-design.md`（无关，仅时序相邻）

## 1. 背景与问题

### 1.1 现状机制事实（已核实，宿主 0.2.2-rc.5）

子代理路由有三个写入位置，descriptor 在**创建时**快照 child options（`dsh-subagent/lib/index.js` `snapshotSubagentDescriptor`）：

| 写入位置 | 时机 | descriptor 一致性 | 现状归属 |
|---|---|---|---|
| 工具实例 `agentOptions` | 创建时（声明式） | 一致 | `tool-subagent-readonly` 钉 readonly 路由 |
| `tools/execute` 注入委派参数 | 创建前（改调用参数） | 一致 | model-pin 默认路由注入（仅 `subagent`/`subagent_fork`，[plugin.mjs:60](../../../plugins/subagent-model-pin/plugin.mjs) `DELEGATION_TOOLS`） |
| `agent/created` 时 `agent.model.select()` | 创建后（命令式、监听顺序任意） | **不一致**（descriptor 先于 select 快照） | model-pin R4 角色路由 / R6 默认兜底 |

宿主语义（`dsh-tool-subagent/lib/index.js` `requestedAgentOptions`）：调用级 `provider/model` 覆盖工具 `agentOptions`；`modelSelection: false` 的工具收到调用级选路参数会**抛错**——所以 model-pin 刻意不向 `subagent_readonly` 注入。

### 1.2 两个「两份事实」

**路由面**（已知坑，README 已记载）：`subagent_readonly` 子代理的路由被 `agentOptions` 钉死，但 model-pin 的 R4（[plugin.mjs:383](../../../plugins/subagent-model-pin/plugin.mjs)）在 `agent/created` 时按 label 前缀 select——roles 表只读角色与钉路不一致时，运行路由被覆盖、descriptor 与冷恢复仍是钉路。触发条件恰是「钉路 == 父路由」的常见配置（R5 的父路由比对在此失效）。

**沙箱面**（本次新发现，图纸上的漂移）：model-pin `roles[].sandbox` 按 label 前缀收窄；dispatch-protocol `readonlySandbox` 按 preset 收窄（[plugin.mjs:693](../../../plugins/dispatch-protocol/plugin.mjs) 注释自述「同监听 `agent/created`、同写 `sandbox/mode`：监听顺序任意，last-wins」）。两个写入者同一事件，顺序不定。当前无实际冲突仅因 roles 未配 sandbox 字段。

### 1.3 根因

宿主在 `resolveChildAgentOptions` 合并路由时丢弃来源（继承 / 工具钉路 / 调用显式三者同形），下游只能用启发式重建意图：label 前缀（措辞脆弱）、父路由比对（同路由失效）、tool/call 扫描（只认两个工具名）。两个插件被迫共享「label 前缀」隐式契约划分领地，路由面与沙箱面的漂移都是启发式的失败模式。

实践依据（`dsh-doc` practices.md）：会话日志是唯一真相源（§1）；用够用的最弱机制（§4）；不得新增事件类型做插件间通信（§21）。

## 2. 目标与非目标

**目标**

1. 任何工具用 `agentOptions` 钉死的路由不再被 model-pin 覆盖——从机制上消除，不靠文档约定。
2. 权限（沙箱）判定不再挂在 label 措辞上：spike 获得结构锚点。
3. 两个插件之间不再共享任何文本约定（label 前缀彻底退役）。
4. stock 用户行为零变化；自定义 profile 有明确迁移路径与回滚。

**非目标**

- 不改宿主：上游 `routeSource` provenance 字段仅登记为后续行动（§8）。
- 不动 `force`、顶层 `sandbox`、`depth`、`injectDelegationDefaults` 语义。
- 不合并两个插件（职责不同：流程纪律+只读组合 vs 普通委派默认路由）。

## 3. 方案总览：归属矩阵

| 需求 | 归属 | 机制 |
|---|---|---|
| `subagent_readonly` 路由/工具面/沙箱 | dispatch-protocol | 现状：agentOptions + preset + readonlySandbox |
| **spike（跑命令实测）路由/工具面/沙箱** | dispatch-protocol（**新增**） | 新 preset `dispatch-spike` + 新工具 `subagent_spike`，结构钉死 |
| 普通 `subagent` 默认路由 | model-pin | 现状：tools/execute 注入 |
| 无白名单会话的兜底 pin | model-pin | select，**收窄目标集**（§4.2） |
| workflow 子代理兜底 pin | model-pin | select（workflow 无委派调用可注入，唯一兜底） |
| ~~roles 表角色路由（R4）~~ | **删除** | 有 policy 时注入已分档；无 policy 时它只对 readonly 子代理开火＝漂移本身 |
| ~~roles 表 label 沙箱~~ | **删除** | spike 沙箱改由 readonlySandbox 按 preset 收窄 |
| 顶层 `sandbox`（所有子代理统一收窄） | model-pin | 保留：语义清晰，非 label 驱动 |

## 4. model-pin 0.5.0 详设

### 4.1 roles 表退役与兼容

- `lib/routes.mjs`：`validateRoles`/`resolveRoute` 删除角色匹配；注入路径直接用顶层 `provider/model/reasoningEffort`。
- `plugin.mjs`：`applyRoleSandbox` 收缩为只处理顶层 `sandbox`。
- **schema 兼容**：Config zod schema 中 `roles` 字段**保留但运行时忽略**，命中时 `ctx.logger.warn` 给迁移指引（「roles 已退役：只读评审/勘察/spike 的路由与沙箱由 dispatch-protocol 的组合结构钉死；普通 subagent 角色分档删除，默认路由见顶层 provider/model」）。下个大版本再删字段——避免老 profile 加载期炸掉（与 dispatch-protocol 对废弃配置「加载期抛错给迁移指引」的先例不同：model-pin 的 roles 失效在运行期由 verify 的 FAIL 级提示兜底，见 §6.3）。
- **失效方向不对称，必须分开看**：角色**路由**失效方向安全（少一次覆盖，只读子代理恒为钉路）；角色**沙箱**失效方向是**放宽**（spike 不再被收窄）——后者由 §5.3 的 spike 结构收窄接管，且 verify 对「roles 含 sandbox 字段」的迁移提示必须是 FAIL 级，不许静默。
- `test.mjs` 中 roles 相关用例改写为「忽略 + warn」断言。

### 4.2 select 分支表（替换现 R1–R6）

```
R1  仅 subagent 起源 + depth 过滤（不变）
R2  force → select 默认路由（保留，文档维持「不建议」）
R3  explicit === true（委派调用显式选路）→ keep（不变）
R4' label !== undefined && explicit === undefined → keep（新增：
    自带组合的工具子代理——subagent_readonly、subagent_spike 及未来任何
    自有钉路的委派工具——创建时路由即最终路由，不碰）
R5  explicit === undefined && cur 与父路由不同 → keep（保留：
    workflow 显式选路的保护伞）
R6' 否则 → select 默认路由（实际负载收窄为：无 descriptor 的 workflow
    未选路子代理 + 无白名单会话里普通委派的未选路子代理）
```

`explicit` 判定（`readDelegationChoice` 扫描 `DELEGATION_TOOLS` 的 tool/call）不变；`label` 来自子会话 `subagent/descriptor`（现成读法，`readChildLabel`）。

已知边角（接受）：普通 `subagent` 委派遇上**父 tool/call 未提交**（父回合中断/崩溃）时，`explicit === undefined && label !== undefined` 落入 R4' keep——该子代理跑继承路由、失去默认 pin。旧行为是 R6 select pin。此场景罕见且方向是「少用一次最贵的兜底」，接受；在 README 行为矩阵中写明。

### 4.3 保留面与语义澄清文档

- 顶层 `sandbox`、`force`、`depth`、`injectDelegationDefaults`、`subagent/model-selection-policy` 感知注入——全部不变。
- README 明确写清授权语义（本次勘察新确认）：**注入过白名单、select 不过**；pin 是 profile 拥有者意图，白名单约束的是模型自主选路，两者不同主体。

## 5. dispatch-protocol 0.25.0 详设

### 5.1 新 preset `dispatch-spike`

照 `dispatch-readonly` 的注册模式（cordis.patch.yml insert）：

- `persona`：「只读实测子代理（spike）。组合里没有写入工具；shell 只用于只读探测命令。产物（实测契约表：凭据/端口/库表/接口形状 + 命令 + 退出码 + 输出证据）以 final message 回传，不落盘、不改环境。材料不足停报 NEEDS_CONTEXT。」
- `tool-fs`：`write: false, edit: false`。
- `tool-fs-search`：同 readonly（必填项 `sampleOverCapGlobResults: false`）。
- **shell 双挂** `tool-bash` + `tool-pwsh`：与 stock standard preset 同款（`dsh-web-app/presets/standard.patch.yml:21-25`），各平台自我裁剪，跨平台安全。
- `compaction` 组同 readonly。

### 5.2 新工具 `subagent_spike`

```
- id: tool-subagent-spike
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent_spike
    agentPreset: dispatch-spike
    modelSelection: false
    agentOptions: { provider: deepseek-official, model: deepseek-flash }   # stock 可用；profile 覆盖
```

### 5.3 沙箱：readonlySandbox.presets 默认值加 `dispatch-spike`

- 默认值从 `['dispatch-readonly']` 变为 `['dispatch-readonly', 'dispatch-spike']`；`mode` 默认 `read-only` 不变。
- **为什么 spike 必须进收窄**：spike 有 shell，工具面（write:false）管不住 `echo > file`，沙箱是唯一写约束。
- **已知坑写进 README**：`read-only` 下无法写临时探测脚本文件，用 `node -e` / `pwsh -Command` 内联或 stdout 回传；确需落盘时 profile 覆盖 `readonlySandbox.mode: workspace-write`（config 整体替换，抄全字段）。
- profile 覆盖过 `readonlySandbox.presets` 的老配置不含 `dispatch-spike`——spike 子代理不收窄（fail-open，继承父沙箱）。verify-install 提示（§6.3）。

### 5.4 纪律文本

- `DEFAULT_FOOTER`（lib/config.mjs）：「label 前缀只服务 spike 的沙箱收窄——spike 要跑命令实测，仍走普通 subagent」→「只读实测（spike）一律用 `subagent_spike` 派发：带 shell 的只读组合，路由与沙箱结构钉死」。
- **删除**「只读类子代理 label 一律以『只读』或『勘察』开头，执行类批次不得以这两个词开头」——roles 退役后 label 前缀不再驱动任何机制（checkpoint 判定走 `ranReadOnly` 行为信号，不读 label）。符合「用证据删机制」。
- 规则 1「先派只读勘察（一律用 `subagent_readonly`）」补充半句区分：「要跑命令实测外部环境的用 `subagent_spike`」。
- AUTO_TEXT 同步一句（spike 工具名）；business 规则预设同步。
- KV 缓存注意：规则文本变化影响缓存命中，随版本一次性发布，不迭代改字。

### 5.5 writePolicy.delegationTools

默认值 `['subagent', 'subagent_fork', 'workflow', 'subagent_readonly']` → 追加 `'subagent_spike'`（守卫豁免口径与观测行一致）。

## 6. 兼容、迁移与核验

### 6.1 行为变化清单（用户可见）

| 场景 | 旧 | 新 |
|---|---|---|
| stock 默认（无 roles 配置） | — | 零变化 |
| profile 配了只读角色路由 | R4 可能覆盖钉路 | 角色项忽略 + warn；只读子代理恒为钉路 |
| profile 配了 spike 角色沙箱 | label 前缀命中收窄 | spike 走 `subagent_spike`，按 preset 收窄；label 不再生效 |
| 无白名单会话普通委派 | select 兜底 pin | 不变 |
| workflow 子代理 | select 兜底 pin（R5 保护显式选路） | 不变 |
| 派发词里写 spike | 普通 `subagent` + 「勘察」前缀 | 用 `subagent_spike` 工具 |

### 6.2 版本与回滚

- model-pin 0.5.0、dispatch-protocol 0.25.0（行为/默认值变化，升 minor）。
- 回滚：`dsh plugin --profile <profile> update <name>` 退到上一版本；或 profile 层 `enabled: false` 单插件停用。两插件可独立回滚（无相互依赖的加载期契约）。
- 旧会话：纪律文本按会话冻结，旧会话行为不变；`subagent_spike` 只在重启后的新会话可派发。

### 6.3 verify-install.mjs 改写

- **退役** `route-alignment`（两份事实已消除，无两份可比对）。
- 新增 `route-coverage`（WARN 级）：三处钉路——`tool-subagent-readonly.agentOptions`、`tool-subagent-spike.agentOptions`、model-pin 顶层——一致性提示（不再 FAIL：它们不再互相踩踏，不一致只是运维不统一）。
- 新增：profile 的 model-pin 配置仍含 `roles` → 迁移提示；其中角色带 `sandbox` 字段的必须 **FAIL**（失效方向是放宽约束，见 §4.1），纯路由角色为 WARN。
- 新增：`readonlySandbox.presets` 被 profile 覆盖且不含 `dispatch-spike` → 提示 spike 不收窄。
- 新增：`subagent_spike` 工具与 `dispatch-spike` preset 存在性检查（readonly 同款）。

### 6.4 本机 profile 迁移（发布流程的一部分）

`cordis.patch.yml` 删 model-pin `roles` 全表（含只读角色与 spike 角色）；新增 `tool-subagent-spike` 覆盖段（同 readonly 的覆盖模式）；`subagent-model-selection-settings` 白名单不变。

## 7. 测试计划

**model-pin test.mjs**（改写/新增）

- roles 配置加载不报错 + 运行时忽略 + warn 一次。
- `explicit === undefined && label !== undefined` 子代理不 select（钉路免疫）——含「钉路 == 父路由」的回归（旧 R4 漂移场景）。
- workflow 子代理（无 descriptor label）R6 仍 select；R5 保护 workflow 显式路由。
- 普通委派 explicit=true 仍 keep；force 仍优先。
- 注入路径：无 roles 时 description 任意措辞都注入同一路由。
- 顶层 `sandbox` 收窄仍生效；角色沙箱不再产生 `sandbox/mode`。

**dispatch-protocol test.mjs**（新增）

- cordis.patch.yml 含 `preset-dispatch-spike`（write/edit false、shell 双挂）与 `tool-subagent-spike`（spawn、modelSelection:false、agentOptions stock 路由）。
- readonlySandbox 默认 presets 含两个 id；`dispatch-spike` 子代理收到 `sandbox/mode`；已是目标 mode 跳过不重复。
- DEFAULT_FOOTER 不含 label 前缀强制句、含 `subagent_spike`；AUTO_TEXT 同步；business 预设同步。
- writePolicy.delegationTools 默认含 `subagent_spike`，守卫豁免生效。
- docs-check / check-anchors 全绿。

**stock 冒烟**（发布门槛）：临时 profile 不改 YAML，装两插件 → 新会话派 `subagent_spike`（可用性、钉路 deepseek-official/deepseek-flash、read-only 沙箱生效）→ 派 `subagent_readonly` 回归 → 普通 `subagent` 注入回归。

## 8. 后续（不在本 spec 范围）

- **上游登记**：向 DSH 提 `subagent/descriptor`（或 child options）记录 `routeSource: 'inherited' | 'tool-configured' | 'call-explicit'` 的需求。落地后 model-pin 的 tool/call 扫描、R5 启发式、R4' 的 label 判定全部可退役。
- **下个大版本**：model-pin Config schema 删除 `roles` 字段（加载期抛错给迁移指引，与 dispatch-protocol 废弃配置先例一致）。
- **观察项**：`subagent_spike` 的 read-only 沙箱在真实 spike 中的卡点（临时文件需求）；若频繁触发，评估 spike 专属 mode 默认 `workspace-write` 的利弊（写约束从沙箱退回纪律文本，需证据支撑再改）。

## 9. 风险与权衡

| 风险 | 评估与对策 |
|---|---|
| 三处钉路（readonly/spike/默认）换路由要改多处 | 已不再是机制踩踏，只是运维统一性问题；verify 的 WARN 提示覆盖。接受——结构化优于单点隐式契约 |
| spike 沙箱 read-only 卡住合理探测 | README 写坑 + 内联方案 + profile 放宽路径；§8 观察项跟进 |
| 老 profile 的 roles 静默失效 | 路由项失效方向安全；**沙箱项失效是放宽**——warn 日志 + verify 对含 sandbox 的 roles 报 FAIL + README 版本历史首行说明 |
| 纪律文本改动影响 KV 缓存 | 一次性随版本发布；发布流程已有「规则文本稳定后再发布」约定 |
| 旧派发习惯（label 前缀）残留 | 文本删除该要求；旧习惯不产生错误行为，只是 label 措辞自由化 |
