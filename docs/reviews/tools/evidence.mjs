// 证据提取：subagent 派发、edit 分布、pwsh 命令分类、最终回复、workspace/changes
import fs from 'node:fs'

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
const events = []
for (const line of lines) { try { events.push(JSON.parse(line)) } catch {} }

const fmt = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })

// 关键时间点：用户提醒 22:31:03 (seq=1635)
const REMINDER_TS = 1792762263000 // 22:31:03 附近，用 seq 更稳
const REMINDER_SEQ = 1635

console.log('=== 1. subagent 派发（按时间） ===')
let turnSeq = 0
for (const e of events) {
  if (e.type === 'turn/start') turnSeq++
  if (e.type !== 'tool/call') continue
  const d = e.data || {}
  const name = d.name
  if (name !== 'subagent' && name !== 'subagent_fork') continue
  let a = {}
  try { a = JSON.parse(d.arguments || '{}') } catch {}
  console.log(`\n[${fmt(e.time)} T${turnSeq} seq=${e.seq}] ${name} desc="${a.description}" model=${a.model ?? '-'} provider=${a.provider ?? '-'}`)
  console.log(`  brief_chars=${(a.prompt || '').length}`)
  console.log(`  prompt_head=${(a.prompt || '').replace(/\s+/g, ' ').slice(0, 300)}`)
}

console.log('\n\n=== 2. write/edit 按回合与提醒前后分布 ===')
const editByTurn = {}
let turn = 0
for (const e of events) {
  if (e.type === 'turn/start') turn++
  if (e.type !== 'tool/call') continue
  const d = e.data || {}
  if (d.name !== 'edit' && d.name !== 'write') continue
  let args = {}
  try { args = JSON.parse(d.arguments || '{}') } catch {}
  const phase = e.seq < REMINDER_SEQ ? 'before-reminder' : 'after-reminder'
  const key = `T${turn}/${phase}`
  editByTurn[key] = editByTurn[key] || { files: {}, count: 0 }
  editByTurn[key].count++
  const f = args.file_path || '?'
  editByTurn[key].files[f] = (editByTurn[key].files[f] || 0) + 1
}
for (const [k, v] of Object.entries(editByTurn)) {
  console.log(`\n${k}: ${v.count} 次写/改，涉及 ${Object.keys(v.files).length} 个文件`)
  for (const [f, n] of Object.entries(v.files).sort((a, b) => b[1] - a[1])) console.log(`   ${n}x ${f}`)
}

console.log('\n\n=== 3. pwsh 命令分类 ===')
const pwshClass = { git: [], ledger_gate: [], test_build: [], other: [] }
turn = 0
for (const e of events) {
  if (e.type === 'turn/start') turn++
  if (e.type !== 'tool/call') continue
  const d = e.data || {}
  if (d.name !== 'pwsh') continue
  let pargs = {}
  try { pargs = JSON.parse(d.arguments || '{}') } catch {}
  const cmd = (pargs.command || '').replace(/\s+/g, ' ')
  const rec = `[T${turn} ${fmt(e.time)}] ${cmd.slice(0, 200)}`
  if (/ledger|gate\s|snapshot\.mjs/i.test(cmd)) pwshClass.ledger_gate.push(rec)
  else if (/^git |git (add|commit|status|diff|log)/.test(cmd)) pwshClass.git.push(rec)
  else if (/jest|dotnet|npm run|tsc|build|test/i.test(cmd)) pwshClass.test_build.push(rec)
  else pwshClass.other.push(rec)
}
console.log(`\n-- git (${pwshClass.git.length}) --`); pwshClass.git.forEach(x => console.log(x))
console.log(`\n-- ledger/gate/snapshot (${pwshClass.ledger_gate.length}) --`); pwshClass.ledger_gate.forEach(x => console.log(x))
console.log(`\n-- test/build (${pwshClass.test_build.length}) --`); pwshClass.test_build.forEach(x => console.log(x))
console.log(`\n-- other (${pwshClass.other.length}) --`); pwshClass.other.forEach(x => console.log(x))

console.log('\n\n=== 4. workspace/changes 事件 ===')
for (const e of events) {
  if (e.type !== 'workspace/changes') continue
  console.log(`[${fmt(e.time)}] ${JSON.stringify(e.data).slice(0, 500)}`)
}

console.log('\n\n=== 5. 每回合最后一条 assistant 文本（尾部 500 字符） ===')
turn = 0
let lastText = ''
for (const e of events) {
  if (e.type === 'turn/start') { if (lastText) console.log(`\n--- T${turn - 0} 结束前最后文本 ---\n${lastText.slice(-800)}`); turn++ ; lastText = '' }
  if (e.type === 'assistant/message') {
    const d = e.data || {}
    let txt = ''
    const msg = d.message || {}
    const content = msg.content
    if (Array.isArray(content)) txt = content.filter(c => c.type === 'text').map(c => c.text || '').join('\n')
    if (txt.trim()) lastText = txt
  }
}
if (lastText) console.log(`\n--- 最终回合尾部文本 ---\n${lastText.slice(-1500)}`)
