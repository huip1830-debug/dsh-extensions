# 派发管线实施计划

> 日期：2026-10-23
> 依据：[设计文档](../specs/2026-10-23-dispatch-pipeline-design.md)（`b758e74`）
> 状态：待执行
> 说明：本会话没有 `writing-plans` skill，按派发纪律「缺计划类 skill 时先写任务清单」自写；每条 = 一个决策点或一批派发。

## 0. 前置事实

- 仓库 HEAD `15fba11`，工作区干净；`dispatch-protocol` 回归 39/39，exit 0。
- desktop 部署 0.3.9；`probe` 为 `link:` → 直接吃工作区。
- `~/.dsh/dispatch/` 与台账**不在版本控制内**；改动前记录 SHA-256 与备份。
- 本计划不改系统提示词（设计 §1.2）；不改角色/沙箱归属。
- 每个实现批次：子代理只跑自己的窄验证；主控在全批结束后复跑集成命令、记台账、提交。

## 1. 批次总览

| ID | 内容 | 类型 | 白名单 | 集成命令 | 依赖 |
|---|---|---|---|---|---|
| P0a | 插件现状勘察（只读） | survey | 仅 `dsh-verify\P0\现状-plugin.md` | 现状文件存在 + `git status` 干净 | 无 |
| P0b | 台账工具链勘察（只读） | survey | 仅 `dsh-verify\P0\现状-ledger.md` | 同上 | 无 |
| P1 | `ledger.mjs gate` + 字段 + 夹具 | normal | `~/.dsh/dispatch/*`（见 §3） | `pwsh -File ~/.dsh/dispatch/verify-gate.ps1` | P0b |
| P2a | 提醒协调器（checkpoint 优先） | normal | `plugin.mjs`、`test.mjs` | `node test.mjs` | P0a |
| P2b | nudge 让位 + 决定日志 | normal | `plugin.mjs`、`lib/nudge.mjs`、`lib/config.mjs`、`test.mjs`、`README.md`、`cordis.patch.yml`、`package.json` | `node test.mjs` | P2a |
| P3 | 流程/机制文档收口 | normal | `~/.dsh/dispatch/README.md`、`plugins/dispatch-protocol/README.md`、`cordis.patch.yml`、`dsh-verify\P3\verify-docs.ps1` | `pwsh -File C:\Users\Administrator\dsh-verify\P3\verify-docs.ps1` | P1、P2b |
| P4 | 真机探针 + 只读评审 + 发布 | **gated**（发布/行为变更） | 无代码；`dsh-verify\P4\*`、`dispatch-ledger.*`、profile | `pwsh -File C:\Users\Administrator\dsh-verify\P4\verify-release.ps1` | P1、P2b、P3 |

P0a/P0b 可并行（只读）；P1/P2 写不同目录，但按串行执行以便归因；P2a→P2b 同文件，必须串行。

## 2. P0 现状勘察（只读，可并行）

### P0a 插件现状

- 读取：`plugins/dispatch-protocol/plugin.mjs`、`lib/nudge.mjs`、`lib/config.mjs`、`test.mjs`（重点 680–818 夹具）、`README.md`、`cordis.patch.yml`。
- 产出：`C:\Users\Administrator\dsh-verify\P0\现状-plugin.md`，每节含 `文件:行号 + 相关代码 + 结论 + 不确定项`，至少覆盖：  - `registerNudge` / `registerCheckpoint` / `parentAlreadyHandled` / `recordNudge` 的当前行号与调用关系；
  - `justifiedInTurn`、`resolveNudge`、`shouldNudge` 的签名与日志路径；
  - `test.mjs` 的 `call/result/harness` 夹具签名，以及新增“同回合两条件只发一条”用例的插入点；
  - 现有 39 条用例清单（名称 + 断言点）。
- 只读：禁止写仓库、禁止 git 写命令。
- 验证：`Get-ChildItem C:\Users\Administrator\dsh-verify\P0\现状-plugin.md`；`git status --porcelain` 为空。

### P0b 台账工具链现状

- 读取：`~/.dsh/dispatch/ledger.mjs`、`~/.dsh/dispatch/README.md`、`~/.dsh/dispatch-ledger.jsonl`（形状与现有 13 行）、`dispatch-ledger.md` 的 E-010/E-011/E-012。
- 产出：`C:\Users\Administrator\dsh-verify\P0\现状-ledger.md`，覆盖：
  - `REQUIRED`/`VERDICT_DIMS`/`checks` 校验的当前行号；
  - 去重键 `child|artifact.sha256` 的实现位置；
  - 现有 `checks[]` 的 `kind`/`by` 取值分布；
  - 新增 `gate` 子命令与可选字段的插入点、向后兼容风险。
