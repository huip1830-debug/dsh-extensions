// Dispatch discipline text injected as a system-prompt section.

/** The five non-negotiable rules; overridable through `config.rules`. */
export const DEFAULT_RULES = [
  '先勘察，后派发：派发前把「文件:行号 + 相关代码 + 结论 + 不确定项」写成现状文件并在派发中引用，同时给出可改文件白名单（≤3 个）。禁止把「调研 X 然后实现」交给执行类子代理。',
  '执行类派发必须自包含：至少含【现状】【允许修改/允许读取】【验证：唯一一条命令】【输出格式】。子代理遇到清单外信息或现状与代码不符时停报 NEEDS_CONTEXT，不得自行扩大范围。',
  '验收要复跑：子代理声称跑过的命令，派发方必须独立复跑并留存退出码；评审子代理只判规格与质量，不得把子代理的自述当作证据。未复跑不得标记完成。',
  '提交权归派发方：子代理不得 commit / push / reset / clean，除非派发中显式授权；派发前先记录目标文件的既有未提交改动，不得覆盖，也不得计入本次成果。',
  '并行只读，不并行写：只读勘察可以并行；同一工作区的写操作与构建串行，需要并行写时拆到独立 worktree。',
]

/** The small-change exemption appended after the rules. */
export const DEFAULT_FOOTER = '小改豁免：单文件且纯文案/配置/测试接线的改动可以直接完成，但必须先读原文，并在回复中给出改动与验证证据。'

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
  const text = ['## 派发纪律（DSH）', '', numbered, '', footer].join('\n')

  return { enabled: source.enabled !== false, order, rules, footer, text, checkpoint }
}
