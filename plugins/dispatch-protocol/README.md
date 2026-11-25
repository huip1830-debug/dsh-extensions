# dispatch-protocol

把「派发纪律」注入 DSH 系统提示词：`full` 档下主控只做控制面、执行面一律派发、契约先冻结，并在工具边界拦住越界写入；默认 `auto` 只注入一段提级提示，由用户确认后再升档。

## 适用场景

**值得开**：

| 场景 | 纪律帮在哪 |
|---|---|
| 多文件 / 跨端改动 | 白名单按文件互斥，并行批次不会互相覆盖 |
| 共享契约（schema / 类型 / 接口 / 路由） | 派发即冻结，契约在批运行期间只读 |
| 需要并行 | 只读子问题并行发，写批次按文件切 |
| 要交给别人接手 | spec、台账、交接文件都留在仓库里 |
| 核心链路（钱 / 权限 / 多租户） | 评审 + 一次性集成验证降低返工 |

**不值得开**：单文件 ≤20 行的小改、机械重命名、改文档 / 配置、陌生代码库探查、紧急热修、一次性数据修复、原型。这些拿不到纪律的收益，只付流程成本。

**成本**：`auto` 的提示段每请求约 0.5K token（可随 KV 缓存复用）；`full` 正文约 3K token，真正的成本大头是 `full` 引起的派发 / 评审 / 提醒轮次（经验值 3–10 倍），小改动尤其明显，大任务可能反而省（少返工）。

**质量边界**：纪律保**过程**（上下文隔离、契约冻结、白名单、评审范围、一次性验证）；**结果**靠项目自己的 CI（typecheck / test / lint）。评审只做语义核对，抓不到运行时装配错误与视觉问题——必须有 E2E 或真机验收。

**常见误用**：

1. 给所有项目都写 `full`：小改动也要走派发 / 评审，轮次成本 3–10 倍；默认 `auto` 就是为了按任务升档。
2. 把本仓库的白名单默认值当通用值：`dispatch/`、`docs/superpowers/specs/` 是本仓库口径，业务项目要 `/dispatch init` 或手写策略，否则误拦。
3. 以为评审能替代测试：评审只看 diff 的语义，运行时装配和视觉问题不在判定面。
4. 把会受益的改动留在 `auto`：`auto` 没有守卫兜底，模型漏问就等同无纪律。

## 安装与升级

包已声明 `dsh.bundle.patch`，插件页可直接安装。桌面版或 Web 侧栏 **插件** → **添加插件** → **安装第三方插件**，填：

```
https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/dispatch-protocol
```

CLI 等价（profile 名按实际安装位置替换）：

```powershell
dsh plugin --profile desktop add "https://github.com/huip1830-debug/dsh-extensions.git#path:/plugins/dispatch-protocol"
```

装完在插件页启用，**完全退出并重启 DSH**（profile 层插件不支持热加载），再**新开会话**。升级 = 同地址重装，或 `dsh plugin --profile desktop update dispatch-protocol`；卸载 = 插件页移除，或 `dsh plugin --profile desktop remove dispatch-protocol`。

改默认值：在 profile 的 `cordis.patch.yml` 用同 id 覆盖；`config` 整体替换，不深合并，手写时抄全字段。

## 四档与项目策略

| 档位 | 提示词段 | 写入守卫 | 完成检查点 | 观测行 |
|---|---|---|---|---|
| `off` | 不注入 | 直接放行 | 不投递 | 不写 |
| `auto`（默认） | 根代理注入提级提示，子代理为空 | 放行，不写日志 | 不投递 | 不写 |
| `shadow` | 注入全文 | 判定照跑，只记不拦 | 照常 | 照常 |
| `full` | 注入全文 | 照常拦 | 照常 | 照常 |

**切档入口**（读写同一个标记文件 `dispatch/protocol.json`）：

