/**
 * 笔记模块截图
 * ------------------------------------------------------------------
 * 输出 6 张到 docs/screenshots/：
 *   note-list.png             笔记列表（分类侧栏 + 卡片）
 *   note-detail.png           笔记详情（正文 + 操作栏 + AI 条）
 *   note-editor.png           笔记编辑器（左写右预览，编辑态）
 *   note-categories.png       分类管理（多级树 + 概览）
 *   note-list-mobile.png      列表窄屏
 *   note-categories-mobile.png 分类管理窄屏
 *
 * 用法：node scripts/capture-note.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer as createHttp } from 'node:http'
import { createServer } from 'vite'

const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-shot-note-'))

const STUB_PORT = 8126

const ME = { id: 1001, userName: '阿燃', avatar: '', intro: 'Java 后端 / 正在写 CodeMind' }

const NOTE_CONTENT = `## 看门狗到底在续什么

Redisson 加锁成功后会启动一个后台任务，每隔 \`lockWatchdogTimeout / 3\`（默认 10 秒）把锁的过期时间续回 30 秒。
只要业务线程还活着，锁就不会因为过期被别人抢走。

\`\`\`java
RLock lock = redisson.getLock("order:1001");
lock.lock();                 // 不传 leaseTime，才会启用看门狗
try {
    // 业务逻辑
} finally {
    lock.unlock();
}
\`\`\`

## 三个容易踩的坑

| 坑 | 现象 | 正确做法 |
| --- | --- | --- |
| 手动传 leaseTime | 看门狗不再续期，业务没跑完锁就没了 | 不传 leaseTime |
| 忘了 unlock | 锁一直续期，直到进程退出 | finally 里释放 |
| 用错线程释放 | 抛 IllegalMonitorStateException | 谁加锁谁释放 |

> 结论：不确定持有时长时不要传 leaseTime；确定很短可以传，避免多一次续期开销。

## 和 SETNX 自研锁的差别

自研锁要自己处理「续期」「可重入」「释放时校验持有者」三件事，其中续期最难写对：
既要保证续期失败时不误判，又要在客户端崩溃后让锁自然过期。Redisson 把这些都封在客户端内部了。
`

const DETAIL = {
  id: 7001,
  user: ME,
  title: 'Redisson 看门狗机制笔记',
  content: NOTE_CONTENT,
  summary: '看门狗续的是什么、三个常见坑，以及和 SETNX 自研锁的差别。',
  cover: '',
  category: { id: 5, name: 'Spring' },
  tags: [
    { id: 1, name: 'Java' },
    { id: 2, name: 'Redis' },
  ],
  visibility: 1,
  status: 1,
  wordCount: 860,
  createTime: '2026-09-10 10:20:00',
  updateTime: '2026-09-14 21:05:00',
}

const NOTES = [
  {
    id: 7001,
    title: 'Redisson 看门狗机制笔记',
    summary: '看门狗续的是什么、三个常见坑，以及和 SETNX 自研锁的差别。',
    cover: '',
    visibility: 1,
    status: 1,
    wordCount: 860,
    categoryName: 'Spring',
    tags: [
      { id: 1, name: 'Java' },
      { id: 2, name: 'Redis' },
    ],
    createTime: '2026-09-10 10:20:00',
    updateTime: '2026-09-14 21:05:00',
  },
  {
    id: 7002,
    title: 'JVM 内存区域速查',
    summary: '堆、栈、方法区各自的职责，以及常用 GC 参数的含义。',
    cover: '',
    visibility: 0,
    status: 1,
    wordCount: 1420,
    categoryName: 'JVM',
    tags: [{ id: 1, name: 'Java' }],
    createTime: '2026-09-09 09:00:00',
    updateTime: '2026-09-13 18:40:00',
  },
  {
    id: 7003,
    title: 'Vue 3 响应式丢失的几种情况',
    summary: '解构 props、直接改数组下标、把 reactive 存进普通变量。',
    cover: '',
    visibility: 1,
    status: 1,
    wordCount: 960,
    categoryName: '前端',
    tags: [{ id: 3, name: 'Vue' }],
    createTime: '2026-09-08 20:10:00',
    updateTime: '2026-09-12 11:20:00',
  },
  {
    id: 7004,
    title: '缓存穿透、击穿、雪崩的区别',
    summary: '三种失效模式的表现和各自的解法，别再混着说了。',
    cover: '',
    visibility: 1,
    status: 1,
    wordCount: 1180,
    categoryName: 'Redis',
    tags: [{ id: 2, name: 'Redis' }],
    createTime: '2026-09-07 15:00:00',
    updateTime: '2026-09-11 09:30:00',
  },
  {
    id: 7005,
    title: '未写完：MySQL 索引下推',
    summary: '',
    cover: '',
    visibility: 0,
    status: 0,
    wordCount: 120,
    categoryName: 'MySQL',
    tags: [],
    createTime: '2026-09-06 22:00:00',
    updateTime: '2026-09-06 22:40:00',
  },
]

const TREE = [
  {
    id: 1,
    name: 'Java',
    sort: 4,
    children: [
      { id: 5, name: 'Spring', sort: 2, children: [] },
      { id: 6, name: 'JVM', sort: 1, children: [] },
    ],
  },
  {
    id: 2,
    name: 'Redis',
    sort: 3,
    children: [{ id: 7, name: '缓存策略', sort: 0, children: [] }],
  },
  { id: 3, name: '前端', sort: 2, children: [] },
  { id: 4, name: 'MySQL', sort: 1, children: [] },
]

const stub = createHttp(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${STUB_PORT}`)
  const ok = (data) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ code: 200, message: 'success', data }))
  }

  if (url.pathname === '/api/user/info') return ok(ME)
  if (url.pathname === '/api/notify/unread') return ok(2)
  if (url.pathname === '/api/category/tree') return ok(TREE)
  // 2.12 /api/tag/list 已弃用、后端未实现：前端不再请求，桩里也不再提供

  // 顺序很重要：/note/list 必须先于 /note/:id
  if (url.pathname === '/api/note/list') {
    return ok({ total: NOTES.length, size: 10, current: 1, records: NOTES })
  }
  if (/^\/api\/note\/\d+$/.test(url.pathname) && req.method === 'GET') return ok(DETAIL)

  return ok({ total: 0, size: 10, current: 1, records: [] })
})
await new Promise((r) => stub.listen(STUB_PORT, r))

const vite = await createServer({
  server: {
    port: 5203,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${STUB_PORT}`, changeOrigin: true } },
  },
  logLevel: 'error',
})
await vite.listen()
const BASE = 'http://localhost:5203'

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
    '--remote-debugging-port=9340',
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
    const r = await fetch('http://127.0.0.1:9340/json/version')
    if (r.ok) break
  } catch {
    /* 等待 */
  }
}

const targets = await (await fetch('http://127.0.0.1:9340/json/list')).json()
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
await call('Page.navigate', { url: BASE + '/notes' })
await wait(1200)
await call('Runtime.evaluate', {
  expression: `localStorage.setItem('codemind_token', 'fake-jwt-for-screenshot')`,
})

/* 1. 笔记列表 */
await call('Page.navigate', { url: BASE + '/notes' })
await wait(2600)
await shoot('note-list.png')

/* 2. 笔记详情 */
await call('Page.navigate', { url: BASE + '/notes/7001' })
await wait(2600)
await shoot('note-detail.png')

/* 3. 编辑器（编辑态，左写右预览） */
await call('Page.navigate', { url: BASE + '/notes/7001/edit' })
await wait(2600)
await shoot('note-editor.png')

/* 4. 分类管理 */
await call('Page.navigate', { url: BASE + '/categories' })
await wait(2400)
await shoot('note-categories.png')

/* 5. 窄屏 */
await call('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await call('Page.navigate', { url: BASE + '/notes' })
await wait(2400)
await shoot('note-list-mobile.png', false)

await call('Page.navigate', { url: BASE + '/categories' })
await wait(2400)
await shoot('note-categories-mobile.png', false)

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
