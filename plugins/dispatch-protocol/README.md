# dispatch-protocol

> 部署状态不在本文档硬编码：desktop 的实际版本以 profile 安装为准（`dsh plugin --profile desktop list` 或 `profiles/desktop/node_modules/dispatch-protocol/package.json`）；probe 为 `link:` → 直接吃工作区。发布顺序固定为：提交推送 → `dsh plugin --profile desktop update dispatch-protocol` → 重启 DSH → 台账记一笔。没走完不算发布。

把「派发纪律」常驻注入 DSH。三个机制，都不拦截任何调用：

1. **系统提示词 section**：每次请求（主控与每个子代理）都会看到五条规则，不依赖模型是否加载了某个 skill。
2. **完成检查点**：子代理结束（`stopReason === 'completed'`）时只登记「待验收」，等父代理下一个回合收尾（`agent/turn-stopping`）才判定：已验收就静默丢弃，未验收才提醒读 diff、独立复跑子代理声称的命令。静态规则容易被跳过，时点提醒不会；**父代理已经按子代理汇报处理过的不再重复提醒**。
3. **漏派发提示**：一回合改了多个文件却一次没派发时，在本回合收尾前给主控一条提醒。规则只约束「怎么派发」，从来不含「必须派发」，所以「这回合漏了派发」只能观测，不能推断。

## 为什么不用 AGENTS.md

`AGENTS.md` 是跨工具共享的（Codex、OpenCode、Claude Code 都读），而派发纪律只对 DSH 的子代理机制成立。写进 AGENTS.md 会污染其他工具，并与 OpenCode 的 lead/impl/verify 流程冲突。

插件层是 DSH 专属、且**不依赖模型是否加载某个 skill**：即使主控没有加载 `subagent-driven-development`，这段规则仍在系统提示词里。

## 注入内容

默认五条规则 + 一段收口（`lib/config.mjs` 的 `DEFAULT_RULES` / `DEFAULT_FOOTER`）：

1. 先勘察，后派发（现状文件 + 白名单逐条列名；白名单以「全批结束后能用一条集成命令验收」为界；验收分两层：子代理跑窄验证，派发方在全批结束后跑集成命令）
2. 执行类派发必须自包含（现状/允许修改/单条验证/输出格式）
3. 验收要复跑（派发方独立复跑并留退出码；并行写批次与契约面改动完成后另派**只读评审**，逐条 `PASS|FAIL + 文件:行号`，不采信实现者自述或其测试通过）
4. 提交权归派发方（子代理不得 commit/push/reset/clean）
5. 并行只读，**互斥**并行写（≥2 个互不依赖的只读子问题同一条消息并行发出；实施也并行，但白名单按文件/模块互斥、契约派发前定死、禁止并发跑共享产物的全量构建）

渲染为系统提示词里的 `## 派发纪律（DSH）` 小节，`order: 500`（在一方指引之后、persona suffix 之前），`interpolate: false`（`{{…}}` 原样保留）。当前渲染 1075 字符（785 汉字）。

收口段回答的是「谁来做、什么可以直接做、想不清怎么办」：

- **成本**：主控贵而强、子代理便宜 → 多文件机械活默认派发，主控只留决策、例外、验收、提交；
- **豁免**：单文件且纯文案/配置/测试接线可以直接做（须给证据）；
- **拆批**：步骤穷举不出来就分批（先只读勘察、再实现）；只读勘察能拆成互不依赖的子问题就并行派出；实现批次按互斥文件切分后也能并行，契约先定死；
- **缺 skill**：先写「每条 = 一个决策点或一批派发」的清单，不得据缺 skill 跳过判断。

**为什么第 5 条要写触发，0.3.7 起又允许并行写**：旧措辞只有「可以并行」这个许可，没有触发条件。实测几天里并行的分支一次都没走到——本机留存的会话日志中 4 次派发全在同一个父会话（`session-4d76d479`），按 `createdAt` + 运行时长还原出四个完全不相交的区间，`workflow` 一次未调用。0.3.5 补上触发句，0.3.6 在真机上验到只读并行（同批 1ms 启动、重叠 16.7s）。但「同工作区写操作串行」这句太粗：互不相交的文件并行写并不冲突，真正会坏的只有三类面——**同文件/同模块的写**、**共享构建产物**（`dist`、缓存目录、同一端口）、**契约面**（schema、类型、路由、barrel、lockfile）。0.3.7 把门槛改成「白名单互斥 + 契约派发前冻结 + 禁止并发跑共享产物的全量构建」，大改动需要各自完整构建时仍拆独立 worktree。`≥2 个互不依赖的子问题` 是判定条件，不是白名单上限，不与「不写死数字」矛盾。

