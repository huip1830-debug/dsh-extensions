# subagent-model-pin

> 部署状态以 profile 安装为准（`dsh plugin --profile desktop list`）；probe 为 `link:`。改动后：提交推送 → 关闭 DSH → `dsh plugin --profile desktop update subagent-model-pin` → 启动。

DSH profile 插件：**子 agent 默认跑低成本模型，需要时在委派调用里显式升级**。

- 默认（不传路由）→ 子 agent 用 `config.provider` / `config.model`（含 effort）。
- 显式传了 `provider` / `model` / `reasoning_effort` → 放行，即使与父 agent 同款也能升级。
- 本仓库的 `plugin.mjs` 是**唯一真源**；安装到 profile 后是 pnpm 管理的副本，改代码要重装才生效。

这是一个**独立的工具链仓库**，与任何业务项目无关：DSH 插件属于本机开发工具，多个项目共用，跟着开发机走。

## 安装

包已声明 `dsh.bundle.patch`，所以 DSH 插件页可以直接装。桌面版或 Web 侧栏 **插件** → **添加插件** → **安装第三方插件**，填：

```
https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/subagent-model-pin
```

CLI 等价：

```powershell
dsh plugin --profile desktop add "https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/subagent-model-pin"
```

装完在插件页启用，重启 DSH。升级 = 同地址重装（插件页会提供"更新"）。卸载 = 插件页移除（或 `dsh plugin --profile desktop remove subagent-model-pin`）。

装完必须：

1. **重启 DSH**（profile 层插件不支持热加载）；
2. **新开会话**再验证（`allowedModels` 白名单按会话冻结，旧会话不受新配置影响）。

本机参数与 profile 绑定，不进仓库；bundle 方式的默认值在 `cordis.patch.yml`，要改就在 profile 的 `cordis.patch.yml` 里用同 id 覆盖（`config` 整体替换，不深合并）。

## 配置项

| 键 | 必填 | 界面可改 | 说明 |
|----|------|----------|------|
| `provider` | 是 | ✅ | pin 到的 provider id |
| `model` | 是 | ✅ | pin 到的模型 id |
| `reasoningEffort` | 否 | ✅ | pin 时一并写入的 effort；换路由时会丢掉继承来的 effort，避免落在新模型不支持的档位 |
| `debug` | 否 | ✅ | `true` 时写 `%TEMP%\subagent-model-pin.log`（apply / agent/created / 每次改写前后，含 `label=` 与 `explicit=`）；路径可用环境变量 `SUBAGENT_MODEL_PIN_LOG` 覆盖 |
| `injectDelegationDefaults` | 否 | — | 默认 `true`。在 `tools/execute` 阶段把默认路由写进委派参数，使 descriptor / 首请求 / 冷恢复三者一致；设 `false` 退回纯 request 层 pin |
| `force` | 否 | — | `true` = 一律覆盖，连显式选择也 pin（回到 v5 之前的"强制"行为） |
| `depth` | 否 | — | 只处理委派深度等于该值的子 agent |
| `roles` | 否 | — | 按委派 `description` 前缀分档路由的数组；每项含 `match`（前缀，大小写不敏感）、`provider`、`model`，可选 `reasoningEffort`、`sandbox`。首个命中生效；未命中回落到 `provider`/`model`；委派调用里显式传的路由仍然优先。**注意前缀按字面匹配**：中文 description（如「评审后端改动」）不会命中 `Survey`/`Review` 这类英文前缀——三样本评审（`docs/reviews/2026-10-23-dispatch-pipeline-review.md` G8）里全部评审/勘察子代理因此以 `danger-full-access` 运行。用中文 label 的派发方应在角色表里配对应中文前缀（如 `评审`/`勘察`/`只读`），或约定英文 label |

「界面可改」= 插件页配置卡片可编辑（见下节「GUI 配置」），这四个字段在 Config schema 里标了 `.volatile()`，settings 系统只允许界面写 volatile 路径，所以 `roles` 等其余字段**从机制上**不可能被界面覆盖。

### roles：按角色分档

