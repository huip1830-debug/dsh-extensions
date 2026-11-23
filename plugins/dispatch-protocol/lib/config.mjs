// Dispatch discipline text injected as a system-prompt section.
//
// The six rules are ordered by *who owns what*, not by when they were added:
//   1 ownership   — who may produce which artifact (control plane vs execution
//                   plane); the survey format lives inside this rule
//   2 dispatch    — what a child may touch, must return, may spend, and what
//                   stays frozen while it runs
//   3 verify      — who pays for command execution (once, plus one coverage
//                   exception), and how the dispatcher waits
//   4 review      — what an independent review may look at, and how far
//   5 commit      — who owns the repository history
//   6 parallel    — what may run together, and how a change set is graded/sliced
// A rule change lands in exactly one paragraph; the header keeps that ownership
// explicit so later edits do not append a seventh clause out of habit.
//
// Rule 4 is deliberately scoped to the change set: the review object is the
// union of the batch whitelists as a diff, plus the frozen contract and the
// main agent's integrated result — never the repository. A repo-wide sweep is a
// separate, explicitly bounded column, opened only when the requirement itself
// is an invariant ("彻底统一" / "不得残留" / "所有调用方").
//
// 0.8.0: permission follows the *artifact*, not the activity. The main agent may
// write only the contract/ledger state files; anything under src/tests/scripts
// or a document body belongs to a child. Work whose path is unknown until it is
// run (>=3 run→inspect→change rounds) is a *loop batch*: one child owns the
// environment and the iteration, and the main agent answers only contract forks
// (NEEDS_DECISION). External unknowns are measured by a read-only spike before
// the contract is frozen. Budgets are symmetric: a child batch and a main-agent
// turn both carry a wall-clock/step cap. The numbers in the rules bound
// capacity and cost, never the whitelist: review packages (20 files / 3
// contract surfaces), a batch budget (15 min / 30 edits), a main-agent turn
// (15 min / 20 steps). The dispatch whitelist stays enumerated and is never
// capped by file count.
// Ceremony scales with risk (0.8.1): the control plane, a light batch, a full
// batch, and the bounded direct edit below.
//
// 0.9.0: the discipline moved from a turn-end reminder (nudge) to the tool
// boundary (write policy). Rule 1 therefore names the exemption artifact —
// `dispatch/override.json` — instead of asking for a prose override line; the
// rest of the rules, the footer and the gate texts are unchanged.
//
// 0.9.1: the ledger is per requirement, not per workspace. Rule 1 names
// `dispatch/state/<需求>.md` / `dispatch/ledger/<需求>.md` and closes with the
// multi-session paragraph (list `dispatch/state/` first, ask the user when the
// same requirement already has a live file, legacy `dispatch/state.md` is
// read-only). Only rule 1 text changed; rule 2-6 stay as they were.
//
// 0.15.0: a project policy file may pick a rule preset. The `business` preset's
// six skeleton rules and closing paragraph are frozen verbatim here
// (`BUSINESS_RULES` / `BUSINESS_FOOTER`) and selected by `resolveRulesPreset`;
// `resolveConfig`'s own return object is unchanged (the profile's rules/footer
// still render `text`), so a project without a policy file is byte-identical.
//
// 0.17.0: the five turn-end state gates (wait/verify/contract/review/handoff)
// are gone. Their defaults went with them; a `gates` section in a profile is a
// load-time error with a migration hint rather than a silently ignored config.
//
// 0.21.0: review / re-review / recon are bound to the Host-global delegation
// tool `subagent_readonly` (spawn + the `dispatch-readonly` preset in
// `cordis.patch.yml`). That preset has no write tools and no shell, so rule 4's
// "no build/test/integration re-runs" is enforced at the tool surface as well
// as by the prompt. Rule 1's recon sentence, rule 4's review sentence, the
// closing paragraph and the `business` preset's rule 4 changed;
// `AUTO_TEXT` and `BUSINESS_FOOTER` are untouched.
//
// 0.22.0: the readonly role's route and sandbox stop depending on the label
// prefix. The tool instance pins the route at creation (`agentOptions`), and a
// new `readonlySandbox` mechanism narrows the sandbox by the child session's
// `agent-preset/selected` record (structural) instead of the label prefix
// (textual). The label convention survives only for the spike path (plain
// `subagent`, narrowed by model-pin's role table). Rule 1's parenthetical and
// the footer's last sentences changed; the binding to `subagent_readonly`,
// `BUSINESS_RULES` and `BUSINESS_FOOTER` are untouched.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWritePolicy } from './write-policy.mjs'
import { DEFAULT_PROJECT_SWITCH } from './project.mjs'

