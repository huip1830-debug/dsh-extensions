# dispatch-protocol

> 部署状态不在本文档硬编码：desktop 的实际版本以 profile 安装为准（`dsh plugin --profile desktop list` 或 `profiles/desktop/node_modules/dispatch-protocol/package.json`）；probe 为 `link:` → 直接吃工作区。发布顺序固定为：提交推送 → `dsh plugin --profile desktop update dispatch-protocol` → 重启 DSH → 台账记一笔。没走完不算发布。

把「派发纪律」常驻注入 DSH。四个机制，都不拦截任何调用：

1. **系统提示词 section**：每次请求（主控与每个子代理）都会看到六条规则，且**按职责排序**（谁产出前提 → 子代理可碰什么、能花多久 → 谁付执行成本、怎么等 → 评审看什么 → 谁拥有提交权 → 什么能并行、怎么判级）。规则在插件里，不依赖模型是否加载了某个 skill。
2. **完成检查点**：子代理结束（`stopReason === 'completed'`）时只登记「待验收」，等父代理下一个回合收尾（`agent/turn-stopping`）才判定：已验收就静默丢弃，未验收才提醒读 diff、核对它报告的退出码，并在全批结束后跑一次集成命令。静态规则容易被跳过，时点提醒不会；**父代理已经按子代理汇报处理过的不再重复提醒**。
3. **漏派发提示**：一回合改了多个文件却一次没派发时，在本回合收尾前给主控一条提醒。规则只约束「怎么派发」，从来不含「必须派发」，所以「这回合漏了派发」只能观测，不能推断。
4. **状态闸门（0.6.0/0.7.0）**：等待期只读轮询（WaitGate）、「验证之后又改却准备 present/commit」（VerifyGate）、有子代理在跑时改写契约文件（ContractGate）、只读评审后改动工作区（ReviewGate）、空回合兜底（HandoffGate）各提醒一次；同样只读事件、不拦截调用，详见「状态闸门（0.6.0/0.7.0）」。

## 为什么不用 AGENTS.md

`AGENTS.md` 是跨工具共享的（Codex、OpenCode、Claude Code 都读），而派发纪律只对 DSH 的子代理机制成立。写进 AGENTS.md 会污染其他工具，并与 OpenCode 的 lead/impl/verify 流程冲突。

插件层是 DSH 专属、且**不依赖模型是否加载某个 skill**：即使主控没有加载 `subagent-driven-development`，这段规则仍在系统提示词里。

## 注入内容

默认六条规则 + 一段收口（`lib/config.mjs` 的 `DEFAULT_RULES` / `DEFAULT_FOOTER`）。顺序按「谁决定什么」排，不按加入时间排，这样以后改规则只会落在对应那一条上，不会习惯性追加第七条：

1. **先勘察，后派发**：派发前把「文件:行号 + 相关代码 + 结论 + 不确定项」写成现状文件并在派发中引用，同时给出可改文件白名单（逐条列名；以「全批结束后能用一条集成命令验收」为界）。勘察批次的唯一触发条件是主控现有上下文写不出这份现状——刚读过相关模块或属已知模式克隆时免派勘察，现状直接引用已读证据。
2. **执行类派发必须自包含**：至少含【现状】【允许修改/允许读取】【验证：唯一一条命令】【预算：墙钟与步数上限】【输出格式】。验证必须是覆盖本批改动的**窄命令**——全量构建/全量测试归派发方的集成命令；预算过半时发一句进度（改到哪、还差什么、有无契约疑点），超预算先报阻塞点再停、不得自行续期。子代理遇到清单外信息或现状与代码不符时停报 `NEEDS_CONTEXT`，不得自行扩大范围。**派发即冻结**：该批运行期间白名单外的契约面（`src`/schema/类型/路由）只读，必须改时先 `interrupt_agent` 停批、改完重派并注明「契约已变」。
3. **验收与等待**：验收分两层，执行性验证只归派发方——子代理只跑自己那部分的窄验证（负责归因），派发方在相关子代理全部结束后跑那条集成命令（负责集成状态）并留存退出码；宽窄混用会让两边都失真，同一条命令全系统只跑一次、不重复付费。**前提（0.5.4 起写进规则文本）**：集成命令必须覆盖各批窄验证断言点的并集；某批窄验证断言了集成命令覆盖不到的行为时，该批窄命令由派发方自己再跑——这是唯一的复跑例外。派发后结束回合等完成事件：预算过半时的一次主动检查是唯一例外，不要用一串 `Start-Sleep`/`list_agents` 轮询。未跑集成命令不得标记完成。
4. **评审只审变更集，不审仓库**：命中 gated 的批次另派只读评审子代理，输入只有需求原文、冻结契约、本批白名单并集的 diff、派发方复跑的集成结果；逐条给 `PASS|FAIL + 文件:行号`。范围、切片与方法是独立的一节，见「评审」。
5. **提交权归派发方**：子代理不得 commit / push / reset / clean，除非派发中显式授权；派发前先记录目标文件的既有未提交改动，不得覆盖，也不得计入本次成果。
6. **并行只读，互斥并行写**：只读子问题互不依赖且 ≥2 个时，在同一条消息里并行发出；实施也能并行，但白名单按文件/模块互斥、契约（schema/类型/路由/barrel/lockfile）在派发前定死、不得并发跑共享产物的全量构建。开工先按两轴判级并把拆批方案或一行不派发理由写进任务清单：风险轴同一需求合并判级，任一批次命中并行写或契约面即整个需求 gated；规模轴单批 <10 分钟或纯模式克隆判微批、免独立评审，单批预估超过 15 分钟或 30 次编辑就按场景切片（同文件/同构建产物仍串行），保证 10 分钟内出现第一个可验收切片。执行中改动面超出预估必须停手重判。

渲染为系统提示词里的 `## 派发纪律（DSH）` 小节，`order: 500`（在一方指引之后、persona suffix 之前），`interpolate: false`（`{{…}}` 原样保留）。

收口段回答「谁来做、什么可以直接做、想不清怎么办」：**成本**（主控贵而强、子代理便宜，机械活默认派出，但派发有固定成本——启动上下文 + 派发词 + 串行墙钟，批次工作量盖不住时不许拆碎）；**豁免与分流**（微批去向按序短路判定，判不准一律派出）；**拆批**（步骤穷举不出来就先派只读勘察、再按互斥文件切实现，能并行的同一条消息发出，契约先定死）；**缺 skill**（先写「每条 = 一个决策点或一批派发」的清单，不得据缺 skill 跳过判断）。没有这段时，「步骤一时穷举不出来」会被读成「那我自己做完」：`session-a80150dd` 走完 56 步、2.5 万输出 token，只换来 +26 行。

