# 派发管线验证接续手册

> 日期：2026-10-25（2026-10-26 更新）
> 用途：新开会话或换设备后继续做派发管线的真实任务验证。**只读这一份即可开工**；细节按链接跳。
> 当前状态：dispatch-protocol **0.4.0** 已完成**七个**真实会话样本验证（10-26 新增 S5 批量审查 df9232a1 / S6 新项目从0 170c0b2d / S7 细节优化 ca836591，复核结论见评审主文档 §10）。机制方向全部正确（34/34 观测行、单文件静默、评审后重评多轮闭环）；**但发现 P1 配置回归：本机 profile 角色表丢失中文前缀，三样本只读沙箱 0/40**（见 §3.2 勘误与 §5 新增 I5–I8）。0.4.1 清单已扩到 I3/I4/I5 + 安装核验。

## 1. 一句话现状

派发管线的「上半场」（勘察→评审切片→契约冻结→互斥派发→独立复跑→评审后重评）已在四个真实会话样本中验证有效；**唯一缺失的硬环是完成门禁（manifest + gate 自动落账）**，留给下一版。0.4.0 的提醒/观测机制全部生效，有四个边界小问题攒作 0.4.1（见 §5）。

## 2. 关键坐标

| 项 | 位置 |
|---|---|
| 管线设计文档 | `docs/superpowers/specs/2026-10-23-dispatch-pipeline-design.md` |
| 四样本评审主文档（G1–G9 缺口、自审计 §8、逐样本复核 §5/§7/§9） | `docs/reviews/2026-10-23-dispatch-pipeline-review.md` |
| 0.4.0 升级方案（P1–P6 + 对比实验协议 §4） | `docs/superpowers/specs/2026-10-24-dispatch-pipeline-patch-plan.md` |
| 插件源码 | `plugins/dispatch-protocol/`（含 `node test.mjs` 离线回归，58 用例） |
| 会话解码/取证脚本 | `docs/reviews/tools/`（decode-session / timeline / evidence / usermsgs） |
| 样本取证快照 | `docs/reviews/evidence/<sessionId>/` |
| 决定日志（提醒判定，含被静默的） | `%TEMP%\dispatch-protocol-decisions.jsonl` |
| 回合观测行（0.4.0 起） | `<任务仓库>/dispatch/runs/<sessionId>.jsonl` |
| 会话日志 | `~/.dsh/sessions/<项目目录>/<会话id>/session.v4.jsonl.zstd`（zstd 多帧，必须用 decode-session.mjs 逐帧解） |
| desktop profile 配置 | `~/.dsh/profiles/desktop/cordis.patch.yml`（角色表在这里，不在仓库） |

关键提交：`e5475c1` 升级前基线（对比实验的对照点）→ `53d2023` 0.4.0 实现 → `97e3e0f` 第四样本复核。仓库远端：`github:huip1830-debug/dsh-extensions`（profile 的插件依赖指向它，**改插件必须先推远端再 update**）。

## 3. 换设备/新环境恢复步骤

