/**
 * 社区文章列表页截图
 * ------------------------------------------------------------------
 * 截 4 张：默认最新 tab（桌面）、标签筛选态、详情密度、窄屏。
 * 桩后端提供可读的中文数据，便于确认排版与信息层次。
 *
 * 用法：node scripts/capture-article-list.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer as createHttp } from 'node:http'
import { createServer } from 'vite'

const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-shot-list-'))

/* ==================== 桩后端 ==================== */
const STUB_PORT = 8124

const ARTICLES = [
  {
    id: 1,
    title: '深入理解 Vue 3 响应式：Proxy 与依赖收集的完整链路',
    cover: '',
    summary:
      '从响应式系统的设计目标出发，梳理依赖收集、派发更新与调度队列的完整链路，并对比 Vue 2 的 Object.defineProperty 实现，解释为什么 Proxy 才能解决数组与新增属性的监听问题。',
    user: { id: 9, userName: '阿燃', avatar: '' },
    tags: [
      { id: 1, name: 'Vue' },
      { id: 2, name: '源码' },
      { id: 3, name: 'TypeScript' },
      { id: 4, name: '原理' },
      { id: 5, name: '进阶' },
    ],
    viewCount: 12840,
    likeCount: 486,
    favoriteCount: 231,
    commentCount: 57,
    createTime: '2026-09-14 14:20:00',
  },
  {
    id: 2,
    title: 'Vite 构建优化实战：从 8 分钟到 40 秒',
    cover: '',
    summary:
      '记录一次真实项目的构建提速过程：定位瓶颈、拆分 chunk、预构建依赖、把 tsc 从构建链路里摘出去，最终把 CI 时间压缩到原来的十分之一。',
    user: { id: 10, userName: '小林', avatar: '' },
    tags: [
      { id: 6, name: '工程化' },
      { id: 7, name: '性能' },
    ],
    viewCount: 8231,
    likeCount: 312,
    favoriteCount: 147,
    commentCount: 34,
    createTime: '2026-09-13 11:05:00',
  },
  {
    id: 3,
    title: '写给前端的 HTTP 缓存入门：强缓存、协商缓存与踩坑记录',
    cover: '',
    summary:
      '用一张流程图讲清 Cache-Control、ETag、Last-Modified 的协作方式，并整理了三个上线时真实踩到的缓存坑。',
    user: { id: 11, userName: '阿May', avatar: '' },
    tags: [
      { id: 8, name: '网络' },
      { id: 9, name: 'HTTP' },
    ],
    viewCount: 5610,
    likeCount: 208,
    favoriteCount: 96,
    commentCount: 18,
    createTime: '2026-09-12 09:40:00',
  },
  {
    id: 4,
    title: 'TypeScript 类型体操到底有没有用？一次真实的类型重构',
    cover: '',
    summary:
      '把 200 行的 any 改成完整的泛型约束后，编译期多抓出了 11 个潜在 bug。这篇文章记录重构思路，也聊聊类型体操的边界在哪。',
    user: { id: 12, userName: '老陈', avatar: '' },
    tags: [
      { id: 3, name: 'TypeScript' },
      { id: 10, name: '重构' },
    ],
    viewCount: 4302,
    likeCount: 176,
    favoriteCount: 88,
    commentCount: 26,
    createTime: '2026-09-11 16:12:00',
  },
  {
    id: 5,
    title: '我用 CSS 变量搭了一套设计令牌系统',
    cover: '',
    summary:
      '不引入任何 UI 框架的样式层，只用 CSS 自定义属性做主题、间距、字号和圆角，并把它映射到组件库的变量上，实现换肤零成本。',
    user: { id: 13, userName: 'Luna', avatar: '' },
    tags: [
      { id: 11, name: 'CSS' },
      { id: 12, name: '设计系统' },
    ],
    viewCount: 3187,
    likeCount: 142,
    favoriteCount: 73,
    commentCount: 11,
    createTime: '2026-09-10 20:30:00',
  },
  {
    id: 6,
    title: '手写一个 Promise：从规范到实现',
    cover: '',
    summary:
      '按 Promises/A+ 规范逐步实现 then 方法的链式调用、状态机与异步调度，每写一段用官方测试套件验证一次。',
    user: { id: 14, userName: '阿燃', avatar: '' },
    tags: [
      { id: 13, name: 'JavaScript' },
      { id: 14, name: '面试' },
    ],
    viewCount: 2964,
    likeCount: 121,
    favoriteCount: 65,
    commentCount: 9,
    createTime: '2026-09-09 13:18:00',
  },
]