## 评审

评审是独立的一步，不是通读仓库。只审变更集、不审仓库，是因为一次跨切面改动的正确性挂在「这批 diff 是否满足这条需求」上，而仓库通读产不出可裁决的结论。

- **触发**：gated 批次——同一需求**合并判级**，任一批次命中并行写或契约面，整个需求按 gated 处理，不得按子代理切分绕过。规模轴判为微批的批次免独立评审：主控复跑 + diff 自查留证。
- **输入四项**：需求原文、冻结契约、本批**白名单并集**的 diff、派发方复跑的集成结果（退出码与输出全文）。评审对象是这份 diff，**不是工作区快照**——从 `git status` 或「看看仓库」起步的评审会把一次跨切面改动变成仓库审计，报告再也挂不回任何一个批次。
- **不做的部分**：不逐文件通读未改动文件；默认只回答「这批改动是否满足这条需求」。
- **全仓不变量核查（单列）**：只看 diff 必然漏掉跨切面的遗漏点。当需求本身是全局不变量（「彻底统一」「不得残留」「所有调用方」这类）时另开一栏：给定检索词与目录（不是「到处看看」），输出命中点排除表，每个命中点标注满足或遗漏，**用户可见的遗漏判 FAIL**。证据见「设计取舍」第 ④ 条。
- **切片上限**：一个评审包超过 **20 个文件或 3 个契约面**就按契约面切片；单个契约面自身超 20 个文件时按读写路径再切并在报告里写明切法；跨切片一致性另设一包，只核接口/类型/别名表/路由边界，不重复逐文件。
- **方法**：只做 read/grep 语义核对——纯读取的 `git diff`、`Select-String`、程序化比对都算；禁止重跑构建/测试/集成命令。
- **不采信自述**：实现者的说明、以及它自己的测试通过，都不算证据（实现与测试可能共享同一个盲点）。
- **输出**：逐条 `PASS|FAIL + 文件:行号`；全 PASS 须说明每条例子的验证方式。可以给建议，但不得改文件；建议归派发方，裁决也归派发方。评审后任何改动（含派发方自修）都要重开受影响切片的评审。

## 派发预算与等待

规则原先只约束「怎么派发」，不约束派发之后主控干什么。本版起第 2、3 条把「花多久、怎么等」也写进规则——等待期最容易失守的是主控自己：子代理在跑，主控用 `Start-Sleep` / `list_agents` 反复探，每探一次都付一次完整模型步进，子代理的状态却没有变。

- **【预算】字段**：执行类派发必须在【验证】之后给出【预算：墙钟与步数上限】。默认取规则 6 的数字——**15 分钟 / 30 次编辑**；任务本身就更大时按场景切片，不要靠放宽预算硬塞。
- **预算过半**：子代理发一条一句话进度（改到哪、还差什么、有无契约疑点）。这一句是派发方唯一的主动检查依据，不是汇报礼节。
- **超预算**：先报阻塞点再停，**不得自行续期**。派发方据此决定继续、停批还是切片——续期由派发方给，不由子代理自己延长。
- **契约冻结（派发即冻结）**：批在跑期间，白名单外的契约面（`src`/schema/类型/路由）只读。必须改时先 `interrupt_agent` 停批，改完重派并在派发词里注明「契约已变」；运行中直接改的代价见文末实测。
- **等待**：派发后结束回合等完成事件；预算过半时的一次主动检查是唯一例外。不要用一串 `Start-Sleep` / `list_agents` 轮询——轮询拿不到新状态，只是把回合拆成多次付费步进。
- **看门狗（仅软兜底）**：只跑一个批次、且没有别的在跑任务时，可用 `schedule` 设一条「预算 + 5 分钟」的提醒兜底；收到进度或完成事件就删掉。它不是主路径——多批并行时它反而会打断注意力。它只发一条提醒，不会 steer 回合，也不改变「等完成事件」的付费口径。

实测证据（`session-1433e747`）：子代理 30.8 分钟 / 192 步 / 57 次 `edit`；派发方在同一段里 31 次 `Start-Sleep` 合计 54.1 分钟（会话总长 106 分钟）。更贵的一次是契约冻结失守——子代理开工 8 分钟后（08:46:41）派发方改了 `GradingViewModel.cs`，子代理随后返工。

## 完成检查点

`agent/created` 记录每个子代理的父会话；`subagent/end` 在 `completed` 时**不再直接投递**，而是把「待验收」登记进 pending（每个子代理只登记一次，失败/中止不登记），投递时机见下。消息仍是 `[dispatch-protocol]` 一条，模板支持 `{childId}` 与 `{label}` 占位。

**投递时序（0.3.4 起）**：settle 与父代理的验收动作天然赛跑——子代理汇报后通常立刻 settle，此时父代理的验收回合还没动手，settle 时判定只会读到「尚未验收」，检查点因此必然误发。所以判定挪到父代理的回合收尾：

- 父代理有 hook 作用域：settle 时登记 pending，并给该父代理挂一个（每个父代理只挂一次）`agent/turn-stopping` 监听；回合收尾时逐个判定，判定完立即从 pending 移除，后续回合不会重复发。
- 已验收（汇报后整回合有 `tool/call`，且子代理汇报后没再写文件）→ **静默丢弃**：零消息、零额外步骤。
- 未验收 → `steer` 一条提醒（与 nudge 同机制：回合还开着，花一步）。
- 父代理没有 hook 作用域（如嵌套子代理作父等异常形态）→ **回退**为 settle 时立即 `followup`，判定顺序不变。

真机依据：`session-96dda908` 的父会话 seq——241 子代理汇报 splice → 246 settle（旧版在这里判定）→ 247 检查点误发 → 249 父代理才第一次 `tool/call`（读 diff）。判定比验收早了 3 个事件，正是 0.3.4 要消除的赛跑。离线用例覆盖：settle 后 0 条、回合收尾才补验收仍 0 条（时序赛跑回归）；判定后不重复发；同回合多个 pending 合并为一条波次消息（`checkpoint.waveText`，`{count}`/`{labels}` 占位），已验收的静默丢弃（决定日志仍每个子代理一行）。

