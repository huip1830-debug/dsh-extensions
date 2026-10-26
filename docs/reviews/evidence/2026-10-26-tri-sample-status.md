# 2026-10-26 三样本复核·现状文件（派发依据）

> 用途：三个只读复核子代理的派发引用。含会话映射、产物坐标、决定日志摘录、观测行摘录、已知异常与待证项。
> 复核判据：`docs/superpowers/2026-10-25-dispatch-pipeline-continuation.md` §4.3 生效判据 + §4.4 对比数字 + §5 I1–I4 候选清单；结论格式参照 `docs/reviews/2026-10-23-dispatch-pipeline-review.md` §9。

## 1. 会话映射（用户口径的三次真实任务，0.4.0）

| 样本 | 会话 ID | 任务形态 | 任务仓库 | 会话日志 |
|---|---|---|---|---|
| S5 | session-df9232a1-9604-4375-95b7-bd094537a520 | 批量代码审查（scale-03 近三天改动，三轮修复+三轮评审） | G:\www\ziyou\scale-03 | ~/.dsh/sessions/--G-www-ziyou-scale-03--/session-df9232a1-…/ |
| S6 | session-170c0b2d-d6aa-4fe6-a82d-51dc57e10648 | 新项目从 0 开发（ocr-01 mobile-app OCR 识别 demo） | G:\www\ziyou\ocr\ocr-01 | ~/.dsh/sessions/--G-www-ziyou-ocr-ocr-01--/session-170c0b2d-…/ |
| S7 | session-ca836591-3e37-40ed-84e0-324b61942cb5 | 细节优化（scale-03 打级单价确认交互重设，spec 驱动） | G:\www\ziyou\scale-03 | ~/.dsh/sessions/--G-www-ziyou-scale-03--/session-ca836591-…/ |

用户原文第三个 ID 重复粘贴了 S6；经首条用户消息实证（"电子秤客户端，确认白条单价的操作很奇怪" + spec `2026-10-26-grading-unit-price-confirm-redesign.md`），第三样本为 ca836591。

## 2. 已解码产物（主控已跑，子代理直接用）

| 样本 | 主会话 JSONL | 时间线 | 证据 | 用户消息 |
|---|---|---|---|---|
| S5 | tmp\s5.jsonl (1367 行) | tmp\s5-timeline.txt | tmp\s5-evidence.txt | tmp\s5-users.txt |
| S6 | tmp\s6.jsonl (844 行) | tmp\s6-timeline.txt | tmp\s6-evidence.txt | tmp\s6-users.txt |
| S7 | tmp\s7.jsonl | tmp\s7-timeline.txt | tmp\s7-evidence.txt | tmp\s7-users.txt |

工具：`node docs/reviews/tools/decode-session.mjs <zstd路径> <输出>`（子会话同样解）。
决定日志：`%TEMP%\dispatch-protocol-decisions.jsonl`（22KB，含被静默判定）。
观测行：`<任务仓库>\dispatch\runs\<sessionId>.jsonl`（三个样本都已确认存在）。
子代理会话：`~/.dsh/sessions/<项目目录>/<agentId>/session.v4.jsonl.zstd`（agentId = 决定日志 childId；目录在项目级，不在会话目录下）。

## 3. 决定日志摘录（按样本）

### S5 df9232a1（审查→修复→三轮评审）
- read-only 静默（kind=checkpoint, reason=read-only）：t2 审查仓库选择后端链路(cbd6521a)、t2 审查设备常用品类全栈(5ea0fb33)、t2 审查WPF仓库选择常用品类(04f4cc92)、t3 审查采购入库推送链路(a6695a15)、t4 审查打级分割成本链路(f40a354a)、t11 评审WPF修复FC-4/5/6(4c7c3b22)、t11 评审后端修复FC-1/2/3(465e0a0a)、t20 二轮评审后端FC-7/8/9(fc196d6d)、t28 三轮评审WPF FC-13/14(269f3eb2)
- handled 静默（执行类完成检查点）：t2 审查WPF打级打印生命周期(4c07f511,注意:审查前缀但 reason=handled)、t6 W2(baa18881)/B2(33578f70)、t7 W1(2c516b9a)、t8 B1(de21c59d)、t9 W3(adbf88d7)/B3(bb7ff8cf)、t13 P3(350bc3c9)、t15 P1(b0c3dcf6)、t16 P4(9bfc6fd7)、t17 P2(86c55d56)、t19 二轮评审WPF(b9443879,评审前缀但 handled)、t21 R2(bde05831)、t22 R1(d5a006b3)、t23 R3(1ecbdc64)、t25 R4b(8347012e)、t27 R4a(992eb313)、t29 三轮评审后端(5a3df4d5,评审前缀但 handled)、t31 F1切片重审(676f9f29)
- nudge delivered：t11 writes=11（5 个 md 文档，含 failedWrites=5）、t20 writes=6（3 个 md）、t34 writes=0 files=[]（shellWrites=2，疑 I3）
- nudge suppressed(handled)：t29 writes=5

### S6 170c0b2d（新项目从 0）
- checkpoint handled：t8 B1 脚手架(26ebc468)、t9 B4 三视图(4d6d13f0)、t11 B3 TFLite 插件(a2f1052c)
- checkpoint **delivered**：t10 B2 识别模块 TDD(065818f1) ← 执行类子代理完成检查点被投递，待查原因
- checkpoint read-only：t12 只读评审：对照 spec 逐条验收(4df05e30)
- nudge delivered：t12 writes=9（BenchView.vue/README/AGENTS.md，delegations=0，与只读评审同回合）、t13 writes=1+shellWrites=1（BenchView.vue）
- 无决定的写回合：t2 writes=8 单文件（方案 md）、t6 writes=1（spec md）、t8 writes=4 但 delegations=3、t11 writes=16 但 delegations=1

