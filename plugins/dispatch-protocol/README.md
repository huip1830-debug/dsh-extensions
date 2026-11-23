# dispatch-protocol

> 部署状态不在本文档硬编码：desktop 的实际版本以 profile 安装为准（`dsh plugin --profile desktop list` 或 `profiles/desktop/node_modules/dispatch-protocol/package.json`）；probe 为 `link:` → 直接吃工作区。发布顺序固定为：提交推送 → `dsh plugin --profile desktop update dispatch-protocol` → 重启 DSH → 台账记一笔。没走完不算发布。

## 使用场景（先读这个）

**给谁用**：用 DSH 开发自己业务项目的团队。它解决的是「多代理并行时谁写代码、谁验收、契约何时冻结」——不是给「维护本插件」用的；维护本仓库时它只是顺带生效的约束，别把维护体验当成产品价值。

**值得开的场景**：

| 场景 | 纪律帮在哪 |
|---|---|
| 多文件 / 跨端改动 | 白名单按文件互斥，并行批次不会互相覆盖 |
| 共享契约（schema / 类型 / 接口 / 路由） | 派发即冻结，契约在批运行期间只读 |
| 需要并行 | 只读子问题并行发，写批次按文件切 |
| 要交给别人接手 | spec、台账、交接文件都留在仓库里 |
| 核心链路（钱 / 权限 / 多租户） | 评审 + 一次性集成验证降低返工 |

**不值得开的场景**：单文件 ≤20 行的小改、机械重命名、改文档 / 配置、陌生代码库探查、紧急热修、一次性数据修复、原型。这些拿不到纪律的收益，只付流程成本。

**成本**：默认 `auto` 的提示段每请求约 0.5K token（估算；可随 KV 缓存复用）；`full` 正文约 3K token，真正的成本大头是 `full` 引起的派发 / 评审 / 提醒轮次（经验值 3–10 倍），小改动尤其明显；大任务 `full` 可能反而省（少返工）。

**四档一句话**：`off` 全静默（不注入、不拦、不提醒）；`auto`（默认）只注入一段提级提示，模型判断需求会不会从 `full` 的四个机制显著受益，会则请示用户，确认后用 `dispatch_upgrade_full` 升到 `full`；`shadow` 规则与提醒都在、写入只记不拦；`full` 完整纪律。**不要**给所有项目都写 `full`（见「常见误用」）。