- 只读：禁止修改 `~/.dsh/dispatch` 与台账。
- 验证：同 P0a。

## 3. P1 台账 gate（normal）

- 现状引用：P0b 的 `现状-ledger.md`；当前 `ledger.mjs` 92 行，`REQUIRED = ['id','child','description','route','checks','verdict']`，无 `gate` 子命令。
- 白名单（逐条）：
  - `C:\Users\Administrator\.dsh\dispatch\ledger.mjs`
  - `C:\Users\Administrator\.dsh\dispatch\README.md`
  - `C:\Users\Administrator\.dsh\dispatch\gate-fixtures\*.jsonl`（新建）
  - `C:\Users\Administrator\.dsh\dispatch\verify-gate.ps1`（新建）
- 动作：
  1. `check` 增加可选字段校验：`batchClass`（normal/gated）、`classReason`、`children`、`review{by,verdict,sandbox?,notes}`、`checks[].scope`、`acceptedRisk/acceptNote`；`batchId` 存在时去重键用 `batchId`，否则沿用旧键；旧行不报错。
  2. 新增 `gate <batchId> [--file] [--json]`：按 §7.1 的 gated 条件校验，打印 `RESULT: PASS|FAIL`，exit 0/1。
  3. 夹具 6 条：legacy、normal、gated 完整、缺 review、缺 integration、review FAIL + acceptedRisk；`verify-gate.ps1` 断言各自 exit。
  4. README 增补 gate 用法、字段表、完成清单（批次 → 证据 → gate）。
- 集成命令：`pwsh -File C:\Users\Administrator\.dsh\dispatch\verify-gate.ps1`，必须 exit 0；脚本内部先跑真实台账 `node ledger.mjs check`（现有 13 行仍 PASS），再跑夹具。
- 验收：命令 exit 0；`git status` 不受影响（工具链不在仓库）；记录 `ledger.mjs` 改前/改后 SHA-256 到台账备注。
- 风险：工具链无版本控制——先备份；`gate` 不得改变 `check` 对旧行的行为。

## 4. P2 提醒统一（normal；P2a → P2b 串行）

### P2a 协调器（checkpoint 优先，一回合一条）

- 现状引用：P0a 的 `现状-plugin.md`；当前 `plugin.mjs` 347 行：`registerNudge` L156、`registerCheckpoint` L206、`parentAlreadyHandled` L304、`apply` L135。
- 白名单：`plugins/dispatch-protocol/plugin.mjs`、`plugins/dispatch-protocol/test.mjs`。
- 动作：
  1. 抽出每父代理的提醒协调器：单一 `agent/turn-stopping` 处理器，先 drain checkpoint，再评估 nudge；每回合 `delivered` 标记保证最多一条。
  2. 保留现有语义：checkpoint 的 read-only 跳过、`parentAlreadyHandled` 去重、settle 回退；nudge 的阈值、成功写入计数、`justifiedInTurn` 抑制。
  3. 共享判定函数只实现一次（read-only / handled），不得复制。
  4. 新增用例：同回合 checkpoint+nudge 只发 checkpoint；checkpoint 被抑制时 nudge 仍可发；单回合不重复。
- 集成命令：`cd plugins\dispatch-protocol; node test.mjs`，exit 0（39 + 新增）。
- 验收：既有 39 条零改动通过；新增用例覆盖两条消息源的竞争。

### P2b nudge 让位 + 决定日志

- 白名单：`plugin.mjs`、`lib/nudge.mjs`、`lib/config.mjs`、`test.mjs`、`README.md`、`cordis.patch.yml`、`package.json`（版本 0.3.10）。
- 动作：
  1. nudge 抑制：本回合存在已处理的 checkpoint（复用 handled 判据）→ 静默；上一回合（turn-1）投递过 checkpoint → 静默（一回合宽限）。
  2. 决定日志：默认 `%TEMP%\dispatch-protocol-decisions.jsonl`，字段 `{time,session,turn,kind,decision,reason,writes?,files?,delegations?}`；delivered 与 suppressed 都记；`nudge.log` 配置键保留（兼容显式路径），默认值改指新文件；README 注迁移。
  3. 测试：acceptance-turn 抑制、grace、日志 `kind/decision/reason`、旧 `nudge.log` 显式路径仍生效。
