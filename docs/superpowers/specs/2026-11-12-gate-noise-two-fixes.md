# 闸门噪声两修（检查点去重 / shell 写入目标分类）设计

- 日期：2026-11-12
- 状态：已确认（用户 2026-11-12 裁决「修，但不要做补丁追加式修复」）
- 触发证据：session-8c30d320（mes-02，「退料调拨单生产日期维度」，52.1 分钟，gated 需求）
- 上一版行为基线：0.12.1

## 1. 两条缺陷（都有决策日志 + 时间戳，不是推测）

### 缺陷 A：完成检查点的去重只认一种上报方式

决策日志 `%TEMP%\dispatch-protocol-decisions.jsonl`（session 8c30d320）5 行：

| time (UTC) | turn | kind | decision | 事实 |
|---|---|---|---|---|
| 09:34:48 | 5 | checkpoint | delivered | frontend settle 09:34:39 之后 9 秒，父代理尚未动手 |
| 09:45:30 | 6 | checkpoint | delivered | **父代理 09:44:28 已跑过集成命令**（stale） |
| 09:51:18 | 7 | checkpoint | suppressed(read-only) | 评审子代理零写入，走只读豁免 |
| 09:55:45 | 8 | checkpoint | delivered | **父代理 09:55:35 已跑完全量 build+test**（stale） |
| 09:57:06 | 9 | gate | delivered | 见缺陷 B |

三个 impl/fix 子代理**都是靠 closing message 汇报的**（没调 `send_message`）。`plugin.mjs:721 parentAlreadyHandled` 只认 `agent/inbox/spliced` 里的 `Agent <childId> sent a message` 这一种标记 → `reportAt < 0` → 一律判「没处理过」→ 必发。

### 缺陷 B：`pwsh` 写控制面台账被算成 `<shell>`「未知改动」

- 最后一次成功集成命令：09:55:35（`npm run build && npm test`，exit 0）。
- 之后唯一的写动作：`Add-Content dispatch\ledger\2026-11-12-transfer-return-production-date.md "…"`（09:56:11）。
- 09:57:06 VerifyGate 投出：`本回合准备 present/commit，但 <shell>（未知改动）在最后一次成功集成命令之后又有改动`。
- 父代理照办：09:57:14 起对 server + frontend 各跑一次全量 build+test（都 exit 0），并写台账「提交后集成复跑（dispatch-protocol 要求）」。

`gates.mjs:418 touchedWorkingTree` 对 `write`/`edit` 会先 `classifyPath` 控制面豁免，对 `pwsh` 只按 `DEFAULT_PWSH_SHELL_PATTERN` 判类型、**不看目标路径**，统一记 `<shell>`，而 `<shell>` 按设计算代码。于是同一个台账文件：`write` 追加算控制面，`Add-Content` 追加算代码改动。追加台账恰是纪律鼓励的动作（PowerShell 里唯一的自然追加方式）。

## 2. 为什么这两个修法不是「补丁追加」

判断标准：是否新增机制（配置键、文案、哨兵、规则条款）。两条都不新增。

- **A 是删条件**：现状是三条件（认标记 → 父代理有动作 → 子代理上报后没再写）拼出的近似；改为一个原语——**「子代理的报告对父代理可见之后，父代理有没有动过手」**。行数净减，且覆盖两条上报路径（`send_message` 与 closing message）。
- **B 是补完既有抽象**：代码里已有「一个调用 → 目标路径」的抽象（`readPath` + `dirtyPath` + `classifyPath`），只是 pwsh 分支从来没接进去。本修把 pwsh 也接进同一个分类器，`<shell>` 回归它原本的语义——**「拿不到路径」**，而不是「只要是 shell 就按代码算」。

## 3. 决定

