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

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWritePolicy } from './write-policy.mjs'
import { resolveGates } from './gates.mjs'

// 0.6.0/0.7.0 状态闸门的默认值统一从 config.mjs 导出（契约 §7）：默认值只有
// 这一个入口，实现与加载期校验放在 lib/gates.mjs，避免「文档里的默认值」和
// 「代码里的默认值」各写一份。
export {
  DEFAULT_CONTRACT_PATTERNS, DEFAULT_CONTRACT_TEXT,
  DEFAULT_HANDOFF_EMPTY_TURNS, DEFAULT_HANDOFF_TEXT,
  DEFAULT_REVIEW_LABEL_PREFIXES, DEFAULT_REVIEW_TEXT,
  DEFAULT_VERIFY_COMMANDS, DEFAULT_VERIFY_COMMIT_PATTERN, DEFAULT_VERIFY_TEXT,
  DEFAULT_WAIT_TEXT, DEFAULT_WAIT_THRESHOLD, DEFAULT_WAIT_TOOLS,
} from './gates.mjs'

// 0.9.0 写入守卫的默认值同样从这里转出：README/配置表与测试都只认这一个入口。
export {
  DEFAULT_ALLOWLIST, DEFAULT_OVERRIDE_PATH, DEFAULT_WRITE_POLICY_MODE,
  evaluateWritePolicy, isAllowedPath, readOverride, renderDenyText, resolveWritePolicy,
} from './write-policy.mjs'

/** 决策日志默认路径（checkpoint + 写入守卫 + 状态闸门共用一份）。 */
export const DEFAULT_LOG = join(tmpdir(), 'dispatch-protocol-decisions.jsonl')