```yaml
roles:
  - match: Survey
    provider: deepseek-official
    model: deepseek-flash
  - match: Review
    provider: deepseek-official
    model: deepseek-flash
```

匹配规则：取子代理的 `description`（即 descriptor label），去掉首尾空白、转小写后做 `startsWith`。所以派发时按 `Survey …` / `Implement …` / `Review …` 命名即可自动分档；不按约定命名则落回默认路由。`roles` 非法（非数组、`match` 为空、缺 `provider`/`model`）在插件加载时直接报错。

配置有三条途径：插件页配置卡片（4 个 volatile 字段，见下节）、bundle 自带的 `cordis.patch.yml` 作默认值、profile 的 `cordis.patch.yml` 用同 id 覆盖（`config` 整体替换，不深合并——手写 YAML 时务必抄全字段）。

**角色与沙箱的唯一真相源就是这里的 `roles`**：`sandbox` 字段（`read-only` / `workspace-write` / `danger-full-access`）也在同一张表里。别再在别处维护第二份角色名单——2026-10-22 的审查把这种复制列为漂移源（`dispatch-guard` 的 `stall.exempt` 就因从未配置而失效，已归档）。

## GUI 配置（插件页配置卡片）

0.2.0 起插件页自带配置卡片：**插件 → subagent-model-pin → 配置区**（bundle 详情内），可编辑上表标 ✅ 的四个字段：

- **Provider / 模型**：下拉实时取自 `remote.session.modelCatalog()`（与官方「子智能体」设置页同源），只能选目录里存在的组合；个别 provider 拉取失败会降级提示，不影响其他选项。
- **推理强度**：按选中模型的 `reasoning.efforts` 列出档位，首项「跟随模型默认」（保存为空串 = 不 pin effort）；模型无档位时禁用并标注。
- **调试日志**：开关即写即生效（volatile 字段 Host 原地更新，**无需重启 DSH**）。

生效语义：

- **保存立即写入** profile 的 `cordis.patch.yml`（settings 传输落盘，带 revision 冲突检测）；pin 路由的改动作用于**此后的委派**，但白名单按会话冻结——**需新开会话**，且新路由必须在「允许 Agent 为子智能体选择模型」的白名单里，否则注入式委派会被拒。
- **「恢复 YAML 配置」按钮**：对四个字段发 `unset`。注意 Host 的语义是「重置 = 显式钉住当前 YAML 值」（settings 的 unset 遇 inherited 值会写成显式拷贝），所以重置后立刻等于 YAML，但**之后再改 YAML 的这四个字段不会生效**——需到界面再点一次重置，或手工删 profile patch 里该行的 config。
- 摘要行在插件页直接显示当前生效路由；存在界面覆盖时带「界面覆盖」徽标。

实现要点（改动前先看）：

| 事实 | 依据 |
|------|------|
| 浏览器半区是手写的 `window.__ModuleLoader__.load({id, factory})` 纯 JS，Host 按字节直读、不转译 | `dsh-client-modules`（`exports["./client"]` + `dsh.client.platform === 'web'`）；`id` 必须等于包名，文件缺失会让 Host 启动失败 |
| 卡片注册在 `plugins.bundle.config` slot，key = 包名 | 官方先例：cot-translation / voice-input；`plugins.row.config` 零官方占用者，未采用 |
| 表单自绑 `ctx.configForms.get('subagent-model-pin')`（命名空间 = patch 行 id），不依赖页面传入的 `form` prop | 官方 4 个设置页同款；`form` prop 零消费者 |
| 界面只能写 `.volatile()` 字段；Host 写盘时校验路径并把 volatile 子树剥离后合并进 profile patch | `dsh-settings/lib/index.js` `write()` / `validatePaths` / `strip` |
| Host 侧 `plugin.mjs` 运行期一律 `readVolatile(config.x)` 现取，不缓存 | volatile 引用由 loader 用 `updateVolatile` 原地换值，不 remount |
| 改 `client.js` 后需重启 DSH | bundle 在激活时快照进内存 |

成本约 300 行手写 `client.js`；客户端契约（slot、`ui-primitives`、种子模块表）属内部 API，DSH 升级可能要跟改。