**只读跳过（0.3.3 起）**：子代理**整个会话**没有任何一次文件变更调用时，检查点**不发**（0.3.4 起该判定同样挪到 `agent/turn-stopping` 执行）。勘察类子代理只读文件、跑命令、汇报结论，既没有 diff 可读，也没有退出码可核对，提醒只会空转。判定只看 `session.snapshotEvents()` 里 `tool/call`，**尝试即算**——写入被拒绝或抛错也算执行类，照旧发（判定抛错同样照旧发）。判定与 nudge 共用 `callTouchesFile`：`pwsh` 命中变更动词（`Remove-Item`/`Set-Content`/重定向等）也算写——样本 `session-82db5b7d` 的 W-5 纯用 `pwsh` 删文件、零 `write`/`edit`，被判只读而漏验收。真机依据：`session-03f065ca` 回合 3 的勘察子代理 `56f7d82d` 汇报「未修改任何文件」、主控 0 次工具调用，检查点仍然发出，主控只能在回合 4 补一句「只读任务、无命令可复跑」。

**去重（0.3.2 起）**：子代理通常先用 `send_message` 汇报，父代理会当场读 diff + 跑集成命令；等 `subagent/end` 再提醒同一件事，父代理只能回一个空回合。所以投递前先判定「父代理是否已经按这份汇报动过手」，满足下列全部条件就**不发**（条件与内部逻辑自 0.3.2 起不变；0.3.4 起判定时机随投递一起挪到 `agent/turn-stopping`，看的是父代理整个回合）：

1. 父代理日志里存在 `agent/inbox/spliced`，文本含 `Agent {childId} sent a message`（子代理**汇报过**）；
2. 那次汇报之后，父代理有任意一次 `tool/call`（**动过手**）；
3. 子代理在它最后一次 `send_message` 之后**没有**再 `write`/`edit`（汇报即终态）。

任一条不成立就照旧发；判定抛错、父代理没有日志、子代理没汇报过，也一律照旧发。**已知边界**：条件 2 不区分那次调用是不是针对这个子代理，属有意近似——宁可少提醒一次，也不要在已验收后重复打扰。

## 漏派发提示

六条规则只约束派发的**形式**，没有任何机制要求「必须派发」。实测就有会话全程不派发：`session-a80150dd`（2 回合 / 56 步 / 67 次工具调用 / 0 次派发）把 5 个 XAML 同性质改动判成「小改豁免」自己做了，全程没有任何提示。

本机制把「漏派发」变成可观测事实：

- **触发点**：`agent/turn-stopping`（serial，回合即将收尾、`turn/end` 提交之前）。这里 `steer` 会让本回合再跑一步，因此提醒只花一步，且**每回合最多一次**（按回合号去重，模型回一句「收到」后继续改文件也不会再触发）。
- **被打断回合补评估**：回合 N 收尾时，若 N−1 从未做过 nudge 评估且满足条件（≥2 去重文件、0 派发、正文无解释），补发一条；决定行带 `deferred: true`；补评估投递过的回合不再评自己（交给下一回合接手），刚挂上的会话不追溯 backlog。
- **计数来源**：该回合已提交的 `tool/call` 事件。事件自带 `turn`，所以不需要任何跨回合状态，恢复的会话算出的数字与实时一致。
- **失败不计数**：写调用的结局要看它的 `tool/result`——`isError === true` 的写入没有落盘，不计入 `writes`/`files`；没有 `callId` 或找不到结果的调用照旧计数（回合被打断时不能把写入抹掉）。
- **触发条件**：本回合**去重文件数 + shell 变更数** ≥ `nudge.threshold`（默认 2；同一文件多次编辑只算 1；nudge 档不把 `git commit` 算作 shell 变更）**且**派发调用（`subagent`/`subagent_fork`/`workflow`）为 0。
- **动作**：给主控发一条 `{fileCount}`/`{writes}`/`{files}`/`{turn}` 渲染的提醒（形如「写入 4 个文件（9 次）：…」；纯 shell 回合为「写入 0 个文件（0 次）：另有 2 条 shell 变更命令」），并往决定日志（`nudge.log`，默认 `%TEMP%\dispatch-protocol-decisions.jsonl`，一行一条 JSON）记一笔 `"kind":"nudge"` 的决定。
- **已解释则静默（0.3.6 起）**：本回合的 `assistant/message` 正文里若已出现 `nudge.justifiedPatterns` 中的任一词（默认 `豁免` / `不派发` / `未派发` / `无需派发` / `不需要派发` / `直接做` / `一条命令验完` / `一处改动的` / `镜像面`），**不发消息**，只往日志记一行 `"decision":"suppressed","reason":"justified"`。多文件写入是常态，模型常常在同一回合已经写清「为什么自己改」，再把问题复述一遍只会让会话窗口多一条噪音——实测 `session-a2e9f600` 的 turn 3：主控正文已写「4 个文件是同一处文案的 4 个镜像面…属于豁免」，提醒仍照样发出，用户只得到一条重复消息。判定只看 `assistant/message`（模型说的话），不看 `tool/result` 文本；只认本回合，别的回合解释过不算。
- **不适用于子代理**：子代理本身不能再派发，其写操作已经记在父回合里。

`write`/`edit` 按**结果**算——成功才计数，被策略拒绝或抛错的调用（`tool/result.isError === true`）不计；`pwsh` 命中变更正则才算 shell 变更；nudge 档不含 `git commit`，checkpoint 档仍含。计数按去重路径：同一文件改多次只算 1 个文件。

## 提醒让位（0.3.10 起）

两个提醒与五个状态闸门由同一个 `agent/turn-stopping` 处理器按固定顺序判定：**先 checkpoint，再按 Wait → Verify → Contract → Review → Handoff 顺序判定状态闸门，最后 nudge**，不依赖订阅顺序。同一回合号不同时发 checkpoint 与 nudge（deferred 补评估属于 N−1，可能在同一次回合收尾里与本回合 checkpoint 各发一条）；闸门投递后 nudge 让位；nudge 每回合至多一条，checkpoint 每个未验收子代理一条。

| 优先级 | 提醒 | 触发 | 让位/静默 |
|---|---|---|---|
| 1 | 完成检查点 | 子代理 `completed` + 父代理未验收 | 只读子代理；父代理已按汇报动过手 |
| 2 | WaitGate | 回合内状态查询 ≥ 阈值且无写入/派发/验证 | 本回合已投递 checkpoint；N−1 的 deferred nudge 已投递；每回合最多一条 |
| 3 | VerifyGate | present/commit 且有成功写入未验证、验证后又脏 | 纯只读 present（零写入）；上一条闸门已投递；每回合最多一条 |
| 4 | ContractGate | 有未结束子代理时改写契约文件 | 收尾时无活跃子代理；每回合最多一条 |
| 5 | ReviewGate | 只读评审完成后父代理又写工作区 | 同一轮评审已提醒（warned）；每个 completed 建立新基线；每回合最多一条 |
| 6 | HandoffGate | 连续空回合 ≥ `emptyTurns` | 回合有工具调用或非空文本；子代理回合；每回合最多一条 |
| 7 | 漏派发提示 | ≥2 去重文件 + 0 派发 + 正文未解释 | 本回合是验收回合；上一回合（turn-1）刚投递过检查点（一回合宽限）；闸门已投递 |