- 集成命令：`cd plugins\dispatch-protocol; node test.mjs`，exit 0。
- 验收：新用例通过；`node test.mjs` 总数 = 39 + 新增；无系统提示词 diff（`git diff` 只含白名单文件）。

## 5. P3 文档/配置收口（normal）

- 白名单：`C:\Users\Administrator\.dsh\dispatch\README.md`、`plugins/dispatch-protocol/README.md`、`plugins/dispatch-protocol/cordis.patch.yml`、`C:\Users\Administrator\dsh-verify\P3\verify-docs.ps1`（新建）。
- 动作：完成清单（批次/证据/gate）、决定日志迁移、nudge 优先级与宽限、配置注释；不复述对方口径，只链接。**插件 README 顶部的部署版本行不在 P3 改**，由 P4 发布后回写。
- 集成命令：`pwsh -File C:\Users\Administrator\dsh-verify\P3\verify-docs.ps1`（断言两份 README 含指定小节、链接存在、无重复“已验证能力”段；内部再跑一次 `node test.mjs`），exit 0。
- 验收：命令 exit 0；`git diff --stat` 仅三文件。

## 6. P4 真机探针 + 只读评审 + 发布（gated，主控执行）

- 分类理由：`classReason = "release + reminder behavior change"`；gated。
- 步骤：
  1. 在 `C:\Users\Administrator\dsh-verify\P4\` 建最小场景：一条 gated 批次（1 个写子代理 + 1 个只读评审；契约面用一份冻结 JSON schema）。
  2. 先跑“缺评审/缺台账”分支 → `ledger.mjs gate E-014` exit 1；补齐评审 PASS + integration exit 0 + 台账行 → exit 0。
  3. 只读评审子代理：输入设计文档 + `git diff` + `node test.mjs` 输出 + P4 探针结果；逐条 `PASS|FAIL + 文件:行号`；不得改文件；主控裁决。
  4. 主控复跑 `node test.mjs`、`ledger.mjs check`、`ledger.mjs gate E-014`，记录退出码。
  5. 提交 P2/P3；完全退出 DSH → `dsh plugin --profile desktop update dispatch-protocol` → 启动 → 已装副本 `node test.mjs` + 版本核对 0.3.10。
  6. 发布后回写插件 README 顶部部署行与台账（`dispatch-ledger.md/jsonl` + `ledger.mjs check`）。
- 集成命令：`pwsh -File C:\Users\Administrator\dsh-verify\P4\verify-release.ps1`（已装副本测试 + gate E-014 + 版本断言），exit 0。
- 验收：`E-014` 在台账；`gate E-014` exit 0；desktop bundles 仍含插件；`shared/` 不存在、`lib/` 存在。
- 风险：Windows update EPERM（必须完全退出 DSH，确认无 robocopy/pnpm 子进程）。

## 7. 验收与提交规则

- 每批结束：主控独立复跑该批唯一命令并记录退出码；子代理自述不作为证据。
- 提交权在主控；子代理不得 commit/push/reset/clean。
- P1 工具链不版本化：改前备份 + 记录哈希；P2/P3 在仓库提交；P4 更新 profile 并记台账。
- 失败即停：`node test.mjs` fail、`gate` 非 0、评审 FAIL 未裁决 → 不得进入下一批。

## 8. 风险与回退

| 风险 | 处置 |
|---|---|
| 协调器重构引入回归 | P2a 只做等价重构 + 新竞争用例；既有 39 条必须零改动通过 |
| 日志路径/格式变更 | 保留 `nudge.log` 显式配置；README 迁移说明；旧文件可删 |
| 工具链不在版本控制 | 改前备份 `ledger.mjs`，记录 SHA-256；失败可原样恢复 |
| 文档口径漂移 | P3 只写流程/索引，机制细节链接插件 README |
| Windows 更新 delete-pending | 完全退出 DSH、确认无 robocopy/pnpm；重启 Windows 兜底 |
| 分类误判 | P4 显式 gated + classReason；normal 批次抽样审计 |

## 9. 不在本次范围

自动生成台账行；运行时拦截；系统提示词文本；新插件；角色/沙箱重构；`dispatch-guard` 去留（仍归档）。