## 行为矩阵

| 场景 | 行为 |
|------|------|
| 委托时没传 `provider`/`model` | pin 到低成本模型（含 effort） |
| 委托时显式传了不同路由 | **放行** |
| 委托时显式传了**与父路由相同**的路由 | **放行**（按 label 回查，见下文） |
| workflow 子级 / 冷恢复 / 父事件未提交 | 回退：路由有差异才放行，相同则 pin |
| 父会话已不存在 / 路由不可读 | 回退为 pin（宁可用便宜模型，也不放任继承） |
| 两条委派 `description` 重复且并发 | 可能串路由（概率极低，写清唯一 description） |
| 想恢复"一律强制" | 配置加 `force: true` |

## 为什么"在设置里选子 agent 模型"不管用

DSH 设置里那个开关（`subagent-model-selection-settings`，UI 文案「允许 Agent 为子智能体选择模型」）不是默认值，而是一份**授权白名单**：

```yaml
- id: subagent-model-selection-settings
  config:
    enabled: true
    allowedModels:
      - provider: opencode-go
        model: deepseek-v4.1-flash
```

它只约束「模型显式指定路由时能选哪些」。父 agent 不传 `provider`/`model` 时走的是**继承父路由**，官方注释写得很明确：

> Pure inheritance remains outside this policy because no model-facing choice occurred.

即：白名单对纯继承不生效，子 agent 会跟着主 agent 的模型跑。

## 为什么"用 patch 改子 agent 模型"也不行

三个坑，按踩到的顺序：

1. **顶层 `tool-subagent` 是禁用的。** `@deepseek-ai/dsh-web-app` bundle 把 `dsh-base` 里的顶层条目设成了 `disabled: true`，真正的 `subagent` 工具挂在 **`standard` 预设的 `plugins` 列表**里（带 `modelSelectionSettings: true`）。
2. **预设内的条目不可 patch。** profile patch 只索引「根树 + `group: true` 容器」，预设的 `plugins:` 是普通 config 数据，不在索引里；而且 patch 的 `config` 是**整体替换、不深合并**，没法只加一个 `agentOptions`。
3. **新增条目必须用 `insert`。** 写成 `- id: <新id>` 会被判定为「未知目标」，按官方规则 *"Unknown targets and non-insert patches ... are warned and skipped"* —— **静默跳过，不报错**，这是最坑的一点（表现为"改了配置、重启了、毫无变化"）。

正确写法见本包的 `cordis.patch.yml`（bundle 层，安装后自动生效）。

## 实现要点

`plugin.mjs` 用三个扩展点：

0. `tools/execute`（waterfall，`(exec, next)`）—— 委派工具执行前，`exec.arguments` 已由工具注册表 **deep-freeze**，只能整体替换引用、不能原地改字段。在这里补默认 `provider`/`model`/`reasoning_effort`，让 `subagent/descriptor.agentModel` 从创建时就是最终路由（见下节「descriptor 一致性」）。
1. `agent/created`（参数 `{ agent, source, signal? }`）—— 根级插件也能收到；父会话是 `origin=undefined`，子会话是 `origin=subagent`，据此区分。
2. `agent/request`（waterfall）—— 返回值就是该请求的最终配置 `{ provider, model, reasoningEffort, maxTokens }`。注册时传 `prepend: true`（第三个参数传 `true` 等价于 `{ prepend: true }`），让本监听器位于链条最外层，保证返回值不被内置的「会话模型选择」覆盖。

### descriptor 一致性（v4，2026-10-21）

`subagent/descriptor.agentModel` 记录的是**创建时** `resolveChildAgentOptions()` 的结果，而 pin 发生在 `agent/request`，两者会不一致。受影响的不是 UI（所有 `dsh-client-ui-*` 包都不读 `agentModel`，会话模型选择器读的是 `model/selection` projection），而是：

1. 会话日志里 descriptor 记录了一条从未用于请求的路由；
2. **冷恢复**：`continuation.resume()` 用 `descriptor.agentModel` 重建 `agentOptions`，而恢复时没有新的委派 `tool/call`，插件只能走「路由不同才放行」的回退分支——父会话之后切过模型时，子会话会跑回继承来的强模型。