- **checkpoint 先占用回合**：本回合投递了 checkpoint 就不再评估 nudge。
- **验收回合静默**：checkpoint 判 `handled`（父代理已按汇报动过手）时，本回合 nudge 不发——这回合本来就在验收，不是漏派。
- **一回合宽限**：上一回合投递过 checkpoint，本回合 nudge 静默。已知代价：刚验收完确实漏派会少提醒一次，方向是「宁可少打扰」。
- **checkpoint 自身被跳过**（只读/已验收）时，nudge 仍按自身条件判定；`read-only` 不占用回合。

## 决定日志（0.3.10 起）

checkpoint 与 nudge 的每次判定都写一行，suppressed 也写——否则日志分不清「没触发」和「触发后被静默」；**状态闸门只记 delivered**（闸门不产生 suppressed 行）。默认 `%TEMP%\dispatch-protocol-decisions.jsonl`，`nudge.log` 键名保留：`false` 三个机制都不记，字符串则覆盖路径（checkpoint、nudge 与闸门写同一文件）。

```json
{"time":"...","session":"...","turn":36,"kind":"checkpoint|nudge|gate","decision":"delivered|suppressed","reason":"justified|handled|read-only|grace","writes":3,"files":[...],"delegations":0,"gate":"wait|verify|contract|review|handoff","observations":6,"changes":2,"lastVerify":"npm test","emptyTurns":1}
```

- 公共字段：`time`、`session`、`turn`、`kind`、`decision`；`reason` 只在 `suppressed` 时出现。
- checkpoint 行额外带 `childId`、`label`（每个 pending 子代理一行）；没有回合可用（无 hook 作用域的回退 `followup`）时 `turn` 为 `null`。
- nudge 行额外带 `writes`、`files`、`delegations`。补评估行额外带 `deferred: true`。
- 闸门行额外带 `gate`（`wait`/`verify`/`contract`/`review`/`handoff`）：wait 行带 `observations`（查询次数）；verify 行带 `changes`（脏改动数）与 `lastVerify`（命令或 `null`）；contract/review 行带 `files`（命中的去重路径）；handoff 行带 `emptyTurns`（连续空回合数）。
- **迁移**：旧 `%TEMP%\dispatch-protocol-nudge.jsonl` 不再写入，可以直接删除。

## 回合观测

根代理回合只要发生了写入或派发（写入次数、shell 变更次数、委派次数任一非零），收尾时往 `<cwd>/dispatch/runs/<sessionId>.jsonl` 追加一行，一行一条 JSON：

```json
{"time":"...","session":"...","turn":36,"writes":3,"files":["a.ts","b.ts"],"shellWrites":1,"failedWrites":0,"delegations":0}
```

- 一行写明：时间、回合号、文件集、写入次数、shell 变更次数、委派次数。
- **同一 `(session, turn)` 只保留首行**：`steer` 会让同一回合再跑一步、`agent/turn-stopping` 二次触发，此时丢弃 steer 之后那行快照——首行才是自然的回合末快照。
- **观测不是门禁**：不回读、不阻断任何事，写盘失败静默吞掉（目录不可写、磁盘满都不会让回合失败）。
- **开关**：`observation.enabled: false` 关闭；`observation.dir: false` 一并关闭；字符串则改目录（相对会话 cwd，默认 `dispatch/runs`）。

## 状态闸门（0.6.0/0.7.0）

五个事件闸门，都在 `agent/turn-stopping` 里判定：只对根代理生效、每回合最多一条、判定与投递异常一律吞掉、不阻断任何工具调用。判据只读 `session.snapshotEvents()`，不跑 git、不读磁盘。依据 `session-92f462d1`：同一会话 66 次状态查询轮询（每次查询都付一整步模型步进，子代理状态却没有变），最终 diff 在最后一次集成命令（事件 1112）之后又被写入，主控却已经准备 present/commit 收口；同一会话还在子代理运行期间改过契约文件、在只读评审之后继续改工作区，并出现过无工具调用、无文本的空回合。

| 闸门 | 触发 | 动作 | 决定日志 |
|---|---|---|---|
| WaitGate | 本回合 `gates.wait.tools` 调用数 ≥ `threshold`，且没有 write/edit、派发、`present`、`send_message`、`interrupt_agent`、`job_kill`，也没有命中 `gates.verify.commands` 的 `pwsh` 验证 | 一条「结束回合等完成事件」提醒，占位 `{count}` / `{tools}`（去重、最多 4 个） | `kind:"gate", gate:"wait", observations:<查询次数>` |
| VerifyGate | 本回合出现 `present` 或命中 `commitPattern` 的 `git commit/push`，且（有成功写入但从未成功验证 或 最近一次成功验证之后又脏） | 一条「先跑集成命令再收口」提醒，占位 `{changes}` / `{lastVerify}` | `kind:"gate", gate:"verify", changes:<脏改动数>, lastVerify:<命令或 null>` |
| ContractGate | 本回合 write/edit 的 `file_path`/`path` 命中 `gates.contract.patterns`，且收尾时仍有未结束子代理 | 一条「派发即冻结：先 interrupt 停批」提醒，占位 `{files}`（最多 3 个） | `kind:"gate", gate:"contract", files:[...]` |
| ReviewGate | 只读评审子代理 `completed` 之后，父代理又成功 write/edit | 一条「评审已失效：重开受影响切片」提醒，占位 `{files}`（本轮 dirty 的去重路径，最多 3 个） | `kind:"gate", gate:"review", files:[...]` |
| HandoffGate | 当前收尾回合为空（无本回合 tool/call、无本回合非空 text），且往前连续空回合数 ≥ `gates.handoff.emptyTurns` | 一条「先写 dispatch/state.md 再开新会话」提醒，占位 `{emptyTurns}`（可选） | `kind:"gate", gate:"handoff", emptyTurns:<n>` |