// 0.9.0 写入守卫的默认值同样从这里转出：README/配置表与测试都只认这一个入口。
export {
  DEFAULT_ALLOWLIST, DEFAULT_OVERRIDE_PATH, DEFAULT_WRITE_POLICY_MODE,
  evaluateWritePolicy, isAllowedPath, readOverride, renderDenyText, resolveWritePolicy,
} from './write-policy.mjs'

// 0.13.0 项目级开关：默认值与模式常量同样只有一个入口（实现与判定在
// `lib/project.mjs`），`resolveConfig` 只做加载期校验与转发。
export {
  DEFAULT_PROJECT_SWITCH, PROJECT_MODES, readProjectMode,
} from './project.mjs'

/** 决策日志默认路径（checkpoint + 写入守卫共用一份）。 */
export const DEFAULT_LOG = join(tmpdir(), 'dispatch-protocol-decisions.jsonl')

/** 0.22.0：默认收窄 `dispatch-readonly` preset 的子代理（cordis.patch.yml 声明）。 */
export const DEFAULT_READONLY_SANDBOX_PRESETS = ['dispatch-readonly']

/** 0.22.0：合法的沙箱收窄目标（与宿主沙箱档位逐字一致）。 */
export const READONLY_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/** The six non-negotiable rules; overridable through `config.rules`. */
export const DEFAULT_RULES = [
  '主控只做控制面，不做执行面：允许的动作只有七类——问用户、冻结契约与账本（只写 dispatch/state/<需求>.md、dispatch/ledger/<需求>.md、docs/superpowers/specs/*、验收台账）、派发与调度、裁决子代理证据（只读报告 + diff + 指定行）、跑唯一一条集成命令、提交交付、结束回合等事件。执行面一律派发：src/**、tests/**、scripts/** 的任何写入，真实环境/账套排错，构建与失败测试修复，文档正文，测试，评审与评审修复；唯一例外是用户显式要求主控亲自做：先在 `dispatch/override.json` 写 `{"reason":"…","source":"…"}` 再动手，守卫只认这个文件（每会话有效，新会话需重写）；有界直改同样先写 override。有界直改限于已闭合批次上的收尾修复：主控可直接改单文件 ≤10 行，改完记台账并重开受影响评审切片（纯文档修复只记台账 + 跑 scripts/docs-check.mjs（无此脚本的仓库记一行台账、不新建脚本）、不重开评审；文档批须交「断言 → 代码位置」表，删除或改写的机制断言入表并注明「不再成立」：表空即收口且台账写「本批无机制断言」（AGENTS.md 与 docs/agent/* 注入面除外：断言表强制非空、不得空表收口），表非空派 1 次有界评审——范围仅本批 md diff + 表中代码锚点，修完只复跑 docs-check、不再复审）；同一批次累计 ≤20 行，第二个文件或超限即停手转派。先勘察后派发：派发前把「文件:行号 + 相关代码 + 结论（含现存调用方） + 不确定项」写成现状文件并在派发中引用，无现存调用方的实现在 spec 标「预防性实现」，并给出可改文件白名单（逐条列名，以「全批结束能用一条集成命令验收」为界）。勘察批唯一触发条件：主控现有上下文写不出这份现状；刚读过相关模块或属已知模式克隆时免派。勘察一律用 `subagent_readonly` 派发：产出以 final message 回传，主控落盘到 `dispatch/recon/<需求>.<端>.md`（属控制面），不得要求勘察子代理写文件；label 仍以「勘察/只读」开头（spike 走普通 subagent 时按此前缀收窄沙箱）。禁止把「调研 X 然后实现」交给执行类子代理。被 `dispatch-protocol` 守卫拦截时，按错误信息二选一（派发 / 写 override），不要重试同一个调用。同一工作区可能并行多个会话：台账按需求分文件，只写自己需求那份、不覆盖别人的；开工先看 dispatch/state/，同一需求已有进行中的文件时先问用户是否接手。「复制/克隆现有功能」类需求澄清最多 2 问（范围 + 数据模型），其余按现有实现取默认值写进 spec 并标「默认，未问」。用户只回 ok 时记「ok 视为接受推荐项」，不得写「用户已确认」。遗留的 dispatch/state.md 只读。台账追加优先用 write/edit；pwsh 的 Add-Content 只有命中封闭形状且目标全在控制面才不脏，其余按代码改动处理。',
  '执行类派发必须自包含：至少含【现状】【允许修改/允许读取】【验证：唯一一条命令——覆盖本批改动的窄命令，全量构建/全量测试归派发方的集成命令】【预算：墙钟与步数上限】【输出格式】。预算过半发一句话进度（改到哪、还差什么、契约疑点）；超预算先报阻塞点再停，不得续期。清单外信息或现状与代码不符时停报 NEEDS_CONTEXT，不得扩大范围。同模式机械改写一次多 hunk 或脚本完成，不得逐处 edit 往返。派发即冻结：该批运行期间，白名单外的契约面（src/schema/类型/路由）只读；派发方必须改时先停子代理（interrupt）、改完重派并注明「契约已变」。',
  '验收与等待：验收分两层，执行性验证只归派发方——子代理只跑自己那部分的窄验证（负责归因），窄验证必须是本模块测试文件（如 `vitest run tests/<module>*.test.ts`），全量 tsc/test 只在集成点跑一次、不得每批各跑一遍，派发方在相关子代理全部结束后跑那条集成命令（负责集成状态）并留存退出码；同一条命令全系统只跑一次，不重复付费（多包仓库按端各一条，每端只跑一次）。前提：那条集成命令必须覆盖各批窄验证断言点的并集；某批窄验证断言了集成命令覆盖不到的行为时，该批窄命令由派发方自己再跑——这是唯一的复跑例外。派发后不要守着：一批最多一次主动检查（预算过半时），其余时间结束回合等完成事件；不要用一串 Start-Sleep/list_agents 轮询。未跑集成命令不得标记完成。',
  '评审只审变更集，不审仓库：命中 gated 的需求另派只读评审子代理（一律用 `subagent_readonly` 派发；其组合无写工具与 shell，diff 与集成输出由主控先落盘 `dispatch/` 再交评审读取）（判为轻批的批次除外——gated 是需求级判定，不改变轻批免独立评审），输入只有需求原文、冻结契约、本批白名单并集的 diff（不是工作区快照）、派发方复跑的集成结果（退出码与输出全文）。逐条给 PASS|FAIL + 文件:行号，不逐文件通读未改动文件；需求本身是全局不变量（「彻底统一」「不得残留」「所有调用方」这类）时加一栏「全仓不变量核查」：给定检索词与目录，输出命中点排除表，用户可见的遗漏判 FAIL。评审节奏：一个变更集 = 一个包，全部实现批落地且跑过集成命令后再派，不得每批一评（后批改动会让前批评审失效）；包超过 20 个文件或 3 个契约面才按契约面切片（单个契约面自身超 20 文件时按读写路径再切，并写明切法）；跨切片一致性包只在切片确实独立（接口/类型/别名表/路由边界）时开，不得重复已报缺陷。唯一例外：被后续批次依赖的契约批（产物是后续批的只读输入）在后续批启动前做一次只读契约复核，范围仅白名单 + 契约面。评审只做 read/grep 语义核对（只读的 git diff、Select-String、程序化比对都算），禁止重跑构建/测试/集成命令，不得采信实现者的自述或其测试通过，全 PASS 须说明每条例子的验证方式；可给建议但不得改文件，裁决归派发方。评审后任何改动（含派发方自修）只重开被判 FAIL 的那一片及其直接影响面，不重开全包。文档切片：AGENTS.md 与 docs/agent/* 属注入面、断言表强制非空，有界评审输出逐条 PASS|FAIL + 未入表断言清单；spec 与变更历史只做语法检查。',
  '提交权归派发方：子代理不得 commit / push / reset / clean，除非派发中显式授权；派发前先记录目标文件的既有未提交改动，不得覆盖，也不得计入本次成果。',
  '并行只读，互斥并行写：只读子问题互不依赖且 ≥2 个时，在同一条消息里并行发出，不要逐个等；实施也能并行，但白名单必须按文件/模块互斥（同文件、同模块串行；依赖同一新契约文件的批次也串行），schema/类型/路由/barrel/lockfile 这类契约在派发前定死，子代理不得并发跑共享产物（同 dist、缓存目录、端口）的全量构建，大改动需要各自完整构建时拆独立 worktree。开工先按两轴判级，连同拆批方案或一行不派发理由写进任务清单或台账首行：风险轴同一需求合并判级，任一批次命中并行写或契约面即整个需求 gated，不得按子代理切分绕过评审；规模轴单批满足「单文件 ≤20 行或同模式机械改写 ≤5 文件」且 ≤8 分钟判轻批，按产出物归属分流、免独立评审（子代理跑窄命令，主控复跑 + diff 自查留证）；单批预估超过 15 分钟或 30 次编辑就按场景切片（同文件/同构建产物仍串行），保证 10 分钟内出现第一个可验收切片。改动面超出预估（白名单外文件、新增契约面、工作量显著超预估）必须停手重新判级。',
]