- `/dispatch`：无参查询；`/dispatch off|auto|shadow|full` 切换；`/dispatch init` 按项目检测生成策略文件。
- 输入框上方的 **派发纪律** 控件：已初始化显示四档按钮；没有标记文件的项目显示「未激活 + 激活」，激活即执行 `/dispatch init`。激活失败会先重读状态：并发下别的会话已先建好文件就按已初始化展示，仍为未初始化才在行内显示错误。
- 手改文件：与命令、控件等价。判定在每个工具调用与回合收尾时实时读文件，**不需要重启 DSH**，只按会话 cwd 查找。

**auto 与升级工具**：`dispatch_upgrade_full` 只在「根代理 + 当前 `auto`」可见（`off` / `shadow` / `full` 与子代理都看不到）。`confirmed: false` 直接抛错；`confirmed` 是模型自证，不是安全边界——真正的门是请示文本与用户回复。工具只做 `auto → full` 单向升级，降档仍由用户 `/dispatch auto` 或点控件完成。cwd 缺失、当前不是 auto、写盘失败都返回 `Error: …`，回合继续；提示段同时给出「点 full 按钮 / 输入 `/dispatch full`」的兜底。

**项目策略文件**的字段：

| 字段 | 缺省回落 | 作用 |
|---|---|---|
| `mode` | `auto` | 四档；`enabled:false` 等价 `off`，`enabled:true` 等价 `full` |
| `rules` | 默认六条 + 默认收口 | `"plugin"` 同上；`"business"` 用约 1.1K 的精简预设 |
| `allowlist` | `writePolicy.allowlist` | 主控可直接写的 cwd 相对前缀 |

字段级 fail-open：某字段非法只丢该字段、回落 profile；整个文件坏 JSON 或缺失则全部回落（`mode` 取 `auto`）。`/dispatch init` 的检测规则：有 `docs/` → 白名单 `["dispatch/", "docs/"]`，否则 `["dispatch/"]`；`package.json` 含 `dsh.bundle` / `dsh.client` → `plugin` 预设，否则 `business`；生成 `{ mode: "full", rules, allowlist }`，已存在则拒绝覆盖。切换 mode 只替换 `mode`，保留手写的 `rules` / `allowlist`。

兼容性：旧的 `{"mode":…}` 与 `{"enabled":…}` 语义不变；没有标记文件的项目按 `auto` 处理（不是 `full`），需要全文纪律时显式写 `{"mode":"full"}`。

## 注入内容

默认 `auto` 只注入 `AUTO_TEXT`（约 510 字）：中性陈述当前档位、说明 `full` 的四件事（契约冻结 / 执行面派发 / 独立评审 / 一次性集成）与代价，让模型判断需求会不会显著受益，并设证据门槛——**请示只在能说出具体受益点时提出，说不出就直接做**。用户确认后调用 `dispatch_upgrade_full`。

以下六条只在 `full` / `shadow` 注入，渲染进系统提示词 section `## 派发纪律（DSH）`（`order: 500`、`interpolate: false`）：

1. **主控只做控制面，不做执行面**——七类动作之外一律派发；用户显式要求主控亲做时，先写 `dispatch/override.json`。
2. **执行类派发必须自包含**——现状、白名单、唯一一条窄验证、预算、输出格式缺一不可，派发即冻结。
3. **验收与等待**——执行性验证只付一次：窄验证归子代理、集成命令归派发方，派发后等完成事件。
4. **评审只审变更集，不审仓库**——输入是本批白名单并集的 diff，不是工作区快照。
5. **提交权归派发方**——子代理不得 commit / push / reset / clean，除非派发中显式授权。
6. **并行只读，互斥并行写**——白名单按文件 / 模块互斥，契约在派发前定死，不得并发跑共享产物的全量构建。

收口段（`DEFAULT_FOOTER`）回答「谁来做、什么可以直接做、怎么判级」：产出物归属、交付通道按风险缩放、循环批与 `NEEDS_DECISION`、外部未知先派只读 spike、对称预算。规则细则以 `lib/config.mjs` 为准。

## 机制