- **验证成功口径**：`pwsh` 命中 `gates.verify.commands`（大小写不敏感子串），有对应 `tool/result`、`isError !== true`、结果文本无 `exit code: N` 或 `N === 0`。失败的验证不算验证——一条红的 `npm test` 不能把闸门永久静音。
- **纯只读 present 不提醒**：整会话零写入、也从未验证时没有 diff 可验（例如 present 一份报告/计划），VerifyGate 不触发（契约 §11-A）。
- **脏判定**：最近一次成功验证之后，存在成功的 write/edit，或命中 `DEFAULT_PWSH_NUDGE_SHELL_PATTERN` 的 pwsh（复用 nudge 档位，不计 `git commit`）。没有对应结果的调用按脏处理——宁可多提醒，也不要把被中断的写入抹掉。
- **ContractGate 只看收尾时刻**：`activeChildren` 在 `agent/created` 登记、`subagent/end` 标 `ended`；子代理在写入之后、回合收尾之前结束的，本闸门不会触发（契约 §3 已知边界）。契约文件按路径大小写不敏感子串识别，默认只认 `contract`。**误报**：`src/contracts.ts`、`tmp/contract-notes.md` 在子代理运行时同样命中（`patterns` 是路径子串，不是文件类型），且失败的 write（`isError`）也按 §3 字面视为写入——提醒是建议性的，按需缩小 `patterns`。
- **ReviewGate 只看「有评审完成 + 之后有写入」**：label 以 `gates.review.labelPrefixes` 开头（默认 `只读评审`/`只读复审`）；任一评审子代理 completed 都建立新基线（`since=max(旧基线,当前父事件长度)`、`warned=false`）；不解析评审报告的 PASS/FAIL——FAIL 后返修同样应重开，方向一致。非评审子代理（勘察/实现）不改变状态（契约 §4 已知边界）。**`warned` 在下一轮评审 `created` 或任一评审 `completed` 时重置；每个基线只提醒一次；同一波次里第二个评审切片完成会重新建立基线。** 同一 childId 的重复 settle 不会重建基线（契约 §12-B）。
- **HandoffGate 是 best-effort**：若宿主在空流/中断回合根本不再触发 `agent/turn-stopping`，本闸门无法提醒；连续空回合会在下一个空回合再次提醒（弱提醒，不阻断）。**空回合口径**：只认 `type:'text'` 非空文本，仅 reasoning、无 text 的回合也算空回合。
- **让位顺序**：checkpoint → Wait → Verify → Contract → Review → Handoff → nudge。前一环投递后，后面的机制让位；闸门投递后设 `lastDeliveredTurn`，nudge 让位；闸门投递仍写回合观测行。**同回合已投递过任何提醒（checkpoint/nudge/闸门）→ 后续收尾不再发闸门**（契约 §11-A：一条 steer 之后不叠加第二条）。若 N−1 的 deferred nudge 已占用本次收尾，本回合不再叠加闸门（宁可少一条提醒，也不要一次收尾投递两条 steer）。
- **配置边界**：派发工具名复用 `nudge.delegationTools`（不新增配置键）；`{lastVerify}` 为 `null` 时文案渲染「从未验证」。
- **已知误报与边界**：`present` 只按工具名识别；`pwsh` 里的 `git commit` 即使写在未执行分支也会触发（与 nudge 的过度包含口径一致）；验证命令按子串匹配，`npm test -- --watch=false` 也算 `npm test`。**子串匹配的误报**：`Get-Content tsconfig.json` 会命中 `tsc`、`cat jest.config.js` 会命中 `jest`，非代码会话请按需追加 `gates.verify.commands`。子代理回合不判定。闸门是提醒而非门禁——它不会阻止 `present`/`commit`，只要求模型先补一次集成命令。

## 交接（0.7.0）

HandoffGate 只提醒「这个回合什么都没产出」，它不写文件（闸门不读盘、不写盘）。连续空回合（默认 1 个；模型失稳时常见连续 2 个以上）出现时，正确的动作是先落状态再开新会话，而不是继续 `/compact`：

```markdown
# dispatch/state.md

- run: <目标一句话 + 冻结契约路径>
- head: <当前分支 / 最近提交>
- diffHash: <git diff 的 sha256，或 `git status --short` 摘要>
- batches: <已完成批次 / 在跑批次 / 待派批次>
- verifies: <集成命令 + 退出码 + 时间；失败的也记>
- reviews: <评审轮次 + PASS|FAIL + 切片>
- open: <未决问题 / 阻塞点 / 契约疑点>
- next: <下一步唯一动作；恢复会话先读这一行>
```

