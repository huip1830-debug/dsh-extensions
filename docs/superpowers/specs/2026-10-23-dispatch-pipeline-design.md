# 派发管线设计（证据契约 + 统一补位）

> 日期：2026-10-23
> 状态：设计待评审
> 范围：端到端流程层（dispatch-protocol / subagent-model-pin / dispatch 工具链），插件边界不变
> 依据：`plugins/dispatch-protocol` 0.3.9（HEAD `15fba11`）、`~/.dsh/dispatch/AUDIT-2026-10-22.md`、台账 E-001…E-013、`session-a80150dd` / `session-a9b4842d` 实测

## 1. 目标

**北极星：让每一次「完成」都可归因、可复现、可审计。** 派发是手段，不是目的；机制（规则 / 检查点 / nudge / 评审 / 台账）只在管线缺环时补位。

一个完成声明必须能回答四问：

| 问题 | 证据 |
|---|---|
| 谁做的？ | 主控或子代理 id / label / 路由 |
| 改了什么？ | diff、文件集、白名单比对 |
| 凭什么算完成？ | 派发方独立复跑退出码；gated 批次另加只读评审 `PASS\|FAIL + 文件:行号` |
| 没派发为什么？ | 本回合正文的理由（可被关键词静默，但日志留行） |

### 1.1 约束（按优先级）

1. **北极星：可复现的完成。** 不采信实现者自述，也不只信实现者自己写的测试。
2. **约束 A（成本/延迟）：** 贵模型不做机械活；协调成本有上限——派发往返 + 复跑 + 评审不能超过活本身的价值。
3. **约束 B（可审计）：** 没派发不是违规，但多文件自做必须留下理由；台账是唯一证据库。
4. **约束 C（不打扰）：** 静态规则只写「怎么判」；动态提醒只在答案缺失时出现，且能被已给出的答案抑制；同一回合至多一条；两个机制不得对同一事实重复提醒。

### 1.2 非目标

不新增插件；不做运行时拦截；不做自动批次状态机；不复制真相源；不在第一阶段改系统提示词（避免 KV 缓存抖动）。

### 1.3 为什么不是「成本第一」

成本问题可调（阈值、批次规模、往返次数）；一次「自测全绿、契约失败」（tagify：实现者测试没有重复标签用例，窄验证 4/4 绿，契约两行失败）是不可逆的信任损失。成本若当北极星，最优解是「干脆不派发」，纪律自我否定。所以成本是硬约束，不是方向。

### 1.4 新机制准入规则

任何新机制/提醒上线前必须回答四问，答不全不加：

1. 它补的是管线哪一段的哪个缺环？
2. 现有环节为什么观测不到（而不是「再加一条」）？
3. 它与已有机制是否对同一事实重复？重复时谁让位？
4. 它的效果用什么证据验收（台账编号 + 可复跑命令）？

## 2. 范围与边界

| 组件 | 职责 | 本设计中的角色 |
|---|---|---|
| `dispatch-protocol` | 规则、完成检查点、漏派发提示 | 第 2 段规则与第 3/6 段补位提醒 |
| `subagent-model-pin` | 子代理路由 + 角色/沙箱 | 勘察与评审子代理的只读约束 |
| `~/.dsh/dispatch/` | 快照、会话读取、台账校验、复跑 | 证据工具链 |
| `dispatch-ledger.*` | 唯一证据库 | 完成门禁的机器可读载体 |

**不合并插件**：三件事仍不交叉。管线是流程层，不引入新运行时组件。

## 3. 概念模型

### 3.1 批次（batch）

一次可独立验收的交付单元：

```
batch = 白名单（互斥文件集）+ 唯一集成命令 + 子代理集合（0..n）+ 验收结论
```

- `kind`：`survey`（只读，无 diff）| `write`（有 diff）。
- `class`：`normal` | `gated`（判据见 3.3）。
- `batchId`：进台账时为 `E-xxx`；未进台账的 normal 批次用回合内标签（`turn + description`）。
- 批次是**证据单位**，不是新的工作流步骤。一个小改就是一个 normal 批次，回复里一行证据即可，不多一次往返。

### 3.2 证据契约

缺一项 = `not done`，不是 FAIL。

| 批次 | 必须回答 | 证据 |
|---|---|---|
| `survey` | 结论、依据、不确定项 | 文件:行号 + 与派发前基线一致（`git status` / 快照 diff 无新增）；声称跑过的命令仍需复跑 |
| `write` / `normal` | 谁做的、改了什么、凭什么 | diff/文件集（与白名单比对）+ 派发方独立复跑退出码 |
| `write` / `gated` | 上面全部 + 独立评审 | 冻结契约 + 评审逐条 `PASS\|FAIL + 文件:行号` + 集成命令 `exit 0` + 台账行通过 `ledger.mjs gate` |

