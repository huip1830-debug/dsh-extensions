// 会话事件总览：类型直方图 + 回合/工具调用时间线
import fs from 'node:fs'

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
const hist = {}
const events = []
for (const [idx, line] of lines.entries()) {
  let e
  try { e = JSON.parse(line) } catch { continue }
  const t = e.type || e.event || 'unknown'
  hist[t] = (hist[t] || 0) + 1
  events.push({ idx, t, e })
}
console.log('=== 事件类型直方图 ===')
for (const [t, n] of Object.entries(hist).sort((a, b) => b[1] - a[1])) console.log(`${n}\t${t}`)
console.log(`\ntotal_lines=${lines.length}`)

// 打印每种事件的一个样本的 keys
const seen = new Set()
for (const { t, e } of events) {
  if (seen.has(t)) continue
  seen.add(t)
  console.log(`\n--- sample keys for [${t}] ---`)
  console.log(Object.keys(e).join(', '))
  if (e.ts || e.time || e.timestamp) console.log('ts:', e.ts || e.time || e.timestamp)
}