**验收为什么分两层**：一条集成命令覆盖全树，它红的时候无法判断是哪个子代理引入的。逐个复跑全量能保住归因，但是 N 倍成本；全批只跑一次能压住成本，但失败后要 bisect。所以拆成「子代理跑窄验证（只覆盖自己那部分）+ 派发方在相关子代理全部结束后跑一次集成命令」：前者负责归因，后者负责集成状态。宽窄混用（子代理跑全量、父代理只跑窄的）会让两边都失真。

**为什么要只读评审（0.3.9）**：写实现的人同时写了验收标准时，两者共享同一个理解错误——测试全绿只能证明「实现符合它自己的理解」。2026-10-22 的真机样本构造了这个形状：`tagify` 漏了契约要求的去重，实现者的测试也没有任何重复标签用例，窄验证 4/4 全绿、`EXIT=0`，但契约表格两行不满足（`'a, B ,a,,c'` 得到 `["a","b","a","c"]`）。派出的只读评审逐行实跑契约表后判 `FAIL` 并点名 `tagify.mjs:5-8`，还明确指出「实现与测试同一盲点」；补上去重后同一评审复评 `PASS`，且没有因为派发方说"已修复"就放行——它额外跑了顺序探针（`'b,a,b, ,B'` → `["b","a"]`）和七种非字符串输入。两个方向都验过，所以它不是橡皮图章。代价是符合触发条件的批次多一个只读子代理；小型串行批次不触发。

**为什么不写死数字**：白名单的边界是「全批结束后一条集成命令能验完」，清单的边界是「每条一个决策或一批」——`≤3 个文件` / `≤7 条` 这类数字既不解决验收负担，也会把 5 个同模式文件的机械改写逼成两批。

**为什么有这一段**：主控跑贵模型，没有这段时"步骤一时穷举不出来"会被读成"那我自己做完"（`session-a80150dd`：56 步、2.5 万输出 token，换 +26 行）；而 `using-superpowers` 要求下一步调 `writing-plans`、该 skill 又不在目录里，模型于是又把它读成"那我直接实现"。这两条降级路径都写进了这一段，且这些公用 skill **不改**。

## 完成检查点

`agent/created` 记录每个子代理的父会话；`subagent/end` 在 `completed` 时**不再直接投递**，而是把「待验收」登记进 pending（每个子代理只登记一次，失败/中止不登记），投递时机见下。消息仍是 `[dispatch-protocol]` 一条，模板支持 `{childId}` 与 `{label}` 占位。

**投递时序（0.3.4 起）**：settle 与父代理的验收动作天然赛跑——子代理汇报后通常立刻 settle，此时父代理的验收回合还没动手，settle 时判定只会读到「尚未验收」，检查点因此必然误发。所以判定挪到父代理的回合收尾：

- 父代理有 hook 作用域：settle 时登记 pending，并给该父代理挂一个（每个父代理只挂一次）`agent/turn-stopping` 监听；回合收尾时逐个判定，判定完立即从 pending 移除，后续回合不会重复发。
- 已验收（汇报后整回合有 `tool/call`，且子代理汇报后没再写文件）→ **静默丢弃**：零消息、零额外步骤。
- 未验收 → `steer` 一条提醒（与 nudge 同机制：回合还开着，花一步）。
- 父代理没有 hook 作用域（如嵌套子代理作父等异常形态）→ **回退**为 settle 时立即 `followup`，判定顺序不变。

真机依据：`session-96dda908` 的父会话 seq——241 子代理汇报 splice → 246 settle（旧版在这里判定）→ 247 检查点误发 → 249 父代理才第一次 `tool/call`（读 diff）。判定比验收早了 3 个事件，正是 0.3.4 要消除的赛跑。离线用例覆盖：settle 后 0 条、回合收尾才补验收仍 0 条（时序赛跑回归）；判定后不重复发；同回合多个 pending 各发一条、已验收的静默丢弃。

**只读跳过（0.3.3 起）**：子代理**整个会话**没有任何一次 `write`/`edit` 调用时，检查点**不发**（0.3.4 起该判定同样挪到 `agent/turn-stopping` 执行）。勘察类子代理只读文件、跑命令、汇报结论，既没有 diff 可读，也没有命令可复跑，提醒只会空转。判定只看 `session.snapshotEvents()` 里 `tool/call` 的工具名，**尝试即算**——写入被拒绝或抛错也算执行类，照旧发（判定抛错同样照旧发）。真机依据：`session-03f065ca` 回合 3 的勘察子代理 `56f7d82d` 汇报「未修改任何文件」、主控 0 次工具调用，检查点仍然发出，主控只能在回合 4 补一句「只读任务、无命令可复跑」。

