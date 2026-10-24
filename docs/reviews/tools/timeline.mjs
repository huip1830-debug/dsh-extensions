// 详细时间线：回合、用户消息、工具调用（重点：subagent/write/edit/pwsh/gate/ledger）、子代理目录
import fs from 'node:fs'

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
const events = []
for (const line of lines) {
  try { events.push(JSON.parse(line)) } catch { /* skip */ }
}

const fmt = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
const short = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s }

const toolHist = {}
const subagentCalls = []
const writeCalls = []
const pwshCalls = []
const userMsgs = []
const turns = []
const catalogs = []

for (const e of events) {
  const ts = e.time
  const d = e.data || {}
  switch (e.type) {
    case 'turn/start':
      turns.push({ t: 'start', ts, seq: e.seq })
      console.log(`\n########## TURN START ${fmt(ts)} seq=${e.seq} reason=${d.reason ?? ''}`)
      break
    case 'turn/end':
      console.log(`########## TURN END   ${fmt(ts)} seq=${e.seq}`)
      break
    case 'user/message': {
      const txt = d.text ?? d.content ?? JSON.stringify(d)
      userMsgs.push({ ts, txt })
      console.log(`\n[USER ${fmt(ts)}] ${short(txt, 600)}`)
      break
    }
    case 'tool/call': {
      const name = d.name || d.tool || '?'
      toolHist[name] = (toolHist[name] || 0) + 1
      const args = d.args || d.input || {}
      let detail = ''
      if (name === 'subagent' || name === 'subagent_fork' || name === 'workflow') {
        detail = `desc=${short(args.description, 80)}`
        subagentCalls.push({ ts, name, desc: args.description, prompt: args.prompt, cwd: args.cwd, model: args.model, provider: args.provider })
      } else if (name === 'write' || name === 'edit') {
        detail = `file=${args.file_path}`
        writeCalls.push({ ts, name, file: args.file_path })
      } else if (name === 'pwsh') {
        detail = `cmd=${short(args.command, 100)} desc=${short(args.description, 60)}`
        pwshCalls.push({ ts, cmd: args.command, desc: args.description })
      } else if (name === 'read') {
        detail = `file=${short(args.file_path, 90)}`
      } else if (name === 'grep' || name === 'glob') {
        detail = `pat=${short(args.pattern, 60)} path=${short(args.path, 60)}`
      } else if (name === 'ask_user_question') {
        detail = short(JSON.stringify(args), 200)
      } else if (name === 'send_message') {
        detail = `to=${short(args.agent_id, 20)} msg=${short(args.message, 120)}`
      } else if (name === 'todo_write') {
        detail = `todos=${(args.todos || []).length}`
      } else if (name === 'present') {
        detail = short(JSON.stringify(args), 150)
      } else if (name === 'create_goal' || name === 'update_goal') {
        detail = short(JSON.stringify(args), 200)
      } else if (name === 'skill') {
        detail = `name=${args.name}`
      }
      console.log(`  [CALL ${fmt(ts)}] ${name} ${detail}`)
      break
    }
    case 'tool/result': {
      const r = d.result ?? d.output ?? ''
      const rc = d.exitCode ?? d.exit_code
      if (rc !== undefined && rc !== 0) console.log(`  [RESULT ${fmt(ts)}] exit=${rc} ${short(typeof r === 'string' ? r : JSON.stringify(r), 150)}`)
      break
    }
    case 'subagent/catalog':
      catalogs.push({ ts, agents: d.agents ?? d })
      console.log(`  [CATALOG ${fmt(ts)}] ${short(JSON.stringify(d), 300)}`)
      break
    case 'workspace/changes':
      console.log(`  [CHANGES ${fmt(ts)}] ${short(JSON.stringify(d), 400)}`)
      break
  }
}

console.log('\n=== 工具调用直方图 ===')
for (const [t, n] of Object.entries(toolHist).sort((a, b) => b[1] - a[1])) console.log(`${n}\t${t}`)

console.log(`\n=== 统计 ===`)
console.log(`user_messages=${userMsgs.length}`)
console.log(`subagent_calls=${subagentCalls.length}`)
console.log(`write_edit_calls=${writeCalls.length}`)
console.log(`pwsh_calls=${pwshCalls.length}`)
console.log(`turns=${turns.length}`)

fs.writeFileSync(file + '.subagents.json', JSON.stringify(subagentCalls, null, 2))
fs.writeFileSync(file + '.writes.json', JSON.stringify(writeCalls, null, 2))
fs.writeFileSync(file + '.pwsh.json', JSON.stringify(pwshCalls, null, 2))
fs.writeFileSync(file + '.users.json', JSON.stringify(userMsgs, null, 2))
