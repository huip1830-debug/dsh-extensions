# S6 复核报告（session-170c0b2d，ocr-01 新项目从 0 / dispatch-protocol 0.4.0）

> 只读复核子代理（9c1b4994）产出。数据源：主会话 jsonl(844 行)/timeline/evidence/users、决定日志(命中 7 行)、观测行(9 行)、5 个子会话解码产物。已装插件 0.4.0。未做任何写操作（仅解码产物）。

## 1. read-only 覆盖率：**0/1**

- 5 个子代理（B1/B2/B3/B4/只读评审）全部 `sandbox/mode=danger-full-access`（source=delegation）、approval=never；唯一前缀命中的「只读评审：对照 spec 逐条验收」(4df05e30) 也不是 read-only → 覆盖率 0/1。
- 根因是设备 profile（不是插件逻辑）：`cordis.patch.yml` 角色表只有英文 `Survey`/`Review`，无中文前缀；`defaultPreset: danger-full-access`。旁证：子代理 model 全为兜底默认 opencode-go/deepseek-v4.1-flash → 角色根本没命中。profile mtime 10:06:53 早于 S6 首回合 10:20:36 → 判据 1 **FAIL**（对照样本四 4/5）。
- 插件侧行为判定仍正确：评审子代理 0 次 write/edit、11 条 pwsh 无变更动词 → ranReadOnly=true → 决定日志 t12 suppressed/read-only。「只读」只是 prompt 约束，沙箱没兜底。

## 2. 主控 inline 编辑（§4.4 指标一）：代码/配置 25 次 / 13 文件（另 3 次失败），md 14 次 / 3 文件

主控 write/edit 共 42 次调用：

| 回合 | 次数 | 文件数 | 类别 | 性质 |
|---|---|---|---|---|
| T2 | 8 | 1 | md 方案文档 | 用户指令修文档，单文件 |
| T6 | 1 | 1 | md spec | 派发方落 spec |
| T8 | 4 | 4 | 代码：contracts.ts(冻结契约)+matcher/vectorStore(STUB)+extractor(终版桥) | 派发前契约冻结（文件头注明「各批次只读」「契约占位」） |
| T11 | 16(+3 failed) | 8 | 代码/构建：fetch-model.mjs、package.json、gradle×4、AndroidManifest 等 | 集成 + Gradle/JDK21 排障（cap add 生成物） |
| T12 | 9 | 3 | 代码 4×BenchView.vue + md 5 | 评审闭环内派发方自修，有显式理由 |
| T13 | 1 | 1 | 代码：BenchView.vue | 评审建议修复，有显式理由 |

判定：**没有「该派发未派发」的实现类 inline**。T8 属契约/存根、T11 属集成排障（派发方保留职责）、T12/T13 有理由。唯一记账缺口：**T11 的 16 次大批量 inline 没有留一行"为什么不派发"**。严格口径：0 次违规 / 1 条记账缺失。

## 3. nudge 恰当性：2 delivered（1 真阳 + 1 误报）

- **t12**「改了 3 个文件（9 次写入）：BenchView.vue, README.md, AGENTS.md。派发 0 次…」→ **恰当**：回合内混 1 代码(4 改)+2 md，模型按提示补出「一行不派发理由」。正是协议要的形态。
- **t13**「改了 2 个文件（2 次写入）：…BenchView.vue，另有 1 条 shell 变更命令」→ **I3 误报**：实际 1 文件 + 1 条 `git commit`（派发方提交权），shellWrites 顶到阈值 2，文案错称"2 个文件"。
- 同波次聚合未考验（4 个完成点分落四个回合，renderWave 未走到）。
- checkpoint 静默 5 条：t8 B1 handled、t9 B4 handled、t11 B3 handled、t12 评审 read-only、t10 B2 delivered（见 §7.1）。**t9 B4 的 handled 证据偏弱**：父侧"已动手"唯一证据是一次 todo_write，当回合未验收，build 复跑推迟到 t11。

## 4. 观测行完整性：7/7

- 应出行回合 7 个（t2/t6/t7/t8/t11/t12/t13）全部有行；无写无派发回合无行正确。
- 对账：t11 writes=16=19 次尝试−3 failed ✓；t12 writes=9/3 文件/delegations=0 ✓；t13 writes=1/shellWrites=1 ✓。
- 重复行（I4）：t12×2、t13×2——nudge steer 使同回合二次 close 再次 observeTurn。