| 机制 | 位置 | 拦不拦 |
|---|---|---|
| 注入 | 系统提示词 section，主控与每个子代理的每次请求都带着（`lib/config.mjs#resolveConfig`） | 不拦 |
| 写入守卫 | `ctx.tools.guard`，工具调用边界（`plugin.mjs#makeGuard`） | **拦**：拒绝这一次 `write` / `edit`，回合继续 |
| 检查点与观测 | 子代理 settle 登记 → 父代理回合收尾判定；根代理收尾写观测行（`plugin.mjs#registerReminders`、`plugin.mjs#drain`、`plugin.mjs#observeTurn`） | 不拦 |
| 文档校验 | `scripts/docs-check.mjs`，只判语法 / 围栏 / 表格列数 / 相对链接 / 配置表键名 | 不拦 |
| 项目级开关 | 每个工具调用 / 回合收尾按会话 cwd 实时读标记文件（`lib/project.mjs#readProjectPolicy`） | 按项目分四档 |
| 升级工具 | `dispatch_upgrade_full`，只在「根代理 + 当前 `auto`」可见（`plugin.mjs#registerUpgradeTool`） | 不拦：用户确认后把 `mode` 写成 `full` |

收尾只剩完成检查点一个提醒；写入约束不在收尾，而在动作之前。五个收尾状态闸门已删除——它们逐回合复述「刚发生了什么」，实测几乎不改变下一步动作，却每次多一次模型步进与一条消息。

### 写入守卫

主控用 `write` / `edit` 写控制面名单（默认 `dispatch/`、`docs/superpowers/specs/`）之外的文件时，DSH 在工具边界拒绝**这一次**调用：模型收到 `Error: <reason>`，回合继续。纠正点因此从「回合收尾」前移到「动作之前」，零模型步进。

- **判定顺序**：① 名单内 → 放行且不写日志；② `dispatch/override.json` 有效 → 放行，日志 `reason: 'override'`；③ 否则拒绝，`reason` 为 `no-override` / `stale` / `invalid`；`mode: shadow` 只记日志（`lib/write-policy.mjs#evaluateWritePolicy`）。
- **豁免**：没有 `agent`；子代理（`session.header.origin === 'subagent'`）；工具不在 `writePolicy.tools`；参数里既无 `file_path` 也无 `path`。子代理放行是有意的——派发要的正是它在 `src` / `tests` / `scripts` 里写。
- **路径口径**：`\` → `/`、去 `./`、折叠 `..`；相对路径相对 `session.cwd ?? header.cwd`，绝对路径先转 cwd 相对，cwd 外一律视为不在名单；名单大小写不敏感，带尾 `/` 按前缀匹配，无尾 `/` 按词边界（`lib/write-policy.mjs#normalizePath`、`lib/write-policy.mjs#isAllowedPath`）。
- **override 是唯一凭据**：默认 `<cwd>/dispatch/override.json`；schema 为 `{"reason":"…","source":"…","createdAt":"…"}`，代码只校验 `reason` 非空；有效 = JSON 可解析 + `reason` 非空 + **本会话写下**（`mtimeMs >= (session.createdAt ?? header.createdAt)`），新会话必须重写；取不到会话开始时间时跳过新鲜度判断（fail-open，日志 `override-unbounded`，`lib/write-policy.mjs#readOverride`）。
- **只拦 `write` / `edit` 的参数路径**：`pwsh` 里的 `Set-Content` / `Remove-Item` 不拦，只在观测口径里计为写入。
- **fail-open**：守卫内部异常一律按放行处理，日志写失败也不影响调用；拒绝串说清「拦了什么、不在哪份名单」，并给两条出路——派给执行批，或按用户明确授权先写 override 再重试（`lib/write-policy.mjs#renderDenyText`）。

### 完成检查点与观测

三处记录各写各的、互不回读：检查点提醒父代理验收，观测行记回合事实，决定日志记判定。

**完成检查点**：子代理 `subagent/end` 且 `stopReason === 'completed'` 才登记「待验收」，每个子代理只登记一次，失败 / 中止不登记；判定挪到父代理的 `agent/turn-stopping`。父代理已按汇报动过手 → 静默（`handled`）；子代理整个会话零写入 → 静默（`read-only`）；其余投一条 `steer`，同回合多个 pending 合并成波次消息。父代理没有 hook 作用域时回退为 settle 时 `followup`，判定顺序不变。

