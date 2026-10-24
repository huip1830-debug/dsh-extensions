// dump 原始事件结构样本
import fs from 'node:fs'
const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
let callDumped = 0, msgDumped = 0
for (const line of lines) {
  let e; try { e = JSON.parse(line) } catch { continue }
  if (e.type === 'tool/call' && callDumped < 2) {
    console.log('--- tool/call ---')
    console.log(JSON.stringify(e, null, 2).slice(0, 2000))
    callDumped++
  }
  if (e.type === 'assistant/message' && msgDumped < 2) {
    console.log('--- assistant/message ---')
    console.log(JSON.stringify(e, null, 2).slice(0, 2000))
    msgDumped++
  }
}
