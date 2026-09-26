/**
 * 社区文章列表页验证（真实浏览器 CDP + 桩后端）
 * ------------------------------------------------------------------
 * 验证目标（都是 jsdom 测不到的）：
 *   1. 三种 tab 各自打到正确的接口（latest / hot / tag）
 *   2. URL query 是唯一事实来源：改 URL 能还原页面，点 Tab 能改 URL
 *   3. 标签筛选：点文章卡片上的标签 → tab=tag&tagId=x&tagName=y，chip 上的 × 取消
 *   4. 分页：URL page 变化触发请求，请求参数正确
 *   5. 过期响应丢弃：快速连点 tab，最终渲染的必须是最后一次点击的 tab 数据
 *   6. 后端返回空数组 → 空状态（而不是错误态）
 *   7. 后端 500 → 错误态 + 重试可用
 *   8. 零 console 报错 / 零未捕获异常 / 零横向溢出
 *   9. 绝不请求 /api/tag/list（文档已弃用、后端未实现，见 2026-09-16 联调记录）
 *
 * 桩后端：用 Node 原生 http 起一个 /api 服务，intercept Vite proxy 的目标。
 * 这样能真实走完 axios → 响应拦截器 → 页面渲染的完整链路。
 *
 * 用法：node scripts/verify-article-list.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'vite'

/* ==================== 桩后端 ==================== */
const STUB_PORT = 18080

/** 请求日志：[{ method, url, query }] */
const requestLog = []

/** 让某个路径返回错误 / 空数组的开关，用例里动态改 */
const stub = {
  // 'ok' | 'empty' | 'error' | 'slow'
  mode: 'ok',
  /** 某次请求延迟多少毫秒（用于制造"慢响应"来测过期丢弃） */
  delayFor: null,
}