**回合观测行**：根代理回合只要有写入、`pwsh` 变更或派发（任一非零），收尾时往 `<cwd>/dispatch/runs/<sessionId>.jsonl` 追加一行，含 `time` / `session` / `turn` / `writes` / `files` / `shellWrites` / `failedWrites` / `delegations`；同一 `(session, turn)` 只保留首行。控制面路径的写入不计入；`write` / `edit` 以失败结果为准排除，没有结果照算（回合被打断时不能把写入抹掉）；`pwsh` 命中变更动词才算 `shellWrites`，`git commit` 不计。观测行**不参与判定**，写盘失败静默吞掉（`plugin.mjs#observeTurn`）。

**决定日志**：键是顶层 `log`，默认 `%TEMP%\dispatch-protocol-decisions.jsonl`，`false` 时全部不记。checkpoint 每个子代理一行（含 `reason: 'handled' | 'read-only'`）、写入守卫每次判定一行（控制面放行不写）、项目开关与升级切换各记事实，便于事后分辨「没触发」与「触发后被静默」。

### 交接与多会话

模型失稳（连续空回合、`/compact` 之后丢了上下文）时不要在旧会话里硬撑：先写 `dispatch/state/<需求>.md`，再开新会话接力。模板保持最小：

```text
需求：<slug>
进行中：<批次 / 文件:行号>
下次开工：<一条命令或一次派发>
```

一个工作区同时开多个会话时，机制只兜三件事：

- **台账按需求分文件**：`dispatch/state/<需求>.md` 与 `dispatch/ledger/<需求>.md`，两处同一个 slug；只写自己需求那份。
- **开工先看 `dispatch/state/`**：同一需求已有进行中的文件时先问用户是否接手；遗留 `dispatch/state.md` 只读。
- **`dispatch/override.json` 仍是单文件**：它按 mtime 判本会话新鲜度，并行会话里 A 的直改豁免可被 B 复用；需要隔离时手动删除该文件再各自重写。

## 评审

评审是独立的一步，不是通读仓库。只审变更集，是因为一次跨切面改动的正确性挂在「这批 diff 是否满足这条需求」上，而仓库通读产不出可裁决的结论。

- **触发与节奏**：gated 需求同一需求合并判级，任一批次命中并行写或契约面就整体按 gated 处理，不得按子代理切分绕过。默认**一个变更集一个评审包、终评一次**：全部实现批落地且跑过集成命令后再派，禁止每批一评。唯一例外：被后续批次依赖的契约批，在后续批启动前做一次只读契约复核。规模轴判为轻批的批次免独立评审：子代理跑窄命令，主控复跑 + diff 自查留证。
- **输入四项**：需求原文、冻结契约、本批**白名单并集**的 diff、派发方复跑的集成结果（退出码与输出全文）。评审对象是这份 diff，**不是工作区快照**。
- **不做的部分**：不逐文件通读未改动文件；默认只回答「这批改动是否满足这条需求」。
- **全仓不变量核查**：需求本身是全局不变量（「彻底统一」「不得残留」「所有调用方」）时另开一栏：给定检索词与目录，输出命中点排除表，每个命中点标注满足或遗漏，**用户可见的遗漏判 FAIL**。
- **切片上限**：一个评审包超过 **20 个文件或 3 个契约面**才按契约面切片；跨切片一致性包只在切片确实独立时开。
- **方法**：只做 read / grep 语义核对——`git diff`、`Select-String`、程序化比对都算；禁止重跑构建 / 测试 / 集成命令。
- **不采信自述**：实现者的说明、以及它自己的测试通过，都不算证据。
- **输出**：逐条 `PASS|FAIL + 文件:行号`；全 PASS 须说明每条例子的验证方式。可以给建议，但不得改文件；裁决归派发方。改完只重开被判 FAIL 的那一片及其直接影响面。

