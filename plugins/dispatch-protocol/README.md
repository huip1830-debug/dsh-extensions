# dispatch-protocol

> 当前部署：desktop **0.3.1**；probe 为 `link:` → 直接吃工作区。改动后的发布顺序固定为：提交推送 → `dsh plugin --profile desktop update dispatch-protocol` → 重启 DSH → 台账/本行记一笔。没走完不算发布。

把「派发纪律」常驻注入 DSH。三个机制，都不拦截任何调用：

1. **系统提示词 section**：每次请求（主控与每个子代理）都会看到五条规则，不依赖模型是否加载了某个 skill。
2. **完成检查点**：子代理结束（`stopReason === 'completed'`）时，给父代理发一条提醒，要求读 diff、独立复跑子代理声称的命令。静态规则容易被跳过，时点提醒不会。
3. **漏派发提示**：一回合改了多个文件却一次没派发时，在本回合收尾前给主控一条提醒。规则只约束「怎么派发」，从来不含「必须派发」，所以「这回合漏了派发」只能观测，不能推断。

## 为什么不用 AGENTS.md

`AGENTS.md` 是跨工具共享的（Codex、OpenCode、Claude Code 都读），而派发纪律只对 DSH 的子代理机制成立。写进 AGENTS.md 会污染其他工具，并与 OpenCode 的 lead/impl/verify 流程冲突。

插件层是 DSH 专属、且**不依赖模型是否加载某个 skill**：即使主控没有加载 `subagent-driven-development`，这段规则仍在系统提示词里。

## 注入内容

默认五条规则 + 一段收口（`lib/config.mjs` 的 `DEFAULT_RULES` / `DEFAULT_FOOTER`）：

1. 先勘察，后派发（现状文件 + 白名单逐条列名；一批只对应一条验证命令）
2. 执行类派发必须自包含（现状/允许修改/单条验证/输出格式）
3. 验收要复跑（派发方独立复跑并留退出码）
4. 提交权归派发方（子代理不得 commit/push/reset/clean）
5. 并行只读，不并行写（同工作区写操作与构建串行）

渲染为系统提示词里的 `## 派发纪律（DSH）` 小节，`order: 500`（在一方指引之后、persona suffix 之前），`interpolate: false`（`{{…}}` 原样保留）。当前渲染 712 字符（525 汉字）。

收口段回答的是「谁来做、什么可以直接做、想不清怎么办」：

- **成本**：主控贵而强、子代理便宜 → 多文件机械活默认派发，主控只留决策、例外、验收、提交；
- **豁免**：单文件且纯文案/配置/测试接线可以直接做（须给证据）；
- **拆批**：步骤穷举不出来就分批（先只读勘察、再实现），不许整包自留；
- **缺 skill**：先写「每条 = 一个决策点或一批派发」的清单，不得据缺 skill 跳过判断。

**为什么不写死数字**：白名单的边界是「一批一条验证命令」，清单的边界是「每条一个决策或一批」——`≤3 个文件` / `≤7 条` 这类数字既不解决验收负担，也会把 5 个同模式文件的机械改写逼成两批。

**为什么有这一段**：主控跑贵模型，没有这段时"步骤一时穷举不出来"会被读成"那我自己做完"（`session-a80150dd`：56 步、2.5 万输出 token，换 +26 行）；而 `using-superpowers` 要求下一步调 `writing-plans`、该 skill 又不在目录里，模型于是又把它读成"那我直接实现"。这两条降级路径都写进了这一段，且这些公用 skill **不改**。

## 完成检查点

`agent/created` 记录每个子代理的父会话；`subagent/end` 在 `completed` 时向父代理投递一条 `[dispatch-protocol]` 消息（每个子代理只发一次，失败/中止不发）。消息模板支持 `{childId}` 与 `{label}` 占位。

## 漏派发提示

五条规则只约束派发的**形式**，没有任何机制要求「必须派发」。实测就有会话全程不派发：`session-a80150dd`（2 回合 / 56 步 / 67 次工具调用 / 0 次派发）把 5 个 XAML 同性质改动判成「小改豁免」自己做了，全程没有任何提示。

本机制把「漏派发」变成可观测事实：

- **触发点**：`agent/turn-stopping`（serial，回合即将收尾、`turn/end` 提交之前）。这里 `steer` 会让本回合再跑一步，因此提醒只花一步，且**每回合最多一次**（按回合号去重，模型回一句「收到」后继续改文件也不会再触发）。
- **计数来源**：该回合已提交的 `tool/call` 事件。事件自带 `turn`，所以不需要任何跨回合状态，恢复的会话算出的数字与实时一致。
- **失败不计数**：写调用的结局要看它的 `tool/result`——`isError === true` 的写入没有落盘，不计入 `writes`/`files`；没有 `callId` 或找不到结果的调用照旧计数（回合被打断时不能把写入抹掉）。
- **触发条件**：本回合**去重文件数** ≥ `nudge.threshold`（默认 2；同一文件多次编辑只算 1）**且**派发调用（`subagent`/`subagent_fork`/`workflow`）为 0。
- **动作**：给主控发一条 `{fileCount}`/`{writes}`/`{files}`/`{turn}` 渲染的提醒（形如「改了 4 个文件（9 次写入）」），并往 `nudge.log`（默认 `%TEMP%\dispatch-protocol-nudge.jsonl`，一行一条 JSON）记一笔账。
- **不适用于子代理**：子代理本身不能再派发，其写操作已经记在父回合里。

