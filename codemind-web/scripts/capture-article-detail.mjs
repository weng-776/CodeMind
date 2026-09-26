/**
 * 文章详情页 + 编辑器截图
 * ------------------------------------------------------------------
 * 输出 5 张：
 *   article-detail.png        详情页（正文 + 指标 + 操作栏 + 评论）
 *   article-detail-ai.png     详情页 + AI 面板（流式生成中）
 *   article-editor.png        编辑器双栏（左写右预览）
 *   article-editor-mobile.png 编辑器窄屏
 *   article-detail-mobile.png 详情页窄屏
 *
 * 用法：node scripts/capture-article-detail.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { createServer as createHttp } from 'node:http'
import { createServer } from 'vite'

const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-shot-detail-'))

const STUB_PORT = 8125

/* ==================== 生成一张示例封面图 ==================== */
/* 不引第三方图像库：直接手写最小 PNG（IHDR + IDAT + IEND） */

let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  CRC_TABLE = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC_TABLE[n] = c
  }
  return CRC_TABLE
}

function crc32(buf) {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

/** 靛蓝斜向渐变，用作示例封面 */
function makeCoverPng(w = 720, h = 320) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  let o = 0
  for (let y = 0; y < h; y += 1) {
    raw[o] = 0 // filter: none
    o += 1
    for (let x = 0; x < w; x += 1) {
      const t = x / w
      const u = y / h
      const r = 60 + 70 * t - 18 * u
      const g = 58 + 42 * t + 12 * u
      const b = 190 - 30 * t + 40 * u
      raw[o] = Math.max(0, Math.min(255, Math.round(r)))
      raw[o + 1] = Math.max(0, Math.min(255, Math.round(g)))
      raw[o + 2] = Math.max(0, Math.min(255, Math.round(b)))
      raw[o + 3] = 255
      o += 4
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const COVER_PNG = makeCoverPng()

const CONTENT = `## 背景

在项目里同时用过 Jedis 和 Redisson，最初只是因为 Redisson 的 API 更顺手，
后来在压测中才真正意识到两者的差别不只在封装层。

## 连接管理

Jedis 是直连模型，每个线程取一个连接，靠连接池复用：

\`\`\`java
JedisPoolConfig config = new JedisPoolConfig();
config.setMaxTotal(64);
config.setMaxIdle(16);
JedisPool pool = new JedisPool(config, "127.0.0.1", 6379);
\`\`\`

Redisson 则维护一套 Netty 连接，命令走异步管线，不需要业务侧关心连接生命周期。

## 分布式锁

| 能力 | Jedis | Redisson |
| --- | --- | --- |
| 加锁 | 需自行 SETNX + 过期时间 | \`lock()\` 开箱可用 |
| 看门狗续期 | 无 | 支持 |
| 可重入 | 需自行实现 | 支持 |

> 结论：业务代码复杂时，Redisson 能省掉大量自己实现分布式锁的精力；
> 但如果只是简单的 GET/SET 且对依赖体积敏感，Jedis 依然够用。

## 线程安全

Jedis 实例本身不是线程安全的，必须依赖连接池；
Redisson 的客户端是线程安全的，可以全局单例复用。
`

const DETAIL = {
  id: 5001,
  title: '为什么我觉得 Redisson 比 Jedis 更好用',
  summary: '从连接管理、分布式锁与线程安全三个角度，聊聊为什么最终选了 Redisson。',
  content: CONTENT,
  // 走 /api 前缀，Vite 的 proxy 会把它转给桩后端，这样详情页与编辑器都能拿到真实图片
  cover: '/api/cover.png',
  user: { id: 1001, userName: '阿燃', avatar: '', intro: 'Java 后端 / 正在写 CodeMind' },
  viewCount: 12840,
  likeCount: 486,
  favoriteCount: 231,
  tags: [
    { id: 1, name: 'Java' },
    { id: 2, name: 'Redis' },
    { id: 3, name: '后端' },
  ],
  isLiked: true,
  isFavorited: false,
  createTime: '2026-09-12 10:20:00',
  updateTime: '2026-09-13 08:30:00',
}

const COMMENTS = [
  {
    id: 9001,
    articleId: 5001,
    user: { id: 2001, userName: '小林', avatar: '' },
    parentId: 0,
    content: '看门狗那段补充得好，我一开始也以为锁会自动释放，结果业务卡住时锁一直续期。',
    createTime: '2026-09-12 11:00:00',
    children: [
      {
        id: 9002,
        articleId: 5001,
        user: { id: 1001, userName: '阿燃', avatar: '' },
        parentId: 9001,
        content: '是的，看门狗默认 30 秒续一次，业务没结束就会一直续。',
        createTime: '2026-09-12 11:30:00',
      },
    ],
  },
  {
    id: 9003,
    articleId: 5001,
    user: { id: 2002, userName: 'Luna', avatar: '' },
    parentId: 0,
    content: '表格对比很直观，收藏了。',
    createTime: '2026-09-12 15:20:00',
    children: [],
  },
]

const stub = createHttp(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${STUB_PORT}`)
  const ok = (data) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ code: 200, message: 'success', data }))
  }

  // 示例封面图：编辑器截图里要显示「已有封面」的状态
  if (url.pathname === '/api/cover.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(COVER_PNG)
    return
  }

  if (url.pathname === '/api/user/info') {
    return ok({ id: 1001, userName: '阿燃', avatar: '', intro: 'Java 后端 / 正在写 CodeMind' })
  }
  if (url.pathname === '/api/notify/unread') return ok(5)
  // 2.12 /api/tag/list 已弃用、后端未实现：前端不再请求，桩里也不再提供
  if (url.pathname.startsWith('/api/user/follow/status/')) return ok(false)
  if (url.pathname.match(/^\/api\/article\/\d+\/comment$/)) {
    return ok({ total: COMMENTS.length, size: 20, current: 1, records: COMMENTS })
  }
  if (url.pathname.match(/^\/api\/article\/\d+$/)) return ok(DETAIL)
  return ok({ total: 0, size: 10, current: 1, records: [] })
})
await new Promise((r) => stub.listen(STUB_PORT, r))

const vite = await createServer({
  server: {
    port: 5202,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${STUB_PORT}`, changeOrigin: true } },
  },
  logLevel: 'error',
})
await vite.listen()
const BASE = 'http://localhost:5202'

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
let browserPath = null
for (const p of CHROME) {
  try {
    await fs.access(p)
    browserPath = p
    break
  } catch {
    /* 继续找 */
  }
}
if (!browserPath) {
  console.log('未找到浏览器，跳过截图')
  process.exit(0)
}