### 只读评审 preset

评审 / 复审 / 勘察的「只读」与「低成本路由」有三层独立保障，任一层失效其余仍在：

- **工具面**：`cordis.patch.yml` 声明 agent preset `dispatch-readonly`——`dsh-tool-fs` 的 `write` / `edit` 关闭、不挂 `tool-pwsh` / `tool-bash`，只剩 read / readImage / grep / glob；同时注册 Host 全局委派工具 `subagent_readonly`（`provider: spawn` + `agentPreset: dispatch-readonly` + `modelSelection: false`）。评审想写文件或重跑构建时得到的是「工具不存在」，而不是沙箱拒绝。
- **路由面**：`tool-subagent-readonly` 带 `agentOptions`，子代理路由在**创建时**钉死——`subagent/descriptor`、首请求、冷恢复三者一致，adapter 预检在委派调用时就报错，且不经会话白名单。默认路由是 stock 自带的 `deepseek-official/deepseek-flash`，不 pin effort。换路由要在 profile 层按 id 整段覆盖 `tool-subagent-readonly`，并与 model-pin 的 roles 表对齐（交互与修法见「已知坑」）。
- **沙箱面**：`readonlySandbox` 机制按子会话的 preset 记录（`header.agentPreset` / `agent-preset/selected` 事件）把命中角色的沙箱收窄为 `read-only`——`agent/created` 时追加一条 `sandbox/mode` 事件，幂等共存、监听顺序无关。
- **谁必须走它**：评审、复审、勘察一律用 `subagent_readonly` 派发。**工具按产出物而非批次名选择**：要新建或修改任何文件的批次（含**评审修复批**）一律用普通 `subagent`——批次名含「评审/复审」不改变工具选择，拿不准时用 `subagent`（评审误走它只损失一层沙箱保险；修复批误走 `subagent_readonly` 会被无写工具的 preset 整批钉死）。**spike 例外**：只读 spike 要真跑命令实测环境，不能用这个无 shell 的工具，仍走普通 `subagent`，其沙箱收窄由 model-pin 的角色表按 label 前缀提供。
- **派发方职责**：评审组合没有 shell，读不到主控运行时之外的东西——本批 diff 与集成命令输出由派发方先落盘到 `dispatch/` 再交评审读取。
- **成本**：该工具常驻所有会话（约数百 token/请求），是本版显式接受的取舍。
- **安装后验证**：重启 DSH → 新会话派一个「只读评审：…」任务，确认 ① 子代理工具列表里没有 write / edit / pwsh；② `list_agents` 能看到它；③ 尝试写文件时得到「工具不存在」；④ `agent-preset/selected` = `dispatch-readonly`、`subagent/descriptor.agentModel` = 钉死路由、`sandbox/mode` 末态为 `read-only`；⑤ `verify-install.mjs` 的 `readonly-tool` 与 `route-alignment` 项 PASS。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关：`false` 时完全不加载——不注入提示词、不注册写入守卫、不投递任何提醒 |
| `order` | `500` | 在系统提示词中的排序（必须有限数字） |
| `rules` | 六条默认 | 非空字符串数组，整体替换默认规则 |
| `footer` | 白名单与循环批 | 追加在规则之后；`''` 关闭该段 |
| `checkpoint.enabled` | `true` | 子代理完成后是否给父代理发检查点 |
| `checkpoint.text` | 内置模板 | 覆盖检查点文案，支持 `{childId}` / `{label}` |
| `checkpoint.waveText` | 内置模板 | 波次聚合文案，支持 `{count}` / `{labels}` |
| `observation.enabled` | `true` | 是否写回合观测行（不是门禁） |
| `observation.dir` | `dispatch/runs` | 观测行目录（相对会话 cwd）；`false` 关闭 |
| `readonlySandbox.enabled` | `true` | 是否按子会话 preset 收窄沙箱 |
| `readonlySandbox.presets` | `['dispatch-readonly']` | 收窄哪些 preset 的子代理（非空字符串数组） |
| `readonlySandbox.mode` | `read-only` | 收窄目标档位（`read-only` / `workspace-write` / `danger-full-access`） |
| `log` | `%TEMP%\dispatch-protocol-decisions.jsonl` | checkpoint / 写入守卫 / 沙箱收窄共用的决定日志；`false` 都不记 |
| `projectSwitch.enabled` | `true` | 项目级开关总闸；`false` 时完全回到旧行为（不读标记文件） |
| `projectSwitch.path` | `dispatch/protocol.json` | 项目标记文件，cwd 相对 |
| `writePolicy.enabled` | `true` | 是否注册写入守卫（宿主没有 `ctx.tools.guard` 时静默跳过） |
| `writePolicy.mode` | `enforce` | `enforce` 拦截并返回拒绝串；`shadow` 只记日志、不拦 |
| `writePolicy.allowlist` | `['dispatch/','docs/superpowers/specs/']` | 主控可直接写的前缀（cwd 相对、大小写不敏感；尾 `/` 前缀匹配，无尾 `/` 词边界）；命中放行且不写日志 |
| `writePolicy.overridePath` | `dispatch/override.json` | 唯一豁免凭据（cwd 相对）；`reason` 非空且本会话写下才有效 |
| `writePolicy.tools` | `['write','edit']` | 守卫检查的工具名 |
| `writePolicy.delegationTools` | `['subagent','subagent_fork','workflow','subagent_readonly']` | 观测行复用的「已派发」工具名 |

