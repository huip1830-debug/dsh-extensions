# dispatch-protocol 0.12.0 — 文档按「断言类型」分通道 + 确定性检查器

- 日期：2026-11-12
- 状态：已冻结（用户确认实施「machine check 不足 → 断言类型分通道 + docs-check 实体化」）
- 版本：0.11.0 → **0.12.0**
- 上游自审：T2/T3 把「机器校验」写成口号（括号/链接/路径），**没有实体化**，实际靠模型自觉；本会话实测 6 条文档漂移里，确定性检查只能抓 1 条（AGENTS.md 括号），其余 3 条被主控逐行读 diff、2 条被独立评审抓到；而那次文档评审成本是 **10.4 min / 74 次调用 / 2.37M token**。

## 1. 冻结契约

### D1 确定性检查器 `plugins/dispatch-protocol/scripts/docs-check.mjs`
纯 Node、零依赖、只读（`--self-test` 只写 `os.tmpdir()`）。

**调用**：`node scripts/docs-check.mjs [--self-test] [--root <dir>] [files...]`
- 无 `files` 且无 `--self-test` → 扫 `<root>`（默认 cwd）下的 `AGENTS.md`、`README.md`、`docs/agent/**/*.md`、`plugins/*/README.md`、`docs/superpowers/specs/**/*.md`（当前事实文档）；**跳过** `docs/reviews/**`、`docs/superpowers/plans/**`（历史/证据快照）、`node_modules/`、`.git/`、`tmp/`。
- 相对路径按 cwd 解析；文件不存在 → `FAIL DOC000`。

**检查项**（每项独立 code，逐条输出 `PASS|FAIL <code> <file>:<line> <detail>`）：
| code | 检查 | 边界 |
|---|---|---|
| DOC001 | 全角/半角括号按行平衡 | 跳过 ``` 围栏内与行内 `` `…` `` |
| DOC002 | 代码围栏成对闭合（``` 计数为偶数） | 围栏内的 ``` 不再重复计数 |
| DOC003 | 同一表格块内列数一致（按 `\|` 切，去掉首尾） | 忽略行内代码里的 `\|` |
| DOC004 | 相对链接目标存在（`](x)`） | 跳过 `http(s)://`、`mailto:`、`#…`；先按文档所在目录解析，再按 root 解析 |
| DOC005 | 配置表行首键真实存在：匹配 `^\|\s*`(gates\|writePolicy)\.[A-Za-z.]+`` 行，键名必须**逐字命中** `lib/config-keys.mjs` 的 `CONFIG_KEYS` 清单（不再做末段兜底——兜底会让 `gates.review.docPatterns` 这类**内部字段冒充配置键**蒙混过关，即 0.10.0 的真实漂移样本） | 只查表格行；迁移/历史正文不查 |

**`CONFIG_KEYS` 的正确性由测试保证**（不靠人工维护）：`test.mjs` 用 `resolveGates({})` / `resolveWritePolicy({})` 递归推导叶子键路径（前缀 `gates.` / `writePolicy.`），断言与 `CONFIG_KEYS` **集合相等**；代码新增/删除键而未同步清单 → 测试红。

**输出**：逐条结果 + 末行 `docs-check: files=<N> fail=<M>`；`M>0` → exit 1；全部通过 → exit 0。
**`--self-test`**：在 tmpdir 造 8 个 fixture（括号平衡/不平衡、围栏闭合/不闭合、表格齐/不齐、链接存在/不存在、键存在/不存在），逐条断言判定与退出码，输出 `self-test: pass=<n> fail=<m>`，`fail>0` → exit 1。
**不得**：修改被检查文件；引入依赖；联网。

### D2 纪律正文按「断言类型」分通道（只改两处，其余不动）
1. **规则 1（有界直改）**把「机器校验：括号平衡/链接/路径存在」改为：
   `纯文档级修复只记台账 + 插件自带 scripts/docs-check.mjs 跑一遍，不重开评审切片；若改动引入机制断言（「X 不触发 Y」「删除后会被忽略」「评审失效」这类）或落在 AGENTS.md / docs/agent/*，改为出「断言 → 代码位置」表、主控抽查 2 条。`
2. **规则 4（文档切片）**把现有「文档切片默认不派独立评审…」一句改为：
   `文档切片默认不派独立评审：验收 = docs-check 跑绿 + 断言表抽查（语法/链接/键名由脚本判；机制断言逐条给代码位置，主控抽 2 条）；AGENTS.md 与 docs/agent/* 属注入面，任何改动都走断言表，必要时派最小只读评审（≤2 文件、只核断言）。spec 与变更历史只做语法检查（历史不冒充现状）。`
- 净增 ≤ +180 字符（如实记账）。**注：本口径与「主控抽查 2 条」均已被 D5 取代**——实际以 D5 的「表空/表非空 + 1 次有界评审」为准，字符数按 release 实测记账（规则 1 = 1176 字符、规则 4 = 797 字符，0.12.0）。

### D3 README
新增「文档校验」小节：说明 `scripts/docs-check.mjs` 的用法、五个 code 的含义、与「断言表」的分工；变更历史加 0.12.0 行。

### D4 测试
- `test.mjs` 增两条文本断言：规则 1 含 `scripts/docs-check.mjs`、规则 4 含 `断言表` 与 `注入面`。
- `docs-check.mjs --self-test` 覆盖 D1 的 8 个 fixture。

