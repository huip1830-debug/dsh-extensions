# S5 复核报告（dispatch-protocol 0.4.0 / session-df9232a1-9604-4375-95b7-bd094537a520）

> 只读复核子代理（a139b963）产出，全程只读；唯一产物是 28 个 `tmp\sub-<agentId前8>.jsonl` 子会话解码文件。判据：`docs/superpowers/2026-10-25-dispatch-pipeline-continuation.md` §4.3/§4.4/§5；现状引用：`docs/reviews/evidence/2026-10-26-tri-sample-status.md`。

## 0. 头号结论

**§4.3 判据 1 实测 FAIL：read-only 沙箱覆盖率 0/12（含「F1切片重审」为 0/13；全会话 0/28）。**

- 13 个只读意图子会话的开头事件全为 `sandbox/mode = danger-full-access`、`source=delegation`，且每个文件只有 1 条 sandbox/mode 事件（`subagent-model-pin` 的 `applyRoleSandbox` 从未追加第二条收窄事件）；同一子会话的 runtime-context 亦写着 `Current DSH file policy: danger-full-access`。
- 根因在配置层，不是插件代码：本机 `cordis.patch.yml` 的 `subagent-model-pin.roles` 只剩 `match: Survey` / `match: Review`（英文），没有「评审/勘察/只读」；`subagent-model-pin/lib/routes.mjs` 是字面前缀匹配 → 中文 label 全部 `matched:false` → sandbox 取 fallback（未配置）→ 子会话继承父会话 danger-full-access。
- 该 profile 的 mtime 为 `2026-10-26 10:06:53`，早于会话开始（10:07:47）且此后无写入 → S5 期间即为此内容。与接续手册「roles 段含中文前缀角色」及评审主文档 §9.1「样本四 4/5 生效」矛盾：**P1 的只读收窄在 10-26 上午重发插件后丢失**。
- 只读目前只靠 prompt 保证：13 个只读子代理实测 0 次仓库写入（无 write/edit，pwsh 也未改仓库），属行为合规而非沙箱兜底 → G8 缺口在 S5 复现。

## 1. read-only 覆盖率（逐个解码）

分母 28 次 subagent 调用 = 13 只读意图（12 个「审查/评审」前缀 + 1 个「F1切片重审」）+ 15 写批次（15/15 含【允许修改】+【验证：唯一一条命令】）。

| 口径 | 数字 |
|---|---|
| 严格「评审/审查/勘察/只读/复审」前缀（12 个） | **0/12** |
| 加语义只读的「F1切片重审」 | **0/13** |
| 全部 28 个子代理 | 0/28 |
| 决策日志 reason 分布（行为口径，非 label） | 28 checkpoint = read-only 9 + handled 19 + delivered 0 |
| 只读意图子代理实际仓库写入 | 0 次（13/13 行为只读，非沙箱兜底） |

明细（childId / label / 日志 reason）：cbd6521a 审查仓库选择后端链路 read-only；5ea0fb33 审查设备常用品类全栈 read-only；04f4cc92 审查WPF仓库选择常用品类 read-only；a6695a15 审查采购入库推送链路 read-only；f40a354a 审查打级分割成本链路 read-only；4c7c3b22 评审WPF修复FC-4/5/6 read-only；465e0a0a 评审后端修复FC-1/2/3 read-only；fc196d6d 二轮评审后端FC-7/8/9 read-only；269f3eb2 三轮评审WPF FC-13/14 read-only；**4c07f511 审查WPF打级打印生命周期 handled**；**b9443879 二轮评审WPF FC-10 handled**；**5a3df4d5 三轮评审后端FC-11/12/14 handled**；**676f9f29 F1切片重审 handled**。全部 sandbox=danger-full-access。

## 2. 主控 inline 编辑（§4.4 指标一）

主控 write/edit 共 39 次调用（36 edit + 3 write；34 成功 / 5 被文件观察策略拒绝），落在 9 个文件：**代码 2 次 / 2 文件，md 37 次 / 7 文件**。

- 代码（唯一一处）：turn 9 `SalesOutboundViewModel.cs` + `SalesOutboundViewModelTests.cs`——同回合原文「现在执行派发方自修项——SalesOutbound 单价区同模式守卫」（跨批横切守卫，不在任何批白名单内），且同回合另派 2 个只读评审。有显式理由 → 指标一达标（样本三 43/14 → 样本四 0 → S5 2/2 带理由）。
- md 文档：dispatch 三份（situation/report/fix-plan）+ docs/agent 三份 + spec 一份。
- 判定：**不存在「该派发未派发」**。

## 3. nudge 恰当性（3 delivered + 1 suppressed）

