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

import { resolveNudge } from './nudge.mjs'
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

/** The six non-negotiable rules; overridable through `config.rules`. */
export const DEFAULT_RULES = [
  '主控只做控制面，不做执行面：允许的动作只有七类——问用户、冻结契约与账本（只写 dispatch/state.md、dispatch/ledger/*、docs/superpowers/specs/*、验收台账）、派发与调度、裁决子代理证据（只读报告 + diff + 指定行）、跑唯一一条集成命令、提交交付、结束回合等事件。执行面一律派发：src/**、tests/**、scripts/** 的任何写入，真实环境/账套排错，构建与失败测试修复，文档正文，测试，评审与评审修复；唯一例外是用户显式要求主控亲自做，记一行 override。有界直改：已闭合批次上的收尾修复，允许主控直接改单文件 ≤10 行，改完记一行台账并重开受影响评审切片；同一批次累计 ≤20 行，第二个文件或超限即停手转派。先勘察后派发：派发前把「文件:行号 + 相关代码 + 结论 + 不确定项」写成现状文件并在派发中引用，同时给出可改文件白名单（逐条列名；以「全批结束后能用一条集成命令验收」为界）；勘察批次的唯一触发条件是主控现有上下文写不出这份现状，刚读过相关模块或属已知模式克隆时免派勘察。禁止把「调研 X 然后实现」交给执行类子代理。',
  '执行类派发必须自包含：至少含【现状】【允许修改/允许读取】【验证：唯一一条命令——必须是覆盖本批改动的窄命令，全量构建/全量测试归派发方的集成命令】【预算：墙钟与步数上限】【输出格式】。预算过半时必须发一条一句话进度（改到哪、还差什么、有无契约疑点）；超预算先报阻塞点再停，不得自行续期。子代理遇到清单外信息或现状与代码不符时停报 NEEDS_CONTEXT，不得自行扩大范围。派发即冻结：该批运行期间，白名单外的契约面（src/schema/类型/路由）只读；派发方必须改时先停子代理（interrupt）、改完重派并注明「契约已变」。',
  '验收与等待：验收分两层，执行性验证只归派发方——子代理只跑自己那部分的窄验证（负责归因），派发方在相关子代理全部结束后跑那条集成命令（负责集成状态）并留存退出码；宽窄混用会让两边都失真，同一条命令全系统只跑一次，不重复付费。前提：那条集成命令必须覆盖各批窄验证断言点的并集；某批窄验证断言了集成命令覆盖不到的行为时，该批窄命令由派发方自己再跑——这是唯一的复跑例外。派发后不要守着：一批最多一次主动检查（预算过半时），其余时间结束回合等完成事件；不要用一串 Start-Sleep/list_agents 轮询。未跑集成命令不得标记完成。',
  '评审只审变更集，不审仓库：命中 gated 的批次另派只读评审子代理（其中判为轻批的批次除外——gated 是需求级判定，不改变轻批免独立评审），输入只有需求原文、冻结契约、本批白名单并集的 diff（不是工作区快照）、派发方复跑的集成结果（退出码与输出全文）。逐条给 PASS|FAIL + 文件:行号，不逐文件通读未改动文件；需求本身是全局不变量（「彻底统一」「不得残留」「所有调用方」这类）时加一栏「全仓不变量核查」：给定检索词与目录，输出命中点排除表，用户可见的遗漏判 FAIL。包超过 20 个文件或 3 个契约面就按契约面切片；单个契约面自身超 20 个文件时按读写路径再切，并在评审报告里写明切法；跨切片一致性另设一包，只核接口/类型/别名表/路由边界，不重复逐文件。评审只做 read/grep 语义核对（纯读取的 git diff、Select-String、程序化比对都算），禁止重跑构建/测试/集成命令，不得采信实现者的自述或其测试通过，全 PASS 须说明每条例子的验证方式；可给建议但不得改文件，裁决归派发方。评审后任何改动（含派发方自修）重开受影响切片。',
  '提交权归派发方：子代理不得 commit / push / reset / clean，除非派发中显式授权；派发前先记录目标文件的既有未提交改动，不得覆盖，也不得计入本次成果。',
  '并行只读，互斥并行写：只读子问题互不依赖且 ≥2 个时，在同一条消息里并行发出，不要一个一个等；实施也能并行，但白名单必须按文件/模块互斥（同文件、同模块串行），schema/类型/路由/barrel/lockfile 这类契约在派发前定死，子代理不得并发跑共享产物（同 dist、缓存目录、端口）的全量构建，大改动需要各自完整构建时拆独立 worktree。开工先按两轴判级，连同拆批方案或一行不派发理由写进任务清单或台账首行：风险轴同一需求合并判级，任一批次命中并行写或契约面即整个需求 gated，不得按子代理切分绕过评审；规模轴单批满足「单文件 ≤20 行或同模式机械改写 ≤5 文件」且 ≤8 分钟判轻批，按产出物归属分流、免独立评审（子代理跑窄命令，主控复跑 + diff 自查留证）；单批预估超过 15 分钟或 30 次编辑就按场景切片（同文件/同构建产物仍串行），保证 10 分钟内出现第一个可验收切片。执行中发现改动面超出预估（白名单外文件、新增契约面、工作量显著超预估）必须停手重新判级。',
]

