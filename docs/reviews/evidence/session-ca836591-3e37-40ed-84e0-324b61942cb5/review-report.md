# S7 复核报告：session-ca836591-3e37-40ed-84e0-324b61942cb5（dispatch-protocol 0.4.0）

> 只读复核子代理（73100eda）产出。复核对象：细节优化「打级单价确认交互重设」（spec 驱动，仓库 G:\www\ziyou\scale-03）。取证：主会话 jsonl（438 事件 / 12 回合）/timeline/evidence/users、观测行（11 行）、决定日志（S7 共 8 行）、7 个子会话全部解码。

## 0. 结论速览（两处修正现状文件）

| # | 现状文件说法 | 本次实证 | 判定 |
|---|---|---|---|
| A | 「t8 复审 delivered ← I1 实证」 | **不成立**。delivered 的直接原因是 read-only 判定的重定向正则误报（新 **I5**）；I1 只影响子代理沙箱，不参与 checkpoint 判定 | 改判 + 新增 I5 |
| B | 接续手册称 profile 角色表「含中文前缀」 | 实际只有英文 `Survey`/`Review`，S7 全部 7 个子代理 danger-full-access | 文档/配置不一致 |

## 1. read-only 覆盖率

**按判据「子会话有 sandbox/mode read-only」计：S7 = 0/3（严格前缀 0/2）；全 7 个子代理 0/7。行为上真正只读的 2 个（aef0c18a、5949ee67）只靠自守，无沙箱强制。**

| agentId | label | sandbox/mode | write/edit | pwsh 命中「变更」 | plugin 判定 |
|---|---|---|---|---|---|
| 3a4fe31e | 批次1：共享层确认单价键 | danger-full-access | 12 | — | handled |
| 8d5ac3ab | 批次2：打级场景层接线 | danger-full-access | 9 | 1（Tee-Object 误报） | handled |
| aef0c18a | 只读评审：spec 逐条核对 | danger-full-access | 0 | 0 | read-only（正确） |
| bc7c561d | 评审修复批：补测试+清零前移 | danger-full-access | 10 | — | handled |
| 5949ee67 | 复审：修复切片逐条核对 | danger-full-access | 0 | 3（全为误报） | delivered（误判） |
| cb7f3c01 | 微批：复审建议 4 项落地 | danger-full-access | 4 | — | handled |
| 5a5421a4 | 微批2：测试判别力修复 | danger-full-access | 5 + 2（Copy-Item 备份） | — | handled |

### 1.1 根因一：profile 角色表无中文前缀

`cordis.patch.yml:76-86` 只有 `match: Survey` / `match: Review`；匹配逻辑为 label 小写前缀（routes.mjs），未命中即回落父会话预设。7 个中文标签全部 matched:false → 沙箱一律 danger-full-access、approval=never。profile mtime 10:06:53 早于 S7 开跑 13:40。

### 1.2 根因二：t8 delivered ≠ I1，而是重定向正则把 C# 语法当成写盘（I5）

checkpoint 的只读判定是纯行为的（plugin.mjs ranReadOnly → nudge.mjs:51 callTouchesFile），标签只用于文案；判定顺序 read-only → handled → delivered。5949ee67 实为完全只读（89 次调用 = read 39 / grep 12 / pwsh 38，write/edit 0 次），但 3 条 pwsh 因 `nudge.mjs:36` 的 `(?<![\d&])>{1,2}(?![&=\d])` 误命中：

| 命令（截取） | 误命中片段 |
|---|---|
| `git grep -n "…EffectiveUnitPrice =>\|…"` | `=>` |
| `git grep -n "private async Task<string?> TryPrintBatchLabelAsync" -A 40` | `<string?>` |
| `"{0,-58} -> index {1}" -f …` | `->` |

派发方用插件真实导出正则独立复现（tmp\verify-i5c.mjs）：`=>`/`<string?>`/`->`/`> %TEMP%` 全部 MUTATION，`git status --short`、`dotnet build 2>&1` 正确 readonly。机理：`=>` 是 `=` 前 `>` 后，`>` 后随字符非 `&=\d` 故 lookahead 放行；lookbehind 未排除 `=`/`-`/泛型语境。现有 test.mjs 的"只读 pwsh"用例只测 `git log`/`dotnet build 2>&1`，未覆盖该 FP 类。

### 1.3 第二道条件也失效：不经 send_message 汇报的子代永远判不到 handled

`parentAlreadyHandled` 以 `Agent <childId> sent a message` 拼接为 marker。5949ee67 只有 `subagent-settled` 拼接（"Background subagent … finished"），从未 send_message → marker 永不命中 → handled 恒为 false。delivered 有两条独立缺口；修好 read-only FP 即可抑制（read-only 先判），单修 marker 不足。

### 1.4 口径警示：中文前缀配 read-only 会误伤执行批