> **2026-11-12 第三次复审后的设计反转（主控裁决，取代 §3 D2 全部内容）**
>
> 三次复审连续挖出漏验：逗号数组 → F1/F2/F3 → L1–L4（逗号旁空白与引号变形、模式外别名/外部命令/`git stash|switch|reset`、单 `&` 不切段、`cmd /c` 与 `iex` 的引号载荷）。根因不是分支不够，而是**命题不可证**：用「解析 PowerShell」去证明「这条命令没写到控制面之外」，而 PowerShell 是开放语言，每轮都能构造新语法绕开。
>
> 改为**封闭形状豁免**（proof by construction，而非 proof by enumeration）：
>
> - 新判定 `controlPlaneOnlyShellWrite(command, { cwd, controlPlanePatterns }): boolean`，**只在能证明是记账写入时返回 true**，其余一律 false（→ 脏 → `<shell>`）。
> - 返回 true 当且仅当**全部**成立：
>   1. 命令切成段（仅 `;` 与换行）后，**每一段**都命中下面的封闭形状之一；出现 `&`、`|`、`&&`、`||`、`$`、`(`、`)`、`@`、`,`、`cmd`、`invoke-expression`/`iex`、`--%` 等**任何**段外元字符即整体拒绝；
>   2. 形状 A：`(Add-Content|Set-Content|Out-File|Clear-Content) [-Path|-FilePath] <path> [<单个双引号字符串>]`；
>      形状 B：`New-Item ... [-Path] <path>`（`-ItemType Directory` 允许，其余开关拒绝）；
>      形状 C：形如 `git diff <只读参数> > <path>`（唯一允许的重定向形态，且 `git diff` 之外的 `git` 动词一律拒绝）；
>   3. 解析出的路径**恰好一个**，且 `classifyPath(path) === CONTROL`。
> - 其它任何写法（含逗号数组、`-Destination`、别名 `ac/ni/cp/mv/ri/del`、`Copy-Item`、`Tee-Object`、外部命令、子表达式、引号内可执行载荷）→ **false**（脏）。代价是偶尔多跑一次构建；收益是**不可能静默**。
> - 旧的多目标解析（`readShellWriteTargets`、`dirtyPaths`、`SHELL_DUAL_TARGET_VERBS`、逗号合并、残段复检）**整体删除**，不保留并列实现。
> - 判据来源：`controlPlaneOnlyShellWrite` 只回答「是不是记账写入」，**不再回答「写到哪」**；`gates.mjs` 的 `dirtyPaths` 随之退回单路径（`write`/`edit` 取 `readPath`，`pwsh` 一律 `<shell>`），`{files}` 里的 shell 条目重新显示为 `<shell>`。
> - 规则文本补一句（规则 1 账本相关处）：台账追加用 `write`/`edit`，不要用 `pwsh` 追加——shell 写入无法定位目标，按代码改动处理。

### D2（原文已作废，仅留作历史）

### D1 检查点去重：一个原语

`plugin.mjs` 的 `parentAlreadyHandled(parent, child, childId)` 重写为：

1. 在父代理日志里找**最后一条让该子代理报告可见的事件** `reportAt`，两类都算：
   - `agent/inbox/spliced`，插入文本含 `Agent ${childId} sent a message`；
   - `user/message` 且 `data.source.kind === 'subagent-settled'` 且 `data.source.senderSessionId === childId`
     （实测该事件带 `senderSessionId`，与 childId 精确相等，不需要按名字匹配）。
2. `reportAt < 0` → 返回 false（没有可见性证据，保守投递）。
3. 返回 `hasToolCallAfter(parentEvents, reportAt)`。

**删除**「子代理最后一次 `send_message` 之后是否又写过」这一支：报告可见点取「最后一条」，settle 必然晚于任何此类写入，旧支covered 的场景新判据等价（逐场景见 §5）。

### D2 shell 写入目标分类

**新函数**（`lib/tool-calls.mjs`，纯函数、无 IO、无配置）：

`readShellWriteTargets(command: string|undefined): string[]`