**按项目适配**：项目根 `dispatch/protocol.json` 可写 `mode` / `rules` / `allowlist`，缺省字段回落 profile；`rules: "business"` 换成精简预设；`/dispatch init` 扫项目生成初始策略。字段与生成规则见 [项目策略文件与 business 预设](#项目策略文件与-business-预设)。

**质量边界**：纪律保**过程**（上下文隔离、契约冻结、白名单、评审范围、一次性验证）；**结果**靠项目自己的 CI（typecheck / test / lint）。评审只做语义核对，抓不到运行时装配错误与视觉问题——必须有 E2E 或真机验收（0.14.0 的 `inject` 缺失、选中态白底白字都是用户点到 / 看到才暴露）。

**常见误用**：

1. **给所有项目都写 `full`**：小改动也要走派发 / 评审 / 提醒，经验值 3–10 倍轮次成本；默认 `auto` 就是为了不付这笔钱，按项目或按任务升档。
2. **把本仓库的白名单默认值当通用值**：`dispatch/`、`docs/superpowers/specs/` 都是本仓库口径，业务项目要用 `/dispatch init` 或手写策略，否则误拦。
3. **以为评审能替代测试**：评审只看 diff 的语义，运行时装配和视觉问题不在它的判定面；没有 E2E / 真机验收，纪律全绿也可能不能用。
4. **把会受益的改动留在 `auto`**：`auto` 没有守卫兜底，模型漏问就等同无纪律；契约面、并行写、独立验收或失败归因会改变结果的改动，确认后应升 `full`，不要一路「先按 auto 做」。

## 它是什么

把「派发纪律」常驻注入 DSH：主控只做控制面、执行面一律派发，并在工具边界拦住越界写入——纪律不依赖模型记得住规则。

| 机制 | 位置 | 拦不拦 |
|---|---|---|
| 注入 | 系统提示词 section `## 派发纪律（DSH）`，主控与每个子代理的每次请求都带着（`lib/config.mjs#resolveConfig`） | 不拦 |
| 写入守卫 | `ctx.tools.guard`，工具调用边界（`plugin.mjs#apply`） | **拦**：拒绝这一次 `write`/`edit`，回合继续 |
| 检查点与观测 | 子代理 settle 登记 → 父代理回合收尾判定；根代理回合收尾写观测行（`plugin.mjs#registerReminders`、`plugin.mjs#drain`、`plugin.mjs#observeTurn`） | 不拦 |
| 文档校验 | `scripts/docs-check.mjs`，仓库根无参运行，只判语法 / 围栏 / 表格列数 / 相对链接 / 配置表键名 | 不拦 |
| 项目级开关 | 每个工具调用 / 回合收尾按会话 cwd 实时读标记文件（`lib/project.mjs#readProjectPolicy`） | 按项目分四档：`auto`（默认）只注入提级提示、`shadow` 只记不拦、`off` 全静默 |
| 升级工具 | `ctx.tools.register`，`dispatch_upgrade_full` 只在「根代理 + 当前 `auto`」可见（`plugin.mjs#registerUpgradeTool`） | 不拦：用户确认后把 `mode` 写成 `full`（单向，保留其它策略字段） |

收尾只剩完成检查点一个提醒（`agent/turn-stopping` 里一次收尾最多投一条 `steer`）；写入约束不在收尾，而在动作之前。0.17.0 起五个收尾状态闸门已删除——它们逐回合复述「刚发生了什么」，实测几乎不改变下一步动作，却每次多一次模型步进与一条消息。

## 注入内容

默认档是 `auto`：只注入 `AUTO_TEXT`（约 510 字）——中性陈述当前档位、说明 `full` 的四件事（契约冻结 / 执行面派发 / 独立评审 / 一次性集成）与代价，让模型判断「这个需求会不会显著受益」，给三类典型受益情形（契约面多调用方 / 多批次需评审 / 用户明确要求纪律）作正例锚点，并设证据门槛：请示只在能说出具体受益点时提出，说不出就直接做。确认后调用 `dispatch_upgrade_full`。**下面六条规则只在 `full` / `shadow` 注入**，渲染进 `## 派发纪律（DSH）` 小节：`order: 500`、`interpolate: false`（`{{…}}` 原样保留）。六条各一句主旨，细则以 `lib/config.mjs` 为准：

1. **主控只做控制面，不做执行面**——七类动作之外一律派发；用户显式要求主控亲做时，先写 `dispatch/override.json` 再动手。
2. **执行类派发必须自包含**——现状、白名单、唯一一条窄验证、预算、输出格式缺一不可，派发即冻结。
3. **验收与等待**——执行性验证只付一次：窄验证归子代理、集成命令归派发方，派发后等完成事件。
4. **评审只审变更集，不审仓库**——输入是本批白名单并集的 diff，不是工作区快照。
5. **提交权归派发方**——子代理不得 commit / push / reset / clean，除非派发中显式授权。
6. **并行只读，互斥并行写**——白名单按文件/模块互斥，契约在派发前定死，不得并发跑共享产物的全量构建。

收口段（`DEFAULT_FOOTER`）回答「谁来做、什么可以直接做、怎么判级」：产出物归属、交付通道按风险缩放、循环批与 `NEEDS_DECISION`、外部未知先派只读 spike、对称预算。

## 机制

### auto 档与升级工具

`auto` 是默认档：只给根代理注入 `AUTO_TEXT`，不注册守卫拦截、不投递检查点、不写观测行。模型判断需求会不会从 `full` 的四个机制显著受益，会则请示用户；用户确认后调用 `dispatch_upgrade_full`（`confirmed: true`），工具用 0.15 的原子合并写把 `mode` 改成 `full`，保留 `rules` / `allowlist` 等字段；成功后下一步按 full 执行。

- **可见性**：`ctx.tools.register(definition, { when })` 的 `when` 只在「根代理 + 当前 auto」为真；`off` / `shadow` / `full` 与子代理都看不到这个工具（`plugin.mjs#registerUpgradeTool`）。
- **确认门**：`confirmed: false` 直接抛错；`confirmed` 是模型自证，不是安全边界——真正的门是请示文本与用户回复。
- **单向**：只 `auto → full`；降档仍由用户 `/dispatch auto` 或点 dock 完成，模型不能在任务中途自行卸掉纪律。
- **失败面**：cwd 缺失、当前不是 auto、写盘失败都返回 `Error: …`，回合继续；提示段同时给出「点 full 按钮 / 输入 `/dispatch full`」的兜底。

### 写入守卫

主控用 `write`/`edit` 写控制面名单（`dispatch/`、`docs/superpowers/specs/`，`lib/write-policy.mjs#DEFAULT_ALLOWLIST`）之外的文件时，DSH 在工具边界拒绝**这一次**调用：模型收到 `Error: <reason>`，回合继续。纠正点因此从「回合收尾」前移到「动作之前」，零模型步进。

- **注册**：`ctx.effect(() => ctx.tools.guard(makeGuard(config)))`，`inject` 带 `'tools'`，插件卸载时随 disposer 一起移除；`writePolicy.enabled: false` 或宿主没有 `ctx.tools.guard` 时不注册（`plugin.mjs#inject`、`plugin.mjs#apply`）。
- **判定顺序**：①名单内 → 放行且**不写日志**（控制面写入是主控的合法动作，不制造噪音）；②`dispatch/override.json` 有效 → 放行，日志 `reason: 'override'`；③否则拒绝，`reason` 为 `no-override`/`stale`/`invalid`——`mode: enforce` 返回拒绝串，`shadow` 只记日志（`lib/write-policy.mjs#evaluateWritePolicy`、`plugin.mjs#makeGuard`）。
- **豁免**：没有 `agent`；子代理（`session.header.origin === 'subagent'`，执行面本来就该写）；工具不在 `writePolicy.tools`；参数里既无 `file_path` 也无 `path`（`plugin.mjs#makeGuard`）。**子代理放行是有意的**——派发要的正是它在 `src`/`tests`/`scripts` 里写。
- **路径口径**：`\` → `/`、去 `./`、折叠 `..`；相对路径相对 `session.cwd ?? header.cwd`，绝对路径先转 cwd 相对、cwd 外一律视为不在名单；名单大小写不敏感，带尾 `/` 按前缀匹配，无尾 `/` 按词边界（`lib/write-policy.mjs#normalizePath`、`lib/write-policy.mjs#toCwdRelative`、`lib/write-policy.mjs#isAllowedPath`）。
- **override 是唯一凭据**：默认 `<cwd>/dispatch/override.json`（`writePolicy.overridePath` 可改）；schema 是 `{"reason":"…","source":"…","createdAt":"…"}`，代码只校验 `reason` 非空，`source`/`createdAt` 不参与判定；有效 = JSON 可解析 + `reason` 非空 + **本会话写下**（`mtimeMs >= session.createdAt ?? header.createdAt`），新会话必须重写；取不到会话开始时间时跳过新鲜度判断（fail-open），日志记 `reason: 'override-unbounded'` 以区分（`lib/write-policy.mjs#readOverride`、`plugin.mjs#readSessionStart`）。
- **只拦 `write`/`edit` 的参数路径**：`pwsh` 里的 `Set-Content`/`Remove-Item` 不拦，只在观测口径里计为写入（`lib/tool-calls.mjs#DEFAULT_PWSH_SHELL_PATTERN`）。
- **fail-open**：守卫内部异常一律按放行处理，日志写失败也不影响调用（`plugin.mjs#makeGuard`）；拒绝串说清「拦了什么、不在哪份名单」，并给两条出路——派给执行批，或按用户明确授权先写 override 再重试（`lib/write-policy.mjs#renderDenyText`）。

### 完成检查点与回合观测

三处记录各写各的、互不回读：检查点提醒父代理验收，观测行记回合事实，决定日志记判定。

**完成检查点**（`plugin.mjs#registerReminders`）

- 子代理 `subagent/end` 且 `stopReason === 'completed'` 才登记「待验收」（每个子代理一次，失败/中止不登记）；判定挪到父代理的 `agent/turn-stopping`，此时父代理整回合的动作已在日志里。
- 判定：父代理已按汇报动过手 → 静默（`reason: 'handled'`）；子代理整个会话零写入 → 静默（`reason: 'read-only'`）；其余投一条 `steer`，同回合多个 pending 合并成波次消息（`checkpoint.waveText`，`{count}`/`{labels}`）（`plugin.mjs#drain`）。
- 「已验收」的判定：父代理在子代理报告可见之后已动过手 → 静默（`reason: 'handled'`）；报告可见点取最后一条——`send_message` 的 `agent/inbox/spliced`（文本含 `Agent {childId} sent a message`），或 `user/message` 且 `data.source.kind === 'subagent-settled'`、`data.source.senderSessionId === {childId}`；没有可见性证据时保守投递（`plugin.mjs#parentAlreadyHandled`）。
- 只读判定用 `callTouchesFile`：`write`/`edit` **尝试即算**，`pwsh` 命中变更动词也算；判定抛错按执行类处理（`plugin.mjs#ranReadOnly`、`lib/tool-calls.mjs#callTouchesFile`）。
- 父代理没有 hook 作用域时（如嵌套子代理作父）回退为 settle 时 `followup`，判定顺序不变，`turn` 记 `null`（`plugin.mjs#registerReminders`）。

**回合观测行**（`plugin.mjs#observeTurn`）

- 根代理回合只要有写入、`pwsh` 变更或派发（任一非零），收尾时往 `<cwd>/dispatch/runs/<sessionId>.jsonl` 追加一行：`time`/`session`/`turn`/`writes`/`files`/`shellWrites`/`failedWrites`/`delegations`；默认目录 `dispatch/runs`（`observation.dir`，`lib/config.mjs#resolveConfig`）。
- 同一 `(session, turn)` 只保留首行：`steer` 会让同一回合再跑一步，首行才是自然的回合末快照（`plugin.mjs#observeTurn`）。
- 口径：控制面路径的写入不计入；`write`/`edit` 以失败结果为准排除（没有结果照算，回合被打断时不能把写入抹掉）；`pwsh` 命中变更动词才算 `shellWrites`，`git commit` 不计（`lib/tool-calls.mjs#summarizeTurn`）。
- **观测行不参与判定**：没有任何机制回读它，写盘失败静默吞掉——观测不是门禁（`plugin.mjs#observeTurn`）。

**决定日志**（`lib/config.mjs#resolveConfig`、`plugin.mjs#recordDecision`）

- 键是顶层 `log`，默认 `%TEMP%\dispatch-protocol-decisions.jsonl`，`false` 时 checkpoint、写入守卫都不记；两者写同一文件（`lib/config.mjs#DEFAULT_LOG`）。
- 只记事实、便于事后分辨「没触发」和「触发后被静默」：checkpoint 每个子代理一行（含 `reason: 'handled'|'read-only'`）、写入守卫每次判定一行（控制面放行不写行）（`plugin.mjs#makeGuard`、`plugin.mjs#drain`）。

### 交接

模型失稳（连续空回合、`/compact` 之后丢了上下文）时不要在旧会话里硬撑：先写 `dispatch/state/<需求>.md`，再开新会话接力。模板保持最小：

```text
需求：<slug>
进行中：<批次 / 文件:行号>
下次开工：<一条命令或一次派发>
```

### 多会话

一个工作区同时开多个会话，机制只兜三件事：

- **台账按需求分文件**：`dispatch/state/<需求>.md` 与 `dispatch/ledger/<需求>.md`，两处同一个 slug；只写自己需求那份。
- **开工先看 `dispatch/state/`**：先看目录里已有哪些需求在进行，同一需求已有进行中的文件时先问用户是否接手（这一步是约定，守卫认不出文件属于谁）；遗留 `dispatch/state.md` 只读。
- **`dispatch/override.json` 仍是单文件**（已知限制）：它按 mtime 判本会话新鲜度，并行会话里 A 的直改豁免可被 B 复用；需要隔离时手动删除该文件再各自重写（`lib/write-policy.mjs#readOverride`）。

## 评审

评审是独立的一步，不是通读仓库。只审变更集、不审仓库，是因为一次跨切面改动的正确性挂在「这批 diff 是否满足这条需求」上，而仓库通读产不出可裁决的结论。

- **触发与节奏**：gated 需求——同一需求**合并判级**，任一批次命中并行写或契约面，整个需求按 gated 处理，不得按子代理切分绕过。**默认一个变更集一个评审包、终评一次**：全部实现批落地且跑过集成命令后再派，禁止每批一评——后批改动会让前批评审立即失效，等于白付一次上下文。唯一例外：被后续批次依赖的契约批（产物是后续批的只读输入）在后续批启动前做一次只读契约复核，范围仅白名单 + 契约面（它错了的返工倍数最高）。规模轴判为轻批的批次免独立评审：子代理跑窄命令，主控复跑 + diff 自查留证。
- **输入四项**：需求原文、冻结契约、本批**白名单并集**的 diff、派发方复跑的集成结果（退出码与输出全文）。评审对象是这份 diff，**不是工作区快照**——从 `git status` 或「看看仓库」起步的评审会把一次跨切面改动变成仓库审计，报告再也挂不回任何一个批次。
- **不做的部分**：不逐文件通读未改动文件；默认只回答「这批改动是否满足这条需求」。
- **全仓不变量核查（单列）**：只看 diff 必然漏掉跨切面的遗漏点。当需求本身是全局不变量（「彻底统一」「不得残留」「所有调用方」这类）时另开一栏：给定检索词与目录（不是「到处看看」），输出命中点排除表，每个命中点标注满足或遗漏，**用户可见的遗漏判 FAIL**。证据：KOL 会话 `session-37256e00` 的评审按检索词全仓 grep，抓到 3 处白名单外、用户可见的漏点。
- **切片上限**：一个评审包超过 **20 个文件或 3 个契约面**才按契约面切片；单个契约面自身超 20 个文件时按读写路径再切并在报告里写明切法；跨切片一致性包只在切片确实独立（接口/类型/别名表/路由边界）时开，不得重复已报缺陷。
- **方法**：只做 read/grep 语义核对——纯读取的 `git diff`、`Select-String`、程序化比对都算；禁止重跑构建/测试/集成命令。
- **不采信自述**：实现者的说明、以及它自己的测试通过，都不算证据（实现与测试可能共享同一个盲点）。
- **输出**：逐条 `PASS|FAIL + 文件:行号`；全 PASS 须说明每条例子的验证方式。可以给建议，但不得改文件；建议归派发方，裁决也归派发方。评审后任何改动（含派发方自修）只重开被判 FAIL 的那一片及其直接影响面，不重开全包。（纯文档级修复：docs-check 绿 + 断言表，见规则 1/4）

## 只读评审 preset（0.21.0 / 0.22.0）

评审/复审/勘察的「只读」与「低成本路由」有三层独立保障，任一层失效其余仍在：

- **工具面（0.21.0）**：`cordis.patch.yml` 声明 agent preset `dispatch-readonly`——`dsh-tool-fs` 的 `write`/`edit` 关闭、不挂 `tool-pwsh`/`tool-bash`，只剩 read / readImage / grep / glob；同时注册 Host 全局委派工具 **`subagent_readonly`**（`provider: spawn` + `agentPreset: dispatch-readonly` + `modelSelection: false`）。派给它的子代理组合里根本没有写工具与 shell：评审想写文件或重跑构建时得到的是「工具不存在」，而不是沙箱拒绝。
- **路由面（0.22.0）**：`tool-subagent-readonly` 带 `agentOptions`（默认 `opencode-go` / `deepseek-v4.1-flash` / `high`），子代理路由在**创建时**钉死——`subagent/descriptor`、首请求、冷恢复三者一致，adapter 预检在委派调用时就报错，且不经会话白名单（白名单只约束模型在调用时显式选择的路由）。`modelSelection: false` 表示模型不能在该工具上改路由。要换钉死的路由：profile patch 按 id 整段覆盖 `tool-subagent-readonly`（config 整体替换，不深合并）。
- **沙箱面（0.22.0）**：`readonlySandbox` 机制按子会话的 preset 记录（`header.agentPreset` / `agent-preset/selected` 事件，结构键）把命中角色的沙箱收窄为 `read-only`——`agent/created` 时追加一条 `sandbox/mode` 事件（与 model-pin 同款 last-wins 写路径，幂等共存、监听顺序无关）。0.21.0 时这一面靠 model-pin 按 label 字面前缀收窄（G8/P1 两起事故的根因）；现在 label 前缀只服务 spike。
- **谁必须走它**：评审、复审、勘察一律用 `subagent_readonly` 派发（规则 1/4 与 `business` 规则 4 已写死）。**spike 例外**：只读 spike 要真跑命令实测环境，不能用这个无 shell 的工具，仍走普通 `subagent`——它的沙箱收窄仍由 model-pin 角色表按 label 前缀提供（这是 label 约定剩下的唯一机制用途）。
- **派发方的职责**：评审组合没有 shell，读不到主控运行时之外的东西——本批白名单并集的 diff 与集成命令输出（退出码 + 输出全文）由派发方先落盘到 `dispatch/` 再交评审读取（规则 4 已写死）。
- **成本**：该工具常驻所有会话（约数百 token/请求），是本版显式接受的取舍；动态注册（方案 B）因复刻官方委派语义风险高而放弃，工具名与文本日后可平滑演进。
- **安装后验证**：更新插件 → 完全退出并重启 DSH → 新会话派一个「只读评审：…」任务，确认 ① 子代理工具列表里没有 write / edit / pwsh；② `list_agents` 能看到它；③ 让它尝试写文件时得到「工具不存在」；④ 子会话日志里 `agent-preset/selected` = `dispatch-readonly`、`subagent/descriptor.agentModel` = 钉死路由、`sandbox/mode` 末态为 `read-only`；⑤ `node scripts/verify-install.mjs` 的 `readonly-tool` 项 PASS（两行 insert + `agentOptions` 在安装副本里）。
- **回滚**：插件页禁用 dispatch-protocol，或在 profile patch 里给 `preset-dispatch-readonly` / `tool-subagent-readonly` 两行写 `disabled: true`；单关沙箱机制用 `readonlySandbox: { enabled: false }`，单退路由钉就整段覆盖 `tool-subagent-readonly` 删掉 `agentOptions`；纪律文本随下一版退回。

## 项目级开关

同一个 profile 里不同项目用不同档位。**默认是 `auto`**：不建标记文件的项目只注入提级提示。项目根建 `dispatch/protocol.json` 可显式选档：`{"mode":"off"}`（或 `{"enabled":false}`）全静默、`{"mode":"auto"}` 与默认相同、`{"mode":"shadow"}` 照常提醒但写入只记不拦、`{"mode":"full"}`（或 `{"enabled":true}`）完整纪律。判定在每个工具调用与回合收尾时实时读文件（`lib/project.mjs#readProjectPolicy`），**不需要重启 DSH、不需要改 profile**；标记文件只按会话 cwd 查找（`lib/project.mjs#resolveMarkerFile`），同 profile 的其它项目不受影响。

| 档位 | 提示词段 | 写入守卫 | 完成检查点 | 观测行 |
|---|---|---|---|---|
| `auto`（无标记 / 坏文件 / `{"mode":"auto"}`） | 根代理注入 `AUTO_TEXT`，子代理为空（`plugin.mjs#apply`） | 根代理带路径的 `write`/`edit` 直接放行，不写日志（`plugin.mjs#makeGuard`） | 不投递，也不写 suppressed 行（`plugin.mjs#drain`） | 不写 jsonl、不建目录（`plugin.mjs#observeTurn`） |
| `off`（`{"mode":"off"}` 或 `{"enabled":false}`） | 不注入：`text` 返回 `''`，空段被宿主丢弃（`plugin.mjs#apply`） | 直接放行，每 `(会话, cwd)` 记一条 `kind:"project", reason:"project-off"`（`plugin.mjs#makeGuard`；子代理、名单外工具、无 `file_path`/`path` 的调用在 `off` 判定之前就已豁免，不记） | 不投递；每个 child 记一条 `kind:"checkpoint", reason:"project-off"`（`plugin.mjs#drain`） | 不写 jsonl、不建目录（`plugin.mjs#observeTurn`） |
| `shadow` | 注入全文 | 判定照跑，**永不返回拒绝串**；仅对本会被拦下的写入改记一条 `reason: 'project-shadow'`（`plugin.mjs#makeGuard`） | 照常提醒 | 照常写 |
| `full`（`{"mode":"full"}` 或 `{"enabled":true}`） | 注入全文 | 照常拦 | 照常提醒 | 照常写 |

判定口径（顺序固定，`lib/project.mjs#readProjectPolicy`）：

- 配置来自顶层 `projectSwitch`，默认 `{enabled:true, path:'dispatch/protocol.json'}`（`lib/project.mjs#DEFAULT_PROJECT_SWITCH`）；`enabled` 非布尔、`path` 空白在加载期报错（`lib/config.mjs#resolveConfig`）；`enabled`/`path` 写 `null` 视同未设置，回落默认值（其余配置段同款 `??` 口径）。
- `projectSwitch.enabled: false`、cwd 不是非空字符串、路径归一化失败 → `full`（无法判定项目，或用户显式关闭项目开关）。
- 标记文件不存在、`stat` 或读取失败 → `auto`（默认档；0.16.0 起坏文件不再等于 full）。
- JSON 解析失败、顶层不是 plain object（`[]`、`null`）→ `auto`（坏文件按「没配」处理，`lib/project.mjs#readPolicyDocument`）。
- 对象含 `mode` 且为 `off`/`auto`/`shadow`/`full` 之一 → 该值；否则 `enabled: false` → `off`、`enabled: true` → `full`、其余 → `auto`（`lib/project.mjs#modeOfDocument`）。
- 路径只相对会话 cwd：绝对路径落在 cwd 外或含 `..` 逃逸 → 归一化失败 → `full`（`lib/project.mjs#resolveMarkerFile`）。
- fail-open 是唯一口径：任何异常都回落、永不抛错（`lib/project.mjs#readProjectPolicy`），与写入守卫同口径（`plugin.mjs#makeGuard`）。方向分两类：判不出项目 → `full`，项目策略缺失/损坏 → `auto`。

判定按 `(归一化绝对路径, mtimeMs)` 记忆化：每次调用先 `stat` 取 mtime（实时读取），mtime 变了就是新缓存键；`stat` 或读取失败不缓存（`lib/project.mjs#readProjectPolicy`）。

日志（与 checkpoint、写入守卫共用同一份决定日志，`log: false` 时都不写，`lib/config.mjs#resolveConfig`）：

- 写入守卫的 `off` 记录每 `(会话, cwd)` 只有一条——键是 `session.id + '\0' + cwd`，去重集合在守卫闭包里（`plugin.mjs#makeGuard`）；`auto` 是默认档，不写这条。
- 检查点是「每个 child 一条」：沿用既有 `kind:"checkpoint"` + `reason` 字段，便于事后区分「没触发」与「触发后被静默」（`plugin.mjs#drain`）；`auto` 不写。
- 升级工具成功切换时记一条 `kind:"project", decision:"switched", reason:"user-confirmed"`（`plugin.mjs#registerUpgradeTool`）。

边界：

- `shadow` 只放弃拒绝串，不放弃判定与日志：越界写入记成 `decision:"allowed", reason:"project-shadow", mode:"shadow"`（`plugin.mjs#makeGuard`）。
- `off` 的项目不再背派发纪律：规则段整段消失（`plugin.mjs#apply`），该项目的模型不会被提醒、也不会被拦——漏派发只能靠用户自己发现。
- `auto` 的项目有提示、没有兜底：模型漏问就等同无纪律，这是默认档的已知取舍；跨文件或契约面改动应确认升 `full`。
- 标记文件只认会话 cwd（`lib/project.mjs#resolveMarkerFile`）：子代理继承父 cwd 时同档（提示词段按 context 的会话 cwd 求值，`plugin.mjs#apply`），取不到 cwd 时回落 `full`（`lib/project.mjs#readProjectPolicy`）。

## 项目策略文件与 business 预设

0.15.0 把 `dispatch/protocol.json` 从「一个 mode」扩成「项目自带纪律策略」：模式、主控白名单、规则预设都写在项目里，缺省字段回落到 profile 配置。0.17.0 删除五个收尾闸门后，只有闸门消费的 `controlPlanePatterns` / `verify.commands` / `contract.patterns` / `docs.patterns` 一并删除（文件里仍写着它们也只会被忽略）。文件仍是唯一真相：实时读、按 `(路径, mtime)` 记忆化，改完不需要重启（`lib/project.mjs#readProjectPolicy`）。

| 字段 | 缺省回落（profile 解析值） | 作用 |
|---|---|---|
| `mode` | `auto`（`enabled:false` → `off`，`enabled:true` → `full`） | 四档行为见「项目级开关」 |
| `rules` | 默认六条 + 默认收口（`config.rules` / `config.footer`） | `"plugin"` 同上；`"business"` 用精简预设（见下） |
| `allowlist` | `writePolicy.allowlist` | 主控可直接写的 cwd 相对前缀（`isAllowedPath` 口径） |

**字段级 fail-open**：某个字段类型或内容非法（空数组、含非字符串、`rules` 不是两个预设名之一）只丢该字段、回落 profile，其它字段与 `mode` 不受影响；整个文件坏 JSON 或缺失 → 全部回落（mode 取 `auto`，策略字段取 profile）。路径匹配沿用 `isAllowedPath`（cwd 锚定、大小写不敏感、尾 `/` 前缀），没有第二套归一化。

**`business` 预设**：`BUSINESS_RULES`（实测 900 字，六条骨架）+ `BUSINESS_FOOTER`（217 字）冻结在 `lib/config.mjs`；相对默认正文（规则正文 3216 字 + 5 个分隔换行、合计 3221；收口 615 ≈ 3.8K）约 3/10（含换行实测：business 正文 905/3221 ≈ 28%，含收口 1122/3836 ≈ 29%，不到三分之一）。删掉的是本仓库专属细节：docs-check、「断言 → 代码位置」表、`docs/superpowers/specs` 路径与 spec 冻结/评审切片细则；留下的是主控只做控制面、派发自包含、验收只付一次、评审只审变更集、提交权、并行读写判级。预设只换规则正文，不改白名单口径——业务项目仍要配 `allowlist`。

**`/dispatch init`**：扫项目并写出 `dispatch/protocol.json`（已存在则拒绝并提示先查看或删除，绝不覆盖）：

- 白名单：有 `docs/` → `["dispatch/", "docs/"]`，否则 `["dispatch/"]`。
- 预设：`package.json` 含 `dsh.bundle` / `dsh.client` → `plugin`，否则 `business`。
- 生成 `{ mode: "full", rules, allowlist }`；返回一行摘要（文件、preset、白名单项数）+「随时 `/dispatch off|auto|shadow|full` 切档」；生成的是可直接手改的示例 JSON。

**切换 mode 会保留其它字段**：`/dispatch off|auto|shadow|full` 只替换 `mode`（读现有 JSON 后原子写回），不会抹掉手写的 `rules` / `allowlist`；文件缺失或坏 JSON 时仍只写 `{"mode":"…"}`（0.14 行为）。

**与 0.13/0.14/0.15 兼容**：已有的 `{"mode":…}` 与 `{"enabled":…}` 语义不变——`off`/`shadow`/`full` 逐字节不变，`{"enabled":true}` 仍是 `full`。0.16.0 的唯一行为变化是**没有标记文件的项目从 `full` 变为 `auto`**；0.15 手写的、只有 `rules` / `allowlist` 等字段而没有 `mode` 的策略文件也按 `auto` 处理，需要全文纪律时补 `"mode":"full"`。

## 会话区控件与 /dispatch

0.14.0 起有两个新入口，读写的是同一个标记文件 `dispatch/protocol.json`：宿主命令 `/dispatch`（无参=查询，`/dispatch off|auto|shadow|full`=切换，`/dispatch init`=按项目检测生成策略文件）和输入框上方的常驻控件。**文件仍是唯一真相**：在默认 `projectSwitch.path` 下，控件、命令、手改文件三者等价，无标记文件时按 `auto` 兜底；自定义 `path` 时见下方读口径与「已知坑」。0.18.0 起，没有标记文件的项目在控件上显示「未激活」+「激活」按钮，点击激活执行 `/dispatch init`——不再把宿主的 `auto` 兜底显示成已生效的档位。

控件落点是 `conversation.input.dock`——输入框卡片正上方那一行（与 Todo、队列停靠同一片区域，本控件 `order: 10`）。已初始化时显示 `派发纪律` 和当前档位，右侧四个窄按钮 `off` / `auto` / `shadow` / `full`；窄屏（宽度不超过 640px）只留当前档位那一个按钮，点它之前先看档位、点其它档位需横向空间。**未初始化时**只显示 `派发纪律` / `未激活` / `激活` 按钮，不渲染四档按钮（详见下方「未激活与激活」）。会话 id 由 slot 的 session 作用域注入传进来，控件不依赖 owner props（`client.js#apply`、`dsh-client-ui-conversation` 的 `src/client/contract/slots.ts:301-305`）。0.14.x 的 `conversation.composer.dock` 不行：宿主只在 `variant === 'composer'` 时渲染它（`dsh-client-ui-conversation` 的 `src/client/skeleton/InputBar.tsx:596-599`），而新建的空白会话是 hero 态（同包 `src/client/skeleton/ConversationMainPanel.tsx:32-35`），整行控件因此不出现；`input.dock` 只要求会话与输入态就绪（同包 `src/client/skeleton/ConversationContent.tsx:86-87`、`:169`）。

**宽度对齐（0.17.1）**：slot outlet 是 `display:contents`，控件直接成为宿主 `.composerStack` 的 flex 子项，而这个栈占满整条会话列——宿主只居中输入框卡片本身（`max-width: var(--dsh-composer-card-max-width)`）。所以 dock 行必须自己带上同样的约束，否则会贴在会话列最左边、离卡片很远（0.17.0 的线上表现）。控件照抄宿主的两级几何：`.ddp-frame` ≈ `.GRgSLq_root`（`padding:0 var(--dsh-composer-side-clearance)` + 列向居中），`.ddp-dock` ≈ `.GRgSLq_card`（`width:100%` + `max-width:var(--dsh-composer-card-max-width)`），内容再按 `--dsh-composer-dock-inset`（8px）内缩，与卡片内工具栏行（8px 内边距）左对齐。**为什么不是一行 `calc(100% - 2×clearance)`**：嵌入形态（右侧栏子代理会话）的 `--dsh-composer-card-max-width` 本身是百分比（`min(calc(100% - 16px), 952px)`），单行 calc 会让它按「用它的元素」解析、每边差 8px；镜像两级容器后两边基准一致。效果是**窗口任意宽度、缩放、hero↔active 切换、右侧栏展开/收起都保持左右边缘重合**（0.17.1 用宿主真实 CSS 在 420–2200px × active/hero/embedded 21 组尺寸上实测：`dockLeft - cardLeft = 0`，内容内缩恒为 8px）。官方 `QueueDock` / `TodoPanel` 同样各自承担这段宽度 CSS。

**未激活与激活（0.18.0）**：未激活态只有三个元素——`派发纪律` 标签、`未激活` 值、`激活` 按钮；档位值与四档按钮都不渲染，因为项目还没建立策略文件。点击激活走 `remote.commands.execute(sessionId, '/dispatch init', [])`（与 `/` 菜单同一条 admission 路径），宿主按项目检测写出 `dispatch/protocol.json`（`mode:"full"` + preset + 白名单）；成功后控件重读，切成四档控件并将当前档显示为 `full`。请求期间按钮禁用、同一时刻只允许一次激活。失败时先把状态重读一次：并发下另一个会话已先建好文件（宿主返回「已存在…未覆盖」）按已初始化展示、不显示错误；仍为未初始化才在行内显示 `激活失败：<detail>`。`激活` 按钮在窄屏下不被 `max-width:640px` 的规则隐藏——它是未激活项目唯一的入口。

读口径（`client.js#readModeOf`、`client.js#dockStateOf`）：

- `remote.workspaceFiles.read(sessionId, 'dispatch/protocol.json', {})`，路径按**工作区根相对**解析。**控件拿不到 profile 配置**：这个路径是硬编码的默认值（`client.js#MARKER_PATH`），改了 `projectSwitch.path` 的项目控件仍读默认文件，会一直显示 `未激活`（点激活写的是自定义文件，控件读不到）——这类项目以 `/dispatch` 为准（见「已知坑」）。
- 错误码 `workspace-file/not-found` → 显示 `未激活` + 激活按钮（0.18.0；宿主仍按 `auto` 兜底，但项目没被初始化，控件不假装已启用）。
- 其它错误（越界、非文本、RPC 失败）→ 显示 `未知`，鼠标悬停的 title 给出错误码与消息；**不给**激活按钮（状态判不出来时不做写动作）。
- 文件能读到但 JSON 坏 → 仍算已初始化，档位与宿主读取器同口径回落 `auto`（`client.js#modeOfText`、`lib/project.mjs#readPolicyDocument`）。

写口径（首选面，`client.js#switchModeOf` / `client.js#activateProjectOf`）：点档位按钮走 `remote.commands.execute(sessionId, '/dispatch <mode>', [])`，点激活走同一条路径拼 `/dispatch init`，也就是 `/` 菜单敲命令走的那条 admission 路径（`dsh-client-ui-commands` 的 `src/client/service.ts:420-435`）；成功与否看返回的 `{ ok, value: { result } }`，`result.kind === 'error'` 时把宿主文案放进 `切换失败：…` / `激活失败：…` 提示。`remote`、`remote.commands`、`remote.workspaceFiles` 都写在 `inject` 里（`client.js#inject`）——它们是独立的子服务，少一个宿主就不加载本插件（控件整块不出现，而不是「显示未知/不支持」），所以注入是必需项，不做第二套写入；激活同样只调宿主命令，客户端从不直接写文件。

刷新时机（`client.js#DispatchDock`）：挂载时、会话切换时、`command/executed` 事件（浏览器本地确认，`service.ts:437-452`）、窗口 `focus` / `pageshow`、标签页 `visibilitychange` 各重读一次；组件卸载时移除全部监听。**页面刷新才拿得到新控件**：客户端产物没有热更，装完插件必须刷新；没跑 UI 的宿主（headless / SDK）不受影响，用 `/dispatch` 即可。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关：`false` 时完全不加载——不注入提示词、不注册写入守卫、不投递任何提醒 |
| `order` | `500` | 在系统提示词中的排序（必须有限数字） |
| `rules` | 六条默认 | 非空字符串数组，整体替换默认规则 |
| `footer` | 白名单与循环批（见「注入内容」收口段） | 追加在规则之后；`''` 关闭该段 |
| `checkpoint.enabled` | `true` | 子代理完成后是否给父代理发检查点 |
| `checkpoint.text` | 内置模板 | 覆盖检查点文案，支持 `{childId}` / `{label}` |
| `checkpoint.waveText` | 内置模板 | 波次聚合文案，支持 `{count}` / `{labels}` |
| `observation.enabled` | `true` | 是否写回合观测行（不是门禁） |
| `observation.dir` | `dispatch/runs` | 观测行目录（相对会话 cwd）；`false` 关闭 |
| `readonlySandbox.enabled` | `true` | 是否按子会话 preset 收窄沙箱（0.22.0，判定面见「只读评审 preset」） |
| `readonlySandbox.presets` | `['dispatch-readonly']` | 收窄哪些 preset 的子代理（非空字符串数组） |
| `readonlySandbox.mode` | `read-only` | 收窄目标档位（`read-only` / `workspace-write` / `danger-full-access`） |
| `log` | `%TEMP%\dispatch-protocol-decisions.jsonl` | checkpoint / 写入守卫 / 沙箱收窄共用的决定日志；`false` 都不记 |
| `projectSwitch.enabled` | `true` | 项目级开关总闸；`false` 时完全回到 0.12.3 行为（不读标记文件） |
| `projectSwitch.path` | `dispatch/protocol.json` | 项目标记文件，cwd 相对；命中判定见「项目级开关」一节 |
| `writePolicy.enabled` | `true` | 是否注册写入守卫（宿主没有 `ctx.tools.guard` 时静默跳过） |
| `writePolicy.mode` | `enforce` | `enforce` 拦截并返回拒绝串；`shadow` 只记日志、不拦 |
| `writePolicy.allowlist` | `['dispatch/','docs/superpowers/specs/']` | 主控可直接写的前缀（cwd 相对、大小写不敏感；尾 `/` 前缀匹配，无尾 `/` 词边界）；命中放行且不写日志 |
| `writePolicy.overridePath` | `dispatch/override.json` | 唯一豁免凭据（cwd 相对）；`reason` 非空且本会话写下才有效 |
| `writePolicy.tools` | `['write','edit']` | 守卫检查的工具名 |
| `writePolicy.delegationTools` | `['subagent','subagent_fork','workflow','subagent_readonly']` | 观测行复用的「已派发」工具名 |

表内 6 个 `writePolicy.*` 键就是 `resolveWritePolicy({})` 的叶子键；`enabled`/`order`/`rules`/`footer`/`checkpoint.*`/`observation.*`/`readonlySandbox.*`/`log`/`projectSwitch.*` 是 `resolveConfig` 的顶层键（`projectSwitch` 段默认值只在 `lib/project.mjs#DEFAULT_PROJECT_SWITCH`，校验在 `lib/config.mjs#resolveConfig`）。`gates` 段已在 0.17.0 移除：出现即加载期报错（迁移提示指向 `dispatch/runs` 与决定日志）。

非法配置在插件加载时直接报错，不会静默降级：`order` 非有限数字、`rules` 为空/非数组、`footer` 或 `checkpoint.*` 非字符串、`log` 既非非空路径也非 `false`、`observation.dir` 非非空字符串也非 `false`、`nudge`/`gates` 段出现、`writePolicy.mode` 不是 `enforce`/`shadow`、`writePolicy.allowlist`/`tools`/`delegationTools` 为空数组或含空白串、`writePolicy.overridePath` 空白、`projectSwitch` 非对象/`projectSwitch.enabled` 非布尔/`projectSwitch.path` 空白、`readonlySandbox` 非对象/`readonlySandbox.enabled` 非布尔/`readonlySandbox.presets` 为空数组或含空白串/`readonlySandbox.mode` 不在三值档位内。

## 文档校验

`scripts/docs-check.mjs` 是插件自带的确定性检查器：纯 Node、零依赖、只读（只有 `--self-test` 会写 `os.tmpdir()`，结束即删）。

- **调用**：`node plugins/dispatch-protocol/scripts/docs-check.mjs [files...]`；无参时从 cwd 扫「当前事实文档」——`AGENTS.md`、`README.md`、`docs/agent/**/*.md`、`plugins/*/README.md`、`docs/superpowers/specs/**/*.md`，跳过 `docs/reviews/`、`docs/superpowers/plans/`、`node_modules/`、`.git/`、`tmp/`；`--self-test` 跑内建 fixture 自检；`--root <dir>` 换扫描根。逐条输出 `PASS|FAIL <code> <file>:<line> <detail>`，末行 `docs-check: files=<N> fail=<M>`，`M>0` 时 exit 1。
- **DOC001** 括号平衡：全角/半角括号逐行平衡，跳过围栏内与行内代码。
- **DOC002** 围栏：三反引号代码围栏成对闭合（计数为偶数）。
- **DOC003** 表格列数：同一表格块内每行列数与块首行一致，忽略行内代码里的竖线与转义竖线。
- **DOC004** 相对链接：行内 `](path)` 形态的相对目标必须存在；跳过 `http(s)://`、`mailto:` 与 `#` 锚点，先按文档所在目录、再按 root 解析。
- **DOC005** 配置表键名：表格行首的 `writePolicy.*` 必须逐字命中输入键集合；集合由本脚本运行时从 `resolveWritePolicy({})` 的叶子键推导 → 6 个输入键（`scripts/docs-check.mjs#CONFIG_KEYS`）。0.17.0 起 `gates.*` 键已不存在：表格里再写它们一律 FAIL（旧键回归守卫）。
- **与断言表的分工**：机器只判语法、链接、表格与键名，判不了「这句话与它引用的那行代码是否一致」。所以文档批必须交「断言 → 代码位置」表：表空（纯措辞/格式/排版）→ docs-check 绿即收口；表非空 → 派 1 次有界只读评审（范围仅本批 md 的 diff + 表中代码锚点，输出逐条 `PASS|FAIL` + 未入表断言清单），修完只复跑 docs-check、不再复审；`AGENTS.md` 与 `docs/agent/*` 属注入面，断言表强制非空，表空收口不适用于注入面（规则 1 的「表空即收口」已写明该例外）。

## 验证

| 命令 | 期望 |
|---|---|
| `node plugins/dispatch-protocol/test.mjs` | 126 pass（`ℹ pass 126` / `ℹ fail 0`），exit 0 |
| `node plugins/dispatch-protocol/scripts/docs-check.mjs` | 无参扫仓库根，`docs-check: files=35 fail=0`，exit 0 |
| `node plugins/dispatch-protocol/scripts/check-anchors.mjs` | 无参扫仓库根 `README.md` 与 `plugins/*/README.md`，`anchors-check: files=4 fail=0`，exit 0 |
| `node plugins/dispatch-protocol/scripts/docs-check.mjs --self-test` | `self-test: pass=20 fail=0`，exit 0 |

前三条都是离线检查（测试、文档语法、锚点有效性）；最后一条只验 docs-check 自身（fixture 全建在 `os.tmpdir()`，不写仓库；`check-anchors.mjs --self-test` 同理）。真机口径另走临时 profile：`dsh plugin --profile probe add "link:<仓库根>/plugins/dispatch-protocol"`；无标记项目应看到 `auto` 提级提示，写 `{"mode":"full"}` 的项目再 headless 问系统提示词「派发纪律」里的六条，模型应逐条复述。

## 设计取舍

- **① 为什么是插件而不是 `AGENTS.md` 文件**：六条规则要每次请求都在场；`AGENTS.md` 得模型主动读、每个任务仓库还得各复制一份，读不读没有保证。插件把正文挂进系统提示词 section（`lib/config.mjs#resolveConfig`），与加载了哪些 skill 无关；代价是改正文会影响 KV 缓存前缀（见「已知坑」）。
- **② 为什么收尾只剩一个提醒（0.17.0）**：五个状态闸门在实现上是 fail-open 的（判定与投递异常全部吞掉），代价是它们逐回合复述「刚发生了什么」，每次多一次模型步进与一条消息，而证据本来就已经落在观测行与决定日志里。0.9.0 删 nudge 时已有同类证据（45/45 次投递发生在最终答复之后、0 次促成派发）；0.17.0 把同一个判断推广到五个闸门：可核对的收尾提醒整体删除，纠正点只保留「动作之前」（写入守卫）与「子代理完成后」（检查点）。
- **③ 为什么 `dispatch/override.json` 是唯一凭据**：散文里的「豁免」「直接做」不可审计、也判不出新旧；文件有 schema、mtime、会话起点三个可判字段，新会话必须重写（`lib/write-policy.mjs#readOverride`）。
- **④ 为什么文档分三层**：docs-check 判确定性失败（括号、围栏、表格、链接、键名），断言表判语义失败（这句话还有没有代码出处——机器判不了），有界评审只核表与 diff 锚点。三层各管一类失败，机器能判的不付评审钱；表空时 docs-check 绿即可收口。
- **⑤ 预算经验一：派发后不守着**：等待期主控的动作只有「结束回合等完成事件」；`Start-Sleep` / `list_agents` 轮询用完整模型步进换零信息（实测 31 次 sleep 合计 54.1 分钟，子代理状态并没有变）。预算过半时的一次主动检查是唯一例外。
- **⑥ 预算经验二：预算对称、触顶即停**：子代理单批 15 分钟 / 30 次编辑，主控单回合 15 分钟 / 20 步；过半报一句进度，超预算先报阻塞点再停，不得自行续期——续期由派发方给，量不够按场景切片。

## 版本历史

| 版本 | 要点 |
|---|---|
| `0.9.0` | 删除漏派发 nudge，改为工具边界写入守卫：`ctx.tools.guard` 拦截根代理名单外的 `write`/`edit`，`dispatch/override.json` 成为唯一豁免凭据（每会话有效）；配置 `nudge.*` → `log` + `writePolicy.*`，`nudge` 段出现即加载期报错；顶层 `enabled` 改为总开关。 |
| `0.9.1` | 台账按需求分文件：`dispatch/state/<需求>.md` + `dispatch/ledger/<需求>.md`；`DEFAULT_CONTROL_PLANE_PATTERNS` 增加 `dispatch/state/`；HandoffGate 文案与「交接」模板改新路径；新增「多会话」。 |
| `0.12.0` | 文档收口：新增 `scripts/docs-check.mjs`（DOC001–DOC005 + `--self-test`）；配置键集合改为运行时从解析器推导（26 个输入键，4 个镜像/编译字段排除）；`gates.review.textDocOnly` 删除、闸门收成一句 `{action}`；控制面判定改为 `classifyPath`（cwd 锚定 + 段级前缀，`src/**/dispatch/**` 不再豁免）；规则 1/4 改为「断言表 + 有界评审」。中间版本 0.10.0（文档/还原豁免、`{files}`/`{kind}` 点名）与 0.11.0（分类器收敛、文案收敛）的内容一并并入本版。 |
| `0.12.1` | 纪律正文补四处缺口：规则 1 允许仓库没有 `scripts/docs-check.mjs`（记一行台账、不新建脚本）；只回 `ok` 记「ok 视为接受推荐项」、不得写「用户已确认」；勘察结论须含「现存调用方」，无调用方的实现标「预防性实现」；规则 3 补多包仓库「按端各一条、每端只跑一次」。正文 3611 → 3716 字符，条款数仍为 6。 |
| `0.12.2` | 闸门噪声两修。D1：检查点去重收敛成一个原语「子代理报告对父代理可见之后，父代理有没有动过手」——settle 事件与 `send_message` 两条上报路径都认，不再只认 inbox 标记。D2（第三次复审后的设计反转）：删除「解析 PowerShell 求写入目标」的多目标解析器（`readShellWriteTargets`、动词/开关表、逗号合并、残段复检全部删除，无并列实现），改为封闭形状豁免——`controlPlaneOnlyShellWrite` 只在整条命令每段都能构造性证明是记账写入（形状 A/B/C：`Add-Content`/`Set-Content`/`Out-File`/`Clear-Content` 具名路径、`New-Item` 建目录/文件、`git diff > <路径>`）且路径唯一、全在控制面时返回 true，其余一律 false → 脏 → `<shell>`（未知=代码）；`gates.mjs` 的脏路径随之退回单路径（`write`/`edit` 取参数路径，`pwsh` 与取不到路径一律 `<shell>`），`{files}` 里的 shell 条目重新显示为 `<shell>`。代价是偶尔多跑一次集成命令，收益是漏验方向不可能静默。 |
| `0.12.3` | 规则 1「表空即收口」补注入面例外：`AGENTS.md` 与 `docs/agent/*` 不得空表收口——此前规则 1 的空表收口吞掉了规则 4 的「注入面断言表强制非空」，注入面文档可凭一句无验证的「本批无机制断言」零评审收口。规则 1 正文 1259 → 1306 字符，条款数仍为 6。 |
| `0.13.0` | 项目级开关：新增顶层 `projectSwitch`（默认 `{enabled:true, path:'dispatch/protocol.json'}`），按会话 cwd 读标记文件分三档——`full` 行为不变、`shadow` 规则与提醒照旧但写入只记不拦、`off` 规则段/写入守卫/检查点/五闸门/观测行全部静默（判定与 fail-open 见 `lib/project.mjs#readProjectMode`）。实时读文件、按 `(路径, mtime)` 记忆化，每个 `off` 项目留一条 `kind:"project"` 决定日志。无标记文件时与 `0.12.3` 逐字节一致：规则正文、`gates.*`/`writePolicy.*` 默认值与校验全未改，配置段只是新增。 |
| `0.14.0` | 会话区控件 + `/dispatch` 命令：宿主命令 `/dispatch [off\|shadow\|full]`（无参查询，写标记文件走 `writeProjectMode` 的原子写）；浏览器半区新增 `client.js`，在 `conversation.composer.dock` 显示当前档位与三态按钮，读走 `remote.workspaceFiles.read`、写走 `remote.commands.execute`（与 `/` 菜单同一条 admission 路径），`command/executed` / 窗口 focus / 会话切换后重读。`package.json` 加 `dsh.client`（`platform: 'web'` + inject 清单）与 `./client` 导出，`locale/zh.json` / `locale/en.json` 加 `ui` 词条。宿主行为零变化：无 client 运行时、`enabled:false`、无 `commands` 服务都照旧。 |
| `0.14.1` | 客户端注入缺陷修复：`client.js` 此前未声明 Remote 命名空间注入，点 dock 按钮报 `cannot get property "remote.commands" without inject`；现在 `inject` 含 `slots`/`locale`/`remote`/`remote.commands`/`remote.workspaceFiles`（与官方 Goal 控件同款），注入是前置条件——缺面时控件整块不出现；`test.mjs` 补回归断言（168 pass：`client.js` 的 `inject` 必须含这五个名字）。 |
| `0.14.2` | `package.json` 的 `files` 白名单补回 `test.mjs`——0.14.0 引入 `files` 时漏了它，导致 `scripts/verify-install.mjs` 的 `files` 项在每次发布后永久报「installed 缺失」（该脚本按仓库插件目录全部文件与 installed 逐项比对）。 |
| `0.14.3` | dock 选中态改用「标签主色 + 透明度」着色（`color-mix` 叠在 `--dsw-alias-label-primary` 上，14% / hover 20% + 1px `inset` 描边），原先用 `--dsw-alias-brand-primary`，该别名在浅/深主题下解析成白色底色、配 `--dsw-alias-label-inverse` 回落 `#fff` → 白底白字；不支持 `color-mix` 的浏览器回退到 `--dsw-alias-bg-layer-3`（缺失则 `--dsw-alias-interactive-bg-hover`）+ `--dsw-alias-label-primary`。 |
| `0.15.0` | 项目策略文件 + `business` 预设 + `/dispatch init`：`dispatch/protocol.json` 从 mode 扩成项目策略（`rules` / `allowlist` / `controlPlanePatterns` / `verify.commands` / `contract.patterns` / `docs.patterns`，字段级 fail-open——坏字段只丢自己；切换 mode 只替换 `mode`、保留其它字段）；`rules:"business"` 用 900 + 217 字的精简预设（默认正文 3.8K，约 3/10）；`/dispatch init` 按锁文件 / scripts / `docs/` / 契约面 / `dsh.bundle|client` 检测生成示例 JSON，已存在不覆盖；`/dispatch` 的 `input.hint` 与用法串加 `init`。无策略文件时行为与 0.14.3 一致；测试 183 条（相对 0.14.3 的 168 条新增 15 条：策略读取 / 回落 / business / init / 切档保留 / 命令形状）。 |
| `0.15.1` | dock 落点从 `conversation.composer.dock` 迁到 `conversation.input.dock`（`order: 10`）——原落点只在 composer 形态渲染，新建的空白会话是 hero 态，整行控件不显示；位置同时纠正为用户最初要的「输入框上方」；测试 184 条（新增 1 条落点回归）。 |
| `0.16.0` | `auto` 默认档 + 模型请示 + 单向升级工具：默认从 `full` 改为 `auto`（无标记 / 坏文件 / 无 `mode` 的策略文件都回落 `auto`；`{"enabled":true}` 仍是 `full`），`auto` 只给根代理注入 370 余字的提级提示（判断式：`full` 的四件事是否会显著受益，不列文件数门槛），不拦写入、不投递检查点/闸门、不写观测行；新增 `dispatch_upgrade_full` 工具，仅在「根代理 + 当前 auto」可见，用户确认后原子写回 `mode:"full"` 并保留其它策略字段；`/dispatch`、dock 与客户端读取器增加 `auto`。行为变化只有一条：没有标记的项目从 `full` 降到 `auto`；测试 188 条（新增 4 条：默认/静默/工具/客户端）。 |
| `0.17.0` | 删除五个收尾状态闸门（Wait / Verify / Contract / Review / Handoff）：`agent/turn-stopping` 不再逐回合 steer「本回合事实」，收尾只留完成检查点；`lib/gates.mjs` 整体删除，`plugin.mjs` 去掉闸门判定/状态/文案，`config.gates` 段与 `gates.*` 默认值删除（旧 profile 写 `gates` 段即加载期报错并给迁移提示）；项目策略文件只剩 `mode` / `rules` / `allowlist`（闸门专用的 `controlPlanePatterns` / `verify.commands` / `contract.patterns` / `docs.patterns` 一并删除，旧文件里出现也忽略）；`/dispatch init` 不再检测验证命令 / 契约面 / 文档口径；`tool-calls.mjs` 删除只服务闸门的 `controlPlaneOnlyShellWrite`，`DEFAULT_DOC_PATTERNS` 搬入 `tool-calls.mjs`；docs-check 的 DOC005 输入键集合只剩 6 个 `writePolicy.*`。写入守卫、完成检查点、观测行、项目开关、`auto` 提级与升级工具不变；测试 110 条（删除 80 条闸门用例，新增 2 条：`gates` 段加载期报错、收尾不 steer 而观测行照写）。 |
| `0.17.1` | dock 行对齐输入框卡片：slot outlet 是 `display:contents`，控件成为宿主 `.composerStack`（占满整条会话列）的 flex 子项，而宿主只居中卡片本身——0.17.0 的 `.ddp-dock` 没有宽度约束，整行贴在会话列最左边、离卡片很远，线上看到的「没和输入框对齐」即此。现在控件照抄宿主两级几何：`.ddp-frame` ≈ `.GRgSLq_root`（侧留白 + 居中）、`.ddp-dock` ≈ `.GRgSLq_card`（`width:100%` + 卡片宽度上限），内容按 `--dsh-composer-dock-inset` 内缩 8px 与卡片内工具栏行对齐；不用单行 calc 是因为嵌入形态的卡片上限是百分比、解析基准会差 8px。窗口任意宽度（含 680/920px 钳制区、hero 态、≤640px）与右侧栏展开/收起均实测边缘重合（21 组尺寸 `dockLeft - cardLeft = 0`）；测试 111 条（新增 1 条 CSS + 元素树契约回归）。 |
| `0.18.0` | 会话区控件新增未激活态与激活按钮：没有 `dispatch/protocol.json` 的项目显示 `派发纪律 未激活 [激活]`（不显示档位值与四档按钮），点击激活执行 `/dispatch init`（写 `mode:"full"` + preset + 白名单），成功重读后切成四档控件；激活失败先重读状态，并发的「已存在…未覆盖」按已初始化展示；已初始化项目与坏 JSON 行为不变；新增 `dockStateOf` 状态映射，locale 加 `inactive` / `activate` / `activateHint` / `activateFailed`；测试 115 条（新增 4 条：状态映射、未激活渲染、激活接线、失败/并发）。 |
| `0.19.0` | `AUTO_TEXT` 重框架（spec `2026-11-22-dispatch-auto-text-reframe.md`）：针对「auto 档几乎不升级」的诊断改提示词——删首句「本项目默认不启用派发纪律」（基线框成 off 的措辞），改为中性陈述当前档位与判断责任；删「哪怕文件不少、看起来很大——不要问」的最强负例，保留降调后的反向边界；补三类典型应请示的正面情形（契约面多调用方随动 / 拆多批次需独立评审 / 用户明确要求过程纪律），场景式而非关键词触发。四件事清单、判断问句、「每需求最多问一次」、工具名与兜底文案逐字保留；明确不加 auto 观测、不做文本关键词触发（用户裁决）。行为变化只有提示段正文；测试 116 条（新增 1 条：中性框架 / 正面示例 / 负例降调 / 保留要素）。 |
| `0.20.0` | `AUTO_TEXT` 证据门槛（spec `2026-11-22-dispatch-auto-evidence-gate.md`）：解决「判断在需求入口、手里无证据」——否掉流程式措辞（「先勘察再判断」会被模型当流程真执行，等于把 full 的阶段搬进 auto），改为门槛式：「请示只在你能说出具体受益点（哪个契约面、哪些调用方、几个批次）时提出；说不出就不要问，直接做」。配套删除首段「在收到需求时判断」的入口时点、「典型应该请示升级的情形」改「典型受益的情形」、删被门槛句涵盖的「反过来…直接做、不必问」。中途再请示仍走已有的「被拒后除非范围实质扩大」许可条款，措辞不动。行为变化只有提示段正文；测试 117 条（0.19.0 用例断言适配 + 新增 1 条：门槛存在 / 无流程措辞 / 入口时点删除 / 保留要素）。 |
| `0.21.0` | 只读评审机制面（spec `2026-11-23-dispatch-readonly-preset-design.md`）：`cordis.patch.yml` 新增两行 insert——agent preset `dispatch-readonly`（`dsh-tool-fs` 关 `write`/`edit`、不挂 `tool-pwsh`/`tool-bash`，只留 read/grep/glob）与 Host 全局委派工具 `tool-subagent-readonly`（`provider: spawn` + `toolName: subagent_readonly` + `agentPreset: dispatch-readonly` + `modelSelection: false`）。纪律文本把评审/复审/勘察绑定到该工具（规则 1/4、footer、`business` 规则 4），footer 注明 spike 例外（要跑命令实测，仍走普通 `subagent`）；`writePolicy.delegationTools` 默认值追加 `subagent_readonly`；`verify-install.mjs` 新增 `readonly-tool` 检查项。工具面（该组合无写工具、无 shell）与沙箱面（model-pin 按 label 前缀只读）构成双保险，`AUTO_TEXT` / `BUSINESS_FOOTER` 不变；全文增量 197 字符；测试 120 条（新增 3 条：patch 结构 / 文本绑定 / 字数增量）。 |
| `0.22.0` | 只读角色路由钉死 + 结构化沙箱（spec `2026-11-23-dispatch-readonly-route-sandbox.md`）：`tool-subagent-readonly` 增加 `agentOptions`（创建时钉死路由——descriptor / 首请求 / 冷恢复一致、adapter 预检、不经会话白名单）；新增 `readonlySandbox` 机制与配置段——`agent/created` 按子会话 preset 记录（`header.agentPreset` / `agent-preset/selected`，结构键）收窄沙箱为 `read-only`，替代 model-pin 对评审角色按 label 字面前缀的收窄（label 前缀只继续服务 spike，其沙箱仍由 model-pin 角色表提供）；规则 1 括号注与 footer 末两句随之改词（增量 22 字符），`BUSINESS_RULES` / `BUSINESS_FOOTER` / `AUTO_TEXT` 不变；`verify-install.mjs` 的 `readonly-tool` 检查补 `agentOptions` 三字段；测试 126 条（新增 6 条：配置段默认与校验 / 创建时收窄 / 事件回退 / 非命中跳过 / 幂等 / 根代理与开关豁免）。 |

0.10.0–0.11.0 为未发布的中间提交，内容并入 0.12.0。

迁移要点：

- 0.17.0：删除 profile 里的 `gates` 段（出现即加载期报错）；项目策略文件里的 `controlPlanePatterns` / `verify.commands` / `contract.patterns` / `docs.patterns` 可删，留着也不会生效。收尾提醒只剩完成检查点；回看回合事实改用 `dispatch/runs/*.jsonl` 与决定日志。
- 0.12.0：`gates.review.textDocOnly` 已删除，改用 `gates.review.text` 的 `{action}`（0.17.0 随闸门整体删除）。
- 规则 1/4 改为「断言表 + 有界评审 / 一个变更集一个包」——文档批不再靠「必要时派最小只读评审」。

## 已知坑

- **系统提示词改动会影响 KV 缓存前缀**：`order` 与正文变化会让后续请求失去前缀复用；规则固定后不要频繁改。
- **section 名重复会报错**：同一 profile 只能挂一个 `dispatch-protocol`；改配置用同 id 覆盖，不要重复插入。
- **守卫只覆盖一个面**：唯一的硬拦截是根代理 `write`/`edit` 的参数路径越界（见「机制 › 写入守卫」）；`pwsh` 里的 `Set-Content`/`Remove-Item`、`git` 操作与其它工具都不拦，只在观测口径里计为写入。
- **只识别 `file_path` / `path`**：参数里两个都没有时守卫直接放行，观测行按「未知路径」计数，不会当成控制面。
- **fail-open**：守卫内部异常按放行处理、日志写失败不影响调用；检查点判定与投递异常同样吞掉——所以「没提醒」不等于「没问题」，补救只能看决定日志。
- **override 是文件不是散文**：正文里写「豁免」「直接做」彻底无效；每会话有效、新会话必须重写；它仍是单文件，并行会话可互相复用；取不到会话开始时间时跳过新鲜度判断（日志 `override-unbounded`）。
- **记账在 TEMP 里**：`log` 默认落系统临时目录（`dispatch-protocol-decisions.jsonl`），不随仓库版本化；要长期留档就把路径指到固定位置，或写 `false` 全关。
- **观测计数与守卫是两套口径**：观测行按去重路径计、失败写入不计；检查点的只读判定按调用名、尝试即算（失败或被拒也算执行类）；守卫只看参数路径，不解析 `pwsh`。
- **控件只读默认标记路径**（0.14.0 已知限制）：浏览器控件拿不到 profile 的配置，读路径硬编码为 `dispatch/protocol.json`（`client.js#MARKER_PATH`），丢弃 `projectSwitch.path`。自定义了 `projectSwitch.path` 的项目**以 `/dispatch` 为准**——命令与写入守卫走同一份配置，仍是唯一真相；控件的显示会一直是 `未激活`（它读的默认文件不存在，0.18.0 起 `workspace-file/not-found` 按未初始化显示）；点激活会写自定义文件，但控件读不到，仍显示未激活。
- **auto 没有兜底**：默认档只注入提示，模型漏问就等同无纪律；需要「保证不裸奔」的项目显式写 `{"mode":"full"}`。
- **升级工具依赖宿主工具面**：`ctx.tools.register` 不存在时工具静默缺席，模型只能请用户点 dock 或输入 `/dispatch full`；提示段已写这条兜底。
- **无会话 / 会话未就绪时不显示控件**（0.15.1 的 `input.dock` 也如此）：该槽要求会话已打开且输入态就绪（`zone` 需 `session` 与 `inputState`）——还没选/建会话（`sessionId === undefined`）、会话打开中、打开失败时整行不渲染，属预期；会话打开且输入态就绪后显示（**空白新会话也算**），`/dispatch` 在这些状态下始终可用。
- **profile 插件不支持热加载**：装完必须重启 DSH；`dsh plugin update` 失败可能留下半残目录（被打开的子目录进入 delete-pending），只能重启 Windows 清——先完全退出 DSH 再 update。
- **钉死路由与兜底 pin 是两份事实**（0.22.0）：评审角色的路由在 `cordis.patch.yml` 的 `agentOptions`（跟随仓库发布），其余子代理的默认路由在 model-pin 的 pin（插件页可改）。换低成本模型时两处都要动（或在 profile 整段覆盖 `tool-subagent-readonly`）；两处不一致不会报错，只会让评审角色留在旧路由——换路由后跑一遍「只读评审 preset › 安装后验证」的第 ④ 项即可确认。