### D5 文档批的断言表与有界评审（2026-11-12 用户裁决后追加，**取代**「必要时派最小评审」）
- 每个文档批必须交「断言 → 代码位置」表：本批新增/修改的**机制/行为**断言逐条给 `file:line`。**删除或改写的既有机制断言同样入表**，并注明「不再成立」及理由（防「删除型漂移」——删掉一句机制约束不会产生新断言，表仍会是空的）。
- **表空**（纯措辞/格式/排版）：`docs-check` 绿即收口，且台账写一行「本批无机制断言」留证；表非空派 1 次有界评审。
- **本节的「表空免评审」是被评审指出的最弱一环**（反规避分析：赶进度的批可把机制断言说成措辞）。现有对手只有三条：删除/改写必须入表（上条）、`AGENTS.md`/`docs/agent/*` 强制非空、评审输出的「未入表断言清单」。不做更多工具化——加检索引擎的成本高于它抓到的漏。
- **表非空**：派 **1 次**有界只读评审。范围硬约束：仅 ①本批 md 的 diff ②断言表 ③表中代码锚点（≤10 处）；**不得读整仓**。输出：逐条 PASS|FAIL + 一行「diff 里未入表的断言」清单（防作者漏报）。
- **次数 = 1 / 变更集**：修完只复跑 `docs-check` 并更新断言表，**不再复审**（与 ReviewGate 每波次只提醒一次同构）。
- `AGENTS.md`、`docs/agent/*` 属**注入面**：断言表强制非空（哪怕看似只改措辞）。
- 成本基线（本会话实测）：无界文档评审 74 次调用 / 10.4 min / 2.37M token；有界复核 6 次调用 / 1.3 min。
- 残余上限（如实记录）：机器只能判语法/链接/表格/键名；有界评审只能核「这句话与它引用的那行代码是否一致」；**语义是否解释得对**无人能自动保证。

### D6 评审节奏：一个变更集一个包（2026-11-12 用户裁决后追加）
- 默认**「一个变更集 = 一个评审包」且终评一次**：全部实现批落地、集成命令跑过之后再派。**禁止每批一评**——后批改动会让前批评审立即失效，等于白付一次上下文。
- 切片仅在 **>20 文件或 >3 契约面**时按契约面切（单个契约面自身超 20 文件再按读写路径切）；cross-slice 包只在切片之间**确实独立**（接口/类型/别名表/路由边界）时开，且不得重复已报缺陷。
- 修复后**只重开被判 FAIL 的那一片 + 直接影响面**，不重开全包。
- **唯一例外**：被后续批次依赖的**契约批**（其产物是后续批的只读输入）在后续批启动前做一次**只读契约复核**，范围仅白名单 + 契约面。理由不是"更保险"，是它错了的返工倍数最高。
- 成本依据（本会话实测）：32cd3319 用 5 个评审包 = 49.5 min / 13.4M token，其中 cross-slice 包无独有发现；若按 15 个实现批各评一次 ≈ 30M token。

## 2. 白名单与批次（串行 G → H）
| 批 | 文件 | 窄命令 |
|---|---|---|
| G 检查器 | `plugins/dispatch-protocol/scripts/docs-check.mjs`（新建） | `node scripts/docs-check.mjs --self-test` + 对 `README.md`、`plugins/dispatch-protocol/README.md`、本 spec 各跑一次并报发现 |
| H 规则+文档+版本 | `lib/config.mjs`、`README.md`、`package.json`、`test.mjs`（仅新增两条断言） | `node test.mjs` |

G 只报发现、不修文档（README 属 H）；H 负责把 G 在 README 上发现的真问题修掉。

### 批次实况（执行记录，替代 §2 的计划表）
| 批 | 内容 | 结果 |
|---|---|---|
| G | `scripts/docs-check.mjs`（DOC001–DOC005 + self-test） | ✅ 首跑抓到 README `:165/:243` 两条真实表格渲染缺陷 |
| H1 / H1b | `lib/config-keys.mjs`（输入面 26 项）+ DOC005 严格化 + 镜像集 4 项显式化 | ✅（H1 曾按「输出叶子」误把镜像字段当输入键，H1b 修正） |
| H2 | 规则 1/4 文本 + README 表格修复与文档校验节 + 0.12.0 | ✅ 123 pass |
| H3 | 规则 4 评审节奏（D6）+ README 评审小节 | ✅ 124 pass |
| 有界直改 | 规则 4 残留 `**` 清理（2 字符，override.json 已写） | ✅ 124 pass |
| I | 断言表空分支加固（删除/改写也入表 + 台账留证） | 见台账 |

## 3. 验收
- 集成命令（派发方，唯一，**从仓库根执行**）：
  ```
  node plugins/dispatch-protocol/test.mjs
  node plugins/dispatch-protocol/scripts/docs-check.mjs --self-test
  node plugins/dispatch-protocol/scripts/docs-check.mjs README.md plugins/dispatch-protocol/README.md docs/superpowers/specs/2026-11-12-dispatch-guard-artifact-class.md docs/superpowers/specs/2026-11-12-doc-verification-by-assertion.md
  ```
  三段全部 exit 0。
- 只读评审：一个包（G+H 的 diff），核对 D1–D4；**重点**：检查器是否真的能抓「括号不平衡」与「配置表键不存在（含内部字段冒充）」两类，且不误报当前事实文档。
- 真实用例回归：本会话 0.10.0 的两处漂移样本（AGENTS.md 括号 8/7、配置表把 `gates.review.docPatterns` 当键）作为 fixture，必须 FAIL。

## 4. 明确不在本次范围
- 不接入 CI、不做全仓历史 md 修复、不做默认值/数字比对（易误报）、不做 markdown AST 解析（只做行级）。
