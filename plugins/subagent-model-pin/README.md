# subagent-model-pin

DSH profile 插件：**子 agent 默认跑低成本模型，需要时在委派调用里显式升级**。

## 长期定位

本插件是**过渡补丁**：宿主目前没有「子代理默认路由」的一等配置点，预设内的工具条目又不可 patch，只能靠运行时补默认值。上游一旦提供一等配置（例如 `subagent/descriptor` 记录路由来源 provenance），本插件即废弃——它的健康指标是**功能持续做减法**（0.5.0 已删角色路由与角色沙箱、删 label 前缀契约），而不是越做越重。

- 不传路由 → 子 agent 用 `provider` / `model`（含 effort）的 pin。
- 显式传了 `provider` / `model` / `reasoning_effort` → 放行，即使与父 agent 同款也能升级（`force: true` 时除外）。
- 本仓库的 `plugin.mjs` 是**唯一真源**；安装到 profile 后是 pnpm 管理的副本，改代码要重装才生效。

设计记录：[配置卡](../../docs/superpowers/specs/2026-10-22-subagent-model-pin-config-card-design.md)、[agentModel 一致性](../../docs/superpowers/specs/2026-11-06-subagent-model-pin-agent-model.md)。

## 它解决什么问题

DSH 默认让子 agent **继承父 agent 的路由**——复杂主会话派生的一堆子任务会全部跑在贵模型上。官方提供两个看起来能改这件事的入口，但都不是「默认值」：

- **设置里的「允许 Agent 为子智能体选择模型」是授权白名单**，只约束模型显式指定路由时能选哪些；父 agent 不传路由时是纯继承，白名单不生效。
- **用 patch 改子 agent 模型有三个坑**：顶层 `tool-subagent` 被 web-app bundle 设成 `disabled: true`，真正的工具在 `standard` 预设的 `plugins` 列表里；预设内条目不可 patch，且 `config` 整体替换、不深合并；新增条目必须用 `insert`，写成 `- id: <新 id>` 会「未知目标、静默跳过」。

本插件因此不改官方工具，而是在委派时补默认路由，并把「没人选才 pin」作为默认策略：主路径在 `tools/execute` 注入，回退路径在 `agent/created` 时 select。正确写法见包内 `cordis.patch.yml`（bundle 层，安装后自动生效）。

## 与 dispatch-protocol 的关系

职责分工一句话：**dispatch-protocol 管流程纪律与专用组合**（只读评审 `subagent_readonly`、只读实测 `subagent_spike`，工具面 / 路由 / 沙箱都钉在 preset 与工具实例上），**model-pin 管普通委派的默认路由**（`subagent` / `subagent_fork` / `workflow`，运行时补默认值）。两者**无加载期依赖**：任意组合可装，可独立启停与回滚；关掉一层，下面的层还在。

| | 有 model-pin | 无 model-pin |
|---|---|---|
| 有 dispatch-protocol | 全功能 | 只读评审 / spike 仍跑钉路（钉在工具实例上，不经白名单、不依赖本插件）；普通 `subagent` 回到继承父路由 |
| 无 dispatch-protocol | 只读评审 / spike 工具随纪律消失；普通 `subagent` / `workflow` 仍有默认 pin | stock 原生：全部继承父路由；换路由只能逐次显式传参（需先配白名单） |

分层看：L0 宿主原生（继承父路由 + 调用显式传参 + workflow 显式）→ L1 官方白名单（无白名单时显式选路被宿主限制为只能选父路由）→ L2 本插件的全局默认路由 → L3 dispatch-protocol 的专用组合。

## 安装

包已声明 `dsh.bundle.patch`，插件页可直接安装。桌面版或 Web 侧栏 **插件** → **添加插件** → **安装第三方插件**，填：

```
https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/subagent-model-pin
```

CLI 等价（profile 名按实际安装位置替换）：

```powershell
dsh plugin --profile desktop add "https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/subagent-model-pin"
```

装完在插件页启用，**完全退出并重启 DSH**（profile 层插件不支持热加载），再**新开会话**。默认路由是 stock 安装自带的 `deepseek-official/deepseek-flash`，不配白名单也能用——没有 `subagent/model-selection-policy` 的会话会自动跳过注入、走 `agent/created` 兜底。

升级 = 同地址重装，或 `dsh plugin --profile desktop update subagent-model-pin`；卸载 = 插件页移除，或 `dsh plugin --profile desktop remove subagent-model-pin`。

