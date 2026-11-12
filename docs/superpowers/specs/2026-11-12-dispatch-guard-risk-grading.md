# dispatch-protocol 0.10.0 — 守卫按改动类型分级（文档豁免 + 还原豁免 + 切片归属）

- 日期：2026-11-12
- 状态：已冻结（用户要求「所有发现的真实问题全部修复」）
- 版本：0.9.1 → **0.10.0**（新增配置键，minor）
- 上游证据：`tmp/session-analysis/`（session-32cd3319 复盘，4 次闸门注入 **0 真阳性**：3 次纯文档、1 次控制面+文档）
- 关联：`docs/superpowers/specs/2026-10-30-dispatch-0.8.2-control-plane-exemption.md`（0.8.2 只解决了 state/ledger/specs，漏了 `dispatch/` 其余部分与文档类改动）

## 1. 问题（实测，逐条对应证据）

| # | 现象 | 证据 |
|---|---|---|
| P1 | `dispatch/override.json` 是纪律**强制**写入的豁免凭据，却被 ReviewGate 当脏改动 → 「评审已失效」 | 00:41:21 注入文案点名 `dispatch/override.json, AGENTS.md`；`lib/tool-calls.mjs:35` 白名单不含 `dispatch/` 全树 |
| P2 | 文档改动与代码改动同权：VerifyGate 不看路径，1 个字符 → 三端 build+test | 00:54:02 注入；`lib/gates.mjs:304-335` 只计数不记路径 |
| P3 | 还原类命令（`git checkout -- <path>`）被算成新脏改动 | 00:35:39 `git checkout -- migration_lock.toml` 后主控自查「这确实改动了工作区」 |
| P4 | 闸门文案不给文件名/类型，模型要花 2–3 步反查为什么被拦 | T28 A(28.5-28.7)、T32 A(32.6) 各 2–3 步 |
| P5 | ReviewGate 只会说「重开受影响切片」，不知道哪个切片、也不区分文档 | 00:41:21 → 主控只能新开一个文档切片评审（10.4 min / 2.37M token） |

## 2. 冻结契约：守卫（C1–C5）

### C1 控制面默认集合与写入守卫对齐
`lib/tool-calls.mjs` 的 `DEFAULT_CONTROL_PLANE_PATTERNS` 由
`['dispatch/state.md','dispatch/state/','dispatch/ledger/','docs/superpowers/specs/']`
改为 `['dispatch/', 'docs/superpowers/specs/']`（与 `lib/write-policy.mjs:28 DEFAULT_ALLOWLIST` 同值）。
效果：`dispatch/override.json`、`dispatch/recon/*`、`dispatch/runs/*` 不再使 Verify/Review 闸门判定为脏。
禁止：不改 `write-policy.mjs`。

### C2 文档类改动不触发 VerifyGate
- 新配置 `gates.verify.docPatterns: string[]`，默认
  `['.md','.mdx','docs/','dispatch/','LICENSE','.gitignore','.gitattributes']`（大小写不敏感子串，复用 `matchesPath`）。
- `analyzeVerification(events, verify)` 返回值扩为 `{ lastVerify, dirty, changes, files, docOnly }`：
  - `files`：去重脏路径（write/edit 取 `file_path`）；**无法定位路径的 pwsh 记为 `'<shell>'`**。
  - `docOnly`：`changes > 0` 且每个脏条目都命中 `docPatterns` 或控制面（`<shell>` 一律算非文档）。
  - `changes` 语义不变（仍计所有脏调用），既有断言不回归。
- `evaluateVerifyGate`：`docOnly === true` → 返回 `null`（不提醒）。「从未跑过」分支同样适用。

### C3 还原到 HEAD 不算脏
`touchedWorkingTree` 对 pwsh 先判还原：
- 命中即返回 `false`（不算脏）：`git ... checkout -- <路径...>`（`--` 后不含 commit-ish）、`git ... restore <路径...>`（不含 `--source`）。
- 仍算脏：`git checkout <branch|ref>`、`git checkout -b`、`git restore --source=…`、以及一切无法可靠判定的写法（保守按脏）。
- 实现放 `lib/gates.mjs` 私有 helper `isRestoreCommand(command)`，`test.mjs` 直接测 helper 的判定对各写法的结果。

### C4 ReviewGate 区分文档/控制面改动
- `evaluateReviewGate` 返回值扩为 `{ files, docOnly }`：`files` 全部命中 `docPatterns`/控制面 → `docOnly: true`（混合含代码 = `false`）。
- 新增配置 `gates.review.textDocOnly: string`，默认：
  `'[dispatch-protocol] 只读评审之后又改了文档/控制面（{files}）。这类改动不使代码切片失效：机器校验（路径/链接/括号/术语）即可，不必重开代码评审；若改的正是刚评审的那份文档，最小复核该文档即可。'`
- `plugin.mjs` 选文案：`review.docOnly ? gates.review.textDocOnly : gates.review.text`；决定日志保留 `files`，并新增 `docOnly` 字段。
- 每个评审波次仍只提醒一次（`state.warned` 不变）。

### C5 文案点名文件
- `DEFAULT_VERIFY_TEXT` 改为：
  `'[dispatch-protocol] 本回合准备 present/commit，但 {files}（{kind}改动）在最后一次成功集成命令之后又有改动（或从未跑过）。先跑一次集成命令并留存退出码，再收口。'`
- `DEFAULT_REVIEW_TEXT` 改为：
  `'[dispatch-protocol] 本批在只读评审之后又改动了工作区（{files}）。评审已失效：重开受影响切片再收口。'`