## 5. 回归

- 单文件小改静默：PASS（t2 单文件 8 写、t6 单文件 1 写，均无决定行）。
- FAIL 一处：t13（1 文件 + git commit → touched=2）→ I3 误报。
- 新发现（计数不一致）：t6 的 `git -C <path> commit` 不匹配 `\bgit\s+commit` → shellWrites=0（漏计）；t13 的 `cd …; git commit` 命中 → shellWrites=1。同一动作两种计法，并入 I3 整改。
- `>` 误命中字符串：t11 `"$rev => $($resp.StatusCode)"` 被判输出重定向（该回合 delegations=1 未致 nudge）。
- test.mjs 未由本子代理复跑（禁写约束），引用派发方复跑 EXITCODE=0/fail 0。

## 6. 任务纪律（五条）

1. 拆批：B1 搭脚手架 → 派发方冻契约+写 STUB → B2‖B3‖B4 并行，窄验证互斥（B2 只 vitest、B4 只 build），lockfile 三批都不碰。
2. 白名单：B1 明列"禁止读取后修改既有未跟踪文件"，B2 明列"禁止修改 package.json/pnpm-lock.yaml"；子代理逐条自证。
3. 复跑：t10 独立复跑 B2 的 vitest（「独立复跑 vitest run → VITEST_EXIT=0，19/19」）；t12 派发方复跑 vitest+build；评审子代理自己也跑 npx vitest run。
4. 评审后重评：E/D/G 切片发回原评审代理复评 → 10/10 PASS；hunk 快评 → 维持 PASS。续用同一子代理 → 未产生「复审」新子代理，I1 前缀问题未考验。
5. 边界合规/记账缺口：t13 提交由主控执行；T11 16 次 inline 无显式不派发说明；全样本 read-only 沙箱 0 生效。

## 7. S6 专项

### 7.1 t10「B2 识别模块 TDD」checkpoint 为何 delivered

parentAlreadyHandled 三条件需同时成立：(a) 父日志有 `Agent <childId> sent a message` spliced 事件；(b) 其后父代理有任意一次 tool/call；(c) 子代理最后 send_message 后无 write/edit。(c) 对 5 个子代理全成立；差异只在 (b)：

- B1：报告 spliced → 其后 pwsh → handled
- B4：报告 → todo_write → handled
- B3：报告 → pwsh → handled
- **B2：报告 10:59:15 到达 → 判定时刻(10:59:46)父日志 0 个 tool/call → delivered**；主控当时只输出文字「B2 已正式收官」未读 diff 未复跑 → 检查点拦住 → 11:00:02 主控「按协议先验收 B2」→ 台账「独立复跑 vitest run → VITEST_EXIT=0，19/19」。

结论：**delivered 规则正确且结果有益**（拦住了一次"未验收即收官"）。反向风险：t9 B4 靠一次 todo_write 就被判 handled（当回合未验收）——投递率取决于"是否立刻动过任何工具"而非"是否真的验收过"。建议 0.5.0/G1 升级为"验证类命令 + 台账记录"的机器校验。

### 7.2 t11 failedWrites=3

`npx cap add android` 刚生成的 variables.gradle / capacitor.build.gradle / AndroidManifest.xml 被 edit 直接改，被 fs-observation-policy（未先读）拒绝；read 后重 edit 成功。writes=16（19−3）/failedWrites=3 计数正确，属"先读后写"策略的正常拒绝。

t11 shellWrites=3 真实内容：JDK21 zip 解压+清包、字符串 `"=>"` 误命中、Android SDK platform-35 铺放——三条都在仓库外，按 I3 应归零。

## 8. 未验证项

- 判据 2（打断回合 deferred）：S6 无打断回合 → 未考验。
- test.mjs 需派发方独立复跑（派发方已两次复跑 EXITCODE=0）。
- 样本四 4/5 对应的 profile 版本不在本机，无法证实其为样本间唯一变量。

**S6 总体判定：§4.3 = ①FAIL（0/1）｜②未考验｜③部分 PASS（计入实证 + 1 漏计 `git -C commit` + 1 误计 `=>`；聚合未考验）｜④PASS（7/7，I4 重复 2 对）｜⑤单文件静默 PASS / t13 I3 误报 FAIL / test.mjs 绿（派发方复跑）。**