1. `git clone`（或 pull）本仓库；插件依赖经 profile 的 `package.json` 指向 GitHub，无需单独发布 npm 包。
2. **profile 配置不随仓库走**：把 `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `subagent-model-pin.roles` 段（含 `评审`/`勘察`/`只读` 中文前缀角色）拷到目标设备同一文件。**⚠ 2026-10-26 勘误**：本机（G:\ 设备）该文件 roles 段实测只剩英文 `Survey`/`Review`（mtime 10-26 10:06），中文前缀已丢——10-26 三个样本只读沙箱 0/40 即源于此（评审主文档 §10.3-P1）。修复时注意 I1 修订：**不要**直接给「评审」前缀配 read-only（S7 有「评审修复批」这类执行批 label，会被钉死）；只读类 label 应先约定可机械判定的标记（如「（只读）」后缀）再配角色。修复后必须新开会话验证。
3. 发布（每次插件更新都要走）：完全退出 DSH（托盘也退，否则 EPERM）→ `dsh plugin --profile desktop update dispatch-protocol` → 重启 DSH → **新开会话**才生效（插件不热加载、角色白名单按会话冻结）。
4. 核验安装：`profiles/desktop/node_modules/dispatch-protocol/package.json` 的 version 与仓库一致；与仓库逐文件 `Compare-Object` 一致。

## 4. 继续做验证：操作流程

### 4.1 跑真实任务

正常用 DSH 做真实业务任务即可，无需刻意测试。两条建议：覆盖一个**实现类中型任务**和一个**审查类任务**（与样本三/四形态对齐）；每个任务用一个新会话。

### 4.2 任务结束后复核该会话（30 分钟）

```powershell
# 1. 找到会话文件并解码（zstd 多帧，直接解压只读到第一帧）
node docs/reviews/tools/decode-session.mjs "$env:USERPROFILE\.dsh\sessions\<项目目录>\<会话id>\session.v4.jsonl.zstd" tmp\sN.jsonl
# 2. 出时间线/证据/用户消息
node docs/reviews/tools/timeline.mjs tmp\sN.jsonl > tmp\sN-timeline.txt
node docs/reviews/tools/evidence.mjs tmp\sN.jsonl > tmp\sN-evidence.txt
node docs/reviews/tools/usermsgs.mjs tmp\sN.jsonl > tmp\sN-users.txt
# 3. 决定日志筛本会话
Get-Content "$env:TEMP\dispatch-protocol-decisions.jsonl" | Where-Object { $_ -match '<会话id前8位>' }
# 4. 观测行
Get-Content <任务仓库>\dispatch\runs\<会话id>.jsonl
# 5. 子代理沙箱：解码子会话（同目录下以 agent id 命名的目录），看开头 sandbox/mode 事件序列
```

### 4.3 生效判据（对照第四样本 §9.1）

1. 评审/勘察/只读开头的子代理：子会话有 `sandbox/mode read-only`；
2. 打断回合若漏派发：下一回合决定日志有 `deferred:true` 的 nudge 行；
3. pwsh 删/建文件计入 nudge；同波次多子代理完成只发一条聚合提醒；
4. 每个有写/有派发回合有一行观测行；
5. **回归**：单文件小改回合静默；`node plugins/dispatch-protocol/test.mjs` 全绿。

### 4.4 与基线对比的三个核心数字（对照样本三/四）

| 指标 | 样本三（0.3.10） | 样本四（0.4.0） | 新样本目标 |
|---|---|---|---|
| 实现类任务提醒前主控 inline 编辑 | 43 次 / 14 文件 | 0 | 0（或有显式不派发理由） |
| 评审类子代理 read-only 覆盖率 | 0/11 | 4/5 | 100%（注意 I1 的 `复审` 前缀） |
| 打断回合 nudge 观测 | 0 行 | 未被考验 | 有行 |

### 4.5 归档规范

复核完一个会话：取证快照（timeline/evidence/users + observation-rows.jsonl）存 `docs/reviews/evidence/<sessionId>/`，复核结论作为新的一节追加到评审主文档（格式参照 §9），提交推送。**证据不要只留在会话里**（G7 的教训：样本 1/2 的会话证据随设备切换不可复跑）。

## 5. 0.4.1 候选清单（第四样本 §9.3 + 10-26 三样本实证，评审主文档 §10.3）

| # | 问题 | 建议修法 | 优先级 |
|---|---|---|---|
| P1 | **本机 profile 中文角色整段丢失**（mtime 10-26 10:06），三样本只读沙箱 0/40；换设备/重发即漂移且无任何校验能发现 | ① 修复本机 roles（注意先定只读 label 约定，勿直接配「评审」前缀——S7「评审修复批」教训）；② 0.4.1 加**安装核验**：update 后 diff profile roles 与仓库基线，或插件启动探测并记决定日志 | **最高**（G8 缺口复现中） |
| I1 | `复审` label 不命中角色表（前缀按字面匹配） | **修订**：label 只影响 subagent-model-pin 沙箱收窄，不参与 checkpoint 判定；修法从「加一个词」改为「只读类 label 固定可机械判定标记（如『（只读）』后缀）+ profile 校验」 | 并入 P1 |
| I2 | 重启/恢复丢失内存 pending 队列 → 检查点静默缺席且无日志 | pending 队列随决定日志落盘、恢复时重建；或记为已知边界 | 中 |
| I3 | nudge 把 `git commit`、归档型 `Copy-Item/Move-Item` 计为文件变更（已 4 例：样本四 T3、主会话分析回合、S5 t34、S6 t13、S7 t2）；**新维度**：`git -C <path> commit` 漏计（S6 t6）；仓库外变更（%TEMP%/JDK/SDK）全计入；文案把 shell 计入「文件数」 | **两档拆分**：检查点只读判定保留全量变更动词；nudge 计数只计工作区内容变更（Set-Content/Out-File/重定向/Remove-Item），或 shell 变更仅在该回合零 `write`/`edit` 时计入；git 动词统一匹配 `git (-C \S+)? <verb>` 或提交权回合豁免；文案区分「文件」与「shell 变更」 | 建议修 |
| I4 | nudge steer 导致同回合观测行重复（10-26 坐实：7 对重复行与 7 次 steer 一一对应，决定日志不重复） | 观测行按 `(session, turn)` 去重 | 低 |
| I5 | **（新）checkpoint read-only 判定的重定向正则把 C# 语法当写盘**：`=>`（`=` 前 `>` 后，lookbehind 未排除 `=`）、`->`、泛型 `<string?>`；S7 复审子代理 0 写却被判非只读 → delivered；S5 另有 4 个真只读评审因此 reason=handled（决策日志 reason 是行为口径，不能当覆盖率用） | 两档拆分时 read-only 判定只认 write/edit + 真实变更动词；或重定向分支要求 `>` 前为行首/空白且后接路径；补 test.mjs 反例（现有只测 `git log`/`2>&1`） | 建议修（已真实误投递 1 次） |
| I6 | **（新）handled 判定偏松**：parentAlreadyHandled 只要「报告后任意一次 tool/call」即成立（S6 t9 靠 todo_write 判 handled、当回合未验收）；反向 S6 t10 拦下真实「未验收即收官」一次 | 并入 0.5.0/G1：升级为「验证类命令 + 台账记录」机器校验，0.4.1 不打补丁 | 划归 0.5.0 |
| I7 | **（新，结构性）**nudge 在收尾消息前注入，`justifiedInTurn` 看不到 steer 后补写的理由 → 提示即答场景提醒必发一次（S7 seq=127/128） | 可选：第二 stopping 对「已补理由」回合补一条 `suppressed: justified-after` 日志（不改投递） | 低 |
| I8 | **（新，次要）**子代理不经 send_message 直接 finish 时 handled 的 marker 永不命中（S7 5949ee67） | 与 I5 叠加才致 delivered，单修其一即可；一并记录 | 低 |
| D1 | **（纪律层，非插件）**批次在跑时派发方又改冻结契约文件（S7 T6，48s 重叠） | 操作纪律条目：批次在跑时冻结文件不再改；必要时复审 brief 注明最终口径 | 文档 |

### 10-26 三样本复核归档

- 复核结论：评审主文档 §10（判据表/对比数字/I1–I8 实证更新）。
- 证据：`docs/reviews/evidence/session-{df9232a1…,170c0b2d…,ca836591…}/`（各含主会话 jsonl/timeline/evidence/users + observation-rows.jsonl + decisions.jsonl + review-report.md）；跨样本现状文件 `docs/reviews/evidence/2026-10-26-tri-sample-status.md`（§7 有复核后更正）。
- I5 正则复现脚本：`tmp/verify-i5c.mjs`（用插件真实导出正则；tmp 不入库，需要时按 §10.3-I5 描述重建）。

## 6. 下一版（0.5.0）的分水岭

评审主文档 §8.5 的处置清单状态：

- **已做（0.4.0）**：G8 角色匹配、G6 轻量两条、G4 评审后重评（规则六，行为级已验证）、G2 合并判级（规则六）、brief/报告成本项部分改善、G7 证据地板（观测行）。
- **下一版核心**：**G1 完成门禁**——manifest 自动落行升级为含验证结论的批次记录 + `gate` 校验命令；观测行（P6）已把「谁做的、改了什么」落盘，缺的只剩「凭什么算完成」的机器校验。设计文档 §10 的阶段 1–2 是现成方案。
- **明确不做**（自审计裁决，勿夹带）：ChangeSet 完整对象模型、DAG 机械化、fan-out 硬上限、评审全量复跑强制、评分体系精化、跨会话 worktree/lease（G9 推迟）。

## 7. 环境注意事项（踩过的坑）

1. **插件发布时 DSH 必须完全退出**，否则文件占用 EPERM。
2. **旧会话里改配置/插件无效**：插件不热加载；model-pin 的角色表与路由白名单按会话冻结。验证行为必须新开会话。
3. **样本 1/2 在另一台设备**（`G:\www\ziyou\scale-03`，会话日志在 `~/.dsh/sessions/` 对应目录）；其细节数字置信度按评审 §8.0 的跨样本复证口径处理。
4. **本机无 `~/.dsh/dispatch/` 工具链**（旧台账/ledger.mjs 在另一台设备）；0.5.0 的 gate 工作需要先从原设备拷贝或按设计文档 §7 重建。
5. 观测行默认写进**任务仓库**的 `dispatch/runs/`：想留证据就提交，不想入库就在任务仓库加 `.gitignore`。
6. nudge/检查点都是观测不是门禁：被静默的判定也写决定日志——分析时以日志为准，不以「界面上没看到提醒」为准。