**去重（0.3.2 起）**：子代理通常先用 `send_message` 汇报，父代理会当场读 diff + 复跑；等 `subagent/end` 再提醒同一件事，父代理只能回一个空回合。所以投递前先判定「父代理是否已经按这份汇报动过手」，满足下列全部条件就**不发**（条件与内部逻辑自 0.3.2 起不变；0.3.4 起判定时机随投递一起挪到 `agent/turn-stopping`，看的是父代理整个回合）：

1. 父代理日志里存在 `agent/inbox/spliced`，文本含 `Agent {childId} sent a message`（子代理**汇报过**）；
2. 那次汇报之后，父代理有任意一次 `tool/call`（**动过手**）；
3. 子代理在它最后一次 `send_message` 之后**没有**再 `write`/`edit`（汇报即终态）。

任一条不成立就照旧发；判定抛错、父代理没有日志、子代理没汇报过，也一律照旧发。**已知边界**：条件 2 不区分那次调用是不是针对这个子代理，属有意近似——宁可少提醒一次，也不要在已验收后重复打扰。

## 漏派发提示

五条规则只约束派发的**形式**，没有任何机制要求「必须派发」。实测就有会话全程不派发：`session-a80150dd`（2 回合 / 56 步 / 67 次工具调用 / 0 次派发）把 5 个 XAML 同性质改动判成「小改豁免」自己做了，全程没有任何提示。

本机制把「漏派发」变成可观测事实：

- **触发点**：`agent/turn-stopping`（serial，回合即将收尾、`turn/end` 提交之前）。这里 `steer` 会让本回合再跑一步，因此提醒只花一步，且**每回合最多一次**（按回合号去重，模型回一句「收到」后继续改文件也不会再触发）。
- **计数来源**：该回合已提交的 `tool/call` 事件。事件自带 `turn`，所以不需要任何跨回合状态，恢复的会话算出的数字与实时一致。
- **失败不计数**：写调用的结局要看它的 `tool/result`——`isError === true` 的写入没有落盘，不计入 `writes`/`files`；没有 `callId` 或找不到结果的调用照旧计数（回合被打断时不能把写入抹掉）。
- **触发条件**：本回合**去重文件数** ≥ `nudge.threshold`（默认 2；同一文件多次编辑只算 1）**且**派发调用（`subagent`/`subagent_fork`/`workflow`）为 0。
- **动作**：给主控发一条 `{fileCount}`/`{writes}`/`{files}`/`{turn}` 渲染的提醒（形如「改了 4 个文件（9 次写入）」），并往决定日志（`nudge.log`，默认 `%TEMP%\dispatch-protocol-decisions.jsonl`，一行一条 JSON）记一笔 `"kind":"nudge"` 的决定。
- **已解释则静默（0.3.6 起）**：本回合的 `assistant/message` 正文里若已出现 `nudge.justifiedPatterns` 中的任一词（默认 `豁免` / `不派发` / `未派发` / `无需派发` / `不需要派发` / `直接做` / `一条命令验完` / `一处改动的` / `镜像面`），**不发消息**，只往日志记一行 `"decision":"suppressed","reason":"justified"`。多文件写入是常态，模型常常在同一回合已经写清「为什么自己改」，再把问题复述一遍只会让会话窗口多一条噪音——实测 `session-a2e9f600` 的 turn 3：主控正文已写「4 个文件是同一处文案的 4 个镜像面…属于豁免」，提醒仍照样发出，用户只得到一条重复消息。判定只看 `assistant/message`（模型说的话），不看 `tool/result` 文本；只认本回合，别的回合解释过不算。
- **不适用于子代理**：子代理本身不能再派发，其写操作已经记在父回合里。

只数调用名，不解析副作用：`pwsh` 里 `Set-Content` 之类的写入落在口径之外（不算）；而 `write`/`edit` 按**结果**算——成功才计数，被策略拒绝或抛错的调用（`tool/result.isError === true`）不计。计数按去重路径：同一文件改多次只算 1 个文件。

## 提醒让位（0.3.10 起）

两个提醒由同一个 `agent/turn-stopping` 处理器按固定顺序判定：**先 checkpoint，后 nudge**，不依赖订阅顺序。同一回合同不同时发 checkpoint 与 nudge；nudge 每回合至多一条，checkpoint 每个未验收子代理一条。

| 优先级 | 提醒 | 触发 | 让位/静默 |
|---|---|---|---|
| 1 | 完成检查点 | 子代理 `completed` + 父代理未验收 | 只读子代理；父代理已按汇报动过手 |
| 2 | 漏派发提示 | ≥2 去重文件 + 0 派发 + 正文未解释 | 本回合是验收回合；上一回合（turn-1）刚投递过检查点（一回合宽限） |