进阶配置都是可选的：换 pin 路由用插件页配置卡；profile 覆盖只能手写 YAML——在 profile 的 `cordis.patch.yml` 用同 id 覆盖（`config` 整体替换，不深合并，手写时抄全字段）。`roles` 字段已退役，仅为兼容老 profile 保留，见「`roles` 已退役」。本机参数与 profile 绑定，不进仓库。

## 使用

### 默认与显式升级

默认不需要做任何事：子 agent 自动用配置的低成本路由。需要临时用强模型时，**在委派调用里显式传路由**：

```js
subagent({
  description: '复杂审计',
  prompt: '...',
  provider: '<provider>',
  model: '<model>',
  reasoning_effort: 'high',
})
```

workflow 同理：`agent(prompt, { provider, model })`。`subagent` 的显式路由仍受会话白名单约束——目标路由必须在 `allowedModels` 里，否则工具层直接拒绝；workflow 不受该白名单约束，见「白名单语义与坑」。

### 建议写进项目 AGENTS.md 的运行约定

```markdown
- 子 agent 默认使用配置好的低成本模型，不必显式指定。
- 仅当出现以下情况才显式升级子 agent 模型：同一子任务用默认模型连续失败 2 次以上，
  或任务本身需要长上下文/高推理强度（如跨模块架构审计）。
- 升级时显式传 provider/model，并在交付说明里写清"为什么升级"。
```

## 配置

| 键 | 必填 | 界面可改 | 说明 |
|---|---|---|---|
| `provider` | 是 | ✅ | pin 到的 provider id（bundle 默认 `deepseek-official`，stock 自带） |
| `model` | 是 | ✅ | pin 到的模型 id（bundle 默认 `deepseek-flash`） |
| `reasoningEffort` | 否 | ✅ | pin 时一并写入的 effort（默认不 pin——stock 模型无 effort 档位）；换路由时会丢掉继承来的 effort，避免落在新模型不支持的档位 |
| `debug` | 否 | ✅ | `true` 时写 `%TEMP%\subagent-model-pin.log`（apply / agent/created / select 决策前后，含 `label=`、`explicit=`、`cur=`、`parent=`、`default=`；判定分支写 reason ∈ `force` / `explicit` / `tool-pinned` / `route-differs` / `already-default` / `default`）；路径可用环境变量 `SUBAGENT_MODEL_PIN_LOG` 覆盖 |
| `injectDelegationDefaults` | 否 | — | 默认 `true`。在 `tools/execute` 阶段把默认路由写进委派参数，使 descriptor / 首请求 / 冷恢复三者一致；设 `false` 只保留 `agent/created` 时 select 兜底。没有 `subagent/model-selection-policy` 的会话会自动跳过注入 |
| `force` | 否 | — | `true` = 一律覆盖，连显式选择也 pin（回到旧的「强制」行为） |
| `depth` | 否 | — | 只处理委派深度等于该值的子 agent |
| `sandbox` | 否 | — | 顶层沙箱收窄：给该深度的每个子 agent 追加 `sandbox/mode`，未写则继承父会话，见「顶层沙箱」 |
| `roles` | 否 | — | **已退役（0.5.0）**：字段保留以免老 profile 加载失败，运行时完全忽略，`apply()` 时 warn 一次；迁移见「`roles` 已退役」 |

「界面可改」= 插件页配置卡片可编辑；这四个字段在 Config schema 里标了 `.volatile()`，settings 系统只允许界面写 volatile 路径，所以 `roles` 等其余字段**从机制上**不可能被界面覆盖。

配置有三条途径：插件页配置卡（4 个 volatile 字段，写入 profile patch）、bundle 自带的 `cordis.patch.yml` 作默认值、profile 的 `cordis.patch.yml` 用同 id 覆盖（`config` 整体替换，不深合并，手写时抄全字段）。界面保存立即写入 profile patch，pin 路由的改动作用于**此后的委派**，但白名单按会话冻结——**需新开会话**。

### `roles` 已退役（deprecated，0.5.0）

`roles` 数组**字段仍在 Config schema 里，但运行时被完全忽略**：老 profile 照常加载（不会在加载期炸掉），`apply()` 命中非空 `roles` 时只 `warn` 一次迁移提示，插件不读任何条目。角色路由与角色沙箱都在 0.5.0 消失：