/**
 * The closing paragraph: who may produce what, how a loop is dispatched, and the
 * symmetric budget.
 *
 * Permission follows the artifact, not the activity: if the output lands in
 * src/tests/scripts or a document body, it is a child's job; the main agent
 * keeps only the contract, the ledger, adjudication, acceptance and commit.
 * Delivery channels scale with risk instead of being all-or-nothing: the control
 * plane (contract/ledger/adjudication) is written by the main agent; a *light
 * batch* (criteria in rule 6) goes to a child with no spec and no independent
 * review; everything else is a *full batch* (spec freeze + independent review +
 * integration). Loop work (result unknown, >=3 run→inspect→change rounds) is
 * dispatched as a loop batch carrying its environment, per-round evidence,
 * budget, stop condition and NEEDS_DECISION escalation. External unknowns are
 * measured by a read-only spike before the contract is frozen.
 * 0.8.1 bounded direct edit (a fix on an already-closed batch, main agent only):
 * a single file of <=10 lines and <=20 lines per batch, recorded in the ledger,
 * re-opening the affected review slice; a pure documentation or single-character
 * fix (changes confined to .md/AGENTS.md, <=10 lines) records the ledger plus a
 * machine check (balanced brackets/links/paths) and does not re-open the slice.
 * A second file or an exceeded budget hands the work to a child. Gates classify
 * by artifact (control / document / code / unknown), not by activity.
 */