修复方式是在 `tools/execute` 阶段把默认路由注入委派参数（`injectDelegationDefaults`）。这样 descriptor、首请求、冷恢复三者一致；workflow 子级与 continuation 没有委派参数，仍由 request 层兜底。

代价（新增耦合，改配置前先看）：

| 项 | 说明 |
|----|------|
| 注入等于显式选择 | 会经过 `assertAllowedModelSelection` 白名单校验；pin 路由必须在白名单里，否则所有默认委派都会报 `not allowed` |
| 需要启用模型选择 | 工具实例 `modelSelectionEnabled` 为 false 时，注入的参数会让委派抛 `child model selection is disabled` |
| 多一次预检 | `requiresRoutePreflight` 变 true，`llm.resolveCallConfig()` 会先解析一次路由 |
| 可关闭 | patch 里给插件 config 加 `injectDelegationDefaults: false` 即回到纯 request 层 pin |

### 兜底式默认（默认策略：`force: false`）

子 agent 绝大多数时候应跑低成本模型，只有少数情况需要升级，所以插件采用「**没人选才 pin**」。

**判定「有没有人选」不能靠路由比对。** DSH 的 `resolveChildAgentOptions()` 会把父路由**无条件**合并进子 agent 的 options，`agent/created` / `agent/request` 都不携带「这是显式选的还是继承的」信息。因此「显式传了与父路由相同的路由」（最常见场景：升级到主 agent 同款强模型）和「纯继承」在事件层完全同形，早期按 `resolved ≠ 父路由` 判断会把前者误 pin。

可靠信号只在**父会话的 `tool/call` 事件**里：委派工具的 `arguments` 原样保留了模型写的 `provider` / `model` / `reasoning_effort`，且 `description` 等于子会话 `subagent/descriptor` 的 `label`，可用作唯一匹配键（并发委派也不会串）。

回退分支只用于「找不到对应委派调用」的少数场景；此时路由有差异才放行，与父路由相同则保守 pin。

## `allowedModels` 白名单：语义与三个坑

**白名单是「会话级快照」。** DSH 在每个**全新顶层会话**组合时读取一次设置并写进会话事件（`subagent/model-selection-policy`），子会话继承它，之后改配置不影响已有会话。

- 改完白名单后**必须新开会话**才能用新路由；旧会话里升级会被拒（`child LLM route "…" is not allowed for this Session`）。
- **分支（fork /「在新对话中分支」）不算新开会话**，同样继承源会话的旧白名单：`session.fork` 复制 `events.slice(0, boundary+1)` + `session/end-seed {inherited:true}`，而 `tool-subagent` 只在 `firstLiveSeq === 0 && eventAt(0).type !== 'session/end-seed'` 时读当前设置。想用新路由只能「新建对话」。
- **删路由/关闭开关都不追溯**：旧会话与分支仍按旧快照放行，子 agent 继续继承。要让某条路由真的不可用，得撤 provider 侧凭据（`apiKeyEnv`）或停用 provider。
- **workflow 不受白名单约束**：`workflow` 的 `agent(prompt, { provider, model })` 直连 `ctx.subagents.startActivation()`，只校验 provider 已注册。它既是白名单的漏洞，也是"旧会话里升级"的可用旁路（代价：没有 `send_message` 续接，只能跑完拿结果）。

关闭「允许 Agent 为子智能体选择模型」的效果：

| 场景 | 关闭后 |
|------|--------|
| 新建对话 | 无白名单问题（能力被移除：工具 schema 没有 `provider`/`model`，`list_subagent_models` 不注册，所有子 agent 恒走 pin 路由） |
| 关闭前建的会话 / 其分支 | **仍有问题**：日志里的 policy 事件不会消失，旧白名单照旧生效 |
| 关闭期间建的会话（之后重新开启） | 仍然没有选择能力：恢复时 `firstLiveSeq > 0`，不会补写 policy，只能新建对话 |
| workflow 显式路由 | 不受影响 |