非法配置在插件加载时直接报错，不会静默降级：`order` 非有限数字、`rules` 为空 / 非数组、`footer` 或 `checkpoint.*` 非字符串、`log` 既非非空路径也非 `false`、`observation.dir` 非非空字符串也非 `false`、`nudge` / `gates` 段出现、`writePolicy.mode` 不是 `enforce` / `shadow`、`writePolicy.allowlist` / `tools` / `delegationTools` 为空数组或含空白串、`writePolicy.overridePath` 空白、`projectSwitch` 非对象 / `projectSwitch.enabled` 非布尔 / `projectSwitch.path` 空白、`readonlySandbox` 非对象 / `readonlySandbox.enabled` 非布尔 / `readonlySandbox.presets` 为空数组或含空白串 / `readonlySandbox.mode` 不在三值档位内。`gates` 段已在旧版本移除：出现即加载期报错，迁移提示指向 `dispatch/runs` 与决定日志。

`writePolicy.*` 的键名由 `resolveWritePolicy({})` 的叶子键定义；docs-check 的 DOC005 逐字校验配置表行首键。

## 验证

| 命令 | 期望 |
|---|---|
| `node plugins/dispatch-protocol/test.mjs` | 132 pass / fail 0，exit 0 |
| `node plugins/dispatch-protocol/scripts/docs-check.mjs` | 无参扫仓库根，`fail=0`，exit 0 |
| `node plugins/dispatch-protocol/scripts/check-anchors.mjs` | 无参扫 `README.md` 与 `plugins/*/README.md`，`fail=0`，exit 0 |
| `node plugins/dispatch-protocol/scripts/docs-check.mjs --self-test` | `fail=0`，exit 0 |

`docs-check.mjs` 是插件自带的确定性检查器：纯 Node、零依赖、只读。无参时从 cwd 扫「当前事实文档」——`AGENTS.md`、`README.md`、`docs/agent/**`、`plugins/*/README.md`、`docs/superpowers/specs/**`；跳过 `docs/reviews/`、`docs/superpowers/plans/`、`node_modules/`、`.git/`、`tmp/`。检查项：

- **DOC001** 括号平衡；**DOC002** 三反引号围栏成对闭合；**DOC003** 同一表格块列数一致；**DOC004** 行内相对链接目标存在；**DOC005** 配置表行首的 `writePolicy.*` 必须逐字命中输入键集合。