export const DEFAULT_FOOTER = '白名单与循环批：主控的权限按「产出物归属」判定，不按「是否判断密集」判定（分界见第 1 条）。交付通道按风险缩放，不搞全有或全无：控制面主控直写；轻批（判据见第 6 条）子代理直做、免独立评审；其余为全批（spec 冻结 + 独立评审 + 集成）。循环型工作（结果未知、需 ≥3 轮「跑→看→改」）派成循环批：目标判定 + 环境（凭据/端口/库/账号）+ 每轮证据（命令/退出码/错误原文）+ 预算（轮数与墙钟）+ 停止条件 + 契约分叉上报；分叉用 NEEDS_DECISION 三行（现象/选项/建议）回主控，主控只回决策、不接管循环。真实环境的外部未知先派只读 spike 实测出「实测契约表」，再冻结、再实现，不得先实现后验证。预算对称：子代理单批 15 分钟/30 次编辑；主控单回合 15 分钟/20 步，触顶即停、不产生第二个未派发的写批次，剩余工作转成循环批或下一批。多文件机械活（同模式批量改写、大范围检索、跑长命令）默认派给子代理；同需求的多个轻批合并为一个子代理，修改清单取并集、内部串行。拆批时先勘察后实现、按互斥文件切分、可多批陆续派发，不许整包留给自己。缺计划类 skill 时，先写「每条 = 一个决策点或一批派发」的任务清单，再据此决定派发。只读类子代理（评审/复审/勘察）的 label 一律以「只读」或「勘察」开头，执行类批次的 label 不得以这两个词开头。`subagent_readonly` 的 preset 管工具面、路由与沙箱（结构钉死，不靠 label）；label 前缀只服务 spike 的沙箱收窄——spike 要跑命令实测，仍走普通 subagent。'