- 只认**第一个**写入目标；解析不出返回 `[]`。~~（2026-11-12 评审后作废，改为「全部目标」，见下）~~
- **2026-11-12 评审发现 F1/F2/F3 三类假豁免后修正（契约作废条款，主控裁决）**：
  - F1 多段命令只取第一段：`Add-Content dispatch\ledger\x.md "…"; Set-Content server\src\a.ts "y"` → 只解析台账；
  - F2 `-Path` 优先 + `-Destination` 被当取值开关跳过：`Copy-Item -Path dispatch\review\p.txt -Destination server\src\a.ts` → 只解析源；
  - F3 重定向优先于动词：`Set-Content server\src\a.ts "x" > dispatch\review\out.log` → 只解析重定向目标。
  - 三者都让真实代码写入在 `touchedWorkingTree` 面前静默（`targets.every(CONTROL)` 因只收到一个控制面目标而成立）。**危害方向是「漏验」，必须修。**
  - 新规则：解析出**全部**写入目标——
    1. 命令按 `;`、`&&`、`||`、`|`、换行切成段，逐段解析；
    2. 段内三类目标都算：目标开关（`-Path` / `-LiteralPath` / `-FilePath` / `-Destination`）、重定向（`>` / `>>`）、动词后的位置参数；
    3. 位置参数按**动词元数**取：单目标动词（`Add-Content` `Set-Content` `Clear-Content` `Out-File` `Remove-Item` `New-Item` `Tee-Object`）取第 1 个；双目标动词（`Copy-Item` `Move-Item` `Rename-Item`）取前 2 个（源 + 目的）；
    4. 内容参数永不参与（单目标动词只取第 1 个位置参数，第 2 个起视为内容）；
    5. 任一段解析不出目标且该段含写入动词 → 该段贡献 `[]`，整体退回 `<shell>`（保守：不知道就不豁免）。
       - **2026-11-12 复审后修正（本条作废，改为下面的单向规则）**：原判定用「动词白名单」当「这段写没写」的依据，导致 `del` / `ri` / `copy` / `move` / `mkdir` / `git apply` / `git merge` 等**命中 `DEFAULT_PWSH_SHELL_PATTERN` 却不在白名单**的写法被当成「非写入段」忽略——只要同一条命令里另一段写控制面，整条就静默。这是 D2 引入的新漏验（D2 之前这些一定脏），复审用 6 个构造实测 `dirty:false`。
       - **新规则（单向、单一真源）**：变更模式判定「这段写没写」，解析器只判定「写到哪」，解析不出就退回 `<shell>`：
         1. 逐段用**既有** `DEFAULT_PWSH_SHELL_PATTERN` 判定该段是否写入（不再另立「写入动词白名单」当真源；动词表只用于**定位**目标）；
         2. 写入段必须解析出至少一个目标，否则该段 `null` → 整条命令 `[]` → `<shell>`（保守算代码）；
         3. 解析只允许**缩小**脏范围（全部目标具名为控制面才豁免），永不允许放大豁免；
         4. 逗号数组按逗号拆分（`Remove-Item a.md,server\src\a.ts` 是两个目标，`a, b` 同）；
         5. `git commit` 仍不算写入段（`DEFAULT_PWSH_SHELL_PATTERN` 排除），`git checkout --` / `git restore` 仍由 `isRestoreCommand` 在更外层短路。
  - `gates.mjs` 的豁免条件（目标非空且**全部** CONTROL）无需改动——它本来就是对的，只是以前只收到一个目标。
- 目标来源，按优先级：
  1. 显式开关 `-Path` / `-LiteralPath` / `-FilePath` 的下一个 token；
  2. 重定向：token 恰为 `>` / `>>`，或匹配 `/^(?:>|>>)(?!=|&)(\S+)$/`，取其后的 target；
  3. 写入动词（`Add-Content` `Set-Content` `Out-File` `Clear-Content` `New-Item` `Remove-Item` `Copy-Item` `Move-Item` `Rename-Item` `Delete` `tee`）之后的第一个位置参数——跳过以 `-` 开头的开关，以及已知取值开关（`-ItemType` `-Encoding` `-Value` `-Name` `-Filter`）的取值（`-Destination` 已迁到目标开关，见 §3 修正条款）。
- 形状守卫（**2026-11-12 派发方修正**，原文「必须含 `/` 或 `\` 或含 `.`」与 §6 的 `Copy-Item a b → ["a","b"]`（双目标）互斥，按 §6 为准）：拒绝 `$` 开头的变量、以及含 `& | ; = ( ) { } < > ' "` 或空白的表达式/管道产物；**放行裸词位置参数**。
  - 安全性论证（采纳理由）：控制面/文档分类依赖带分隔符或带扩展名的模式（`dispatch/`、`docs/superpowers/specs/`、`.md`），裸词不可能被判成 CONTROL 或 DOC，因此放行裸词**不会**造出假的控制面豁免——最坏情况是把 `<shell>` 换成一条更精确的代码路径。
- **内容参数永不参与分类**：因为只取第一个位置参数，`Add-Content dispatch\ledger\x.md "- 改了 server/src/a.ts"` 解析结果仍是 `dispatch\ledger\x.md`。这是本修最关键的一条（台账正文经常提到代码路径）。
- 不解析 `$变量` / 表达式 / 管道产出；这些一律 `[]`，退回 `<shell>`。

**`lib/gates.mjs` 三处**：

