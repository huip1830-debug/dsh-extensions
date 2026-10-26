// Dispatch discipline text injected as a system-prompt section.
//
// Five rules state *how* to dispatch; one paragraph states *who does what* and
// when a dispatch may be skipped. The paragraph used to be three separate
// paragraphs (exemption / cost split / plan-skill fallback) that contradicted
// each other — the exemption allowed a single-file change to be done inline
// while the cost paragraph said "delegate anything that fits in one sentence".

import { resolveNudge } from './nudge.mjs'

/** The five non-negotiable rules; overridable through `config.rules`. */
export const DEFAULT_RULES = [
  '先勘察，后派发：派发前把「文件:行号 + 相关代码 + 结论 + 不确定项」写成现状文件并在派发中引用，同时给出可改文件白名单（逐条列名；白名单以「全批结束后能用一条集成命令验收」为界）。验收分两层：子代理只跑自己的窄验证，派发方在相关子代理全部结束后跑那条集成命令；宽窄混用会让失败无法归因。禁止把「调研 X 然后实现」交给执行类子代理。',
  '执行类派发必须自包含：至少含【现状】【允许修改/允许读取】【验证：唯一一条命令】【输出格式】。子代理遇到清单外信息或现状与代码不符时停报 NEEDS_CONTEXT，不得自行扩大范围。',
  '验收要复跑：子代理声称跑过的命令，派发方必须独立复跑并留存退出码。并行写批次与契约面改动（schema/类型/路由/权限/迁移）完成后另派只读评审：输入只有需求原文、冻结契约、diff 与集成结果，逐条给 PASS|FAIL + 文件:行号；不得采信实现者的自述或其测试通过，全 PASS 须说明每条例子的验证方式；评审可给建议但不得改文件，裁决归派发方。未复跑不得标记完成。',
  '提交权归派发方：子代理不得 commit / push / reset / clean，除非派发中显式授权；派发前先记录目标文件的既有未提交改动，不得覆盖，也不得计入本次成果。',
  '并行只读，互斥并行写：只读勘察能拆成 ≥2 个互不依赖的子问题（不同目录/不同接口/不同文档）时，在同一条消息里并行发出，不要一个一个等；实施也能并行，但白名单必须按文件/模块互斥（同文件、同模块的写仍串行），schema/类型/路由/barrel/lockfile 这类契约在派发前定死，且子代理不得并发跑共享产物的全量构建或测试（同 dist、同缓存目录、同端口一律串行）；大改动需要各自完整构建时拆独立 worktree。',
  '变更集判级与评审闭环：同一需求的所有批次合并判级——任一批次命中并行写或契约面，整个需求按 gated 处理，不得按子代理切分绕过评审；评审通过后任何后续改动（含派发方自修）须把受影响切片重开评审；实现类任务开工前，任务清单必须显式包含拆批方案或一行不派发理由。',
]

/**
 * Who does what, and when a dispatch may be skipped.
 *
 * Deliberately free of magic numbers: a whitelist is bounded by "the whole batch
 * must be verifiable by one integrated command afterwards" (rule 1), and a task
 * list is bounded by "each entry is one decision or one batch" — not by an
 * arbitrary file count or item count.
 * The cost rule exists because the main agent runs the expensive, stronger
 * model: mechanical volume belongs to children, judgement belongs to the main
 * agent. Uncertainty is a reason to batch, never a reason to keep it all.
 */
export const DEFAULT_FOOTER = '成本与豁免：主控模型贵、判断强，子代理便宜、适合机械执行。单文件且纯文案/配置/测试接线的改动可以直接做，但须先读原文并在回复里给出改动与验证证据；其余多文件机械活（同模式批量改写、大范围只读检索、跑长命令收输出）默认派给子代理，主控只留方案取舍、边界判断、例外文件、验收复跑与提交。步骤一时穷举不出来就拆批：先派只读勘察批次问清不确定项，再派实现批次；实现批次按互斥文件切分，能并行的同一条消息发出，契约先定死。可多批陆续派发，不许整包留给自己。缺计划类 skill 时，先写「每条 = 一个决策点或一批派发」的任务清单，再据此决定派发，不得据缺 skill 跳过派发判断。只读类子代理（评审/复审/勘察）的 label 一律以「只读」或「勘察」开头（如「只读评审：…」）——角色表按此前缀收窄沙箱与路由，执行类批次的 label 不得以这两个词开头。'

/** The checkpoint reminder sent to the parent when a child completes. */
export const DEFAULT_CHECKPOINT = '[dispatch-protocol] 子代理 {childId}（{label}）已完成。标记完成前：读它的 diff，并独立复跑它声称跑过的那条命令；结果记入台账。'

/**
 * The checkpoint reminder for a wave that finished several children (0.4.0).
 * One message per wave instead of one per child: in an 8-way fan-out the
 * per-child form delivered N steers in one turn (constraint C violation in
 * spirit). `{labels}` joins up to five child labels.
 */
export const DEFAULT_WAVE_CHECKPOINT = '[dispatch-protocol] 本波次 {count} 个子代理已完成（{labels}）。标记完成前：逐个读 diff，并独立复跑它们声称跑过的命令；结果记入台账。'

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

  // Per-turn observation rows (0.4.0): every root-agent turn that wrote files
  // or delegated appends one machine-readable line, so "who did what" survives
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

  return { enabled: source.enabled !== false, order, rules, footer, text, checkpoint, observation, nudge }
}