- 渲染规则：`{files}` 最多 3 个路径，多余追加「等 N 个」；无路径时用 `工作区`；`{kind}` 取 `代码` | `未知`。
- 校验：`docPatterns` 非空字符串数组、`textDocOnly` 非空字符串；错误前缀 `dispatch-protocol: gates.verify.docPatterns` / `dispatch-protocol: gates.review.textDocOnly`。

### C3a 还原豁免扩到复合命令（2026-11-12 派发方复核后追加）
上游触发 #2 的原始命令是复合命令 `git checkout -- server/prisma/migrations/migration_lock.toml; git status --porcelain`；若只认「整条命令就是还原」，C3 在唯一真实场景上无效。冻结口径：
- 按 `|| && ; \n |` 切段，每段必须通过「无写盘」检查（不含 `>`、`--output`、`Out-File`、`Set-Content`、`Add-Content`、`tee`），且属于以下之一：
  1. 还原段：`git [-C x] checkout -- <路径…>`、`git [-C x] restore <路径…>`（无 `-` 开头参数）；
  2. 中性只读段：`git [-C x] status|diff|log|show|rev-parse|ls-files|remote …`、`git stash list`、`git branch [--list|-l|无参]`。
- **至少一段是还原段**才返回 true；其余任意段按脏（保守）。
- 测试必须覆盖：`checkout -- a.ts; git status --porcelain`=true、`restore x && git diff --stat`=true、带重定向=false、混 `git add`=false、`git status` 单独=false、多中性段=true、端到端不增 changes。

## 3. 冻结契约：纪律文本（`lib/config.mjs`）

| ID | 位置 | 追加内容（不重写既有条款） |
|---|---|---|
| T1 | 第 1 条「先勘察后派发」后 | 勘察批一律只读：产出以子代理 final message 回传，由主控落盘到 `dispatch/recon/<需求>.<端>.md`（`dispatch/` 属控制面白名单）；派发指令不得要求勘察子代理写文件——「勘察/只读」前缀会把沙箱收窄为只读，写必被拒。 |
| T2 | 第 1 条「有界直改」后 + footer 同步一句 | 纯文档/单字符级修复（改动全落在 `.md`/`AGENTS.md` 且 ≤10 行）只记台账 + 机器校验（括号平衡/链接/路径存在），不重开评审切片。 |
| T3 | 第 4 条评审末尾 | 文档切片默认不派独立评审：验收 = 主控机器校验 + diff 自查；只有被当契约读的 `docs/agent/*.md` 业务口径断言才派最小只读评审（≤2 文件、只核断言与代码是否一致）。 |
| T4 | 第 1 条（澄清） | 用户描述为「复制/克隆现有功能」时，澄清最多 2 问（范围 + 数据模型），其余决策按现有实现取默认值写进 spec 并逐条标「默认，未问」。 |
| T5 | 第 3 条（窄验证） | 窄验证必须是本模块测试文件（如 `vitest run tests/<module>*.test.ts`）；全量 tsc/全量 test 只在集成点跑一次，不得由每个执行批各跑一遍。 |
| T6 | 第 2 条（派发） | 同模式机械改写（跨方法签名/跨调用点）要求一次多 hunk 或脚本完成，不得拆成逐处 edit 往返。 |
| T7 | 第 6 条（并行） | 依赖同一新契约文件（如 `shared/<x>.ts`）的批次串行，其余互斥模块同层并发。 |
| T8 | 第 3 条（证据） | 集成结果按「覆盖文件集」记账：结果之后只有文档/台账/控制面改动时该结果仍有效，不需要复跑。 |

体积约束：新增文本合计 ≤ 900 字符（纪律正文已接近上限，只加不删）。

## 4. 测试（`test.mjs` 新增断言，逐条最小夹具）

1. C1：`dispatch/override.json`、`dispatch/recon/a.md` 写入后 VerifyGate 不触发。
2. C2：last verify 后仅 `AGENTS.md` → 不触发；`server/src/x.ts` → 触发且文案含 `x.ts`。
3. C2 边界：write 无路径 → `docOnly=false` → 触发。
4. C3：`git checkout -- a.ts`、`git restore x` → 不算脏；`git checkout main`、`git checkout -b y`、`git restore --source=HEAD~1 a.ts` → 算脏。
5. C4：评审后仅文档写入 → `docOnly:true` + `textDocOnly` 文案；含代码 → 原文案且 `{files}` 有路径。
6. C5：`docPatterns: []` / `textDocOnly: 42` 抛错且前缀正确；旧配置（无新键）仍加载。
7. 回归：既有断言全绿（当前 58 条基线，新增后 pass 数只增不减）。

## 5. 白名单与批次（串行 A → B）

| 批 | 文件（逐条） | 窄命令 |
|---|---|---|
| A 守卫逻辑+测试 | `plugins/dispatch-protocol/lib/tool-calls.mjs`、`lib/gates.mjs`、`plugin.mjs`、`test.mjs` | `node test.mjs` |
| B 文本+版本+文档 | `plugins/dispatch-protocol/lib/config.mjs`、`README.md`、`package.json`、`test.mjs`（仅既有断言因文本变更失配时最小同步，不得增删用例） | `node test.mjs` |

串行理由：同文件 `test.mjs` 与「A 的行为被 B 的文本断言覆盖」。禁止改：`lib/write-policy.mjs`、`lib/config.mjs` 的 gates 解析逻辑、`cordis.patch.yml`、`locale/*`。

## 6. 验收

- 集成命令（派发方跑，唯一）：`Set-Location plugins\dispatch-protocol; node test.mjs` → exit 0、fail 0。
- 独立只读评审：只审 A+B 的 diff，逐条核对 C1–C5 / T1–T8。
- 发布不随本次执行：装机需「完全退出 DSH → `dsh plugin --profile desktop update dispatch-protocol` → 重启」；改动落地后 `verify-install.mjs` 会报 version/file 漂移，属预期。
