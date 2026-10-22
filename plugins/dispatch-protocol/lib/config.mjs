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
  '先勘察，后派发：派发前把「文件:行号 + 相关代码 + 结论 + 不确定项」写成现状文件并在派发中引用，同时给出可改文件白名单（逐条列名；一批只对应一条验证命令，需要多条命令就拆批）。禁止把「调研 X 然后实现」交给执行类子代理。',
  '执行类派发必须自包含：至少含【现状】【允许修改/允许读取】【验证：唯一一条命令】【输出格式】。子代理遇到清单外信息或现状与代码不符时停报 NEEDS_CONTEXT，不得自行扩大范围。',
  '验收要复跑：子代理声称跑过的命令，派发方必须独立复跑并留存退出码；评审子代理只判规格与质量，不得把子代理的自述当作证据。未复跑不得标记完成。',
  '提交权归派发方：子代理不得 commit / push / reset / clean，除非派发中显式授权；派发前先记录目标文件的既有未提交改动，不得覆盖，也不得计入本次成果。',
  '并行只读，不并行写：只读勘察能拆成 ≥2 个互不依赖的子问题（不同目录/不同接口/不同文档）时，在同一条消息里并行发出，不要一个一个等；同一工作区的写操作与构建串行，需要并行写时拆到独立 worktree。',
]

/**
 * Who does what, and when a dispatch may be skipped.
 *
 * Deliberately free of magic numbers: a whitelist is bounded by "one batch, one
 * verification command" (rule 1), and a task list is bounded by "each entry is
 * one decision or one batch" — not by an arbitrary file count or item count.
 * The cost rule exists because the main agent runs the expensive, stronger
 * model: mechanical volume belongs to children, judgement belongs to the main
 * agent. Uncertainty is a reason to batch, never a reason to keep it all.
 */
export const DEFAULT_FOOTER = '成本与豁免：主控模型贵、判断强，子代理便宜、适合机械执行。单文件且纯文案/配置/测试接线的改动可以直接做，但须先读原文并在回复里给出改动与验证证据；其余多文件机械活（同模式批量改写、大范围只读检索、跑长命令收输出）默认派给子代理，主控只留方案取舍、边界判断、例外文件、验收复跑与提交。步骤一时穷举不出来就拆批：先派只读勘察批次问清不确定项，再派实现批次，可多批陆续派发，不许整包留给自己。缺计划类 skill 时，先写「每条 = 一个决策点或一批派发」的任务清单，再据此决定派发，不得据缺 skill 跳过派发判断。'

/** The checkpoint reminder sent to the parent when a child completes. */
export const DEFAULT_CHECKPOINT = '[dispatch-protocol] 子代理 {childId}（{label}）已完成。标记完成前：读它的 diff，并独立复跑它声称跑过的那条命令；结果记入台账。'

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
  }
  if (typeof checkpoint.text !== 'string' || checkpoint.text.trim() === '') {
    throw new Error('dispatch-protocol: checkpoint.text must be a non-empty string')
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

  return { enabled: source.enabled !== false, order, rules, footer, text, checkpoint, nudge }
}
