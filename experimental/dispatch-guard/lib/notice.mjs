// Model-facing text this plugin writes into a conversation: the nudge sent to a
// stalling child, and the settlement notice sent to its parent.

/**
 * Build the nudge a child receives when it has gone too many steps without
 * writing anything.
 * @param childId - the child session id.
 * @param stepsWithoutWrite - consecutive steps since the last write.
 * @returns the nudge text.
 */
export function renderNudge(childId, stepsWithoutWrite) {
  return [
    `[dispatch-guard] 你已经连续 ${stepsWithoutWrite} 步无写操作。`,
    '这说明你在勘察环境而不是交付改动。请立即停止扩大调查范围：',
    '要么现在开始动手改文件，要么在一轮内按「状态 / 改动 / 验证 / 未验证 / 剩余」汇报并结束。',
    `（子代理 ${childId}）`,
  ].join('\n')
}

/**
 * Build the notice the parent receives when a child was stopped by the guard.
 * @param input - child identity, stop reason, failure evidence, and budget counters.
 * @returns the notice text.
 */
export function renderNotice({ childId, label, reason, failureCode, failureMessage, steps, writes, files = [] }) {
  const lines = [
    `[dispatch-guard] 子代理 ${childId}（${label ?? '未命名'}）已终止：${reason}。`,
    '',
  ]

  if (failureCode !== undefined) {
    const detail = failureMessage === undefined ? '' : ` — ${failureMessage}`
    lines.push(`- 失败：${failureCode}${detail}`)
  }
  lines.push(`- 已执行：${steps ?? 0} 步，写操作 ${writes ?? 0} 次`)

  if ((writes ?? 0) === 0) {
    lines.push('- 副作用：无副作用（未修改任何文件），可以安全重新派发')
  } else {
    const listed = files.length === 0 ? '' : `（${files.slice(0, 8).join('、')}）`
    lines.push(`- 副作用：已产生 ${writes} 次写操作${listed}；重派前先核对 git status / diff`)
  }

  lines.push(
    failureCode === undefined
      ? '- 建议：缩小任务范围或换更有产出的提示后重新派发'
      : '- 建议：等该路由恢复后重派，或换一条模型路由、缩小任务范围',
    '- 不要再用 send_message 追这个子代理，它已经终止。',
  )

  return lines.join('\n')
}