- **先落状态，再开新会话**：空回合往往意味着上下文已经失真，继续压缩只会把状态越压越少；把上面八项写进 `dispatch/state.md` 后开新会话接力，恢复成本最低。
- **状态文件是记忆，不是证据**：恢复会话时用 `head`/`diffHash` 核对工作区；不一致时以工作区为准，并把 `open` 里的疑点重新问一遍。
- **best-effort**：若宿主在空流/中断回合根本不再触发 `agent/turn-stopping`，闸门无法提醒——不能把「没收到提醒」当成「没有空回合」。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册任何 section |
| `order` | `500` | 在系统提示词中的排序（必须有限数字） |
| `rules` | 六条默认 | 非空字符串数组，整体替换默认规则 |
| `footer` | 收口段（成本与豁免） | 追加在规则之后；`''` 关闭该段 |
| `checkpoint.enabled` | `true` | 子代理完成后是否给父代理发检查点 |
| `checkpoint.text` | 内置模板 | 覆盖检查点文案，支持 `{childId}` / `{label}` |
| `checkpoint.waveText` | 内置模板 | 波次聚合文案，支持 `{count}` / `{labels}` |
| `observation.enabled` | `true` | 是否写回合观测行（不是门禁） |
| `observation.dir` | `dispatch/runs` | 观测行目录（相对会话 cwd）；`false` 关闭 |
| `nudge.enabled` | `true` | 是否检查「漏派发」（验收回合与宽限回合仍会静默） |
| `nudge.threshold` | `2` | 本回合去重文件数 + shell 变更数 ≥ 该值且 0 派发时提醒（正整数；nudge 档不计 `git commit`） |
| `nudge.writeTools` | `['write','edit']` | 计入「改动」的工具名 |
| `nudge.delegationTools` | `['subagent','subagent_fork','workflow']` | 计入「已派发」的工具名 |
| `nudge.justifiedPatterns` | 见上（0.3.8 起 9 条） | 本回合正文命中任一即静默（子串匹配，NFKC 归一） |
| `nudge.text` | 内置模板 | 覆盖提醒文案，支持 `{fileCount}` / `{writes}` / `{files}` / `{turn}` |
| `nudge.log` | `%TEMP%\dispatch-protocol-decisions.jsonl` | 决定日志：checkpoint/nudge 写 delivered 与 suppressed，状态闸门只写 delivered；`false` 三个机制都不记 |
| `gates.enabled` | `true` | 五个事件闸门（Wait/Verify/Contract/Review/Handoff）总开关 |
| `gates.wait.enabled` | `true` | 是否提醒等待期的只读状态轮询 |
| `gates.wait.threshold` | `3` | 本回合状态查询次数达到该值、且无写/派发/验证时提醒（正整数） |
| `gates.wait.tools` | `['list_agents','job_list','schedule_list','get_goal']` | 计入「状态查询」的工具名 |
| `gates.wait.text` | 内置模板 | 覆盖等待提醒，支持 `{count}` / `{tools}` |
| `gates.verify.enabled` | `true` | 是否提醒「未验证就收口」 |
| `gates.verify.commands` | `['npm test','npm run build','dotnet test','jest','tsc','prisma migrate deploy','node test']` | 视为集成验证的命令片段（大小写不敏感子串） |
| `gates.verify.commitPattern` | 内置正则字符串（完整默认值见 `lib/gates.mjs` 的 `DEFAULT_VERIFY_COMMIT_PATTERN`） | 收口动作里的 commit/push 识别，加载期编译，非法即报错 |
| `gates.verify.text` | 内置模板 | 覆盖验证提醒，支持 `{changes}` / `{lastVerify}` |
| `gates.contract.enabled` | `true` | 有子代理运行时改写契约文件的提醒 |
| `gates.contract.patterns` | `['contract']` | 契约文件路径片段（大小写不敏感子串） |
| `gates.contract.text` | 内置模板 | 覆盖契约冻结提醒，支持 `{files}` |
| `gates.review.enabled` | `true` | 评审后改动未重开的提醒 |
| `gates.review.labelPrefixes` | `['只读评审','只读复审']` | 识别只读评审子代理的 label 前缀 |
| `gates.review.text` | 内置模板 | 覆盖评审失效提醒，支持 `{files}` |
| `gates.handoff.enabled` | `true` | 空回合兜底提醒 |
| `gates.handoff.emptyTurns` | `1` | 连续空回合达到该值才提醒（正整数） |
| `gates.handoff.text` | 内置模板 | 覆盖交接提醒，支持 `{emptyTurns}` |

非法配置（`order` 非有限数字、`rules` 为空/非数组、`footer`/`checkpoint.text` 非字符串、`nudge.threshold` 非正整数、工具名单为空数组、`nudge.justifiedPatterns` 为空数组或含空白串、`nudge.log` 既非路径也非 `false`、`gates.wait.threshold` 非正整数、`gates.wait.tools`/`gates.verify.commands`/`gates.contract.patterns`/`gates.review.labelPrefixes` 为空数组、`gates.handoff.emptyTurns` 非正整数、`gates.*.text` 为空白串、`gates.verify.commitPattern` 无法编译、`gates.contract`/`gates.review`/`gates.handoff` 非对象）在插件加载时直接报错，不会静默降级。

## 设计取舍

**① 验收为什么分两层**：一条集成命令覆盖全树，它红的时候无法判断是哪个子代理引入的。逐个复跑全量能保住归因，但是 N 倍成本；全批只跑一次能压住成本，但失败后要 bisect。所以拆成「子代理跑窄验证（只覆盖自己那部分）+ 派发方在相关子代理全部结束后跑一次集成命令」：前者负责归因，后者负责集成状态。宽窄混用（子代理跑全量、父代理只跑窄的）会让两边都失真。

**② 为什么要只读评审（0.3.9）**：写实现的人同时写了验收标准时，两者共享同一个理解错误——测试全绿只能证明「实现符合它自己的理解」。2026-10-22 的真机样本构造了这个形状：`tagify` 漏了契约要求的去重，实现者的测试也没有任何重复标签用例，窄验证 4/4 全绿、`EXIT=0`，但契约表格两行不满足（`'a, B ,a,,c'` 得到 `["a","b","a","c"]`）。派出的只读评审从契约表与 diff 做语义核对后判 `FAIL` 并点名 `tagify.mjs:5-8`，还明确指出「实现与测试同一盲点」；补上去重后同一评审复评 `PASS`，且没有因为派发方说「已修复」就放行，另用顺序探针（`'b,a,b, ,B'` → `["b","a"]`）和七种非字符串输入确认去重之外的行为没有回归。两个方向（判 FAIL 与复评 PASS）都验过，所以它不是橡皮图章。（0.3.9 当时评审还允许实跑探针；0.5.1 起执行性验证只归派发方，评审只做 read/grep 语义核对——这个样本的价值在于「实现与测试同一盲点」，不在评审跑了命令。）代价是符合触发条件的批次多一个只读子代理；小型串行批次不触发。

**③ 三个数字各有身份**：`20 个文件 / 3 个契约面` 是**评审容量**——一个读者一次能核完的 diff 有多大，属物理约束；`15 分钟 / 30 次编辑` 是**单批预算**——一批跑多久就该回头看一眼，超过就该切片而不是硬撑（外推初值，证据只有 `session-1433e747` 一个会话，校准计划见 `docs/superpowers/specs/2026-10-28-dispatch-0.5x-followup.md` §3）；`>2 个文件 / ≥3 处改写` 是**微批分流**——成本路由的标定值，判错只花错钱、不坏正确性。三者都不是白名单上限：白名单的边界仍是「全批结束后一条集成命令能验完」，仍逐条列名、不设数量封顶；任务清单的边界仍是「每条一个决策或一批」，同样不封顶。把容量、预算、路由混成一个数字，三种判断会互相污染：5 个同模式文件的机械改写会既被判成该切片、又被判成该自己做完。

**④ 为什么全仓核查必须单列**：只审 diff 必然漏掉跨切面的遗漏点，因为漏掉的东西不在 diff 里。KOL 会话 `session-37256e00` 的评审没有停在 diff 上，而是按给定检索词全仓 grep，抓到 3 处用户可见漏点：`ApplyForm.tsx:16` 的预填、`ApplicationsPanel.tsx:282`、admin 的 `ApplicationsPage.tsx:139`——三处全部在本批白名单之外。若按「只审变更集」收口，这三处会随 `PASS` 一起漏出去；所以单列一栏、给检索空间、把用户可见遗漏直接判 FAIL，而其余部分仍不重开仓库通读。