const stub = createHttp((req, res) => {
  const url = new URL(req.url, `http://localhost:${STUB_PORT}`)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  const ok = (data) => res.end(JSON.stringify({ code: 200, message: 'success', data }))

  // 2.12 /api/tag/list 已弃用、后端未实现：前端不再请求，桩里也不再提供

  if (url.pathname === '/api/article/latest') {
    return ok({ total: 48, size: 10, current: 1, records: ARTICLES })
  }

  if (url.pathname === '/api/article/hot') {
    return ok({
      total: 48,
      size: 10,
      current: 1,
      records: [...ARTICLES].sort((a, b) => b.viewCount - a.viewCount),
    })
  }

  if (url.pathname.startsWith('/api/article/tag/')) {
    const tagId = Number(url.pathname.split('/').pop())
    const filtered = ARTICLES.filter((a) => a.tags.some((t) => t.id === tagId))
    return ok({ total: filtered.length, size: 10, current: 1, records: filtered })
  }

  if (url.pathname === '/api/user/info') {
    return ok({ id: 1, userName: '阿燃', avatar: '', intro: '正在构建 CodeMind' })
  }
  if (url.pathname === '/api/notify/unread') {
    return ok(5)
  }

  res.statusCode = 404
  res.end(JSON.stringify({ code: 404, message: 'not found', data: null }))
})
await new Promise((r) => stub.listen(STUB_PORT, r))

/* ==================== Vite ==================== */
const vite = await createServer({
  server: {
    port: 5201,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${STUB_PORT}`, changeOrigin: true } },
  },
  logLevel: 'error',
})
await vite.listen()
const BASE = 'http://localhost:5201'

/* ==================== Chrome ==================== */
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
    '--remote-debugging-port=9338',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1440,1100',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try {
    const r = await fetch('http://127.0.0.1:9338/json/version')
    if (r.ok) break
  } catch {
    /* 等待 */
  }
}

const targets = await (await fetch('http://127.0.0.1:9338/json/list')).json()
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
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage })
  const file = path.join(OUT_DIR, name)
  await fs.writeFile(file, Buffer.from(shot.data, 'base64'))
  const { size } = await fs.stat(file)
  console.log(`  ✓ ${name} (${(size / 1024).toFixed(1)} KB)`)
}

/* ---- 1. 未登录 · 最新 tab ---- */
console.log('\n--- 截图 ---')
await call('Page.navigate', { url: BASE + '/articles' })
await wait(2600)
await shoot('article-list-guest.png')

/* ---- 2. 热门 tab（带序号） ---- */
await call('Runtime.evaluate', {
  expression: `[...document.querySelectorAll('.cm-tabs__item')].find(e => e.textContent.trim() === '热门').click()`,
})
await wait(1400)
await shoot('article-list-hot.png')

/* ---- 3. 标签筛选 ---- */
await call('Runtime.evaluate', {
  expression: `[...document.querySelectorAll('.cm-article-list__tag')].find(e => e.textContent.trim() === 'TypeScript').click()`,
})
await wait(1400)
await shoot('article-list-tag.png')

/* ---- 4. 登录态 ---- */
await call('Runtime.evaluate', {
  expression: `localStorage.setItem('codemind_token', 'fake-jwt-for-screenshot')`,
})
await call('Page.navigate', { url: BASE + '/articles' })
await wait(2800)
await shoot('article-list-logged-in.png')

/* ---- 5. 窄屏 ---- */
await call('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await call('Page.navigate', { url: BASE + '/articles' })
await wait(2600)
await shoot('article-list-mobile.png', false)

chrome.kill()
await vite.close()
stub.close()
try {
  await fs.rm(profileDir, { recursive: true, force: true })
} catch {
  /* Windows 上文件可能还被占用，忽略 */
}
console.log('\n完成。')
process.exit(0)
