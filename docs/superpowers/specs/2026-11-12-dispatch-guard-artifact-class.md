# dispatch-protocol 0.11.0 — 产物分类器收敛（替代 0.10.0 的补丁式豁免）

- 日期：2026-11-12
- 状态：已冻结（用户要求「站在全局角度处理，不要补丁式追加，不要偏离派发纪律核心目标」）
- 版本：0.10.0 → **0.11.0**
- 上游：`docs/superpowers/specs/2026-11-12-dispatch-guard-risk-grading.md`（0.10.0 已提交 `0f8540b`，**从未发布**，因此允许改口径、删键）
- 本 spec 的定位：0.10.0 是"按事件打补丁"；0.11.0 把它收敛成"一个分类器 + 一套路径语义 + 一个文案模型"

## 0. 自审：0.10.0 的四处补丁式追加（本 spec 要消除的）

| ID | 症状 | 危害 |
|---|---|---|
| A1 | C1 放宽为子串 `dispatch/`，`src/**/dispatch/**` 被连带豁免，并以"已接受的代价"写进 README/注释/评审 | **假阴性**：未验证的代码改动不再触发闸门，方向与「宁可多提醒」相反 |
| A2 | T1–T8 追加 +626 字符，其中 T2↔footer、T3↔README、T7↔规则6、T8↔规则3 重复 | 违反插件自身「只落在对应那一条、不追加第七条」的设计意图 |
| A3 | T8 承诺「集成结果按覆盖文件集记账」，代码无此模型 | 文本/代码分叉（本轮要消灭的病本身） |
| A4 | 每次误报新增配置键：`docPatterns` + `textDocOnly` + `{kind}`，四套占位并存 | 配置面单向增长 → 纪律退化为例外清单 |

## 1. 冻结契约

