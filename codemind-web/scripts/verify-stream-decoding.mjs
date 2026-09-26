/**
 * 验证脚本：证明「跨分片多字节字符截断」是真实存在的问题，
 * 并证明 decode({ stream: true }) 能正确修复。
 *
 * 运行：node scripts/verify-stream-decoding.mjs
 */
import { TextEncoder, TextDecoder } from 'node:util'

const encoder = new TextEncoder()
const sample = '你好，CodeMind！这是流式输出测试。\ncode: \u4e2d\u6587'
const bytes = encoder.encode(sample)

console.log('原文:', JSON.stringify(sample))
console.log('UTF-8 字节数:', bytes.length)
console.log('')

/* ---------- 错误做法：每个分片独立解码 ---------- */
console.log('=== 做法 A：每个分片独立 decode（错误示范）===')
{
  const decoder = new TextDecoder('utf-8')
  let result = ''
  // 每 3 字节切一刀，故意切在汉字中间（汉字占 3 字节）
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = bytes.subarray(i, i + 3)
    result += decoder.decode(chunk) // 没传 stream: true
  }
  const bad = (result.match(/\uFFFD/g) || []).length
  console.log('结果:', JSON.stringify(result))
  console.log('乱码字符 U+FFFD 数量:', bad)
  console.log('是否与原文一致:', result === sample)
}

console.log('')

/* ---------- 正确做法：累积 stream 解码 ---------- */
console.log('=== 做法 B：decode(value, { stream: true })（正确做法）===')
{
  const decoder = new TextDecoder('utf-8')
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = bytes.subarray(i, i + 3)
    result += decoder.decode(chunk, { stream: true })
  }
  result += decoder.decode() // flush 尾部残留
  const bad = (result.match(/\uFFFD/g) || []).length
  console.log('结果:', JSON.stringify(result))
  console.log('乱码字符 U+FFFD 数量:', bad)
  console.log('是否与原文一致:', result === sample)
}

console.log('')

/* ---------- 极端情况：逐字节切分 ---------- */
console.log('=== 极端场景：逐字节切分（模拟最恶劣的网络分片）===')
{
  const decoder = new TextDecoder('utf-8')
  let result = ''
  for (const byte of bytes) {
    result += decoder.decode(new Uint8Array([byte]), { stream: true })
  }
  result += decoder.decode()
  console.log('是否与原文一致:', result === sample)
}