- **checkpoint 先占用回合**：本回合投递了 checkpoint 就不再评估 nudge。
- **验收回合静默**：checkpoint 判 `handled`（父代理已按汇报动过手）时，本回合 nudge 不发——这回合本来就在验收，不是漏派。
- **一回合宽限**：上一回合投递过 checkpoint，本回合 nudge 静默。已知代价：刚验收完确实漏派会少提醒一次，方向是「宁可少打扰」。
- **checkpoint 自身被跳过**（只读/已验收）时，nudge 仍按自身条件判定；`read-only` 不占用回合。

## 决定日志（0.3.10 起）

checkpoint 与 nudge 的每次判定都写一行，被抑制的也写——否则日志分不清「没触发」和「触发后被静默」。默认 `%TEMP%\dispatch-protocol-decisions.jsonl`，`nudge.log` 键名保留：`false` 两个机制都不记，字符串则覆盖路径（checkpoint 与 nudge 写同一文件）。

```json
{"time":"...","session":"...","turn":36,"kind":"checkpoint|nudge","decision":"delivered|suppressed","reason":"justified|handled|read-only|grace","writes":3,"files":[...],"delegations":0}
```

- 公共字段：`time`、`session`、`turn`、`kind`、`decision`；`reason` 只在 `suppressed` 时出现。
- checkpoint 行额外带 `childId`、`label`（每个 pending 子代理一行）；没有回合可用（无 hook 作用域的回退 `followup`）时 `turn` 为 `null`。
- nudge 行额外带 `writes`、`files`、`delegations`。
- **迁移**：旧 `%TEMP%\dispatch-protocol-nudge.jsonl` 不再写入，可以直接删除。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册任何 section |
| `order` | `500` | 在系统提示词中的排序（必须有限数字） |
| `rules` | 五条默认 | 非空字符串数组，整体替换默认规则 |
| `footer` | 收口段（成本与豁免） | 追加在规则之后；`''` 关闭该段 |
| `checkpoint.enabled` | `true` | 子代理完成后是否给父代理发检查点 |
| `checkpoint.text` | 内置模板 | 覆盖检查点文案，支持 `{childId}` / `{label}` |
| `nudge.enabled` | `true` | 是否检查「漏派发」（验收回合与宽限回合仍会静默） |
| `nudge.threshold` | `2` | 本回合去重文件数 ≥ 该值且 0 派发时提醒（正整数） |
| `nudge.writeTools` | `['write','edit']` | 计入「改动」的工具名 |
| `nudge.delegationTools` | `['subagent','subagent_fork','workflow']` | 计入「已派发」的工具名 |
| `nudge.justifiedPatterns` | 见上（0.3.8 起 9 条） | 本回合正文命中任一即静默（子串匹配，NFKC 归一） |
| `nudge.text` | 内置模板 | 覆盖提醒文案，支持 `{fileCount}` / `{writes}` / `{files}` / `{turn}` |
| `nudge.log` | `%TEMP%\dispatch-protocol-decisions.jsonl` | 决定日志（checkpoint 与 nudge 的 delivered/suppressed 各一行）；`false` 两个机制都不记 |

非法配置（`order` 非有限数字、`rules` 为空/非数组、`footer`/`checkpoint.text` 非字符串、`nudge.threshold` 非正整数、工具名单为空数组、`nudge.justifiedPatterns` 为空数组或含空白串、`nudge.log` 既非路径也非 `false`）在插件加载时直接报错，不会静默降级。

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

预期：模型复述出「先勘察」「执行类派发」「验收要复跑」「提交权」「并行只读」五条。

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
- **记账在 TEMP 里**：`nudge.log` 默认落在系统临时目录（`dispatch-protocol-decisions.jsonl`，checkpoint 与 nudge 共用），不随仓库版本化；要长期留档就把路径指到固定位置（或 `false` 全关）。旧 `dispatch-protocol-nudge.jsonl` 已不再写入。
- **profile 插件不支持热加载**：装完必须重启 DSH，新会话才生效。
- **update 失败会留下半残目录，且可能卡成 delete-pending**：`dsh plugin --profile desktop update` 先把 `node_modules/<pkg>` 整块 rename 掉；任一步失败就可能只剩一半文件，而失败时被打开的子目录（实测是 `lib/`）会进入 delete-pending —— 之后**连改父目录、删除、读 ACL 都 Access denied**，`diagnose-windows-sandbox-acl` 报 `VERDICT=UNREADABLE`、Restart Manager 返回 `ACCESS_DENIED`，只有**重启 Windows** 能清。2026-10-22 踩过一次（`AUDIT-2026-10-22.md` 第七节）。
  - 预防：**完全退出 DSH → update → 启动**；确认没有遗留的 `robocopy`/`pnpm` 子进程再跑（那次真正的持有者是一条被我挂住的 robocopy）。
  - 恢复：重启后 `lib/` 自动消失，重跑同一条 update 即可归位；验收标志是 `lib/config.mjs` 存在且没有手工补丁目录。