### D1 唯一分类器（`lib/tool-calls.mjs`）
```js
export const ARTIFACT = { CONTROL: 'control-plane', DOC: 'doc', CODE: 'code', UNKNOWN: 'unknown' }
export function classifyPath(file, { cwd, controlPlanePatterns, docPatterns } = {}) → ARTIFACT.*
```
语义（按顺序判定，全部大小写不敏感）：
1. `file` 缺失/空 → `UNKNOWN`。
2. **归一**：`\` → `/`；去 `./`；若为绝对路径且以 `cwd` 开头（含盘符，比较时大小写不敏感）→ 去掉 `cwd + '/'` 得相对路径。
3. **控制面**：相对路径按**路径段前缀**匹配 `controlPlanePatterns`（末尾带 `/` 的按目录前缀，否则按整段相等或前缀）。`src/app/dispatch/state.ts` **不得**命中。
4. **文档**：`docPatterns` 里以 `.` 开头的按**扩展名后缀**匹配（`.md` 命中 `a/b.md`，不命中 `a/b.mdx` 之外的跨界），以 `/` 结尾的按段前缀（`docs/`），其余按**段边界子串**（`LICENSE` 命中 `a/LICENSE`，不命中 `a/LICENSE-MIT` 之外的意外——实现取「段相等或段前缀」）。
5. 其余 → `CODE`。
6. **`cwd` 缺失或为空**：不做相对化，`CONTROL` 判定一律失败 → 落 `CODE`/`DOC`（**保守方向：闸门宁可多提醒**）。

`isControlPlanePath(path, patterns)`：**删除**（子串口径），由 `classifyPath(file, {cwd}).=== CONTROL` 取代；调用方（观测行、Verify、Review）全部改用它。
`matchesPath`：保留，仅供 ContractGate 的 `contract` 片段与 `gates.*.patterns`（那是**用户可配的粗筛**，语义就是子串，不改）。

### D2 cwd 透传（`lib/gates.mjs` + `plugin.mjs`）
- `analyzeVerification(events, verify, cwd)`、`evaluateVerifyGate(events, turn, gates, cwd)`、`evaluateReviewGate(events, gates, state, cwd)` 增加可选末参 `cwd`；`touchedWorkingTree(call, results, patterns, cwd)` 同步。
- `plugin.mjs` 两处闸门调用点传 `target?.session?.cwd ?? target?.session?.header?.cwd`（与 `:233` 写入守卫同源）；观测行同源。
- 向后兼容：`cwd` 省略时按 D1-6 保守处理（既有单测不传 cwd 的用例改为显式传 cwd 或断言保守结果）。

### D3 VerifyGate / ReviewGate 只消费分类结果
- `analyzeVerification` 的 `docOnly`：每个脏条目 `classifyPath ∈ {CONTROL, DOC}` 才为 true；`UNKNOWN`（无路径 write / pwsh）按代码。
- `evaluateReviewGate` 同口径（`files` 仍排除 CONTROL）。
- 删除 `verify.docPatterns` 之外的新键：**`gates.review.textDocOnly` 移除**。

### D4 一个文案模型（替代 N 个模板键）
- 默认文案：
  - `DEFAULT_VERIFY_TEXT = '[dispatch-protocol] 本回合准备 present/commit，但 {files}（{kind}改动）在最后一次成功集成命令之后又有改动（或从未跑过）。{action}'`
  - `DEFAULT_REVIEW_TEXT = '[dispatch-protocol] 本批在只读评审之后又改动了工作区（{files}）。{action}'`
- `{action}` 由闸门给出（固定两句之一，不可配置）：
  - verify：`'先跑一次集成命令并留存退出码，再收口。'`
  - review 代码：`'评审已失效：重开受影响切片再收口。'`
  - review 文档：`'这类改动不使代码切片失效：机器校验（路径/链接/括号/术语）即可，不必重开代码评审；若改的正是刚评审的那份文档，最小复核该文档即可。'`
- 占位兼容：`{changes}` / `{lastVerify}` 仍渲染（0.9.x 自定义文案不抛错）。
- 渲染函数统一为 `renderGateText(template, { files, kind, action, changes, lastVerify })`；`renderVerifyGate`/`renderReviewGate` 保留为薄封装（测试与旧调用点不破）。

### D5 纪律正文：归位 + 去重（目标：删除全部重复表述，净增 ≤ +350 字符）
> 说明：初稿写的「≤ 基线 +150」是未经验证的臆定数字；要凑到它只能砍掉规则 1 的核心枚举，属另一种失真。本版改为**可验证的结构目标**：每条规则只有一个家、不留重复；净增字符数如实记录；**整篇压缩另行决定**（见 §5）。
| 内容 | 归属（唯一一处） | 处理 |
|---|---|---|
| 勘察批只读、主控落盘 `dispatch/recon/` | 规则 1「先勘察后派发」 | 保留（0.10.0 T1），合并进同一句 |
| 克隆类需求澄清 ≤2 问 + 标「默认，未问」 | 规则 1 | 保留（T4） |
| 纯文档/单字符级直改只记台账 + 机器校验 | 规则 1（有界直改定义处） | 保留；**删除 footer 的重复复述** |
| 窄验证只看本模块测试文件 | 规则 3 | 保留（T5） |
| 机械改写一次多 hunk/脚本 | 规则 2 | 保留（T6） |
| 文档切片默认免独立评审 | 规则 4 | 保留（T3） |
| 依赖同一新契约文件的批次串行 | 规则 6 | 保留（T7），并与「同文件/同模块串行」合并成一句 |
| 集成结果按覆盖文件集记账 | — | **删除（T8）**：代码无覆盖集模型，文本不得承诺不存在的机制 |
- footer 只保留「产出物归属 + 交付通道按风险缩放 + 循环批 + 预算对称 + 轻批合并 + 勘察批只读前缀」，删除与规则 1/3/6 重复的 有界直改复述、机械改写复述。

## 2. 测试（`test.mjs`）
1. 分类器：`dispatch/override.json`（cwd=项目根）→ control；`src/app/dispatch/state.ts` → **code**（0.10.0 曾断言为 true，本版改回 false——这是 A1 的证据）；`D:\proj\dispatch\x.md`（cwd=`D:\proj`）→ control；无 cwd 时 `dispatch/x.md` → code（保守）。
2. doc：`docs/agent/a.md` → doc；`docs/agent/a.ts` → **code**（扩展优先）；`README.md` → doc；`LICENSE` → doc；`LICENSE-MIT` → doc（段前缀）；`a/LICENSE-BACKUP` → code。
3. `{action}`：verify 代码→“先跑一次集成命令…”；review 代码→“重开受影响切片”；review 文档→“不必重开代码评审”。
4. 旧占位：`{changes}`/`{lastVerify}` 仍渲染；不传 `cwd` 的 `evaluateVerifyGate` 对 `AGENTS.md`（相对路径、无 cwd）保守触发（`UNKNOWN`/`CODE`）。
5. 回归：0.10.0 的 C2/C3/C3a/C4 行为用例全部保留（改 `cwd` 形参后逐条跑绿）。
6. 删除 `textDocOnly` 相关断言与配置校验；`review` 段非法配置项同步收紧。

## 3. 白名单与批次（串行 D → E）
| 批 | 文件 | 窄命令 |
|---|---|---|
| D 分类器+闸门+测试 | `lib/tool-calls.mjs`、`lib/gates.mjs`、`plugin.mjs`（仅 cwd 透传）、`test.mjs` | `node test.mjs` |
| E 文案模型+正文归位+文档+版本 | `lib/config.mjs`、`lib/gates.mjs`（默认文案常量与渲染）、`plugin.mjs`（按分类选 `{action}`）、`README.md`、`package.json`、`test.mjs`（仅失配断言最小同步） | `node test.mjs` |

## 4. 验收
- 集成命令（派发方）：`Set-Location plugins\dispatch-protocol; node test.mjs` → exit 0。
- 真实场景回放（派发方）：4 次注入静默 + 对照组代码改动报警 + **`src/app/dispatch/x.ts` 改动必须报警**（A1 的回归）+ **`dispatch/../src/x.ts` 必须报警**（路径穿越回归）。
- 只读评审：一个包，核对 D1–D5。
- 量化自检：纪律正文净增字符数、配置键数量（0.9.1 = N，0.11.0 应 = N+1）。

## 5. 明确不在本次范围（避免"顺手重写"）
- **整篇纪律正文压缩**：6 条规则已约 4.5k 字符，做真正的压缩需要逐条重写、并单独评审（它是所有会话的系统提示词）。本次只做"去重 + 归位"，净增如实记录；整篇压缩作为独立决策项提出，不夹带。
- `matchesPath` 的 ContractGate 粗筛语义（用户可配的 `patterns` 本就是子串）。
- 观测行的落盘格式与 `dispatch/runs/*` 生命周期。
