# 派发管线小版本升级方案（0.3.10 → 0.4.0）

> 日期：2026-10-24
> 状态：**已实施**（`53d2023`，dispatch-protocol 0.4.0；P1 角色表落在 desktop profile 的 `cordis.patch.yml`，不在本仓库）。P1–P6 全部交付，测试 58/58 绿。
> 依据：`docs/reviews/2026-10-23-dispatch-pipeline-review.md` §8 自审计的处置清单
> 边界（小版本 = 不动这些）：不改 DSH 核心系统提示词；不新增插件；不做运行时拦截；不动 `subagent-model-pin` 代码；`gate` 强制与 `~/.dsh/dispatch/` 工具链恢复留给下一版。
> 已核实的实现事实（决定方案形态）：
> - `subagent-model-pin` 角色匹配是 **description 大小写不敏感前缀匹配**（`lib/routes.mjs resolveRoute`）→ G8 修复零代码，纯配置。
> - nudge 的唯一评估点是 `agent/turn-stopping` → 覆盖被打断回合的最稳做法是不赌 hook 触发条件，**在下一回合开始时对上一未评估回合补评估**。
> - `ranReadOnly` 与 nudge 的写工具白名单是两份硬编码（`['write','edit']`）→ 统一成一个 `touchesFile` 判定，一处实现两处共用。

## 1. 纳入本版本的 6 项

| # | 治 | 改动 | 量 | 验收（每条可复跑） |
|---|---|---|---|---|
| **P1** | G8 只读角色未生效 | **零代码**：`cordis.patch.yml` 的 `subagent-model-pin.roles` 加中文前缀角色：`评审` / `勘察` / `只读` → `sandbox: read-only`（路由沿用默认） | 配置 ~10 行 | 新开会话派一个 description 以「评审」开头的子代理 → 子会话日志出现 `sandbox/mode read-only`，其 `write` 被拒 |
| **P2** | N2 nudge 对被打断回合失明 | dispatch-protocol：回合 N 开始时，若回合 N−1 从未做过 nudge 评估且满足条件（≥2 去重文件、0 派发、正文无解释），补发一条；决定日志记 `reason:'deferred-abort'` | ~30 行 + 测试 | `node test.mjs` 新用例（turn 5 无评估 → turn 6 开头补一条）；真机：故意打断一个多文件回合，下一回合日志有行 |
| **P3** | G6 pwsh 写操作不计入 | dispatch-protocol：新增统一的 `touchesFile(toolCall)`——`write`/`edit` 直接计入；`pwsh` 仅当命令命中变更动词（`Remove-Item`/`Set-Content`/`Out-File`/`Add-Content`/`New-Item`/`Copy-Item`/`Move-Item`/`git apply|checkout|restore|commit`、`del`/`ren`/`tee` 等）才计入；nudge 计数与 `ranReadOnly` 共用此判定 | ~40 行 + 测试 | W-5 场景单测：子代理用 `pwsh Remove-Item` 删文件、零 `write`/`edit` → 不判 read-only，checkpoint 正常投递 |
| **P4** | G6 checkpoint 按子代理线性放大 | dispatch-protocol：`drain` 把同一回合所有 pending 子代理合并成**一条** steer（列出 N 个待验收），不再每个一条 | ~20 行 + 测试 | 单测：3 个 pending → 1 行 delivered；真机决定日志每个波次 ≤1 行 delivered |
| **P5** | G2 判级绕过 / G4 不重评 / N1 派发触发 | dispatch-protocol 自有 `systemPrompt.section` 文本加三句：① 同一需求的所有批次合并判级，不得按子代理切分绕过 gated；② 评审通过后任何改动（含主控自修）须重开该 slice 评审包；③ 实现类任务开工前，计划必须显式列出拆批方案或不派发理由 | 文本 ≤300 字符 | 新会话请求里该 section 含三句；改动仅限插件自有段，不动核心提示词 |
| **P6** | G1/G7 证据不落盘 | dispatch-protocol：turn-stopping 时把本回合观测（writes/files/delegations + 本回合 pwsh 命令与退出码 + 时间）追加为一条 jsonl **观测行**（仓库 `dispatch/runs/<sessionId>.jsonl` 或 profile 目录，配置可选路径）。明确：**观测行不参与 gate、不阻断任何事** | ~60 行 + 测试 | 跑一个真实小任务 → 每个有写回合一行，字段齐全；模拟压缩后凭文件能回答「谁做的、改了什么」 |