- **角色路由**：只读评审 / 勘察 / spike 的路由钉在 dispatch-protocol 的工具实例上（`subagent_readonly` / `subagent_spike` 的 `agentOptions`），不再需要也不允许 `roles` 覆盖；普通 `subagent` 不再分档，统一用顶层 `provider` / `model` / `reasoningEffort`。
- **角色沙箱**：spike / 勘察由 dispatch-protocol 的 `dispatch-spike` preset + `readonlySandbox` 结构收窄；本插件只剩顶层 `sandbox`。

迁移方向**不对称，必须分开看**：

- 失效的是**路由**时方向安全——少一次覆盖，只读子代理恒为钉路。纯路由角色在 `verify-install.mjs` 的 `roles-migration` 项里只是 WARN。
- 失效的是**沙箱**时方向是**放宽**——`roles[].sandbox` 一删，原本被收窄的 spike / 勘察子代理回到继承父沙箱。所以 `verify-install.mjs` 对**带 `sandbox` 字段的角色报 FAIL**，不许静默。
- 迁移做法：把需要收窄的子代理改派 `subagent_spike` / `subagent_readonly`（结构收窄），或临时用顶层 `sandbox` 兜住；随后从 profile 删掉 `roles` 段。
- 下个大版本会删掉 `roles` 字段，届时老配置在加载期报错并给迁移指引。

```yaml
# 老配置（0.5.0 起无效，仅作迁移对照）
roles:
  - match: Survey
    provider: deepseek-official
    model: deepseek-flash
    sandbox: read-only      # 不再收窄任何子代理——这是需要人工确认的一项
```

### GUI 配置卡片

插件页 **插件 → subagent-model-pin → 配置区** 可编辑四个字段：

- **Provider / 模型**：下拉实时取自 `remote.session.modelCatalog()`（与官方「子智能体」设置页同源），只能选目录里存在的组合；个别 provider 拉取失败会降级提示，不影响其他选项。
- **推理强度**：按选中模型的 `reasoning.efforts` 列出档位，首项「跟随模型默认」（保存为空串 = 不 pin effort）；模型无档位时禁用并标注。
- **调试日志**：开关即写即生效（volatile 字段 Host 原地更新，**无需重启 DSH**）。

**「恢复 YAML 配置」按钮**对四个字段发 `unset`。Host 的语义是「重置 = 显式钉住当前 YAML 值」——重置后立刻等于 YAML，但**之后再改 YAML 的这四个字段不会生效**；需到界面再点一次重置，或手工删 profile patch 里该行的 config。摘要行在插件页直接显示当前生效路由；存在界面覆盖时带「界面覆盖」徽标。

## 行为矩阵

判定全部发生在 `agent/created`（`plugin.mjs#apply` 注册的监听器），首个命中生效；命中「select」时调一次 `agent.model.select()`（`(provider, model)` 相同的跳过分支不产生事件）。`cur` = `agent.model.current()`，`target` = 顶层 `provider` / `model` / `reasoningEffort`，`label` = 子会话 `subagent/descriptor.label`，`explicit` = 父会话 `tool/call` 里能否找到同 `description` 的委派调用并读到路由字段（`plugin.mjs#readDelegationChoice`）。

| # | 场景 | 行为 |
|---|---|---|
| R1 | 非子会话，或 depth 不匹配 | 不动（起源过滤） |
| R2 | `force: true` | 一律 `select(target)` |
| R3 | `explicit === true`：委派调用显式传了路由 / effort | **放行**（含「与父路由相同」的升级） |
| R4' | `label !== undefined && explicit === undefined`：自带钉路的工具子代理（`subagent_readonly`、`subagent_spike`，及未来任何用 `agentOptions` 钉路的委派工具） | **放行**：创建时路由即最终路由，不碰（reason `tool-pinned`） |
| R5 | `explicit === undefined` 且 `cur` 与父路由不同 | **放行**（workflow 显式选路的保护伞；reason `route-differs`） |
| R6' | 其余 | `cur` ≠ `target` → `select`；相同 → 跳过（reason `default` / `already-default`） |

R6' 的实际负载收窄为：没有 descriptor label 的 workflow 未选路子代理，以及无白名单会话里普通委派的未选路子代理。

补充：