| 回合 | 决策行 | 内容 | 判定 |
|---|---|---|---|
| t11 | writes=11 / 5 文件 | 全是 md 文档同步 | 边界命中；模型当场补一行不派发理由（成本 1 step） |
| t20 | writes=6 / 3 md | 同上 | 同上 |
| t29 | suppressed handled | 同类文档回合 | 设计正确（同回合有 handled 检查点，nudge 让位） |
| t34 | writes=0 / files=[] / shellWrites=2 | git 提交回合 | **I3 误报** |

t34 还原：`git checkout -- components.d.ts`、`git add -A; git commit -m …`、`git push origin main`。mutation pattern 命中 `git checkout`+`git commit` → shellWrites=2 ≥ 阈值 → 投递，且文案把 shell 变更说成「改了 2 个文件（2 次写入）」。（派发方复跑：tmp\verify-i5c.mjs 证实 `git add -A; git commit` 命中、`git -C <path> commit` 不命中。）

## 4. 观测行完整性

按插件同一算法从会话日志重算，与观测行文件逐行完全一致：**18 个应有回合 / 18 有行；共 21 行 = 18 + 3 重复（t11/t20/t34），无漏行**。重复行恰好等于 3 个 nudge-delivered 回合（间隔 8–13 秒）→ I4 机制坐实（3/3 相关：nudge steer 使回合再收尾一次）。

## 5. 回归

- 单文件小改静默：t19/t24/t28/t31（各 1 md、0 派发、< 阈值 2）均无决策行、无提醒 → PASS。
- `node plugins/dispatch-protocol/test.mjs` 独立复跑：tests 58 / pass 58 / fail 0 / EXITCODE=0。
- 新形态（I5 候选）：mutation pattern 没有「仓库作用域」概念——`>` 到 `$env:TEMP`、`Out-File` 到 %TEMP%、字符串里的 `->`、箭头 `=>` 都算文件变更。后果：4 个真只读评审（4c07f511/b9443879/5a3df4d5/676f9f29）被判成执行类（reason=handled 而非 read-only）。

## 6. 任务纪律

1. 拆批与互斥白名单：t5 六批（B1–B3 后端 / W1–W3 WPF），原文「W1/W2/W3 禁止构建由我方统一串行复跑」；t12 P1–P4、t21 R1/R2/R3+R4a、t22 R4b（同文件串行）、t28 两切片、t31 F1 重审。
2. 执行类派发自包含：15/15 写批次含【允许修改】+【验证：唯一一条命令】；12/13 只读派发含【现状】。
3. 复跑：派发方每波后跑集成命令并留退出码（backend jest 998、dotnet 1080、admin-spa build exit 0）。
4. 评审后重评（G4）四轮闭环：首轮评审(t9×2) → P1–P4 → 二轮评审(t18×2) → R1–R4b → 三轮评审(t27×2) → F1 修复 → F1 切片重审(t31)。
5. 提交权归派发方：t34 主控 commit `20ed900`（45 文件 +3939/−325）并 push `48cb93b..20ed900`。

## 7. S5 专项

**a) t11 failedWrites=5**：16 次 write/edit 中 5 次被文件观察策略拒绝（`file has not been read`：4 次 wpf.md + 1 次 admin-spa.md），随后 read 重试成功。writes=11 只计成功，failedWrites=5 可还原，非内容冲突、非沙箱拒绝。

**b) 4c07f511「审查」前缀却 reason=handled**：checkpoint 判定不看 label，先 `ranReadOnly()` 再 `parentAlreadyHandled()`。该子会话 2 条 pwsh 命中 mutation pattern（`git show … > $env:TEMP\offal.diff`、`Out-File` 到 %TEMP%——都只写 %TEMP%）→ ranReadOnly=false → 落 handled。同类：b9443879（字符串 `' -> '`）、5a3df4d5（`node -e` 箭头 `=>`）、676f9f29（%TEMP% 里做变异测试）。

口径影响：(i) 决策日志 reason 是行为口径，不能当「read-only 前缀子代理覆盖率」用（按日志数会得出误导性的 9/12，真实沙箱覆盖 0/12）；(ii) 反向风险：父代理尚未动手时，真只读评审会收到假「读 diff/复跑命令」检查点；(iii) label 只影响 subagent-model-pin 的路由/沙箱，不影响 dispatch-protocol 的 reason。

## 8. 文档与实证不符两处

1. 接续手册「roles 段含中文前缀」与线上 profile 不符 → 直接导致判据 1 FAIL。
2. I1「复审 label 不命中角色表」在 S5 语境下不成立（角色表已无中文项；dispatch-protocol 不按 label 判定）；S5 暴露的是更根本的「中文角色整体缺失」，修法应从「加一个词」改为「校验 profile roles 是否含中文前缀 + 发布流程回归」。

**S5 总体判定：§4.3 = 1 FAIL（沙箱 0/12，配置回归）｜2 未考验｜3 部分 PASS（pwsh 计入实证 t34；同波次聚合未考验）｜4 PASS（18/18，另 3 行重复=I4）｜5 PASS（单文件静默 + test.mjs 58/58）。**