机器判不了「这句话与它引用的代码是否一致」，所以文档批要交「断言 → 代码位置」表：表空（纯措辞 / 格式 / 排版）→ docs-check 绿即收口；表非空 → 派 1 次有界只读评审。`AGENTS.md` 与 `docs/agent/*` 属注入面，断言表强制非空。

真机口径另走临时 profile：`dsh plugin --profile <临时profile> add "link:<仓库根>/plugins/dispatch-protocol"`；无标记项目应看到 `auto` 提级提示，写 `{"mode":"full"}` 的项目再 headless 问系统提示词「派发纪律」里的六条，模型应逐条复述。

## 已知坑

- **系统提示词改动会影响 KV 缓存前缀**：`order` 与正文变化会让后续请求失去前缀复用；规则固定后不要频繁改。
- **section 名重复会报错**：同一 profile 只能挂一个 `dispatch-protocol`；改配置用同 id 覆盖，不要重复插入。
- **守卫只覆盖一个面**：唯一的硬拦截是根代理 `write` / `edit` 的参数路径越界；`pwsh` 里的 `Set-Content` / `Remove-Item`、`git` 操作与其它工具都不拦，只在观测口径里计为写入。
- **只识别 `file_path` / `path`**：参数里两个都没有时守卫直接放行，观测行按「未知路径」计数。
- **fail-open**：守卫内部异常按放行处理、日志写失败不影响调用；检查点判定与投递异常同样吞掉——「没提醒」不等于「没问题」，补救只能看决定日志。
- **override 是文件不是散文**：正文里写「豁免」「直接做」彻底无效；每会话有效、新会话必须重写；它仍是单文件，并行会话可互相复用；取不到会话开始时间时跳过新鲜度判断（日志 `override-unbounded`）。
- **记账在 TEMP 里**：`log` 默认落系统临时目录，不随仓库版本化；要长期留档就把路径指到固定位置，或写 `false` 全关。
- **观测计数与守卫是两套口径**：观测行按去重路径计、失败写入不计；检查点的只读判定按调用名、尝试即算（失败或被拒也算执行类）；守卫只看参数路径，不解析 `pwsh`。
- **控件只读默认标记路径**：浏览器控件拿不到 profile 的配置，读路径硬编码为 `dispatch/protocol.json`，丢弃 `projectSwitch.path`。自定义了该字段的项目**以 `/dispatch` 为准**；控件的显示会一直是「未激活」，点激活写的是自定义文件，控件仍读不到。
- **auto 没有兜底**：默认档只注入提示，模型漏问就等同无纪律；需要「保证不裸奔」的项目显式写 `{"mode":"full"}`。
- **升级工具依赖宿主工具面**：`ctx.tools.register` 不存在时工具静默缺席，模型只能请用户点 dock 或输入 `/dispatch full`。
- **无会话 / 会话未就绪时不显示控件**：该槽要求会话已打开且输入态就绪——还没选 / 建会话、会话打开中、打开失败时整行不渲染，属预期；空白新会话也算就绪；`/dispatch` 在这些状态下始终可用。
- **profile 插件不支持热加载**：装完必须重启 DSH；`dsh plugin update` 失败可能留下半残目录（被打开的子目录进入 delete-pending），只能重启 Windows 清——先完全退出 DSH 再 update。
- **钉死路由与 model-pin 角色表是两份事实**：评审/勘察角色的路由在 `tool-subagent-readonly` 的 `agentOptions`（创建时钉死），但 model-pin 的 roles 表按 label 前缀命中**不同路由**时仍会在 `agent/created` 时 select 覆盖钉路——`subagent/descriptor` 与运行路由不一致，且结果取决于 label 措辞（「评审…」前缀命中被覆盖，「…勘察」词尾不命中而保留钉路，2026-11-24 实证）。三选一修法：profile 按 id 整段覆盖 `tool-subagent-readonly` 的 `agentOptions` 为角色表同路由（config 整体替换，字段抄全）；把角色改成钉路路由；删掉只读角色（roles 只留 spike 沙箱职责）。换低成本模型时两处都要动；`verify-install.mjs` 的 `route-alignment` 项逐台机器核验一致性。

## 回滚