| 场景 | 行为 |
|---|---|
| 普通委派 + 父 `tool/call` 未提交（父回合中断 / 崩溃） | 子代理带 label 但找不到匹配的委派调用 → 落 **R4' keep**：跑继承路由、失去默认 pin。接受的权衡（spec §4.2）：场景罕见，方向是「少用一次最贵的兜底」 |
| workflow 子级（无 label） | `explicit` 未知：`cur` 与父路由有差异才放行（R5）；等于父路由或父路由不可读则 R6' pin |
| 父会话已不存在 / 路由不可读 | 普通委派仍带 label → R4' keep；workflow 子级无 label → R6' pin |
| 配置的 provider 没有 adapter 注册 | 跳过 select 并写 debug log（见「路由合法性」） |
| 两条委派 `description` 重复且并发 | 可能串路由（概率极低，写清唯一 description） |
| 想恢复「一律强制」 | 配置加 `force: true` |
| 子代理会话中途手动改模型 | 生效（旧中间件每请求重 pin 会覆盖，已不再注册） |

## 白名单语义与坑

**白名单是「会话级快照」。** DSH 在每个**全新顶层会话**组合时读取一次设置并写进会话事件（`subagent/model-selection-policy`），子会话继承它，之后改配置不影响已有会话。

- 改完白名单后**必须新开会话**才能用新路由；旧会话里升级会被拒（`child LLM route "…" is not allowed for this Session`）。
- **分支（fork /「在新对话中分支」）不算新开会话**，同样继承源会话的旧白名单：`session.fork` 复制 `events.slice(0, boundary+1)` + `session/end-seed {inherited:true}`，而 `tool-subagent` 只在 `firstLiveSeq === 0 && eventAt(0).type !== 'session/end-seed'` 时读当前设置。想用新路由只能「新建对话」。
- **删路由 / 关闭开关都不追溯**：旧会话与分支仍按旧快照放行，子 agent 继续继承。要让某条路由真的不可用，得撤 provider 侧凭据（`apiKeyEnv`）或停用 provider。
- **workflow 不受白名单约束**：`workflow` 的 `agent(prompt, { provider, model })` 直连 `ctx.subagents.startActivation()`，只校验 provider 已注册。它既是白名单的漏洞，也是「旧会话里升级」的可用旁路（代价：没有 `send_message` 续接，只能跑完拿结果）。

关闭「允许 Agent 为子智能体选择模型」的效果：

| 场景 | 关闭后 |
|---|---|
| 新建对话 | 无白名单问题（能力被移除：工具 schema 没有 `provider` / `model`，`list_subagent_models` 不注册，所有子 agent 恒走 pin 路由） |
| 关闭前建的会话 / 其分支 | **仍有问题**：日志里的 policy 事件不会消失，旧白名单照旧生效 |
| 关闭期间建的会话（之后重新开启） | 仍然没有选择能力：恢复时 `firstLiveSeq > 0`，不会补写 policy，只能新建对话 |
| workflow 显式路由 | 不受影响 |

## 顶层沙箱

顶层 `sandbox` 是 0.5.0 唯一保留的沙箱收窄：取 `read-only` / `workspace-write` / `danger-full-access`，未写则继承父会话。它按委派深度作用于**每个**子 agent（不区分 label / 角色），语义清晰、非 label 驱动。

```yaml
- id: subagent-model-pin
  config:
    provider: deepseek-official
    model: deepseek-flash
    sandbox: read-only      # 该深度的子 agent 统一收窄：写盘被文件沙箱直接拒绝
```

实现方式：在 `agent/created` 里对命中的子会话追加一条 `sandbox/mode` 事件（`plugin.mjs#applyPinnedSandbox`）——子会话权限在委派开始时固定、不能自行放宽，只能从外部收窄；当前已是目标档位时跳过，不产生重复事件。委派工具没有 sandbox 字段，所以沙箱只能来自这里，或来自 dispatch-protocol 的 `readonlySandbox` 按 preset 收窄。

注意：宿主若禁用了 child model selection，而调用会话里仍有 `subagent/model-selection-policy` 事件，注入会被拒；这时设 `injectDelegationDefaults: false`，只走 `agent/created` 的 select 兜底。0.4.0 起没有 policy 的会话会自动跳过注入。

## 验证

### 离线回归

```powershell
npm ci          # 或 pnpm install（0.2.0 起有 schemastery 依赖，首次需要）
node test.mjs   # 在插件目录内执行
```

