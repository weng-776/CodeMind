/**
 * 流式内核集成验证
 * ------------------------------------------------------------------
 * 启动一个本地 HTTP 服务，模拟后端 Flux<String> 的行为：
 *   - Content-Type: text/html;charset=UTF-8
 *   - 分块返回中文文本，且「故意切在汉字中间」
 *   - 每片之间有延迟，模拟真实网络
 *
 * 然后用与浏览器端相同的解码逻辑读取，验证：
 *   1. 内容与原文完全一致（无乱码）
 *   2. onChunk 被多次调用（确实是流式，而非一次性）
 *   3. AbortSignal 能中断读取
 *   4. 非 2xx 状态被正确识别
 *
 * 运行：node scripts/verify-ai-stream.mjs
 */
import http from 'node:http'
import { TextEncoder, TextDecoder } from 'node:util'

/* ==================== 与服务端实现一致的核心逻辑 ==================== */

async function readTextStream(body, handlers) {
  const { onChunk, onDone, onError } = handlers
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      const text = decoder.decode(value, { stream: true })
      if (text) onChunk(text)
    }
    const tail = decoder.decode()
    if (tail) onChunk(tail)
    onDone?.()
  } catch (err) {
    if (isAbortError(err)) {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      onDone?.()
      return
    }
    onError?.('AI 响应读取中断')
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}

function isAbortError(err) {
  return (err instanceof Error && err.name === 'AbortError') || err?.name === 'AbortError'
}

async function streamFetch(url, init, handlers, signal) {
  const { onChunk, onDone, onError } = handlers
  let response
  try {
    response = await fetch(url, { ...init, signal })
  } catch (err) {
    if (isAbortError(err)) {
      onDone?.()
      return
    }
    onError?.('网络异常，无法连接 AI 服务')
    return
  }
  if (!response.ok) {
    onError?.(`AI 服务响应异常（HTTP ${response.status}）`)
    return
  }
  await readTextStream(response.body, handlers)
}

/* ==================== 测试用的模拟后端 ==================== */

const PAYLOAD = '你好，CodeMind！这是流式输出测试。\n```java\npublic class Demo {}\n```\n中文结尾。'

const server = http.createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' })

    const bytes = new TextEncoder().encode(PAYLOAD)
    // 故意用 7 字节切片（3 和 7 都不整除汉字宽度，必定切断多字节字符）
    const SLICE = 7
    let i = 0
    const timer = setInterval(() => {
      if (i >= bytes.length) {
        clearInterval(timer)
        res.end()
        return
      }
      res.write(Buffer.from(bytes.subarray(i, i + SLICE)))
      i += SLICE
    }, 8)
    return
  }

  if (req.url === '/slow') {
    // 持续输出，用于测试中断
    res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' })
    let n = 0
    const timer = setInterval(() => {
      n += 1
      res.write('第' + n + '段内容。')
      if (n > 200) {
        clearInterval(timer)
        res.end()
      }
    }, 20)
    res.on('close', () => clearInterval(timer))
    return
  }

  if (req.url === '/500') {
    res.writeHead(500, { 'Content-Type': 'text/html;charset=UTF-8' })
    res.end('boom')
    return
  }

  if (req.url === '/401') {
    res.writeHead(401)
    res.end('unauthorized')
    return
  }

  res.writeHead(404)
  res.end()
})

/* ==================== 执行测试 ==================== */

const PORT = 18099
await new Promise((r) => server.listen(PORT, r))
const base = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
function assert(label, actual, expected) {
  const ok = actual === expected
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) {
    console.log(`        期望: ${JSON.stringify(expected)}`)
    console.log(`        实际: ${JSON.stringify(actual)}`)
    fail++
  } else {
    pass++
  }
}

console.log('=== 测试 1：中文分片解码（核心风险点）===')
{
  let result = ''
  let chunkCount = 0
  await new Promise((resolve) => {
    streamFetch(`${base}/ok`, { method: 'POST' }, {
      onChunk(t) {
        result += t
        chunkCount++
      },
      onDone: resolve,
      onError(m) {
        console.log('  错误: ' + m)
        resolve()
      },
    })
  })
  assert('内容与原文完全一致', result, PAYLOAD)
  assert('无乱码字符 U+FFFD', result.includes('\uFFFD'), false)
  assert('确实是流式（chunk 数 > 3）', chunkCount > 3, true)
  console.log(`        （共收到 ${chunkCount} 个 chunk，总长 ${result.length} 字符）`)
}

console.log('')
console.log('=== 测试 2：AbortController 中断 ===')
{
  const controller = new AbortController()
  let result = ''
  let doneCalled = false
  let errorCalled = false

  const p = new Promise((resolve) => {
    streamFetch(
      `${base}/slow`,
      { method: 'POST' },
      {
        onChunk(t) {
          result += t
        },
        onDone() {
          doneCalled = true
          resolve()
        },
        onError() {
          errorCalled = true
          resolve()
        },
      },
      controller.signal,
    )
  })

  // 收到一点内容后，从外部中断（不在 onChunk 里 abort，
  // 这样能真实模拟用户点击「停止生成」的时序）
  const abortTimer = setInterval(() => {
    if (result.length > 10) {
      clearInterval(abortTimer)
      controller.abort()
    }
  }, 10)

  await Promise.race([p, new Promise((r) => setTimeout(r, 3000))])
  clearInterval(abortTimer)
  assert('中断后调用了 onDone', doneCalled, true)
  assert('中断未被当作错误', errorCalled, false)
  assert('已收到部分内容', result.length > 0, true)
  console.log(`        （中断前收到 ${result.length} 字符，未被无限阻塞）`)
}

console.log('')
console.log('=== 测试 3：HTTP 错误状态识别 ===')
{
  let msg500 = ''
  await new Promise((resolve) => {
    streamFetch(`${base}/500`, { method: 'POST' }, {
      onChunk() {},
      onDone: resolve,
      onError(m) {
        msg500 = m
        resolve()
      },
    })
  })
  assert('500 被识别为错误', msg500.includes('500'), true)
  console.log(`        提示文案: "${msg500}"`)
}

console.log('')
console.log('=== 测试 4：连接失败处理 ===')
{
  let msg = ''
  await new Promise((resolve) => {
    streamFetch('http://127.0.0.1:1/nope', { method: 'POST' }, {
      onChunk() {},
      onDone: resolve,
      onError(m) {
        msg = m
        resolve()
      },
    })
  })
  assert('连接失败给出友好提示', msg, '网络异常，无法连接 AI 服务')
}

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}，失败 ${fail}`)

server.close()
process.exit(fail === 0 ? 0 : 1)