bc7c561d 的 label「**评审**修复批：补测试+清零前移」实为执行批（10 次 write/edit）。若按 I1 原建议给「评审」前缀配 read-only 角色，这类 label 会被沙箱钉成只读、修复批直接失败。I1 修法必须一并解决命名冲突。

## 2. 主控 inline 编辑（§4.4 指标一）

**0 次 / 0 个代码文件，达标；无「该派发未派发」。** 主控 write/edit 共 7 次、2 个文件、100% 为 .md（spec 6 次 + wpf-ux-issues 1 次）；pwsh 变更仅 1 条 `git commit`（spec）。派发 7 次；主控 T3/T4/T5/T7/T9/T11 独立跑集成命令。

## 3. t2 nudge 的恰当性

- 机制按判据正确触发：writes=1（md）+ shellWrites=1（git commit）→ touched=2 ≥ 阈值。
- **内容误报（I3 第 3 例）**：实际「1 个文件 1 次写入 + 1 次 git commit」，单文件纯文档本在豁免内；commit 被计成第二个文件；文案把 shell 计入「文件/写入」计数（「改了 2 个文件（2 次写入）…另有 1 条 shell 变更命令」自相矛盾）。
- **结构性发现（新）**：nudge 在收尾消息**之前**注入——提醒（seq=127）紧邻模型写出「不派发理由」（seq=128）之前。`justifiedInTurn` 只能扫注入前已提交的 prose，**"在结尾一行给理由"这种最自然的答法永远无法抑制本回合提醒**。
- 净效果=一次无害噪音：模型补了理由，T3 直接派发批次1，未生成实施计划文档。

## 4. 观测行完整性

**9 个合格回合 9/9 有行；重复行 2 条（t2、t8），与「本回合投递过 steer」严格一一对应 → I4 强化实证。** 重复间隔 10.4s/36.5s；首行时间戳与决定日志 delivered 行逐毫秒吻合；`lastNudgedTurn` 挡住第二次提醒但 `observeTurn` 无 (session,turn) 去重 → 观测行重复、决定日志不重复。T9/T11 无写无派发无行正确（`2>&1` 被 lookbehind 正确排除）。

## 5. 回归

- t12 单文件写（docs\wpf-ux-issues.md）**静默且留行** = PASS：无 nudge、决定日志无该回合行、观测行在场——「观测留痕、提醒静默」正确解耦。
- test.mjs 独立复跑 **58 pass / 0 fail / EXITCODE=0**。
- 新误报仅 I5 + t2 的 I3 放大；无漏报（逐回合核对 touched≥2 && delegations==0 && 无决定行 = 空集；T6/T8 因 delegations=1 不提醒是设计而非漏报）。

## 6. 任务纪律

1. 拆批+契约冻结到位：todo 显式拆批方案；批次2 brief 带【已冻结契约】且注明「不得改共享层文件」，白名单按文件互斥。
2. 5 份执行类 brief 全部含【现状】/【允许修改】/【验证：唯一一条命令】/【输出格式】；主控 T8 用 `git status --porcelain` 面核「8 M + 2 ?? 逐条落在白名单」。
3. 主控独立跑 `dotnet test scale-net` 四次 EXITCODE=0；两轮"未采信自述"（复审员明示"未运行 dotnet，采信派发方集成结果"）。
4. 评审闭环（规则六）彻底：首轮评审 1 FAIL → 修复批 → 复审 ALL PASS+4 建议 → 微批 → 复审微批+3 建议 → 微批2（含变异验证：注释清零行→变红→恢复）→ 终审 3 PASS；三次评审由同一 continuable 子代理续用。
5. 缺口：①只读评审无沙箱兜底（0/7）；②T6 派发修复批 48s 后仍改 spec 四刀——契约文件与子代理运行重叠（复审 brief 已注明"spec 已被派发方更新到最终口径"兜底）；③不经 send_message 汇报时 handled 判定失效。

## 7. 建议（0.4.1 候选，需裁决）

- **I5**：重定向分支要求 `>` 前为行首/空白且后接路径（排除 `=>`、`->`、`<T>`），或 checkpoint 只读判定改用「write/edit + 真实变更动词」两档；补 test.mjs 反例。
- **I1 修法修订**：只读类 label 用可机械判定的后缀约定（如「（只读）」），或派发方在 brief 显式声明只读；不让沙箱收窄依赖"是否以评审开头"。
- **I3**：维持两档拆分 + 文案区分「文件」与「shell 变更」。
- **结构性（可选）**：`justifiedInTurn` 看不到 steer 之后写下的收尾理由；可在第二 stopping 时对"刚被提醒且已补理由"的回合补一条 `suppressed: justified-after` 日志（不改投递）。

**S7 总体判定：§4.3 = ①FAIL（0/2，含复审 0/3，全 7 个 0/7）｜②未考验（12 回合全正常结束，无 deferred 行）｜③部分 PASS（计数生效含 1 例误报；聚合未考验）｜④PASS（9/9）｜⑤PASS（t12 静默 + test.mjs 58/58）。**