覆盖 R1 / R2 / R3 / R4' / R5 / R6' 行为矩阵各分支、`roles` 配置加载不报错且运行时忽略并 warn 一次、自带钉路子代理不 select（含「钉路 == 父路由」的旧 R4 漂移回归）、workflow 场景零 `agent/request` 注册、select 的 effort 透传与缺省、provider 合法性校验、显式「没选」、非委派工具、`injectDelegationDefaults:false`、非子 agent、顶层沙箱收窄，以及 volatile 字段的覆盖即时生效 / 回落 / 空串 effort / debug 热切换。离线 harness 用 `AgentModel` stub 与 `llm.listProviders()` stub。

### 看日志确认生效

子会话日志是 zstd **多帧**追加的（每帧一次 append），`zstdDecompressSync` 只解第一帧，必须逐帧解：

```js
// 逐帧解压：按 magic 0x28 0xB5 0x2F 0xFD 切分后分别解，再拼接
const buf = fs.readFileSync(file)
const offsets = []; let i = 0
while ((i = buf.indexOf(magic, i)) !== -1) { offsets.push(i); i += 4 }
const text = Buffer.concat(offsets.map(o => zstdDecompressSync(buf.subarray(o)))).toString('utf8')
```

然后看两个字段：

| 字段 | 含义 |
|---|---|
| `request/context` 的 `provider` / `model` | **实际请求**用的路由（唯一可信） |
| `subagent/descriptor` 的 `agentModel` | 创建时记录的路由；应等于最终 pin 路由（与 `request/context` 一致） |

会话日志位置：`~/.dsh/sessions/<项目目录>/<会话id>/session.v4.jsonl.zstd`；子会话直接以 agent id 命名。

**升级不生效时**：

1. 确认是重启 DSH 后新开的会话（插件不热加载、白名单按会话冻结）。
2. 查父会话日志里是否有同 `description` 的 `tool/call`。
3. 开 `debug: true` 看 `%TEMP%\subagent-model-pin.log` 里的 `explicit=`：`undefined` 说明没匹配到委派调用，`true` 却仍被 pin 说明标记逻辑异常。
4. 确认目标路由在 `allowedModels` 里。

### 排查技巧：dump 组合配置

被 Electron 独占的 profile（如 `desktop`）会拒绝 `dsh --profile desktop --dump-config`。绕过办法：把 profile 复制成临时名字再 dump：

```powershell
$src = "$env:USERPROFILE\.dsh\profiles\desktop"
$dst = "$env:USERPROFILE\.dsh\profiles\probe-tmp"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item "$src\cordis.yml","$src\cordis.patch.yml","$src\package.json" -Destination $dst -Force
Copy-Item "$src\plugins" -Destination $dst -Recurse -Force
dsh --profile probe-tmp --dump-config   # 验证完记得删掉 probe-tmp
```

dump 里能看到相对插件路径被解析成 `file:///...` 绝对 URL，可用来确认 anchor 是否符合预期。

## 已知坑与副作用

| 现象 | 说明 |
|---|---|
| 任何工具 `agentOptions` 钉死的路由不再被本插件覆盖（R4'） | `subagent_readonly`、`subagent_spike` 及未来任何自带钉路的委派工具，其子代理带 label 且找不到匹配的委派调用，落 R4' keep：顶层 pin 不会覆盖它。要换它们的路由，改 dispatch-protocol 对应工具行的 `agentOptions`；本插件的 `provider` / `model` 对它们无效 |
| 显式路由需先进白名单 | 白名单只列了配置里的路由，想升级到别处必须先放开 |
| 白名单改动对旧会话 / 分支无效 | 会话创建时冻结；改完需**新开会话** |
| workflow 子级显式升级到「与父相同」的路由仍可能被 pin | workflow 不经过 `subagent` 工具，无 `description` 可匹配；回退分支只认「路由不同」 |
| 冷恢复的子会话按 `cur` 比对处理 | 恢复时 descriptor 路由已在 setup 阶段入账，等于目标就零 select，否则按 R5 / R6' 判定 |
| 中途手动改模型不再被覆盖 | 只在 `agent/created`（含 resume 再激活）pin 一次；有意为之 |
| 未注册的 provider 不会 pin | 插件跳过 select 并写 debug log，子会话保留继承路由；写错 model 仍需配置自证 |
| 主 agent 不受影响 | `agent/created` 被 `origin` 判断过滤掉 |
| 插件代码改动需重启 DSH | profile 层插件不支持热加载；4 个 volatile 字段的**配置值**改动即时生效（Host 原地换值），改 `client.js` 后也需重启 |
| 注入是「显式选择」 | 会经过白名单与 `modelSelectionEnabled` 校验；无 `subagent/model-selection-policy` 的会话自动跳过，走 select 兜底 |