/**
 * The closing paragraph: who may produce what, how a loop is dispatched, and the
 * symmetric budget.
 *
 * Permission follows the artifact, not the activity: if the output lands in
 * src/tests/scripts or a document body, it is a child's job; the main agent
 * keeps only the contract, the ledger, adjudication, acceptance and commit.
 * Loop work (result unknown, >=3 run→inspect→change rounds) is dispatched as a
 * loop batch carrying its environment, per-round evidence, budget, stop
 * condition and NEEDS_DECISION escalation. External unknowns are measured by a
 * read-only spike before the contract is frozen.
 * 0.8.1: the ceremony scales with risk instead of being all-or-nothing. A
 * *light batch* is still a child (one file <=20 lines, or <=5 files of the same
 * mechanical rewrite, <=8 minutes, no contract surface, no external
 * environment): no spec file, no independent review, the main agent re-runs the
 * narrow command and reads the diff. A *full batch* keeps the spec freeze and
 * the independent review. A *bounded direct edit* is the only exception: a
 * <=10-line single-file fix on an already-closed batch, recorded in the ledger,
 * re-opening the affected review slice.
 */
export const DEFAULT_FOOTER = '白名单与循环批：主控的权限按「产出物归属」判定，不按「是否判断密集」判定——产出物在 src/tests/scripts/文档正文里，就没有主控的事；只有契约、账本、裁决、验收、提交归主控（见第 1 条）。交付通道按风险缩放，不搞全有或全无：控制面（契约/账本/裁决）主控直写；轻批（无契约面、无外部环境，且单文件 ≤20 行或同模式机械改写 ≤5 文件，≤8 分钟）子代理直做，不写 spec、不派独立评审，主控复跑窄命令 + 读 diff；其余为全批（spec 冻结 + 独立评审 + 集成）。有界直改只用于已闭合批次的收尾修复：单文件 ≤10 行、同批累计 ≤20 行，记账并重开受影响评审切片。循环型工作（结果未知、需 ≥3 轮「跑→看→改」）一律派成循环批：目标判定 + 环境（凭据/端口/库/账号）+ 每轮证据（命令/退出码/错误原文）+ 预算（轮数与墙钟）+ 停止条件 + 契约分叉上报；分叉用 NEEDS_DECISION 三行（现象/选项/建议）回主控，主控只回一个决策，不接管循环。真实环境的外部未知（字段名/枚举/单位/关联方式）先派只读 spike 实测出「实测契约表」，再冻结、再实现，不得先实现后验证。预算对称：子代理单批 15 分钟/30 次编辑；主控单回合 15 分钟/20 步，且不得产生第二个未派发的写批次——触顶即停，把剩余工作转成循环批或下一批。派发固定成本只在批次工作量盖不住「一次派发 + 一次证据」时才成为约束；主控单步约 100–170k cache 读，这个门槛永远低于「主控自己跑」。多文件机械活（同模式批量改写、大范围只读检索、跑长命令收输出）默认派给子代理；同需求的多个轻批合并为一个子代理，允许修改清单取并集、内部串行。步骤一时穷举不出来就拆批：先派只读勘察批次问清不确定项，再派实现批次，实现批次按互斥文件切分；可多批陆续派发，不许整包留给自己。缺计划类 skill 时，先写「每条 = 一个决策点或一批派发」的任务清单，再据此决定派发。只读类子代理（评审/复审/勘察）的 label 一律以「只读」或「勘察」开头（如「只读评审：…」）——角色表按此前缀收窄沙箱与路由，执行类批次的 label 不得以这两个词开头。'

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

  // Validated even when the checkpoint is the only mechanism in use: a typo in
  // `nudge.threshold` must fail at load time, not silently never fire.
  const nudge = resolveNudge(source.nudge)

  // 0.6.0 状态闸门同样在加载期校验（契约 §6）：`threshold: 0` 或一条无法编译的
  // commitPattern 若静默降级，闸门会「永远不触发」，和「配置正确但没命中」
  // 在日志里无法区分。即使 gates.enabled 为 false 也照样校验。
  const gates = resolveGates(source.gates)

  return { enabled: source.enabled !== false, order, rules, footer, text, checkpoint, observation, nudge, gates }
}