### 3.3 分级判据

`gated` 当且仅当满足任一：

1. **并行写**：同一批次内 ≥2 个可写子代理；
2. **契约面**：schema / 类型 / 路由 / 权限 / 迁移 / lockfile / barrel / 公共 API；
3. 用户显式要求评审。

其余为 `normal`。**不确定时默认 gated**，并在台账 `classReason` 记一句判断依据。只读勘察不受门禁约束（无 diff/复跑），但报告必须有文件:行号。

### 3.4 真相源

| 知识 | 唯一位置 | 禁止 |
|---|---|---|
| 规则/机制口径 | 插件 README + 系统提示词 section | 在别处复述 |
| 流程与工具索引 | `~/.dsh/dispatch/README.md` | 复述机制细节 |
| 证据 | `dispatch-ledger.md/jsonl` | README 里存「已验证能力」 |
| 角色/沙箱 | `subagent-model-pin` | 在 dispatch-protocol 里再定义 |

## 4. 数据流

| # | 阶段 | 主控动作 | 产出/证据 | 门禁 |
|---|---|---|---|---|
| 0 | 勘察 | 现状单：文件:行号 + 代码 + 结论 + 不确定项；write 批次定白名单与**一条**集成命令 | 现状文件 | write 缺白名单/集成命令 → 不派发（survey 只需问题清单 + 只读边界） |
| 1 | 分类 | 判 `kind`/`class`；契约面先冻结 | `classReason` | 不确定 → gated |
| 2 | 派发 | 自包含四件套；只读并行、写互斥；角色/沙箱由 model-pin 管 | 子代理 + 派发记录 | write 白名单为空 → 不派发；survey 用只读边界代替 |
| 3 | 回收 | 读 diff + **派发方跑集成命令**；子代理声称的窄命令独立复跑 | 退出码 + 文件集比对 | normal 在此即可标完成（阶段 5/6 用回复内证据，不记台账） |
| 4 | 评审 | gated 才触发：只读评审看需求 + 冻结契约 + diff + 集成结果 | `PASS\|FAIL + 文件:行号` | FAIL → 修复或显式接受并记录 |
| 5 | 记账 | 台账行；`ledger.mjs gate <batchId>` | `E-xxx` | gated：gate 非 0 → 不得标完成 |
| 6 | 完成 | 回复引用批次号 + 退出码 + 评审结论 | 交付 | 缺证据 → not done |

**门禁只在 4/5 两处**：评审子代理是独立证据，`ledger.mjs gate` 是机器校验；两者都不拦截工具调用，符合「运行时不拦截」的既有决定。

## 5. 提醒统一

正常路径下所有提醒发生在 `agent/turn-stopping`（父代理无 hook 作用域时沿用 settle 回退），**每回合至多一条**：

| 优先级 | 提醒 | 触发 | 让位/静默 |
|---|---|---|---|
| 1 | 完成检查点 | 子代理 `completed` + 父代理未验收 | 只读子代理；父代理已按汇报动过手（既有三条判据） |
| 2 | 漏派发提示 | ≥2 去重文件 + 0 派发 + 正文未解释 | 本回合是验收回合（复用「父代理已动手」判据）；上一回合（turn-1）刚投递过检查点（一回合宽限） |
| — | 静默 | 其余 | — |

- **nudge 让位**：checkpoint 优先；同一回合两者都命中时只发 checkpoint。checkpoint 自身被抑制（只读/已验收）时，nudge 仍按自身条件判定。
- **验收回合抑制**：本回合父代理已按某个 pending 子代理的汇报动过手 → nudge 不发（这回合本来就在验收，不是漏派）。
- **一回合宽限**：上一回合（turn-1）刚投递过检查点 → 本回合 nudge 静默。已知代价：刚验收完就真漏派会少提醒一次，方向是「宁可少打扰」。
- **nudge 仍只观测**：它不是完成门禁；质量门禁由评审 + 台账承担。
- **共享判定**：「父代理已按汇报动手」与「子代理只读」两个判据只实现一次，checkpoint 与 nudge 共用；每回合一个 `delivered` 标记，防止两个监听器各自 `steer`。

### 5.1 决定日志

统一为一条决定一行（含被抑制的），默认 `%TEMP%\dispatch-protocol-decisions.jsonl`：

```json
{"time":"...","session":"...","turn":36,"kind":"checkpoint|nudge","decision":"delivered|suppressed","reason":"justified|handled|read-only|grace","writes":3,"files":[...],"delegations":0}
```