### 升级用法（少数情况）

默认不需要做任何事。当低成本模型确实解决不了、需要临时用强模型时，**在委托调用里显式传路由**：

```js
subagent({
  description: '复杂审计',
  prompt: '...',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoning_effort: 'high',
})
```

workflow 同理：`agent(prompt, { provider, model })`。

注意显式路由仍受会话白名单约束——目标路由必须在 `allowedModels` 里，否则工具层直接拒绝。

### 建议写进项目 AGENTS.md 的运行约定

```markdown
- 子 agent 默认使用配置好的低成本模型，不必显式指定。
- 仅当出现以下情况才显式升级子 agent 模型：同一子任务用默认模型连续失败 2 次以上，
  或任务本身需要长上下文/高推理强度（如跨模块架构审计）。
- 升级时显式传 provider/model，并在交付说明里写清"为什么升级"。
```

## 角色沙箱（`roles[].sandbox`）

同一个角色表也能收窄子 agent 的沙箱：`sandbox` 取 `read-only` / `workspace-write` / `danger-full-access`，未写则继承父会话。

```yaml
- id: subagent-model-pin
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    roles:
      - match: Survey
        provider: deepseek-official
        model: deepseek-flash
        sandbox: read-only      # 只读勘察：写盘被文件沙箱直接拒绝
```

实现方式：在 `agent/created` 里对匹配的子会话追加一条 `sandbox/mode` 事件（子会话权限在委派开始时固定、不能自行放宽，只能从外部收窄）。委派工具没有 sandbox 字段，所以沙箱只能由角色表决定；显式 `provider/model` 仍只影响路由。

已验证（headless E2E，mock provider 驱动真实 agent 循环）：

- 子会话事件序列：`sandbox/mode workspace-write source=delegation` → `approval/policy never source=delegation` → `sandbox/mode read-only`（插件追加）；
- 子 agent 的 `write` 返回 `[sandbox: file access denied under read-only mode]`，目标文件未生成；
- 对照组（角色不带 `sandbox`）：同一委派下写盘成功。

注意：headless 等禁用了 child model selection 的宿主里，必须同时设 `injectDelegationDefaults: false`，否则委派参数被注入 `provider/model` 会报 `child model selection is disabled for this tool instance`。

## 验证是否真的生效

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
|------|------|
| `request/context` 的 `provider` / `model` | **实际请求**用的路由（唯一可信） |
| `subagent/descriptor` 的 `agentModel` | 创建时记录的路由；v4 起应等于最终 pin 路由（与 `request/context` 一致） |

会话日志位置：`~/.dsh/sessions/<项目目录>/<会话id>/session.v4.jsonl.zstd`；子会话直接以 agent id 命名。

**升级不生效时**：

1. 确认是重启 DSH 后新开的会话（插件不热加载、白名单按会话冻结）；
2. 查父会话日志里是否有同 `description` 的 `tool/call`；
3. 开 `debug: true` 看 `%TEMP%\subagent-model-pin.log` 里的 `explicit=`：`undefined` 说明没匹配到委派调用，`true` 却仍被 pin 说明标记逻辑异常；
4. 确认目标路由在 `allowedModels` 里。

## 离线回归

```powershell
npm ci          # 或 pnpm install（0.2.0 起有 schemastery 依赖，首次需要）
node test.mjs   # 26 个用例（在插件目录内执行）
```

覆盖：显式升级到父路由、纯继承、显式"没选"、workflow/冷恢复回退、非委派工具、`force`、`injectDelegationDefaults:false`、非子 agent、角色沙箱，以及 volatile 字段（界面配置卡）的覆盖即时生效 / 回落 / 空串 effort / debug 热切换。

## 已知副作用