1. `dirtyPath(call)` → `dirtyPaths(call): string[]`：`write`/`edit` 取 `readPath`（取不到 `['<shell>']`）；`pwsh` 取 `readShellWriteTargets`（空则 `['<shell>']`）。
2. `touchedWorkingTree`：pwsh 分支在既有 pattern + `isRestoreCommand` 判定**之后**，若解析出目标且**全部** `classifyPath === CONTROL` → 返回 false（与 `write`/`edit` 的控制面豁免同口径）；其余不变。
3. `analyzeVerification`：对 `dirtyPaths(call)` 逐个入 `files`（去重）并逐个分类参与 `docOnly`。

**语义不变项**：`<shell>` 仍是占位、仍按代码算；`{kind}` 仍输出「未知」；没有任何配置键或文案新增。

**README 同步 1 行**：`### 状态闸门` 的「脏判定」句补「（`pwsh` 命中变更动词且解析出目标时按目标路径分类，解析不出才算 `<shell>`）」。

## 4. 不做的事

- 不解析变量与表达式（`$x`、`$(…)`、管道产出）；`git apply <patch>` 这类「无路径目标的写入」退回 `<shell>`（保守算代码改动）。~~不推断多目标~~（2026-11-12 作废：多目标必须解析，见 §3 D2 修正条款）。
- 不改任何规则正文、不改闸门文案、不加配置键。
- 不动 ReviewGate / WaitGate / HandoffGate / 写入守卫的行为。

## 5. D1 的四场景等价推演（评审依据）

| 场景 | 旧判据 | 新判据 | 结论 |
|---|---|---|---|
| 子代理 `send_message` → 父代理动手 → 子代理继续写 → settle | 报告后子代理写过 → 投递 | `reportAt` = settle（最后一条可见事件）→ 父代理在 settle 后无动作 → 投递 | 同 |
| `send_message` → 父代理动手 → settle | splice 后有 tool/call → 静默 | `reportAt` = settle → settle 后无动作 → **投递** | **不同**：新判据更吵？见下 |
| closing message 上报 → 父代理动手 → 收尾判定 | 认不出标记 → 投递（本会话 3 次） | settle 后有 tool/call → 静默 | **修复目标** |
| 子代理 settle → 父代理整回合没有任何动作就收尾 | 投递 | 投递 | 同 |

第 2 行需要说明：该场景在旧判据下静默，新判据下投递。风险是「父代理已经动手了却被提醒」。但注意 `reportAt` 取最后一条可见事件，而 flag 的**目的**是「父代理别在孩子跑完前就标记完成」；在 settle 之后父代理还没有任何动作时，提醒一次是唯一有信息量的时机——如果父代理确实已在此前的 turn 里做过验收，settle 之后的一步大概率就是读报告/收口，提醒不会误导。**这是本设计唯一放宽的地方，明确记录、由评审裁决。**

## 6. 测试

- `readShellWriteTargets` 单测（8 条）：`Add-Content dispatch\ledger\x.md "含 server/src/a.ts 的正文"` → `dispatch/ledger/x.md`；`Set-Content src/a.ts "x"` → `src/a.ts`；`New-Item -ItemType Directory -Force dispatch/review` → `dispatch/review`；`git diff > dispatch/review/x.diff` → `dispatch/review/x.diff`；`npm run build 2>&1 | Tee-Object -FilePath ..\dispatch\review\e.log` → `../dispatch/review/e.log`；`Remove-Item $tmp` → `[]`；`echo hi` → `[]`；`Copy-Item a b` → `["a","b"]`（2026-11-12 复审后修正：双目标动词取源与目的两端，原写 `["a"]` 与 §3 修正条款规则 3 冲突）。
- 闸门级（4 条）：最后一次验证之后只有 `Add-Content dispatch\ledger\x.md` → **VerifyGate 为 null**（缺陷 B 回归）；同样时机 `Set-Content src/a.ts` → 投递且 `{files}` 含 `src/a.ts` 不含 `<shell>`；`Add-Content docs/agent/x.md` → 为 null（docOnly）；`Remove-Item $tmp`（解析不出）→ 投递且含 `<shell>`。
- 检查点（3 条）：settle 上报 + 父代理 settle 后有 tool/call → `reason: 'handled'`；settle 上报 + 父代理 settle 后零动作 → 投递；`send_message` 上报路径既有用例保持通过。
- 既有 125 条零改动；新计数以实际为准。

## 7. 验收

- `node plugins/dispatch-protocol/test.mjs`：全 PASS（≥125）。
- `node plugins/dispatch-protocol/scripts/docs-check.mjs`：0 FAIL（README 改了 1 行）。
- 判级：gated（改闸门判定行为）；单批 5 文件 → **全批**，跑过集成命令后派 1 次只读评审。