const chrome = spawn(
  browserPath,
  [
    '--headless=new',
    '--remote-debugging-port=9339',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1440,1200',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try {
    const r = await fetch('http://127.0.0.1:9339/json/version')
    if (r.ok) break
  } catch {
    /* 等待 */
  }
}

const targets = await (await fetch('http://127.0.0.1:9339/json/list')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const call = async (method, params) => {
  const m = await send(method, params)
  if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`)
  return m.result
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await call('Page.enable')
await call('Runtime.enable')
await fs.mkdir(OUT_DIR, { recursive: true })

async function shoot(name, fullPage = true) {
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: fullPage,
  })
  const file = path.join(OUT_DIR, name)
  await fs.writeFile(file, Buffer.from(shot.data, 'base64'))
  const { size } = await fs.stat(file)
  console.log(`  ✓ ${name} (${(size / 1024).toFixed(1)} KB)`)
}

console.log('\n--- 截图 ---')

/* 登录态 */
await call('Page.navigate', { url: BASE + '/articles/5001' })
await wait(1200)
await call('Runtime.evaluate', {
  expression: `localStorage.setItem('codemind_token', 'fake-jwt-for-screenshot')`,
})

/* 1. 详情页 */
await call('Page.navigate', { url: BASE + '/articles/5001' })
await wait(2800)
await shoot('article-detail.png')

/* 2. 编辑器（编辑模式，带内容 + 预览） */
await call('Page.navigate', { url: BASE + '/articles/5001/edit' })
await wait(2800)
await shoot('article-editor.png')

/* 3. 详情页窄屏 */
await call('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await call('Page.navigate', { url: BASE + '/articles/5001' })
await wait(2600)
await shoot('article-detail-mobile.png', false)

/* 4. 编辑器窄屏 */
await call('Page.navigate', { url: BASE + '/articles/5001/edit' })
await wait(2600)
await shoot('article-editor-mobile.png', false)

chrome.kill()
await vite.close()
stub.close()
try {
  await fs.rm(profileDir, { recursive: true, force: true })
} catch {
  /* Windows 上文件可能仍被占用 */
}
console.log('\n完成。')
process.exit(0)
