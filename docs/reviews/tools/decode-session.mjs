// 逐帧解压 session.v4.jsonl.zstd 为纯文本 jsonl
import fs from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const src = process.argv[2]
const dst = process.argv[3]
const buf = fs.readFileSync(src)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
let i = 0
while ((i = buf.indexOf(magic, i)) !== -1) { offsets.push(i); i += 4 }
const parts = offsets.map((o, idx) => {
  const end = idx + 1 < offsets.length ? offsets[idx + 1] : buf.length
  try { return zstdDecompressSync(buf.subarray(o, end)) } catch (e) {
    return Buffer.from(`\n{"__decode_error": "${e.message}", "frame": ${idx}}\n`)
  }
})
fs.writeFileSync(dst, Buffer.concat(parts))
console.log(`frames=${offsets.length} bytes_out=${Buffer.concat(parts).length} -> ${dst}`)