**⑤ 为什么并行条要写触发条件、0.3.7 起又允许并行写（现第 6 条）**：旧措辞只有「可以并行」这个许可，没有触发条件。实测几天里并行的分支一次都没走到——本机留存的会话日志中 4 次派发全在同一个父会话（`session-4d76d479`），按 `createdAt` + 运行时长还原出四个完全不相交的区间，`workflow` 一次未调用。0.3.5 补上触发句，0.3.6 在真机上验到只读并行（同批 1ms 启动、重叠 16.7s）。但「同工作区写操作串行」这句太粗：互不相交的文件并行写并不冲突，真正会坏的只有三类面——**同文件/同模块的写**、**共享构建产物**（`dist`、缓存目录、同一端口）、**契约面**（schema、类型、路由、barrel、lockfile）。0.3.7 把门槛改成「白名单互斥 + 契约派发前冻结 + 禁止并发跑共享产物的全量构建」，大改动需要各自完整构建时仍拆独立 worktree。

**⑥ 为什么等待要走完成事件**：`session-1433e747` 里派发方 31 次 `Start-Sleep` 合计 54.1 分钟，而会话总共 106 分钟——sleep 轮询是**用完整模型步进换零信息**：每次醒来都付一次模型步进，子代理的状态却没有变。完成事件由宿主推送，等到就有；「一批最多一次主动检查（预算过半时）」是为了让跑偏早暴露，不是为了盯进度。

**⑦ 为什么不复跑子代理的窄验证命令（0.5.2）**：实测一个评审任务里评审子代理花了大量时间评审、主控又把验收重复做了一遍——同一执行性信号付了两到三次钱。复跑防的从来不是主要风险：设计取舍②的 `tagify` 样本里，「实现与测试同一盲点」是语义评审抓的，命令复跑两边都绿、毫无作用；复跑实际只防「声称跑过但没跑 / 谎报退出码」这一类窄风险。所以执行性验证只付一次：窄验证留给子代理（负责归因），派发方的执行性预算集中在批末集成命令（负责集成状态），主控读 diff 时核对其退出码报告与 diff 的一致性。**边界（0.5.4 起写进规则 3 文本）**：集成命令必须覆盖各批窄验证断言点的并集——白名单本就以「一条集成命令能验完全批」为界，此条把它显式化为验收前提；某批窄验证断言了集成命令覆盖不到的行为时，该批窄命令由派发方再跑，这是唯一的复跑例外。完整裁决见 `docs/superpowers/specs/2026-10-28-dispatch-0.5x-followup.md` §2。

## 变更历史

| 版本 | 要点 | 依据 |
|---|---|---|
| 0.3.6 | 正文已解释就不发 nudge，只记 `"decision":"suppressed","reason":"justified"`。静默判定只看本回合 `assistant/message`。 | 真机 `session-a2e9f600` turn 3：主控已写清豁免理由，提醒仍发，用户只收到重复消息。 |
| 0.3.10 | checkpoint 与 nudge 收进同一个 `agent/turn-stopping` 处理器，固定「先 checkpoint 后 nudge」，不依赖订阅顺序；每次判定写决定日志（含被抑制的）。 | 两个提醒原按订阅顺序各自判定、同一回合可能都发；且没有日志时分不清「没触发」与「触发后被静默」。 |
| 0.4.0 | `pwsh` 变更计入判定、checkpoint 按波次聚合、被打断回合补评估、回合观测行；新增判级与评审闭环规则（合并判级、评审后改动重评、任务清单须含拆批方案或不派发理由）。 | 三样本评审 `docs/reviews/2026-10-23-dispatch-pipeline-review.md`：G2 切分绕过、G4 评审后改动不重评、N1 派发按任务类型触发；W-5 用 `Remove-Item` 删死代码被判只读。 |
| 0.4.1 | nudge 档不计 `git commit`（提交权归派发方）、文案口径把文件与 shell 变更分开、观测行按 `(session, turn)` 去重、`git -C <path>` 计入与 `=>`/`->` 泛型误报修复、只读 label 约定、`scripts/verify-install.mjs` 安装核验。 | 三样本复核 §10.3（I3/I4/I5 + 只读 label 约定）；四例纯 `git commit` 回合被计入（样本四 T3、S5 t34、S6 t13、S7 t2）。 |
| 0.5.0 | 执行性验证只归派发方（同一条命令全系统只复跑一次）、微批分流表进 footer、判级从一维风险扩为风险 × 规模、勘察触发条件显式化。 | 两日全量实测 `docs/superpowers/specs/2026-10-27-dispatch-cost-redesign.md`（10-26 `session-8634bdc8` 主 + 10 子；10-27 全天 8 主 + 20 子）。 |
| 0.5.1 | 评审对象收窄为变更集：输入四项、白名单并集 diff、不逐文件通读；「全仓不变量核查」单列为有条件的一栏；评审包 20 个文件 / 3 个契约面切片上限；六条规则按职责重排，评审从判级条拆出独立一条。 | 评审实测成本倒挂（评审重跑主控已复跑过的构建/测试，`pwsh×24~33`，成本多次超过被评审的实现批次之和）；KOL 会话 `session-37256e00` 证明只审 diff 会漏白名单外的 3 处用户可见点。 |
| 0.5.2 | 单批预算（过半报进度、超预算报阻塞点再停）、派发即冻结（契约窗口）、等待改走完成事件（禁止 sleep 轮询）、超预算按场景切片。 | `session-1433e747`：30.8 分钟子代理 / 192 步，派发方 31 次 `Start-Sleep` 合计 54.1 分钟；运行中改契约导致返工。 |
| 0.5.3 | locales 与注释口径收口：验收描述改为「派发方跑集成命令」，plugin.mjs 注释去掉 re-run 说法，checkpoint 测试补 `doesNotMatch(/复跑/)` 防回流。 | 0.5.2 复审的三条非阻断建议（`plugin.mjs:219` 注释、checkpoint 负向断言、locale 描述）。 |
| 0.5.4 | 规则 3 补「集成命令必须覆盖各批窄验证断言点的并集」前提与唯一复跑例外——把设计取舍⑦的边界从文档层写进注入文本。 | `2026-10-28-dispatch-0.5x-followup.md` §2 裁决：移除复跑以该覆盖前提成立为边界，此前边界只在文档里、模型看不到。 |
| 0.6.0 | WaitGate / VerifyGate 两个事件闸门：等待期只读轮询、以及收口前的「未验证/验证后又改」各提醒一次；接线顺序 checkpoint → 闸门 → nudge，每回合最多一条；`gates` 加载期校验；决定日志新增 `kind:"gate"`。 | `session-92f462d1`：同一会话 66 次状态查询轮询；最终 diff 在最后一次集成命令（事件 1112）之后又被改，却准备 present 收口。 |
| 0.7.0 | 新增 ContractGate（有子代理在跑时改写契约文件）、ReviewGate（只读评审完成后又改工作区，同一轮只提醒一次）、HandoffGate（连续空回合兜底）；闸门顺序扩为 Wait → Verify → Contract → Review → Handoff；`subagent/end` 先更新闸门状态再走 checkpoint 早退；README 新增「交接」状态文件模板。 | `session-92f462d1`：子代理运行期间在线改写契约、只读评审后改动未重开切片、以及无工具调用无文本的空回合中断。 |

