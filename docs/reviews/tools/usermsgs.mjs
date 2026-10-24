// 提取用户消息文本与子代理派发详情
import fs from 'node:fs'

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)

const fmt = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })

function toText(x) {
  if (x == null) return ''
  if (typeof x === 'string') return x
  if (Array.isArray(x)) return x.map(toText).filter(Boolean).join(' | ')
  if (typeof x === 'object') {
    if (x.text) return x.text
    if (x.content) return toText(x.content)
    if (x.message) return toText(x.message)
    if (x.type === 'text') return x.text || ''
    return JSON.stringify(x).slice(0, 300)
  }
  return String(x)
}

for (const line of lines) {
  let e
  try { e = JSON.parse(line) } catch { continue }
  if (e.type === 'user/message') {
    const txt = toText(e.data)
    console.log(`\n[USER ${fmt(e.time)} seq=${e.seq}] ${txt.replace(/\s+/g, ' ').slice(0, 800)}`)
  }
}