// 0.15.0 `business` 预设（spec `2026-11-17-project-policy-design.md` §2.4，逐字
// 冻结）：给「不跑 dispatch 纪律仓库」的普通业务项目用的六条骨架，删掉本仓库专属
// 的 docs-check / spec 路径 / 断言表细节，固定 token 约砍一半。正文只在这里，
// 不得散落到 `plugin.mjs`；`rules: "business"` 的项目由调用方选它替换
// `config.rules` / `config.footer`。

/** The six skeleton rules of the `business` preset; §2.4 verbatim, no numbering. */
export const BUSINESS_RULES = [
  '主控只做控制面：问用户、写需求/契约/台账、派发、裁决子代理证据、跑唯一一条集成命令、提交。执行面一律派发：src/**、tests/**、scripts/** 的写入、真实环境排错、构建与失败测试修复、文档正文、测试、评审与评审修复。用户显式要求主控亲做，或已闭合批次上的单文件 ≤10 行收尾修复，可以先写 dispatch/override.json 再动手。开工先勘察：派发前把「文件:行号 + 结论 + 现存调用方」写进派发；写不出这份现状就先派只读勘察（一律用 `subagent_readonly` 派发）。',
  '派发必须自包含：现状、允许修改/读取（逐条文件名）、唯一一条覆盖本批的窄验证命令、预算（墙钟与步数）、输出格式。同模式机械改动用一次多 hunk 或脚本完成。清单外信息或现状不符时停报 NEEDS_CONTEXT。派发即冻结：白名单外的契约面（schema/类型/接口/路由）在批运行期间只读。',
  '验收只付一次：子代理跑本模块窄验证并归因；集成命令由派发方在相关批全部结束后跑一次并留存退出码。同一条命令只跑一次；多包仓库按端各一条。派发后不守着：一批最多一次主动检查（预算过半时），其余时间结束回合等完成事件。',
  '评审只审变更集：评审一律用 `subagent_readonly` 派发（其组合无写工具与 shell，diff 与集成输出由派发方落盘 `dispatch/` 后交其读取）。输入是需求、冻结契约、本批白名单并集的 diff、派发方复跑的集成结果（退出码与输出）。逐条给 PASS|FAIL + 文件:行号；不采信实现者自述；可给建议但不得改文件。需求本身是全局不变量（「彻底统一」「所有调用方」）时加一栏全仓检索核查。一个变更集一个包，全部实现批落地且跑过集成后终评一次，禁止每批一评。',
  '提交权归派发方：子代理不得 commit / push / reset / clean，除非派发中显式授权；派发前记录目标文件的既有未提交改动，不得覆盖、不得计入成果。',
  '并行只读、互斥并行写：只读子问题互不依赖时同一条消息并行发出；实施批次白名单按文件/模块互斥，同文件串行；契约在派发前定死；不得并发跑共享产物（dist、缓存、端口）的全量构建。开工先判级：单文件 ≤20 行或同模式机械改写 ≤5 文件且 ≤8 分钟＝轻批，子代理直做、免独立评审；其余为全批（契约冻结 + 独立评审 + 集成）。',
]

/** The closing paragraph of the `business` preset; §2.4 verbatim. */
export const BUSINESS_FOOTER = '交付通道按风险缩放：控制面主控直写；轻批免独立评审；其余全批。结果未知、需 ≥3 轮「跑→看→改」的活派成循环批：目标判定 + 环境 + 每轮证据（命令/退出码/错误原文）+ 预算 + 停止条件；外部未知先派只读 spike 测出契约再冻结。预算对称：子代理单批 15 分钟/30 次编辑；主控单回合 15 分钟/20 步，触顶即停。结论以项目自己的 CI 为准：纪律只保证过程，typecheck/test/lint 才是结果闸门。'