- 临时停用：插件页关掉组合包，或在 profile 的 `cordis.patch.yml` 给该行加 `disabled: true`；重启 DSH 后规则段、写入守卫、检查点全部消失。
- 只退只读评审：给 `preset-dispatch-readonly` / `tool-subagent-readonly` 两行加 `disabled: true`；单关沙箱收窄用 `readonlySandbox: { enabled: false }`。
- 退到旧版本：用旧提交的 Git 地址重新安装（本仓库不发 npm 包）；旧配置里的 `gates` 段要先删掉，否则加载期报错。
- 回滚只需重启 DSH，不改用户项目；`dispatch/` 下的台账与观测文件可保留。

## 版本历史

| 版本 | 要点 |
|---|---|
| `0.24.0` | 规则 4 与 business 预设补工具消歧：派发工具按产出物（要不要写文件）而非批次名选择，评审修复批一律走 `subagent`，拿不准时用 `subagent`——修复「评审修复」类批次被误派到 `subagent_readonly` 后整批无写工具的问题。 |
| `0.23.2` | `verify-install.mjs` 新增 `route-alignment` 检查：model-pin 只读角色表与 `agentOptions` 钉路不一致即 FAIL 并给修法；README 修正两处「两份事实」交互的准确语义（R4 覆盖条件与漂移后果）。 |
| `0.23.1` | 修复：只读评审 preset 给 `tool-fs-search` 补必填的 `sampleOverCapGlobResults: false`；此前缺配导致子代理启动时报 `invalid config`，评审里的 glob/grep 不可用。 |
| `0.23.0` | 只读评审默认路由换 stock 自带的 `deepseek-official/deepseek-flash`，不 pin effort；`verify-install.mjs` 增加 `whitelist-mode` 提示项。 |
| `0.22.0` | `subagent_readonly` 用 `agentOptions` 在创建时钉死路由；新增 `readonlySandbox`，按子会话 preset 收窄沙箱，替代 label 前缀判定。 |
| `0.21.0` | 新增只读评审 preset 与 `subagent_readonly` 工具：没有写工具、没有 shell；纪律把评审 / 复审 / 勘察绑定到该工具。 |
| `0.20.0` | `AUTO_TEXT` 增加证据门槛：能说出具体受益点才请示升级。 |
| `0.19.0` | `AUTO_TEXT` 重框架：中性陈述当前档位，补三类典型受益情形，降调负例。 |
| `0.18.0` | 会话区控件新增未激活态与「激活」按钮；激活即写 `mode:"full"` 的策略文件。 |
| `0.17.1` | dock 行按宿主两级几何对齐输入框卡片，任意窗口宽度左右边缘重合。 |
| `0.17.0` | 删除五个收尾状态闸门，收尾只留完成检查点；`gates` 配置段移除。 |
| `0.16.0` | 默认档从 `full` 改为 `auto`；新增 `dispatch_upgrade_full` 工具；无标记项目回落 `auto`。 |
| `0.15.x` | 项目策略文件从 mode 扩成 `mode` / `rules` / `allowlist`；新增 `business` 预设与 `/dispatch init`；dock 迁到 `input.dock`。 |
| `0.14.x` | 会话区控件 + `/dispatch`；修客户端 inject 缺失、`files` 漏 `test.mjs`、选中态白底白字。 |
| `0.13.0` | 项目级开关：按会话 cwd 读标记文件，分 `off` / `full` / `shadow` 三档。 |
| `0.12.x` | 新增 `docs-check.mjs`；文档收口改为「断言表 + 有界评审」；规则补缺口，检查点去重，注入面禁止空表收口。 |
| `0.9.1` | 台账按需求分文件；新增多会话约定与交接模板。 |
| `0.9.0` | 删除漏派发 nudge，改为工具边界写入守卫；`dispatch/override.json` 成为唯一豁免凭据。 |

0.10.0–0.11.0 为未发布的中间提交，内容并入 0.12.0。更早的 0.1–0.8 见 git 历史与 `docs/superpowers/specs/`。
