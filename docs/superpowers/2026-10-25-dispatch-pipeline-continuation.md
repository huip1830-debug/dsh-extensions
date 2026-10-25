# 派发管线验证接续手册

> 日期：2026-10-25
> 用途：新开会话或换设备后继续做派发管线的真实任务验证。**只读这一份即可开工**；细节按链接跳。
> 当前状态：dispatch-protocol **0.4.0** 已发布到 desktop profile 并完成首个真实任务验证（第四样本）。

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
2. **profile 配置不随仓库走**：把 `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `subagent-model-pin.roles` 段（含 `评审`/`勘察`/`只读` 中文前缀角色）拷到目标设备同一文件。
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

## 5. 0.4.1 候选清单（第四样本 §9.3 + 后续实证）

| # | 问题 | 建议修法 | 优先级 |
|---|---|---|---|
| I1 | `复审` label 不命中角色表（前缀按字面匹配） | profile 角色表加 `复审`，或约定只读类 label 一律以「评审/勘察/只读」开头 | 零代码，顺手做 |
| I2 | 重启/恢复丢失内存 pending 队列 → 检查点静默缺席且无日志 | pending 队列随决定日志落盘、恢复时重建；或记为已知边界 | 中 |
| I3 | nudge 把 `git commit`、归档型 `Copy-Item/Move-Item` 计为文件变更（已两次边界误报：样本四 T3、主会话分析回合） | **两档拆分**：检查点只读判定保留全量变更动词；nudge 计数只计工作区内容变更（Set-Content/Out-File/重定向/Remove-Item），或 shell 变更仅在该回合零 `write`/`edit` 时计入 | 建议修 |
| I4 | nudge steer 导致同回合观测行重复 | 观测行按 `(session, turn)` 去重 | 低 |

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