/**
 * 0.16.0 `auto` 档的提级提示（spec `2026-11-18-dispatch-auto-mode-design.md`
 * §2.2 首次冻结；0.19.0 按 spec `2026-11-22-dispatch-auto-text-reframe.md`
 * 重写首段框架并补正面示例）。只在根代理的 `auto` 项目里注入；不做守卫、
 * 不投递提醒。
 *
 * 2026-11-18 二次裁决：不再列「≥2 文件 / ≥3 文件」这类硬条件——文件数是事后
 * 指标，模型在入口只能猜，误报率高；改成让模型回答「这个需求会不会从 full 的
 * 四个机制里显著受益」。2026-11-22 三次裁决：首句「默认不启用」把基线框成
 * off、全文只有负例没有正例，实测几乎不升级；改为中性陈述当前档位，并给三
 * 类典型受益的情形（场景式，不是关键词触发）。2026-11-22 四次裁决（spec
 * `2026-11-22-dispatch-auto-evidence-gate.md`）：不写「先勘察再判断」这类流
 * 程式措辞——提示词对模型就是指令，流程会被当真执行，等于把 full 的阶段搬
 * 进 auto；改为门槛式：请示只在能说出具体受益点时合法，证据由模型本来就会
 * 做的阅读自然供给。正文里的工具名必须与 `plugin.mjs` 的
 * `dispatch_upgrade_full` 逐字一致。
 */
export const AUTO_TEXT = [
  '## 派发纪律（自动档 auto）',
  '',
  '当前项目处于自动档：派发纪律不拦截、不提醒，是否升级到 full 由你判断。full 在这四件事上真正改变结果：契约面在动手前冻结、执行面一律派发（主控只做控制面，白名单互斥）、验收有独立评审、集成命令只跑一次。代价是派发/评审/复跑的轮次；需求越大越值，小改通常不值。',
  '',
  '判断标准：这项需求会不会从上面四件事中的至少一件显著受益？典型受益的情形：改动触及契约面（schema/类型/接口/路由/权限/迁移）且有多个调用方要随之改动；工作要拆成多个并行或先后批次，需要独立评审与统一集成兜底；用户明确要求过程纪律或验收可追溯。请示只在你能说出具体受益点（哪个契约面、哪些调用方、几个批次）时提出；说不出就不要问，直接做。请示用一句话说清受益点与大致成本；每需求最多问一次；被拒后除非范围实质扩大，不再问。',
  '',
  '用户明确确认后，调用 dispatch_upgrade_full（confirmed=true）完成切换；未确认前不得调用，也不得自行改档位文件。工具不可用时，请用户点输入框上方的 full 按钮或输入 /dispatch full。子代理不评估、不请示，按派发词执行。',
].join('\n')

/**
 * Pick the rule preset for a project policy's `rules` value (0.15.0 §2.3).
 *
 * Pure: reads no disk and never throws. `business` → the frozen §2.4 preset;
 * anything else (including `undefined`) → the caller's resolved config, so a
 * profile that never mentions presets keeps 0.14.3's text byte for byte.
 * @param name - `policy.rules` from the project policy file (may be undefined).
 * @param config - the resolved config (`resolveConfig(...)` output).
 * @returns `{ rules, footer }` to render the prompt section with.
 */
export function resolveRulesPreset(name, config) {
  if (name === 'business') return { rules: BUSINESS_RULES, footer: BUSINESS_FOOTER }
  const source = config ?? {}
  return { rules: source.rules ?? DEFAULT_RULES, footer: source.footer ?? DEFAULT_FOOTER }
}

/** The checkpoint reminder sent to the parent when a child completes. */
export const DEFAULT_CHECKPOINT = '[dispatch-protocol] 子代理 {childId}（{label}）已完成。标记完成前：读它的 diff，核对它报告的退出码，并在全批结束后跑一次集成命令；结果记入台账。'

/**
 * The checkpoint reminder for a wave that finished several children.
 * One message per wave instead of one per child: in an 8-way fan-out the
 * per-child form delivered N steers in one turn (constraint C violation in
 * spirit). `{labels}` joins up to five child labels.
 */