### S7 ca836591（细节优化）
- nudge delivered：t2 writes=1+shellWrites=1（spec md；用户消息 seq=127 可见提醒原文「本回合改了 2 个文件（2 次写入）…派发 0 次，也没有说明理由」）
- checkpoint handled：t4 批次1 共享层(3a4fe31e)、t5 批次2 场景层(8d5ac3ab)、t7 评审修复批(bc7c561d)、t10 微批(cb7f3c01)、t11 微批2(5a5421a4)
- checkpoint read-only：t6 只读评审：spec 逐条核对(aef0c18a)
- checkpoint **delivered**：t8 复审：修复切片逐条核对(5949ee67) ← **I1 实证**：`复审` 前缀不命中角色表
- t12 writes=1（docs\wpf-ux-issues.md，delegations=0）无决定日志 ← 单文件小改静默，符合回归预期

## 4. 观测行事实（主控已读全文）

- S5：21 行；**重复行** t11×2、t20×2、t34×2（同 session+turn，相隔约 10 秒）→ I4 实证；t11 failedWrites=5（待查失败原因）；t34 writes=0/shellWrites=2 且 nudge delivered → I3 实证
- S6：9 行；重复行 t12×2、t13×2 → I4；t11 failedWrites=3+shellWrites=3（Gradle/插件生成期）
- S7：11 行；重复行 t2×2、t8×2 → I4；t12 单文件写有行无 nudge（静默正确）
- 插件回归：`node plugins/dispatch-protocol/test.mjs` EXITCODE=0、fail 0（主控已复跑）

## 5. 待子代理查证项（每个样本）

1. **read-only 覆盖率**：列出全部 评审/勘察/只读/审查/复审 前缀子代理 → 解码其子会话，开头找 `sandbox/mode` 事件，给 x/y 覆盖数字；I1 的「复审」单独标注。
2. **主控 inline 编辑**（§4.4 指标一）：从 evidence/timeline 数主控（非子代理）对**代码文件**的 write/edit 次数与文件数（md 文档单独统计）；判定是否有「该派发未派发」。
3. **nudge 恰当性**：每条 delivered nudge 对照时间线判断是否合理（文档批量归档 vs 代码 inline 改）；t34 writes=0 的 nudge 要还原当时 shell 命令。
4. **观测行完整性**：有写/有派发回合是否都有行；重复行计数。
5. **回归**：单文件小改是否静默；有无新形态误报/漏报（I1–I4 之外）。
6. **任务纪律简述**：拆批/白名单/复跑/重评循环在会话中的实际表现（从 timeline+usermsgs 归纳，三五条即可）。
7. S6 专项：t10 B2 checkpoint delivered 的原因（对照 t8/t9 handled 的差异）；t11 failedWrites=3 是什么。
8. S5 专项：t11 failedWrites=5 是什么；审查类 4c07f511 reason=handled 而非 read-only 是否影响 read-only 覆盖率口径。

## 6. 不确定项

- 子会话 sandbox/mode 事件的确切字段名未预先验证（子代理解码后自行辨认）。
- S5 t34 的两条 shell 变更命令内容未查（子代理从 jsonl 还原）。
- 三样本是否全部走完归档（S5 有 commit？）未查——不属于插件判据，顺带记录即可。

## 7. 复核后更正（2026-10-26，三路只读复核 + 主控复跑之后）

> 本节之后的结论以评审主文档 §10 为准；本节仅登记本文件前文的错误归因。

1. **§3 S7 段「t8 ← I1 实证」错误**：t8 delivered 的直接原因是 read-only 行为判定的重定向正则误报（`=>`/`->`/`<T>` 命中 `>` 分支，新编号 **I5**）+ 该子代理未走 send_message 导致 handled 永不命中。I1（`复审` 前缀不命中角色表）只影响 subagent-model-pin 的沙箱收窄，不参与 checkpoint 判定（dispatch-protocol 的 reason 是纯行为口径，不看 label）。
2. **§4 S6 段「t11 shellWrites=3（Gradle/插件生成期）」归因不准**：三条实为 JDK21 解压清理、字符串 `"=>"` 误命中、Android SDK 平台包铺放，全部在仓库外。
3. **比 I1 更根本的发现**：本机 profile `cordis.patch.yml` 的 `subagent-model-pin.roles` 只剩英文 `Survey`/`Review`（mtime 2026-10-26 10:06，早于三样本），中文前缀角色整体缺失 → 三样本只读沙箱覆盖率合计 **0/16**（主控独立解码 7 个子会话实证，含 465e0a0a/4c7c3b22/269f3eb2/4df05e30/aef0c18a/5949ee67/cbd6521a 全部 danger-full-access）。
4. **I5 已用插件真实正则独立复现**（tmp\verify-i5c.mjs）：`EffectiveUnitPrice =>` 命中 `>` @20（`=>` 是 `=` 在前、`>` 在后，后随字符非 `&=\d` 故 lookahead 放行；lookbehind 未排除 `=`/`-`/泛型语境）；`git -C <path> commit` 不命中 `\bgit\s+commit`（S6 t6 漏计实证）；`git add -A; git commit` 命中（S5 t34 实证）。