/** The six non-negotiable rules; overridable through `config.rules`. */
export const DEFAULT_RULES = [
  '主控只做控制面，不做执行面：允许的动作只有七类——问用户、冻结契约与账本（只写 dispatch/state/<需求>.md、dispatch/ledger/<需求>.md、docs/superpowers/specs/*、验收台账）、派发与调度、裁决子代理证据（只读报告 + diff + 指定行）、跑唯一一条集成命令、提交交付、结束回合等事件。执行面一律派发：src/**、tests/**、scripts/** 的任何写入，真实环境/账套排错，构建与失败测试修复，文档正文，测试，评审与评审修复；唯一例外是用户显式要求主控亲自做：先在 `dispatch/override.json` 写 `{"reason":"…","source":"…"}` 再动手，守卫只认这个文件（每会话有效，新会话需重写）；有界直改同样先写 override。有界直改限于已闭合批次上的收尾修复：主控可直接改单文件 ≤10 行，改完记台账并重开受影响评审切片（纯文档修复只记台账 + 跑 scripts/docs-check.mjs（无此脚本的仓库记一行台账、不新建脚本）、不重开评审；文档批须交「断言 → 代码位置」表，删除或改写的机制断言入表并注明「不再成立」：表空即收口且台账写「本批无机制断言」，表非空派 1 次有界评审——范围仅本批 md diff + 表中代码锚点，修完只复跑 docs-check、不再复审）；同一批次累计 ≤20 行，第二个文件或超限即停手转派。先勘察后派发：派发前把「文件:行号 + 相关代码 + 结论（含现存调用方） + 不确定项」写成现状文件并在派发中引用，无现存调用方的实现在 spec 标「预防性实现」，并给出可改文件白名单（逐条列名，以「全批结束能用一条集成命令验收」为界）。勘察批唯一触发条件：主控现有上下文写不出这份现状；刚读过相关模块或属已知模式克隆时免派。勘察批一律只读：产出以 final message 回传，主控落盘到 `dispatch/recon/<需求>.<端>.md`（属控制面），不得要求勘察子代理写文件——「勘察/只读」前缀会把沙箱收窄为只读。禁止把「调研 X 然后实现」交给执行类子代理。被 `dispatch-protocol` 守卫拦截时，按错误信息二选一（派发 / 写 override），不要重试同一个调用。同一工作区可能并行多个会话：台账按需求分文件，只写自己需求那份、不覆盖别人的；开工先看 dispatch/state/，同一需求已有进行中的文件时先问用户是否接手。「复制/克隆现有功能」类需求澄清最多 2 问（范围 + 数据模型），其余按现有实现取默认值写进 spec 并标「默认，未问」。用户只回 ok 时记「ok 视为接受推荐项」，不得写「用户已确认」。遗留的 dispatch/state.md 只读。',
  '执行类派发必须自包含：至少含【现状】【允许修改/允许读取】【验证：唯一一条命令——覆盖本批改动的窄命令，全量构建/全量测试归派发方的集成命令】【预算：墙钟与步数上限】【输出格式】。预算过半发一句话进度（改到哪、还差什么、契约疑点）；超预算先报阻塞点再停，不得续期。清单外信息或现状与代码不符时停报 NEEDS_CONTEXT，不得扩大范围。同模式机械改写一次多 hunk 或脚本完成，不得逐处 edit 往返。派发即冻结：该批运行期间，白名单外的契约面（src/schema/类型/路由）只读；派发方必须改时先停子代理（interrupt）、改完重派并注明「契约已变」。',
  '验收与等待：验收分两层，执行性验证只归派发方——子代理只跑自己那部分的窄验证（负责归因），窄验证必须是本模块测试文件（如 `vitest run tests/<module>*.test.ts`），全量 tsc/test 只在集成点跑一次、不得每批各跑一遍，派发方在相关子代理全部结束后跑那条集成命令（负责集成状态）并留存退出码；同一条命令全系统只跑一次，不重复付费（多包仓库按端各一条，每端只跑一次）。前提：那条集成命令必须覆盖各批窄验证断言点的并集；某批窄验证断言了集成命令覆盖不到的行为时，该批窄命令由派发方自己再跑——这是唯一的复跑例外。派发后不要守着：一批最多一次主动检查（预算过半时），其余时间结束回合等完成事件；不要用一串 Start-Sleep/list_agents 轮询。未跑集成命令不得标记完成。',
  '评审只审变更集，不审仓库：命中 gated 的需求另派只读评审子代理（判为轻批的批次除外——gated 是需求级判定，不改变轻批免独立评审），输入只有需求原文、冻结契约、本批白名单并集的 diff（不是工作区快照）、派发方复跑的集成结果（退出码与输出全文）。逐条给 PASS|FAIL + 文件:行号，不逐文件通读未改动文件；需求本身是全局不变量（「彻底统一」「不得残留」「所有调用方」这类）时加一栏「全仓不变量核查」：给定检索词与目录，输出命中点排除表，用户可见的遗漏判 FAIL。评审节奏：一个变更集 = 一个包，全部实现批落地且跑过集成命令后再派，不得每批一评（后批改动会让前批评审失效）；包超过 20 个文件或 3 个契约面才按契约面切片（单个契约面自身超 20 文件时按读写路径再切，并写明切法）；跨切片一致性包只在切片确实独立（接口/类型/别名表/路由边界）时开，不得重复已报缺陷。唯一例外：被后续批次依赖的契约批（产物是后续批的只读输入）在后续批启动前做一次只读契约复核，范围仅白名单 + 契约面。评审只做 read/grep 语义核对（只读的 git diff、Select-String、程序化比对都算），禁止重跑构建/测试/集成命令，不得采信实现者的自述或其测试通过，全 PASS 须说明每条例子的验证方式；可给建议但不得改文件，裁决归派发方。评审后任何改动（含派发方自修）只重开被判 FAIL 的那一片及其直接影响面，不重开全包。文档切片：AGENTS.md 与 docs/agent/* 属注入面、断言表强制非空，有界评审输出逐条 PASS|FAIL + 未入表断言清单；spec 与变更历史只做语法检查。',
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
export const DEFAULT_FOOTER = '白名单与循环批：主控的权限按「产出物归属」判定，不按「是否判断密集」判定（分界见第 1 条）。交付通道按风险缩放，不搞全有或全无：控制面主控直写；轻批（判据见第 6 条）子代理直做、免独立评审；其余为全批（spec 冻结 + 独立评审 + 集成）。循环型工作（结果未知、需 ≥3 轮「跑→看→改」）派成循环批：目标判定 + 环境（凭据/端口/库/账号）+ 每轮证据（命令/退出码/错误原文）+ 预算（轮数与墙钟）+ 停止条件 + 契约分叉上报；分叉用 NEEDS_DECISION 三行（现象/选项/建议）回主控，主控只回决策、不接管循环。真实环境的外部未知先派只读 spike 实测出「实测契约表」，再冻结、再实现，不得先实现后验证。预算对称：子代理单批 15 分钟/30 次编辑；主控单回合 15 分钟/20 步，触顶即停、不产生第二个未派发的写批次，剩余工作转成循环批或下一批。多文件机械活（同模式批量改写、大范围检索、跑长命令）默认派给子代理；同需求的多个轻批合并为一个子代理，修改清单取并集、内部串行。拆批时先勘察后实现、按互斥文件切分、可多批陆续派发，不许整包留给自己。缺计划类 skill 时，先写「每条 = 一个决策点或一批派发」的任务清单，再据此决定派发。只读类子代理（评审/复审/勘察）的 label 一律以「只读」或「勘察」开头——角色表按此前缀收窄沙箱与路由，执行类批次的 label 不得以这两个词开头。'

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

  // `log` 取代 `nudge.log`：checkpoint、写入守卫与状态闸门共用一份决策日志，
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

  // 0.6.0 状态闸门同样在加载期校验（契约 §6）：`threshold: 0` 或一条无法编译的
  // commitPattern 若静默降级，闸门会「永远不触发」，和「配置正确但没命中」
  // 在日志里无法区分。即使 gates.enabled 为 false 也照样校验。
  const gates = resolveGates(source.gates)

  return { enabled: source.enabled !== false, order, rules, footer, text, checkpoint, observation, writePolicy, log, gates }
}