## 实现要点

`plugin.mjs` 用两个扩展点：

0. `tools/execute`（waterfall，`(exec, next)`）——委派工具执行前，`exec.arguments` 已由工具注册表 **deep-freeze**，只能整体替换引用、不能原地改字段。在这里补默认 `provider` / `model` / `reasoning_effort`，让 `subagent/descriptor.agentModel` 从创建时就是最终路由。
1. `agent/created`（参数 `{ agent, source, signal? }`）——根级插件也能收到；父会话是 `origin=undefined`，子会话是 `origin=subagent`，据此区分。**回退 pin 在这里做**：按行为矩阵判定后调 `agent.model.select({ provider, model, reasoningEffort? })`。

**不再注册 `agent/request`**：`dsh-agent-loop` 在 `preStep` 开头就用 `agent.model.current()` 固定本步模型，此后中间件若返回不同的 provider/model/effort 会直接 `throw`，不是静默忽略。`select()` 追加持久 `model/selection` 事件，`agent/created` 是 serial 且被 await，早于子代理首个 `preStep` 的模型固定点，一次 select 即对整段会话（含冷恢复）生效。

### descriptor 一致性

`subagent/descriptor.agentModel` 记录的是**创建时** `resolveChildAgentOptions()` 的结果，而早期 pin 发生在 `agent/request`（晚于 descriptor 写入），两者会不一致。受影响的不是 UI（所有 `dsh-client-ui-*` 包都不读 `agentModel`，会话模型选择器读的是 `model/selection` projection），而是：

1. 会话日志里 descriptor 记录了一条从未用于请求的路由；
2. **冷恢复**：`continuation.resume()` 用 `descriptor.agentModel` 重建 `agentOptions`，而恢复时没有新的委派 `tool/call`，插件只能走「路由不同才放行」的回退分支——父会话之后切过模型时，子会话会跑回继承来的强模型。

修复方式是在 `tools/execute` 阶段把默认路由注入委派参数（`injectDelegationDefaults`），使 descriptor、首请求、冷恢复三者一致；workflow 子级与 continuation 没有委派参数，仍由 `agent/created` 时 select 兜底。resume 时 descriptor 路由在 setup 阶段已先 `select` 入账，所以 `current()` 已经是恢复路由——与目标一致就不追加事件，不一致才补一次 select。

### 路由合法性

`agent.model.select()` **不校验白名单、不走 LLM preflight**——合法的路由由插件自证。核对 `dsh-llm` 服务的导出后，落地结论是**只做 provider 半程的同步校验**：

- `llm.listProviders()` 是唯一的**同步**查询，返回当前有 adapter 注册的 provider 表；插件在 select 前调它，返回非空且不含目标 provider 时**跳过 select 并写 debug log**（子会话保留继承路由，而不是 pin 到一条注定在 dispatch 阶段失败的路由）。
- **model 半程无法同步校验**：`listModels()`、`resolveModelInfo()`、`resolveCallConfig()` 全部 `async`（要等 adapter 答复），在 `agent/created` 里同步 await 会拖住 created 链。所以「这个 model 在目标 provider 上存在」仍需配置自证——写错时表现为子代理首个请求由 adapter 报错（`NO_ADAPTER` / 未知模型），日志里能看到插件的 select 记录。
- 查询不可用（没有 llm 服务、旧版 surface）时**不阻塞**：视为「无法回答」，照常 select。

这条自证不改变白名单语义：主路径（注入）仍受 `allowedModels` 约束，回退路径（select）绕过它。

### 兜底式默认（`force: false`）

子 agent 绝大多数时候应跑低成本模型，只有少数情况需要升级，所以插件采用「**没人选才 pin**」。

**判定「有没有人选」不能靠路由比对。** DSH 的 `resolveChildAgentOptions()` 会把父路由**无条件**合并进子 agent 的 options，`agent/created` 时的 `agent.model.current()` 也不携带「这是显式选的还是继承的」信息。因此「显式传了与父路由相同的路由」（最常见场景：升级到主 agent 同款强模型）和「纯继承」在事件层完全同形，早期按 `resolved ≠ 父路由` 判断会把前者误 pin。