| 现象 | 说明 |
|------|------|
| 显式路由需先进白名单 | 白名单只列了配置里的路由，想升级到别处必须先放开 |
| 白名单改动对旧会话/分支无效 | 会话创建时冻结；改完需**新开会话** |
| workflow 子级显式升级到"与父相同"的路由仍可能被 pin | workflow 不经过 `subagent` 工具，无 `description` 可匹配；回退分支只认「路由不同」 |
| 冷恢复的子会话走回退分支 | 恢复时不产生新的委派 `tool/call`，按路由比对处理 |
| 主 agent 不受影响 | `agent/created` 被 `origin` 判断过滤掉 |
| 插件代码改动需重启 DSH | profile 层插件不支持热加载；但 4 个 volatile 字段的**配置值**改动即时生效（Host 原地换值），改 `client.js` 后也需重启 |

## 排查技巧：dump 组合配置

被 Electron 独占的 profile（如 `desktop`）会拒绝 `dsh --profile desktop --dump-config`（"managed exclusively by the Electron application"）。绕过办法：把 profile 复制成临时名字再 dump：

```powershell
$src = "$env:USERPROFILE\.dsh\profiles\desktop"
$dst = "$env:USERPROFILE\.dsh\profiles\probe-tmp"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item "$src\cordis.yml","$src\cordis.patch.yml","$src\package.json" -Destination $dst -Force
Copy-Item "$src\plugins" -Destination $dst -Recurse -Force
dsh --profile probe-tmp --dump-config   # 验证完记得删掉 probe-tmp
```

dump 里能看到相对插件路径被解析成 `file:///...` 绝对 URL，可用来确认 anchor 是否符合预期。

## 时间线（踩坑记录，避免重犯）

| 轮次 | 做法 | 结果 | 根因 |
|------|------|------|------|
| 1 | patch 顶层 `id: tool-subagent` | 无效 | 顶层条目被 web-app bundle 禁用，真实工具在预设里 |
| 2 | 插件写成 `- id: <新id>` | 未加载 | 新增条目必须 `insert`，未知 id 静默跳过 |
| 3 | 加日志探针 | 确认"没挂载"而非"被覆盖" | 同上 |
| 4 | 改成 `- insert:` + `prepend: true` | 成功 | 路径 anchor 与监听器顺序均正确 |
| 5 | 由"一律强制"改为"兜底式"（显式优先） | 生效 | 实际用法是"默认低成本 + 少数升级" |
| 6 | 用「`resolved` 路由 ≠ 父路由」判定显式选择 | 显式升级被吞 | `resolveChildAgentOptions()` 无条件合并父路由 |
| 7 | 按 `subagent/descriptor.label` 回查父会话 `tool/call` 参数 | 已验证 | 委派参数是唯一保留"模型原始选择"的信号 |
| 8 | descriptor/冷恢复记录的是继承路由 | 已修（`tools/execute` 注入） | pin 在 request 层发生，晚于 descriptor 写入 |
| 9 | 分支会话沿用旧白名单 | 设计如此，无法用插件绕过 | policy 事件只写一次，投影只认第一条 |
| 10 | 插件页配置卡片（0.2.0） | 已验证 | schemastery `.volatile()` 四字段 + 手写 `client.js` 注册 `plugins.bundle.config`；settings 写盘只含 volatile 子树，roles 等不可能被界面覆盖 |

### 实测记录（2026-10-21）

同一会话并发委派两个子 agent 做最小任务（各读一行文件）：

| 委派 | 传参 | `subagent/descriptor.agentModel` | `request/header.config` | `request/context` |
|------|------|----------------------------------|-------------------------|-------------------|
| A | `deepseek-official / deepseek-flash`，effort `high`（**与父路由相同**） | 同左 | 同左，`maxTokens 256000` | `deepseek-official / deepseek-flash` |
| B | 不传 | `opencode-go / deepseek-v4.1-flash` | 同左 | `opencode-go / deepseek-v4.1-flash` |

A 证明"显式升级到父同款"被放行；B 证明默认回落 pin。两者 descriptor 都等于最终路由，v4 一致性修复有效。

## 回滚

- 临时停用：插件页关掉该组合包，或在 profile patch 里给该行加 `disabled: true`；
- 彻底移除：插件页移除（或 `dsh plugin --profile desktop remove subagent-model-pin`）；
- 两种都需重启 DSH。YAML 是明文，记事本可改。