旧 `nudge.jsonl` 不再写；README 注一句迁移，旧文件可删。

## 6. 失败处理

| 情形 | 管线动作 | 证据 |
|---|---|---|
| 子代理失败/中止 | 不登记检查点；批次保持 open；台账可记 `FAIL` | 子会话 `stopReason` + 工具序列 |
| 集成命令失败 | 不得标完成；修复后重跑 | 退出码（含失败那次） |
| 评审 FAIL | 修复后**重评**；用户接受风险才可完成 | `review.verdict` + `acceptedRisk` + 理由 |
| 证据缺失 | 状态是 `not done`，不是 FAIL | 缺哪项记哪项 |
| 台账校验失败 | gated 批次阻断完成 | `ledger.mjs gate <id>` exit 1 |
| 回合被中断 | 按已提交事件计；结果缺失记 `unknown`，不算 PASS | 会话事件 |

## 7. 台账契约

### 7.1 新增可选字段（旧行向后兼容）

| 字段 | 类型 | 说明 |
|---|---|---|
| `batchId` | string | 批次号；缺省时用 `id`（旧行为） |
| `batchClass` | `"normal"` / `"gated"` | 缺省 = legacy，按 normal 处理 |
| `classReason` | string | gated 必填；默认判 gated 时写清为什么 |
| `children` | string[] | 多子代理批次的全量 id；单子代理可省 |
| `review` | object | `{ by, verdict: "PASS"\|"FAIL", sandbox?, notes }`；`sandbox` 只记录，gate 不强制（只读由角色策略保证） |
| `checks[].scope` | `"integration"` / `"narrow"` | 缺省按 narrow；gate 要求至少一条 integration |
| `acceptedRisk` | boolean | 为 true 时需 `acceptNote` 非空 |

- 多子代理批次：`child` 置 `batch:<batchId>`，`children` 列全量；去重键在 `batchId` 存在时用 `batchId`，否则沿用 `child|artifact.sha256`。
- `ledger.mjs check`：只做完整性/自洽校验（现状 + 新字段类型），不判断 PASS。
- `ledger.mjs gate <batchId>`：gated 完成门禁：
  - 行存在且 `batchClass === "gated"`；`classReason` 非空；
  - `review.by` 非空；若 `children` 存在，`review.by` 必须是其成员；`review.verdict === "PASS"`（或 `acceptedRisk === true` + `acceptNote`）；
  - 至少一条 `scope === "integration"`、`kind === "process-exit"`、`code === 0`、`by === "dispatcher-rerun"`（或 `cmdlet-success` + `success === true`）；
  - `verdict.behavior === "pass"`（`acceptedRisk` 时允许 fail）。
- 第一阶段不自动生成台账行；行仍由主控写，`gate` 只校验。

## 8. 成本模型

实测锚点（`steps` 含思考步；`chars` 为输出字符代理值，不是精确 token）：

| 场景 | 主控 steps | 工具调用 | 主控输出 chars | 子代理 | 结果 |
|---|---:|---:|---:|---|---|
| 内联做完（`a80150dd`） | 59 | 69 | 4,811 | 0 | 5 文件 / +26 行 |
| E-010 三批往返 | 37 | 39 | 4,764 | 1（1,750 字 brief） | 4 文件小改 |
| **normal 单批（估）** | **10–14** | **8–10** | **2–4k** | 1 | 同 E-010 的活 |
| **gated 单批（估）** | **14–18** | **11–14** | **3–5k** | 1 + 1 评审（只读） | 契约面/并行写 |
| survey（估） | 3–5 | 2–3 | 0.5–1.5k | 1..n 只读 | 无 diff/复跑 |

口径补充：`a80150dd` 的 59 步 / 69 调用含第 3 回合收尾（28+28+3）；审查报告里的 56 步 / 67 调用只计前两回合。E-010 为 turn 28–31 的主控步骤（8+17+6+6）。

### 8.1 主控动作清单

1. 判类 + 定白名单/集成命令（判断，无工具）；
2. 写 brief（600–1,800 字）；
3. 派发；
4. 回收：读汇报 + diff + 跑集成命令；
5. 评审（仅 gated）：派只读评审 + 读摘要；
6. 记账（仅 gated）：台账行 + gate；
7. 收尾：完成声明引用证据；
8. 响应提醒：仅证据缺失时，最多 1 次/回合。

**不做**：写子代理的实现代码（除豁免）、复跑每条窄命令、读完整子会话记录、维护独立状态、给 normal 记账、同回合同一发两条提醒。