可靠信号只在**父会话的 `tool/call` 事件**里：委派工具的 `arguments` 原样保留了模型写的 `provider` / `model` / `reasoning_effort`，且 `description` 等于子会话 `subagent/descriptor` 的 `label`，可用作唯一匹配键（并发委派也不会串）。找不到对应委派调用时按矩阵分流：带 label 的子代理视为自带钉路、直接 keep（R4'）；无 label 的 workflow 子级只在路由有差异时放行（R5），与父路由相同则保守 pin（R6'）。

### 注入代价

| 项 | 说明 |
|---|---|
| 注入等于显式选择 | 会经过 `assertAllowedModelSelection` 白名单校验；pin 路由必须在白名单里，否则所有默认委派都会报 `not allowed` |
| 需要启用模型选择 | 工具实例 `modelSelectionEnabled` 为 false 时，注入的参数会让委派抛 `child model selection is disabled` |
| 多一次预检 | `requiresRoutePreflight` 变 true，`llm.resolveCallConfig()` 会先解析一次路由 |
| 可关闭 | patch 里给插件 config 加 `injectDelegationDefaults: false` 即只保留 `agent/created` 时 select 兜底 |

## 回滚

- 临时停用：在插件页停用本插件（或在 profile 的 `cordis.patch.yml` 该条目加 `disabled: true`）；或退版本 `dsh plugin --profile <profile> update subagent-model-pin` 选旧版。
- 彻底移除：插件页移除，或 `dsh plugin --profile desktop remove subagent-model-pin`。
- 回滚到 0.5.0 之前：`dsh plugin --profile <profile> update subagent-model-pin` 选旧版，或用旧提交的 Git 地址重装（本仓库不发 npm 包），再重启 DSH。0.4.x 的 `roles` 角色分档与角色沙箱随版本回来；0.5.0 期间从 profile 删掉的 `roles` 段需一并恢复。
- 以上操作都要重启 DSH。YAML 是明文，记事本可改。移除后子 agent 回到继承父路由的默认行为；已写入 profile patch 的界面覆盖会随该行一起消失。

## 版本历史

| 版本 | 要点 |
|---|---|
| `0.5.0` | **`roles` 表退役**：schema 字段保留、运行时完全忽略、apply 时 warn 一次；select 分支表改为 R1 / R2 / R3 / R4'（自带钉路工具子代理 keep）/ R5 / R6'，从机制上消除「角色路由覆盖 `agentOptions` 钉路」的漂移；沙箱只剩顶层 `sandbox`。迁移注意失效方向不对称：路由项安全，**角色沙箱项是放宽**（`verify-install.mjs` 对带 `sandbox` 的 roles 报 FAIL）。 |
| `0.4.1` | 文档：写清 `roles` 与 dispatch-protocol 钉路的对齐前提——R4 命中不同路由仍会覆盖 `agentOptions` 钉路，及三种修法。 |
| `0.4.0` | 默认路由换 stock 自带的 `deepseek-official/deepseek-flash`（不 pin effort）；注入感知白名单——无 `subagent/model-selection-policy` 时跳过注入、走 select 兜底，新装零手改 YAML。 |
| `0.3.1` | 评审 / 复审 / 勘察角色的路由与沙箱上移到 dispatch-protocol，`roles` 职责收缩为 spike 沙箱；本插件代码不变。 |
| `0.3.0` | 回退 pin 从 `agent/request` 迁到 `agent/created` + `agent.model.select()`；用 `tools/execute` 注入默认路由，descriptor / 首请求 / 冷恢复一致。宿主 0.2.2 起 `preStep` 先固定本步模型，`agent/request` 改路由会抛错。 |
| `0.2.0` | 插件页配置卡片：4 个 volatile 字段 + 手写 `client.js` 注册 `plugins.bundle.config`。 |
| `0.1.0` | 初版：兜底 pin、显式升级与角色分档。 |

踩坑结论（避免重犯）：新增行必须 `insert`；预设内条目不可 patch；「显式选择」与「纯继承」在事件层同形，只能回查父会话 `tool/call`；白名单按会话冻结，分支不算新会话。2026-10-21 实测：显式传与父同款路由被放行，不传则回落 pin，两者 descriptor 都等于最终路由。
