// dispatch-protocol — always-on dispatch discipline for DSH sessions.
//
// Two mechanisms, both DSH-only:
//   1. One system-prompt section, so every request (main agent and every
//      subagent) carries the five dispatch rules. Independent of which skills
//      the model chose to load.
//   2. A completion checkpoint: when a child agent finishes, its parent gets one
//      short reminder to read the diff and re-run the command the child claims.
//      Static rules alone get skipped; a timed reminder does not.
//
// Why a plugin instead of AGENTS.md: AGENTS.md is shared with Codex, OpenCode
// and Claude Code, where this DSH-specific delegation discipline does not
// apply.
//
// Extension points (installed dsh 0.2.1-rc.2):
//   - `ctx.systemPrompt.section({ name, order, text, interpolate })`
//   - `agent/created({ agent })` — subagent children carry
//     `session.header.parentSession` and `origin === 'subagent'`.
//   - `subagent/end(info)` — settlement; `stopReason` says how it ended.
//   - `ctx.agents.get(parentSessionId).followup(userMessage)`.
import { randomUUID } from 'node:crypto'
import { resolveConfig } from './lib/config.mjs'

export const name = 'dispatch-protocol'
export const inject = ['systemPrompt', 'agents']

/**
 * Build a complete user-role message. `Agent.followup` takes a `UserMessage`,
 * not a bare `{ content }`; a message without `role` is rejected by the provider.
 * @param text - the message text.
 * @returns a user message the session layer accepts.
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Child descriptor label, used only for the checkpoint text. */
function readLabel(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'subagent/descriptor' && typeof event.data?.label === 'string') return event.data.label
    }
  } catch {
    // label is presentation data only
  }
  return undefined
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  if (config.enabled) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'dispatch-protocol',
      order: config.order,
      text: config.text,
      interpolate: false,
    }))
  }

  if (!config.checkpoint.enabled) return

  /** childId → `{ parentId, label }` for settlement lookup. */
  const children = new Map()
  const reported = new Set()

  ctx.on('agent/created', ({ agent }) => {
    const header = agent?.session?.header
    if (header?.origin !== 'subagent') return
    children.set(agent.id, {
      parentId: header.parentSession,
      label: readLabel(agent) ?? '未命名',
    })
  })

  ctx.on('subagent/end', (info) => {
    const childId = info?.childId ?? info?.id
    const record = childId === undefined ? undefined : children.get(childId)
    if (record === undefined || reported.has(childId)) return

    const stopReason = info?.stopReason ?? info?.outcome ?? info?.terminal?.stopReason
    if (stopReason !== 'completed') return
    reported.add(childId)

    const parent = ctx.agents?.get?.(record.parentId)
    if (parent === undefined) return
    const text = config.checkpoint.text
      .replaceAll('{childId}', childId)
      .replaceAll('{label}', record.label)
    if (typeof parent.followup === 'function') parent.followup(userMessage(text))
  })
}