### 8.2 成本红线

1. normal 不记账、不评审，回复内一行证据；
2. brief 模板化，≤800 字，现状单复用；
3. 子代理输出合同 ≤10 行（改动行/命令/exit/白名单差异）；
4. gated 用 `ledger.mjs gate <id>` 一条命令收口；
5. 系统提示词不动。

## 9. 验证计划

- **离线单测**（`plugins/dispatch-protocol/test.mjs`）：提醒优先级（同回合 checkpoint+nudge 只发 checkpoint）、验收回合抑制、一回合宽限、决定日志字段、既有 39 条断言不回归。
- **台账夹具**：legacy 行（无 `batchClass`）通过；normal 行通过；gated 完整 → `gate` 0；缺 review / 缺 integration / verdict fail → `gate` 1。
- **Mock LLM（沿用 E-008 方式）**：① gated 缺评审 → gate 1；② 补齐 → gate 0；③ 同回合两条件 → 只 1 条提醒；④ 已解释 → 静默。
- **真机**：独立小仓跑一个完整 gated 批次 → 台账 `E-014`。验收标志：`node test.mjs` exit 0 + `node ledger.mjs gate E-014` exit 0 + 评审记录可查。
- **成功判据**：审计样本中 gated 批次 100% 有评审 + 台账；每回合提醒 ≤1；验收回合 0 条 nudge；normal 批次不增加往返。

## 10. 落地顺序（每阶段一条集成命令）

1. **台账契约**（文档 + `ledger.mjs` 字段/`gate` + 夹具）→ `node ledger.mjs check` + gate 夹具 exit 0/1；不改插件。
2. **提醒统一**（`plugin.mjs` / `nudge.mjs` / `test.mjs` + 决定日志）→ `node test.mjs`。
3. **流程模板**（`~/.dsh/dispatch/README.md` 完成清单；仅在探针证明需要时改 checkpoint 文案）→ 文档自检 + dry run。
4. **真机探针 + 台账 + 发布**（commit → `dsh plugin --profile desktop update dispatch-protocol` → 重启 → 记录）→ `node test.mjs` + `node ledger.mjs gate E-014`。

发布必须完全退出 DSH（EPERM 教训，见 `AUDIT-2026-10-22.md` 第七节）。`ledger.mjs` 位于 `~/.dsh/dispatch/`，不在本仓库；其改动需直接落到该目录，并在那里跑验收命令。

## 11. 已知风险

1. **分类自判**：normal 误判会绕过评审——默认 gated + `classReason` + 抽样审计；
2. **台账靠人写**：`gate` 只校验不生成，主控可能忘写——checkpoint 文案已提示「记入台账」；
3. **一回合宽限**：真漏派可能少提醒一次，方向是「宁可少打扰」；
4. **评审只读**：评审要写报告需单独角色 `workspace-write`（沿用现有边界）；
5. **系统提示词**：本设计不改，但未来若加文本，需评估 KV 缓存前缀；
6. **Windows 更新**：`dsh plugin update` 期间必须有 DSH 完全退出，否则 delete-pending。

## 12. 备选方案与决策

| 方案 | 取舍 | 结论 |
|---|---|---|
| A 证据契约 + 统一补位 | 不新增插件；小改台账/提醒；分批可验收 | **采用** |
| B 批次状态机 | 一致性最强，但需新事件模型/跨插件协调，推断错会放大 | 拒绝（过度设计） |
| C 台账优先 | 改动最小，但事后审计、回合内无引导 | 拒绝（治不了旧问题） |
| 删除 nudge | 省一步，但失去「0 派发」唯一观测 | 拒绝；nudge 保留、让位、非门禁 |

**决策记录**：目标=可复现的完成（质量/证据第一）；范围=端到端流程层；门槛=流程门禁 + 分级；形态=A；成本=接受 gated 多 2–3 步 + 1 只读评审；nudge=保留但让位。

## 13. 证据索引

- 审查与根因：`~/.dsh/dispatch/AUDIT-2026-10-22.md`（S1–S8、4.x 目标态）
- 真机成本样本：`session-a80150dd`（59 步内联）、`session-a9b4842d` turn 28–31（E-010 三批）、turn 37（E-011）
- nudge 真机证据：`README` 0.3.6 节；`dispatch-ledger.jsonl` E-008/E-009/E-011
- 检查点时序：`README` 0.3.4 节；`session-96dda908`、`session-f1248a2b`
- 0.3.9 评审样本：tagify 契约表两行失败 → 只读评审 FAIL → 补去重 → 复评 PASS
- 当前 HEAD：`15fba11`；部署：desktop 0.3.9