## 验证

离线回归：

```powershell
node test.mjs
```

真机验证（临时 profile，不动桌面 profile）：

```powershell
dsh plugin --profile probe add "link:G:/www/ziyou/dsh-extensions/plugins/dispatch-protocol"
dsh --profile probe headless "不要调用任何工具，只回答：你的系统提示词里「派发纪律」一节列了哪几条？逐条列出标题。"
```

预期：模型复述出「先勘察，后派发」「执行类派发必须自包含」「验收与等待」「评审只审变更集，不审仓库」「提交权归派发方」「并行只读，互斥并行写」六条。

漏派发提示的真机口径：一个回合内连续改 2 个以上**去重文件**（同一文件多次编辑只算 1）且不派发、正文也没写不派发理由时，收尾时会多出一段以 `[dispatch-protocol]` 开头的提醒；`%TEMP%\dispatch-protocol-decisions.jsonl` 同时多一行 `{"kind":"nudge","decision":"delivered","session":…,"turn":…,"writes":…,"files":[…]}`；被静默的那次是同一行改为 `"decision":"suppressed"` 并带 `reason`（`justified`/`handled`/`grace`）。

**0.3.6 真机证据（2026-10-22，desktop 0.3.6）**：

- 抑制路径：一个回合改 3 个文件、0 派发、正文含「不派发」→ 日志写 `"decision":"suppressed","reason":"justified"`（0.3.10 前的旧格式为 `"suppressed":"justified"`），会话 0 条提醒。对照同文件更早的 `turn:6`（0.3.5）：0 派发、15 次写入、**无**抑制字段，随后照常发出提醒。两行的差异就是 0.3.6 的全部作用。
- 只读并行：同一条消息发出两个只读子代理，`childCreatedAt` 相差 1 ms、运行区间重叠 16.7 s（19.1 s 与 16.8 s 两个区间），两个都没有触发完成检查点。并行由模型在同一 assistant 消息里发两个 `subagent` 调用驱动，宿主不自动派生。
- **口径提醒**：回合里只要有派发（`subagent`/`subagent_fork`/`workflow`），`shouldNudge` 直接为假，**既不进抑制判定也不写日志**——「没看到提醒」在这个前提下不能当作抑制生效的证据，这是真机上踩过一次的假阳性。

## 已知坑

- **系统提示词改动会影响 KV 缓存前缀**：`order` 与文本变化会让后续请求失去前缀复用；规则固定后不要频繁改。
- **section 名重复会报错**：同一 profile 只能挂一个 `dispatch-protocol`；改配置用同 id 覆盖，不要重复插入。
- **规则是建议不是强制**：模型仍可无视。要硬拦截需要 `tools/pre-execute` 那类插件（本项目评估后不做）。
- **漏派发提示要花一步**：`agent/turn-stopping` 里 `steer` 会让本回合再跑一步。按回合去重，一回合最多一次；模型可以只在补充说明里写「为什么没派」而不真的派发——提醒不是强制。
- **静默判定是关键词粗判**：引述规则原文（例如「超出单文件豁免」）也会被当成已解释，`不 派 发` 这种被空格切开的写法则**不会**命中。两个方向都是有意的：宁可少发一次提醒，也不要每次打扰。误报多就调 `nudge.justifiedPatterns`，不必改代码。**词表只按实测漏报加词**：0.3.8 补的 `一条命令验完` / `一处改动的` / `镜像面` 都来自真机上一次「解释了但没命中旧词」的回合，不是预先猜的；每加一条都要配一条断言和这一节的记录。
- **检查点只在未验收时花一步**：0.3.4 起 settle 只登记，回合收尾判定已验收就零消息、零额外步骤（比 0.3.2/0.3.3 的 settle 即发更省）；未验收才 `steer` 一条，花一步，与 nudge 同价。父代理没有 hook 作用域时仍回退为 settle 时 `followup`，行为同 0.3.3。
- **触发看文件数、判定看调用名**：是否提醒按去重路径计（同一文件多次编辑算 1 个）；「哪些调用算改动」仍按工具名判断——`pwsh` 里的 `Set-Content`/`dotnet format` 等副作用不计；`write`/`edit` 以 `tool/result.isError` 为准，失败的不计（无结果可查时照算）。
- **检查点的只读判定按调用名、尝试即算**：`write`/`edit` 只要出现在子代理的 `tool/call` 里就算执行类，**不解析 `tool/result`**——失败或被拒绝的写入也不豁免检查点。这与 nudge「成功才计数」的口径不同，是有意的保守方向：宁可多提醒一次，也不要漏掉真正的执行类子代理。
- **记账在 TEMP 里**：`nudge.log` 默认落在系统临时目录（`dispatch-protocol-decisions.jsonl`，checkpoint、nudge 与状态闸门共用），不随仓库版本化；要长期留档就把路径指到固定位置（或 `false` 全关）。旧 `dispatch-protocol-nudge.jsonl` 已不再写入。
- **profile 插件不支持热加载**：装完必须重启 DSH，新会话才生效。
- **update 失败会留下半残目录，且可能卡成 delete-pending**：`dsh plugin --profile desktop update` 先把 `node_modules/<pkg>` 整块 rename 掉；任一步失败就可能只剩一半文件，而失败时被打开的子目录（实测是 `lib/`）会进入 delete-pending —— 之后**连改父目录、删除、读 ACL 都 Access denied**，`diagnose-windows-sandbox-acl` 报 `VERDICT=UNREADABLE`、Restart Manager 返回 `ACCESS_DENIED`，只有**重启 Windows** 能清。2026-10-22 踩过一次（`AUDIT-2026-10-22.md` 第七节）。
  - 预防：**完全退出 DSH → update → 启动**；确认没有遗留的 `robocopy`/`pnpm` 子进程再跑（那次真正的持有者是一条被我挂住的 robocopy）。
  - 恢复：重启后 `lib/` 自动消失，重跑同一条 update 即可归位；验收标志是 `lib/config.mjs` 存在且没有手工补丁目录。