只数调用名，不解析副作用：`pwsh` 里 `Set-Content` 之类的写入落在口径之外（不算）；而 `write`/`edit` 按**结果**算——成功才计数，被策略拒绝或抛错的调用（`tool/result.isError === true`）不计。计数按去重路径：同一文件改多次只算 1 个文件。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册任何 section |
| `order` | `500` | 在系统提示词中的排序（必须有限数字） |
| `rules` | 五条默认 | 非空字符串数组，整体替换默认规则 |
| `footer` | 收口段（成本与豁免） | 追加在规则之后；`''` 关闭该段 |
| `checkpoint.enabled` | `true` | 子代理完成后是否给父代理发检查点 |
| `checkpoint.text` | 内置模板 | 覆盖检查点文案，支持 `{childId}` / `{label}` |
| `nudge.enabled` | `true` | 是否检查「漏派发」 |
| `nudge.threshold` | `2` | 本回合去重文件数 ≥ 该值且 0 派发时提醒（正整数） |
| `nudge.writeTools` | `['write','edit']` | 计入「改动」的工具名 |
| `nudge.delegationTools` | `['subagent','subagent_fork','workflow']` | 计入「已派发」的工具名 |
| `nudge.text` | 内置模板 | 覆盖提醒文案，支持 `{fileCount}` / `{writes}` / `{files}` / `{turn}` |
| `nudge.log` | `%TEMP%\dispatch-protocol-nudge.jsonl` | 记账文件路径；`false` 关闭记账 |

非法配置（`order` 非有限数字、`rules` 为空/非数组、`footer`/`checkpoint.text` 非字符串、`nudge.threshold` 非正整数、工具名单为空数组、`nudge.log` 既非路径也非 `false`）在插件加载时直接报错，不会静默降级。

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

漏派发提示的真机口径：一个回合内连续改 2 个以上**去重文件**（同一文件多次编辑只算 1）且不派发，收尾时会多出一段以 `[dispatch-protocol]` 开头的提醒；`%TEMP%\dispatch-protocol-nudge.jsonl` 同时多一行 `{session, turn, writes, files, delegations}`。

## 已知坑

- **系统提示词改动会影响 KV 缓存前缀**：`order` 与文本变化会让后续请求失去前缀复用；规则固定后不要频繁改。
- **section 名重复会报错**：同一 profile 只能挂一个 `dispatch-protocol`；改配置用同 id 覆盖，不要重复插入。
- **规则是建议不是强制**：模型仍可无视。要硬拦截需要 `tools/pre-execute` 那类插件（本项目评估后不做）。
- **漏派发提示要花一步**：`agent/turn-stopping` 里 `steer` 会让本回合再跑一步。按回合去重，一回合最多一次；模型可以只在补充说明里写「为什么没派」而不真的派发——提醒不是强制。
- **触发看文件数、判定看调用名**：是否提醒按去重路径计（同一文件多次编辑算 1 个）；「哪些调用算改动」仍按工具名判断——`pwsh` 里的 `Set-Content`/`dotnet format` 等副作用不计；`write`/`edit` 以 `tool/result.isError` 为准，失败的不计（无结果可查时照算）。
- **记账在 TEMP 里**：`nudge.log` 默认落在系统临时目录，不随仓库版本化；要长期留档就把路径指到固定位置（或 `false` 关掉）。
- **profile 插件不支持热加载**：装完必须重启 DSH，新会话才生效。
- **update 失败会留下半残目录，且可能卡成 delete-pending**：`dsh plugin --profile desktop update` 先把 `node_modules/<pkg>` 整块 rename 掉；任一步失败就可能只剩一半文件，而失败时被打开的子目录（实测是 `lib/`）会进入 delete-pending —— 之后**连改父目录、删除、读 ACL 都 Access denied**，`diagnose-windows-sandbox-acl` 报 `VERDICT=UNREADABLE`、Restart Manager 返回 `ACCESS_DENIED`，只有**重启 Windows** 能清。2026-10-22 踩过一次（`AUDIT-2026-10-22.md` 第七节）。
  - 预防：**完全退出 DSH → update → 启动**；确认没有遗留的 `robocopy`/`pnpm` 子进程再跑（那次真正的持有者是一条被我挂住的 robocopy）。
  - 恢复：重启后 `lib/` 自动消失，重跑同一条 update 即可归位；验收标志是 `lib/config.mjs` 存在且没有手工补丁目录。
