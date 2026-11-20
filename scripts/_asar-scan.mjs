// Throwaway diagnostic: read the Electron asar directory index without mounting it.
import { open } from 'node:fs/promises'

const archive = process.argv[2]
const needle = (process.argv[3] ?? '').toLowerCase()
const show = Number(process.argv[4] ?? 60)

const handle = await open(archive, 'r')
try {
  const sizeBuf = Buffer.alloc(8)
  await handle.read(sizeBuf, 0, 8, 0)
  const headerSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  await handle.read(headerBuf, 0, headerSize, 8)

  // The JSON string starts after its 4-byte length prefix; scan balanced braces so
  // trailing padding cannot break the parse.
  const start = headerBuf.indexOf('{')
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < headerBuf.length; i += 1) {
    const ch = headerBuf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === 0x5c) escaped = true
      else if (ch === 0x22) inString = false
      continue
    }
    if (ch === 0x22) inString = true
    else if (ch === 0x7b) depth += 1
    else if (ch === 0x7d) {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const index = JSON.parse(headerBuf.subarray(start, end).toString('utf8'))

  const out = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const full = prefix === '' ? name : `${prefix}/${name}`
      if (value.files) walk(value, full)
      else if (needle === '' || full.toLowerCase().includes(needle)) out.push(`${full}\t${value.size ?? 0}`)
    }
  }
  walk(index, '')
  console.log(`matches=${out.length}`)
  for (const line of out.slice(0, show)) console.log(line)
} finally {
  await handle.close()
}