**顺序建议**：P1 → P5 → P3 → P4 → P2 → P6。P1/P5 十分钟级；P3/P4/P2 各半天内；P6 是本版本最大项——若想让版本更小，砍 P6 留到下一版（连同 `gate` 命令与工具链恢复一起做），前五项仍自成闭环。

**版本号**：dispatch-protocol 0.3.10 → **0.4.0**（P2/P6 是新机制，算 minor）；subagent-model-pin 不动版本，仅 profile 配置变更。

## 2. 明确不纳入（审计 §8.5 裁决，勿在小版本里夹带）

ChangeSet 对象模型；依赖 DAG 机械化；fan-out 硬路数上限；跨会话 worktree/lease；`gate` 强制阻断；DSH 核心系统提示词；评审全量复跑强制。这些每一项都会把小版本拖成大改，且其中几项已被裁决为过度设计。

## 3. 已知风险与边界

1. **P3 是启发式**：命令文本提到 `Remove-Item` 但未实际执行会误计入。方向与现有防御风格一致（宁多提醒一次）；误判成本 = 多一条可被静默的提醒。
2. **P2 的提醒是"迟到的"**：打断已发生，下一回合才补。它纠正的是"零观测"，不是"实时拦截"——符合 nudge 只观测不门禁的定位。
3. **P5 改的是插件自有提示词段**：会移动该段的 KV 缓存，影响面远小于改核心提示词；三句合计 ≤300 字符。
4. **P6 观测行的路径**：放仓库 `dispatch/runs/` 才能进版本控制（治 G7 的"证据可复现"）；放 profile/%TEMP% 则只是本机排查用。建议默认仓库路径，`.gitignore` 由用户决定。
5. **发布**：完全退出 DSH 再 `dsh plugin --profile desktop update dispatch-protocol`（EPERM 教训）；插件改动**新开会话才生效**（不热加载、角色白名单按会话冻结）；在旧会话里改 `cordis.patch.yml` 无效。

## 4. 升级后的对比实验协议

升级后跑 2–3 个真实任务（建议一个实现类中型任务 + 一个审查类任务，与样本 3 形态对齐），**固定采集口径**保证与三个历史样本可比：

| 指标 | 采集方式 |
|---|---|
| 回合 / 步 / 工具调用 / 墙钟 | 解码 `session.v4.jsonl.zstd`（`docs/reviews/tools/decode-session.mjs`） |
| 派发次数与类型、brief 长度、主控直接 write/edit 次数与文件数 | `tool/call` 事件统计（`docs/reviews/tools/evidence.mjs`） |
| 提醒决定（含 suppressed） | `%TEMP%\dispatch-protocol-decisions.jsonl` |
| 子代理沙箱与路由 | 子会话 `sandbox/mode`、`request/context` 事件 |
| 观测台账行（P6） | `dispatch/runs/*.jsonl` |

**生效判据（逐项对应 P1–P6）：**
1. 以「评审/勘察」开头的子代理：子会话 `sandbox/mode=read-only` 且写盘被拒；
2. 出现打断回合时，下一回合有 nudge 行（delivered 或带 reason 的 suppressed），不再 0 行；
3. pwsh 删除/写入型子代理不再被误判 read-only；
4. 同一波次多个子代理完成 → checkpoint 仅一条；
5. 实现类任务的 todo/计划里出现拆批条目或显式不派发理由（观察项，不强制）；
6. 若含 P6：压缩后凭观测行仍能回答「谁做的、改了什么」；
7. **回归**：`node test.mjs` 全绿；单文件小改回合仍静默（约束 C 不破）；正常派发流程的 checkpoint 不误伤。

**对比判据（相对样本 3）：** 实现类任务中「提醒前主控 inline 编辑数」应从 43 次/14 文件降到 0（要么先派发、要么有显式理由）；评审类子代理沙箱从 0% read-only 到 100%；每波次提醒从 N 行到 ≤1 行。