export const DEFAULT_WAVE_CHECKPOINT = '[dispatch-protocol] 本波次 {count} 个子代理已完成（{labels}）。标记完成前：逐个读 diff，核对它们报告的退出码，并在全波次结束后跑一次集成命令；结果记入台账。'

/**
 * Validate and render the configured rules into one section body.
 * @param config - raw plugin config from the profile patch layer.
 * @returns the resolved section settings.
 */
export function resolveConfig(config = {}) {
  const source = config ?? {}
  const order = source.order ?? 500
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    throw new Error('dispatch-protocol: order must be a finite number')
  }

  const rules = source.rules ?? DEFAULT_RULES
  if (!Array.isArray(rules) || rules.length === 0
    || rules.some(rule => typeof rule !== 'string' || rule.trim() === '')) {
    throw new Error('dispatch-protocol: rules must be a non-empty array of non-empty strings')
  }

  const footer = source.footer ?? DEFAULT_FOOTER
  if (typeof footer !== 'string') throw new Error('dispatch-protocol: footer must be a string')

  const checkpointSource = source.checkpoint ?? {}
  const checkpoint = {
    enabled: checkpointSource.enabled !== false,
    text: checkpointSource.text ?? DEFAULT_CHECKPOINT,
    waveText: checkpointSource.waveText ?? DEFAULT_WAVE_CHECKPOINT,
  }
  if (typeof checkpoint.text !== 'string' || checkpoint.text.trim() === '') {
    throw new Error('dispatch-protocol: checkpoint.text must be a non-empty string')
  }
  if (typeof checkpoint.waveText !== 'string' || checkpoint.waveText.trim() === '') {
    throw new Error('dispatch-protocol: checkpoint.waveText must be a non-empty string')
  }

  // Per-turn observation rows: every root-agent turn that wrote files or
  // delegated appends one machine-readable line, so "who did what" survives
  // context compression. Observation is not a gate: rows are never enforced,
  // and a full disk or a bad path must never close a turn.
  const observationSource = source.observation ?? {}
  const observation = {
    enabled: observationSource.enabled !== false,
    // A directory name relative to the session cwd; `false` disables entirely.
    dir: observationSource.dir === undefined ? 'dispatch/runs' : observationSource.dir,
  }
  if (observation.dir !== false && (typeof observation.dir !== 'string' || observation.dir.trim() === '')) {
    throw new Error('dispatch-protocol: observation.dir must be a non-empty string or false')
  }

  // 0.22.0 结构化沙箱收窄：按子会话的 preset（`agent-preset/selected` 事件 /
  // `header.agentPreset`）把命中角色的沙箱收窄为 `mode`，替代 model-pin 按
  // label 字面前缀的 roles 表（评审角色；spike 仍走普通 subagent + roles）。
  // 与既有段落同口径：非法配置加载期抛错，不静默降级——`mode` 拼错若静默
  // 回落，会表现为「机制挂着但从不命中」，与「没配」无法区分。
  const readonlySandboxSource = source.readonlySandbox ?? {}
  if (typeof readonlySandboxSource !== 'object' || readonlySandboxSource === null || Array.isArray(readonlySandboxSource)) {
    throw new Error('dispatch-protocol: readonlySandbox must be an object')
  }
  const readonlySandboxEnabled = readonlySandboxSource.enabled ?? true
  if (typeof readonlySandboxEnabled !== 'boolean') {
    throw new Error('dispatch-protocol: readonlySandbox.enabled must be a boolean')
  }
  const readonlySandboxPresets = readonlySandboxSource.presets ?? DEFAULT_READONLY_SANDBOX_PRESETS
  if (!Array.isArray(readonlySandboxPresets) || readonlySandboxPresets.length === 0
    || readonlySandboxPresets.some(preset => typeof preset !== 'string' || preset.trim() === '')) {
    throw new Error('dispatch-protocol: readonlySandbox.presets must be a non-empty array of non-empty strings')
  }
  const readonlySandboxMode = readonlySandboxSource.mode ?? 'read-only'
  if (!READONLY_SANDBOX_MODES.includes(readonlySandboxMode)) {
    throw new Error(`dispatch-protocol: readonlySandbox.mode must be one of ${READONLY_SANDBOX_MODES.join(', ')}`)
  }
  const readonlySandbox = { enabled: readonlySandboxEnabled, presets: readonlySandboxPresets, mode: readonlySandboxMode }

  const numbered = rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')
  const text = [
    '## 派发纪律（DSH）',
    '',
    numbered,
    '',
    footer,
  ].join('\n')

  // 0.9.0：`nudge` 段出现即加载期抛错——静默忽略会让旧配置以为提醒仍在生效，
  // 实际一条都不认；消息里直接给迁移指引（spec §3）。
  if (source.nudge !== undefined) {
    throw new Error('dispatch-protocol: `nudge` 段已在 0.9.0 移除（漏派发提醒换成写入守卫 writePolicy）。迁移：nudge.log → log；nudge.delegationTools → writePolicy.delegationTools；nudge.justifiedPatterns 废弃，豁免改由 dispatch/override.json 承载；nudge.enabled/threshold/text/writeTools/controlPlanePatterns 删除（writeTools → writePolicy.tools，controlPlanePatterns → writePolicy.allowlist）')
  }

  // `log` 取代 `nudge.log`：checkpoint 与写入守卫共用一份决策日志，
  // false 关闭全部日志。加载期校验，避免路径拼错时静默不写；空串按非法处理
  // （回落默认路径会让 README 的「non-empty path」承诺与实现不一致）。
  if (source.log !== undefined && source.log !== false
    && (typeof source.log !== 'string' || source.log.trim() === '')) {
    throw new Error('dispatch-protocol: log must be a non-empty path or false')
  }
  const log = source.log === false ? false : (source.log ?? DEFAULT_LOG)

  // 写入守卫同样在加载期校验（spec §3）：`mode` 拼错或 `tools: []` 若静默降级，
  // 守卫会「永远放行」或「永远不拦」，和「配置正确但没命中」在日志里无法区分。
  const writePolicy = resolveWritePolicy(source.writePolicy)

  // 0.17.0：`gates` 段随五个收尾闸门一起删除。出现即加载期抛错——静默忽略会
  // 让旧配置以为提醒仍在生效，实际一条都不会发。
  if (source.gates !== undefined) {
    throw new Error('dispatch-protocol: `gates` 段已在 0.17.0 移除（五个收尾闸门删除：收尾不再逐回合提醒）。迁移：删除 gates 段；未验证就收口 / 评审后改动 / 等待期轮询 / 空回合 / 契约冻结这些事实改看 dispatch/runs/*.jsonl 与决定日志')
  }

  // 0.13.0 项目级开关（spec §3.1）：`path` 拼错或 `enabled` 写成字符串若静默
  // 降级，会表现为「标记文件放了但不生效」，与「项目本来就没标记」在行为上
  // 无法区分。默认值来自 `lib/project.mjs`，这里只校验与转发。
  const projectSwitchSource = source.projectSwitch === undefined
    ? DEFAULT_PROJECT_SWITCH
    : source.projectSwitch
  if (typeof projectSwitchSource !== 'object' || projectSwitchSource === null || Array.isArray(projectSwitchSource)) {
    throw new Error('dispatch-protocol: projectSwitch must be an object')
  }
  const projectSwitchEnabled = projectSwitchSource.enabled ?? DEFAULT_PROJECT_SWITCH.enabled
  if (typeof projectSwitchEnabled !== 'boolean') {
    throw new Error('dispatch-protocol: projectSwitch.enabled must be a boolean')
  }
  const projectSwitchPath = projectSwitchSource.path ?? DEFAULT_PROJECT_SWITCH.path
  if (typeof projectSwitchPath !== 'string' || projectSwitchPath.trim() === '') {
    throw new Error('dispatch-protocol: projectSwitch.path must be a non-empty string')
  }
  const projectSwitch = { enabled: projectSwitchEnabled, path: projectSwitchPath }

  return { enabled: source.enabled !== false, order, rules, footer, text, checkpoint, observation, readonlySandbox, writePolicy, log, projectSwitch }
}