/** 生成一页假数据 —— 这是"桩后端"的数据，不是前端 mock */
function makeArticles(page, size, prefix) {
  const records = []
  for (let i = 0; i < size; i++) {
    const n = (page - 1) * size + i + 1
    records.push({
      id: n,
      title: `${prefix}文章标题 ${n}`,
      cover: '',
      summary: `这是第 ${n} 篇文章的摘要内容，用于验证列表渲染与三态处理。`,
      user: { id: 100 + n, userName: `用户${n}`, avatar: '' },
      tags: [
        { id: 1, name: 'Vue' },
        { id: 2, name: 'TypeScript' },
      ],
      viewCount: n * 137,
      likeCount: n * 3,
      favoriteCount: n * 2,
      commentCount: n,
      createTime: '2026-09-01 10:00:00',
    })
  }
  return records
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

const stubServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${STUB_PORT}`)
  requestLog.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })

  const json = (code, message, data) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code, message, data }))
  }

  const page = Number(url.searchParams.get('page') ?? 1)
  const size = Number(url.searchParams.get('size') ?? 10)

  // 延迟：用于制造慢响应
  if (stub.delayFor && url.pathname === stub.delayFor.path) {
    await new Promise((r) => setTimeout(r, stub.delayFor.ms))
  }

  if (stub.mode === 'error' && url.pathname.startsWith('/api/article')) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 500, message: '服务器内部错误', data: null }))
    return
  }

  /* ---- 2.12 标签列表：文档已弃用、后端未实现 —— 桩里故意不提供该路由 ---- */

  /* ---- 3.18 最新 ---- */
  if (url.pathname === '/api/article/latest') {
    if (stub.mode === 'empty') return json(200, 'success', { total: 0, size, current: page, records: [] })
    return json(200, 'success', {
      total: 25,
      size,
      current: page,
      records: makeArticles(page, size, '[最新]'),
    })
  }

  /* ---- 3.17 热门 ---- */
  if (url.pathname === '/api/article/hot') {
    if (stub.mode === 'empty') return json(200, 'success', { total: 0, size, current: page, records: [] })
    return json(200, 'success', {
      total: 12,
      size,
      current: page,
      records: makeArticles(page, size, '[热门]'),
    })
  }

  /* ---- 3.19 标签下文章 ---- */
  if (url.pathname.startsWith('/api/article/tag/')) {
    const tagId = Number(url.pathname.split('/').pop())
    if (stub.mode === 'empty') return json(200, 'success', { total: 0, size, current: page, records: [] })
    // total 给足 25，保证标签筛选态下也有分页器可点（验证翻页不丢筛选条件）
    return json(200, 'success', {
      total: 25,
      size,
      current: page,
      records: makeArticles(page, size, `[标签${tagId}]`),
    })
  }

  json(404, 'not found', null)
})

/* ==================== Chrome 探测 ==================== */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

async function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    try {
      await fs.access(p)
      return p
    } catch {
      /* 继续找 */
    }
  }
  return null
}

/* ==================== 极简 CDP 客户端 ==================== */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
        }
      } else {
        this.events.push(msg)
      }
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return new CDP(ws)
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 20000)
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? '页面求值异常')
    }
    return res.result.value
  }

  consoleErrors() {
    return this.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }

  exceptions() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.exception?.description ?? '未知异常')
  }

  clearEvents() {
    this.events = []
  }
}

/* ==================== 测试框架 ==================== */
let pass = 0
let fail = 0
const problems = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    problems.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页面数据快照 */
const SNAP = `(() => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  return {
    url: location.pathname + location.search,
    title: document.title,
    activeTab: q('.cm-tabs__item.is-active:not(.is-tag)')?.textContent?.trim() ?? null,
    tagChip: q('.cm-tabs__item.is-tag')?.textContent?.trim() ?? null,
    headings: all('.cm-article-list__head, .cm-article-card__title').map(e => e.textContent.trim()).filter(Boolean),
    cardTitles: all('.cm-article-card__title').map(e => e.textContent.trim()),
    cardCount: all('.cm-article-card').length,
    firstCardPadLeft: q('.cm-article-card') ? getComputedStyle(q('.cm-article-card')).paddingLeft : null,
    titles: all('.cm-article-card__title').map((e) => e.textContent.trim()),
    /** 文章卡片上的标签按钮（标签筛选的唯一入口） */
    cardTags: all('.cm-article-card__tag').map((e) => e.textContent.trim()),
    /** 标签云侧栏应当彻底不存在（2.12 已弃用） */
    hasTagCloud: !!q('.cm-article-list__side'),
    hasSkeleton: !!q('.cm-skeleton__row'),
    hasError: !!q('.cm-error'),
    hasEmpty: !!q('.cm-empty'),
    emptyTitle: q('.cm-empty__title')?.textContent?.trim() ?? null,
    pagerExists: !!q('.el-pagination'),
    activePage: q('.el-pager li.is-active')?.textContent?.trim() ?? null,
    pagerTotal: all('.el-pager li').length,
    // 横向溢出检查
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})()`

/** 等待某个条件在页面上成立 */
async function waitFor(cdp, expression, timeout = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return true
    await sleep(120)
  }
  return false
}

/* ==================== 主流程 ==================== */
let chromeProc = null
let viteServer = null
let profileDir = null

async function cleanup() {
  try {
    chromeProc?.kill()
  } catch {
    /* 忽略 */
  }
  try {
    await viteServer?.close()
  } catch {
    /* 忽略 */
  }
  try {
    await new Promise((r) => stubServer.close(r))
  } catch {
    /* 忽略 */
  }
  try {
    if (profileDir) await fs.rm(profileDir, { recursive: true, force: true })
  } catch {
    /* Windows 上进程刚退出时文件可能还被占用，忽略即可 */
  }
}

async function main() {
  const browserPath = await findBrowser()
  if (!browserPath) {
    console.log('未找到 Chrome/Edge，跳过浏览器验证')
    process.exit(0)
  }
  console.log(`浏览器：${browserPath}`)

  /* ---------- 起桩后端 ---------- */
  await new Promise((r) => stubServer.listen(STUB_PORT, r))
  console.log(`桩后端：http://localhost:${STUB_PORT}`)

  /* ---------- 起 Vite，proxy 指向桩后端 ---------- */
  const PORT = 5198
  viteServer = await createServer({
    server: {
      port: PORT,
      strictPort: true,
      // 覆盖 .env 里的 VITE_PROXY_TARGET，把 /api 打到桩后端
      proxy: {
        '/api': { target: `http://localhost:${STUB_PORT}`, changeOrigin: true },
      },
    },
    logLevel: 'error',
  })
  await viteServer.listen()
  const base = `http://localhost:${PORT}`
  console.log(`Vite：${base}`)

  /* ---------- 起 Chrome ---------- */
  profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-chrome-list-'))
  const debugPort = 9334

  chromeProc = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,900',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let versionInfo = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (res.ok) {
        versionInfo = await res.json()
        break
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!versionInfo) throw new Error('Chrome 调试端口未就绪')
  console.log(`内核：${versionInfo.Browser}\n`)

  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const pageTarget = targets.find((t) => t.type === 'page')
  const cdp = await CDP.connect(pageTarget.webSocketDebuggerUrl)

  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')

  /* ==================== 1. 默认进入：最新 tab ==================== */
  console.log('[1. 默认进入 /articles —— 最新 tab]')
  requestLog.length = 0
  await cdp.send('Page.navigate', { url: base + '/articles' })
  await sleep(2200)

  let snap = await cdp.evaluate(SNAP)

  check('路由停在 /articles', snap.url === '/articles', `实际 ${snap.url}`)
  check('文档标题为「社区 · CodeMind」', snap.title === '社区 · CodeMind', `实际 ${snap.title}`)
  check('默认选中「最新」tab', snap.activeTab === '最新', `实际 ${snap.activeTab}`)
  check('无骨架屏残留', !snap.hasSkeleton)
  check('未进入错误态', !snap.hasError)
  check('未进入空态', !snap.hasEmpty)
  check('渲染出 10 条文章', snap.cardCount === 10, `实际 ${snap.cardCount}`)
  check(
    '数据来自 latest 接口',
    snap.titles[0]?.includes('[最新]'),
    `首条：${snap.titles[0]}`,
  )
  check('分页器已渲染', snap.pagerExists)
  check('分页器总页数为 3（25 条 / 10 页大小）', snap.pagerTotal === 3, `实际 ${snap.pagerTotal}`)

  /* ---- 请求打点 ---- */
  const latestReq = requestLog.filter((r) => r.path === '/api/article/latest')
  check('确实请求了 /api/article/latest', latestReq.length >= 1, `实际 ${latestReq.length} 次`)
  check(
    'latest 请求带 page/size 参数',
    latestReq[0]?.query.page === '1' && latestReq[0]?.query.size === '10',
    `实际 ${JSON.stringify(latestReq[0]?.query)}`,
  )
  check(
    '未请求 /api/article/hot（不该多发）',
    requestLog.every((r) => r.path !== '/api/article/hot'),
    `实际请求：${requestLog.map((r) => r.path).join(', ')}`,
  )
  check(
    '未请求 /api/tag/list（文档已弃用、后端未实现）',
    requestLog.every((r) => r.path !== '/api/tag/list'),
    `实际请求：${requestLog.map((r) => r.path).join(', ')}`,
  )

  /* ---- 标签云已下线 ---- */
  check('标签云侧栏已下线', !snap.hasTagCloud)
  check(
    '标签入口改在文章卡片上（渲染出 Vue / TypeScript）',
    JSON.stringify([...new Set(snap.cardTags)].sort()) === JSON.stringify(['TypeScript', 'Vue']),
    `实际 ${JSON.stringify([...new Set(snap.cardTags)])}`,
  )

  /* ==================== 2. 切到热门 tab ==================== */
  console.log('\n[2. 切换到「热门」tab]')
  requestLog.length = 0
  await cdp.evaluate(
    `[...document.querySelectorAll('.cm-tabs__item')].find(e => e.textContent.trim() === '热门').click()`,
  )
  await waitFor(cdp, `document.querySelector('.cm-article-card__title')?.textContent.includes('[热门]')`)
  snap = await cdp.evaluate(SNAP)

  check('URL 带上 tab=hot', snap.url === '/articles?tab=hot', `实际 ${snap.url}`)
  check('「热门」tab 高亮', snap.activeTab === '热门', `实际 ${snap.activeTab}`)
  check('数据切到 hot 接口', snap.titles[0]?.includes('[热门]'), `首条：${snap.titles[0]}`)
  check(
    'hot 请求已发出且带分页参数',
    requestLog.some((r) => r.path === '/api/article/hot' && r.query.page === '1'),
    `实际 ${JSON.stringify(requestLog.map((r) => r.path))}`,
  )
  check('热门榜带序号（rank）', await cdp.evaluate(`!!document.querySelector('.cm-article-card__rank')`))

  /* ==================== 3. 直接改 URL 还原页面 ==================== */
  console.log('\n[3. URL 即事实来源 —— 直接访问带 query 的地址]')
  requestLog.length = 0
  await cdp.send('Page.navigate', { url: base + '/articles?tab=hot&page=2' })
  await sleep(2200)
  snap = await cdp.evaluate(SNAP)

  check('URL 保持 tab=hot&page=2', snap.url === '/articles?tab=hot&page=2', `实际 ${snap.url}`)
  check('「热门」tab 仍高亮', snap.activeTab === '热门', `实际 ${snap.activeTab}`)
  check('分页器高亮第 2 页', snap.activePage === '2', `实际 ${snap.activePage}`)
  check(
    '请求带 page=2',
    requestLog.some((r) => r.path === '/api/article/hot' && r.query.page === '2'),
    `实际 ${JSON.stringify(requestLog.filter((r) => r.path.includes('hot')).map((r) => r.query))}`,
  )
  check(
    '第 2 页文章序号从 11 开始（rank 连续）',
    await cdp.evaluate(`document.querySelector('.cm-article-card__rank')?.textContent.trim() === '11'`),
    `实际 ${await cdp.evaluate(`document.querySelector('.cm-article-card__rank')?.textContent.trim()`)}`,
  )

  /* ==================== 4. 标签筛选 ==================== */
  console.log('\n[4. 标签筛选（入口＝文章卡片上的标签）]')
  requestLog.length = 0
  // 卡片上第一条文章带 Vue(1) / TypeScript(2) 两个标签
  await cdp.evaluate(
    `[...document.querySelectorAll('.cm-article-card__tag')].find(e => e.textContent.trim() === 'Vue').click()`,
  )
  await waitFor(cdp, `document.querySelector('.cm-article-card__title')?.textContent.includes('[标签1]')`)
  snap = await cdp.evaluate(SNAP)

  check(
    'URL 带上 tab=tag、tagId 与标签名',
    snap.url === '/articles?tab=tag&tagId=1&tagName=Vue',
    `实际 ${snap.url}`,
  )
  check('出现标签筛选 chip 且显示标签名', (snap.tagChip ?? '').includes('Vue'), `实际 ${snap.tagChip}`)
  check('标签筛选态下没有普通 tab 高亮', snap.activeTab === null, `实际 ${snap.activeTab}`)
  check(
    '标题文案说明当前标签',
    await cdp.evaluate(
      `document.querySelector('.cm-article-list__subtitle')?.textContent.includes('标签「Vue」')`,
    ),
  )
  check('数据来自 tag 接口', snap.titles[0]?.includes('[标签1]'), `首条：${snap.titles[0]}`)
  check(
    '请求打到 /api/article/tag/1',
    requestLog.some((r) => r.path === '/api/article/tag/1'),
    `实际 ${JSON.stringify(requestLog.map((r) => r.path))}`,
  )
  check('切标签后回到第 1 页', !('page' in (requestLog[0]?.query ?? {})) || requestLog[0].query.page === '1')

  /* ---- 翻页时标签筛选条件不能丢 ---- */
  requestLog.length = 0
  await cdp.evaluate(
    `[...document.querySelectorAll('.el-pager li')].find(e => e.textContent.trim() === '2')?.click()`,
  )
  await waitFor(cdp, `document.querySelector('.el-pager li.is-active')?.textContent.trim() === '2'`)
  snap = await cdp.evaluate(SNAP)

  check(
    '翻页保留 tab/tagId/tagName',
    snap.url === '/articles?tab=tag&tagId=1&tagName=Vue&page=2',
    `实际 ${snap.url}`,
  )
  check('第 2 页仍打 tag 接口', requestLog.some((r) => r.path === '/api/article/tag/1'))

  /* ---- 不带 tab、只带 tagId 的链接也要能筛选（兼容老链接） ---- */
  await cdp.send('Page.navigate', { url: base + '/articles?tagId=2' })
  await waitFor(cdp, `document.querySelector('.cm-article-card__title')?.textContent.includes('[标签2]')`)
  snap = await cdp.evaluate(SNAP)
  check('只有 tagId 时也按标签筛选', snap.titles[0]?.includes('[标签2]'), `首条：${snap.titles[0]}`)
  check(
    '没有标签名时 chip 退回「标签 #2」',
    (snap.tagChip ?? '').includes('标签 #2'),
    `实际 ${snap.tagChip}`,
  )

  /* ---- chip 上的 × 按钮取消 ---- */
  await cdp.send('Page.navigate', { url: base + '/articles?tab=tag&tagId=1&tagName=Vue' })
  await waitFor(cdp, `document.querySelector('.cm-tabs__item.is-tag')`)
  check('标签 chip 出现 × 按钮', await cdp.evaluate(`!!document.querySelector('.cm-tabs__close')`))

  requestLog.length = 0
  await cdp.evaluate(`document.querySelector('.cm-tabs__close').click()`)
  await waitFor(cdp, `!document.querySelector('.cm-tabs__item.is-tag')`)
  snap = await cdp.evaluate(SNAP)
  check('点 chip 的 × 取消筛选', snap.url === '/articles', `实际 ${snap.url}`)
  check('取消后回到「最新」tab', snap.activeTab === '最新', `实际 ${snap.activeTab}`)
  check('标签 chip 消失', snap.tagChip === null, `实际 ${snap.tagChip}`)
  check('取消后重新请求 latest', requestLog.some((r) => r.path === '/api/article/latest'))

  /* ==================== 5. 空状态 ==================== */
  console.log('\n[5. 空状态（后端返回空数组）]')
  stub.mode = 'empty'
  await cdp.send('Page.navigate', { url: base + '/articles' })
  await sleep(2200)
  snap = await cdp.evaluate(SNAP)

  check('进入空状态', snap.hasEmpty, '应显示空状态而非错误态')
  check('空状态不是错误态', !snap.hasError)
  check('空状态文案针对社区场景', snap.emptyTitle === '社区里还没有文章', `实际 ${snap.emptyTitle}`)
  check('空状态提供「写第一篇」入口', await cdp.evaluate(`document.querySelector('.cm-empty__action .el-button')?.textContent.trim() === '写第一篇'`))
  check('无文章卡片', snap.cardCount === 0, `实际 ${snap.cardCount}`)
  check('空数据时不渲染分页器', !snap.pagerExists)

  /* ---- 标签下的空状态文案不同 ---- */
  stub.mode = 'empty'
  await cdp.send('Page.navigate', { url: base + '/articles?tab=tag&tagId=1' })
  await sleep(2200)
  snap = await cdp.evaluate(SNAP)
  check(
    '标签下的空状态文案区分场景',
    snap.emptyTitle === '这个标签下还没有文章',
    `实际 ${snap.emptyTitle}`,
  )

  /* ==================== 6. 错误态 + 重试 ==================== */
  console.log('\n[6. 错误态与重试]')
  stub.mode = 'error'
  requestLog.length = 0
  await cdp.send('Page.navigate', { url: base + '/articles' })
  await sleep(2200)
  snap = await cdp.evaluate(SNAP)

  check('进入错误态', snap.hasError)
  check('错误态不是空态', !snap.hasEmpty)
  check('错误态提供重试按钮', await cdp.evaluate(`!!document.querySelector('.cm-error__actions .el-button')`))
  check('接口挂掉时不会额外请求 /api/tag/list', requestLog.every((r) => r.path !== '/api/tag/list'))

  /* ---- 重试：后端恢复后应能加载出来 ---- */
  stub.mode = 'ok'
  requestLog.length = 0
  await cdp.evaluate(`document.querySelector('.cm-error__actions .el-button').click()`)
  await waitFor(cdp, `document.querySelectorAll('.cm-article-card').length > 0`)
  snap = await cdp.evaluate(SNAP)

  check('点重试后成功加载', snap.cardCount === 10, `实际 ${snap.cardCount}`)
  check('重试后错误态消失', !snap.hasError)
  check('重试确实重新发了请求', requestLog.some((r) => r.path === '/api/article/latest'))

  /* ==================== 7. 过期响应丢弃 ==================== */
  console.log('\n[7. 快速连切 tab —— 过期响应必须被丢弃]')
  // 让 latest 变慢：先点 hot（快），再点 latest（慢），最后再点 hot。
  // 若没有序号保护，慢的 latest 回来会覆盖 hot 的结果。
  await cdp.send('Page.navigate', { url: base + '/articles' })
  await sleep(2200)

  // 让 latest 慢 1200ms
  stub.delayFor = { path: '/api/article/latest', ms: 1200 }
  requestLog.length = 0

  await cdp.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.cm-tabs__item')]
    const hot = tabs.find(e => e.textContent.trim() === '热门')
    const latest = tabs.find(e => e.textContent.trim() === '最新')
    hot.click()
    latest.click()
    hot.click()
    return true
  })()`)

  // 等足够久，让那个慢的 latest 响应也回来
  await sleep(2600)
  snap = await cdp.evaluate(SNAP)

  check(
    '最终显示的是最后一次点击的「热门」数据',
    snap.titles[0]?.includes('[热门]'),
    `首条：${snap.titles[0]}`,
  )
  check('「热门」tab 高亮', snap.activeTab === '热门', `实际 ${snap.activeTab}`)
  check('URL 与最终 tab 一致', snap.url === '/articles?tab=hot', `实际 ${snap.url}`)
  check('未被慢响应覆盖成 latest 数据', !snap.titles[0]?.includes('[最新]'), `实际 ${snap.titles[0]}`)
  check('无骨架屏卡死', !snap.hasSkeleton)
  stub.delayFor = null

  /* ==================== 8. 标签云已整体下线 ==================== */
  console.log('\n[8. 标签云下线后列表照常]')
  requestLog.length = 0
  await cdp.send('Page.navigate', { url: base + '/articles' })
  await sleep(2200)
  snap = await cdp.evaluate(SNAP)

  check('列表照常渲染 10 条', snap.cardCount === 10, `实际 ${snap.cardCount}`)
  check('没有标签云侧栏', !snap.hasTagCloud)
  check('不触发整页错误态', !snap.hasError)
  check(
    '整页没有任何 /api/tag/list 请求',
    requestLog.every((r) => r.path !== '/api/tag/list'),
    `实际请求：${requestLog.map((r) => r.path).join(', ')}`,
  )

  /* ==================== 9. 响应式 ==================== */
  console.log('\n[9. 响应式与横向溢出]')
  for (const w of [390, 768, 1440]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(400)
    const ov = await cdp.evaluate(
      `({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          sidebar: !!document.querySelector('.cm-article-list__side'),
          cardWidth: document.querySelector('.cm-article-card')?.getBoundingClientRect().width ?? 0 })`,
    )
    check(`${w}px 下无横向溢出`, ov.overflow <= 0, `溢出 ${ov.overflow}px`)
    check(`${w}px 下依然没有标签云侧栏`, !ov.sidebar)
    if (w === 390) {
      check('390px 下卡片按容器铺满（无侧栏挤压）', ov.cardWidth > 300, `实际 ${ov.cardWidth}px`)
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  /* ==================== 10. 运行时健康度 ==================== */
  console.log('\n[10. 运行时健康度]')
  const consoleErrors = cdp.consoleErrors()
  const exceptions = cdp.exceptions()

  check('无未捕获的 JS 异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

  if (consoleErrors.length) {
    console.log('  ── console.error 明细 ──')
    consoleErrors.slice(0, 6).forEach((e) => console.log('   ', e.split('\n')[0]))
  }
  if (exceptions.length) {
    console.log('  ── 未捕获异常明细 ──')
    exceptions.slice(0, 6).forEach((e) => console.log('   ', e.split('\n')[0]))
  }

  await cleanup()

  console.log(`\n========== 通过 ${pass}，失败 ${fail} ==========`)
  if (problems.length) console.log(`失败项：${problems.join(' / ')}`)
  console.log()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error('验证脚本异常：', err)
  await cleanup()
  process.exit(1)
})
