/**
 * 文章详情页 + 发布/编辑页验证（真实浏览器 CDP + 桩后端）
 * ------------------------------------------------------------------
 * 详情页验证目标：
 *   1. 详情接口正确调用，Markdown 正文渲染成 HTML（标题/代码块/表格）
 *   2. XSS 注入被清洗（正文里塞 <script> 与 onerror）
 *   3. 未登录点击点赞/收藏 → 跳登录页并带 redirect，不发请求
 *   4. 已登录点赞 → 乐观更新（数字立刻变）+ 打到正确接口；失败要回滚
 *   5. 收藏同理，成功给提示
 *   6. 自己的文章不显示「关注」，显示「编辑」
 *   7. 评论列表渲染，两层结构（一级 + 前 2 条 replies）
 *   8. 发表评论成功后重新拉列表；空内容不发请求
 *   9. 作者本人可删自己的评论，别人的评论没有删除按钮
 *  10. 详情 500 → 错误态 + 重试；评论 500 → 只有评论区错误，正文照常
 *
 * 编辑器验证目标：
 *  11. 新建模式（/articles/create）空表单，发布按钮存在
 *  12. 编辑模式（/articles/:id/edit）回显 title/content/tags（标签可多选，候选集来自 2.12）
 *  13. 3.1 / 3.2 是 multipart/form-data：Content-Type 带 boundary，不能手动设置
 *  14. 未填标题点发布 → 不发请求 + 提示
 *  15. 存草稿提交 status=0，发布提交 status=1
 *  16. 实时预览把 Markdown 渲染出来
 *  17. 有改动时离开页面被拦截
 *  18. **封面是文件字段 `file`**：非图片 / 超 5MB 被拒，合法图片有本地预览，
 *      提交时带 filename 与图片 MIME；编辑时不选文件则完全不传 file 字段
 *  19. **tagIds 重复 append 成多个同名字段**（不是数组）；编辑时已有标签必须
 *      原样带回（后端语义「不传/空 = 清空」，少传一次就丢标签）；新建不传该字段
 *  20. 编辑器会请求 /api/tag/list（2.12）拉标签候选集 —— 旧结论「文档已弃用、后端未实现」已作废
 *
 * 用法：node scripts/verify-article-detail.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'vite'

/* ==================== 桩后端 ==================== */
const STUB_PORT = 18081

const requestLog = []
const stub = {
  detailFails: false,
  commentsFail: false,
  likeFails: false,
  createFails: false,
  /** 覆盖详情里的 cover，用于测「编辑模式回显已有封面」 */
  detailCover: null,
}

/** 正文里刻意混入 XSS 向量，验证清洗链路 */
const ARTICLE_CONTENT = `## 背景

在项目中使用 Redis 时常遇到连接管理的问题。

\`\`\`js
const client = createClient({ socket: { reconnectStrategy: () => 1000 } })
console.log('连接池已就绪')
\`\`\`

### 对比

| 特性 | Redisson | Jedis |
| --- | --- | --- |
| 分布式锁 | 支持 | 需自行实现 |
| 线程安全 | 是 | 否 |

> 结论：高并发场景优先 Redisson。

<script>window.__XSS_FIRED__ = true</script>
<img src=x onerror="window.__XSS_FIRED__ = true">
`

const DETAIL = {
  id: 5001,
  title: '为什么我觉得 Redisson 比 Jedis 更好用',
  summary: '从连接管理、分布式锁与线程安全三个角度做一次对比。',
  content: ARTICLE_CONTENT,
  cover: '',
  user: { id: 1001, userName: 'zhangsan', avatar: '', intro: 'Java后端学习者' },
  viewCount: 1280,
  likeCount: 89,
  favoriteCount: 32,
  tags: [
    { id: 1, name: 'Java' },
    { id: 2, name: 'Redis' },
  ],
  isLiked: false,
  isFavorited: false,
  createTime: '2026-06-01 12:00:00',
  updateTime: '2026-06-02 08:30:00',
}

/** 当前登录用户的 id —— 桩里模拟为 1001（与作者一致），用例会切 */
const auth = { myId: 1001, loggedIn: false }

/**
 * 2.12 标签列表的候选集。
 * ⚠️ 旧桩里**故意不提供**该路由（当时的结论是「后端没实现、前端不该请求」），
 * 该结论已被推翻 —— `TagController` 于 2026-09-17 新增，实测可用（需登录，无分页）。
 * 编辑器从 T5 起会请求它做标签候选集，因此这里补上。
 */
const TAG_LIST = [
  { id: 1, name: 'Java', createTime: '2026-08-03 09:00:00' },
  { id: 2, name: 'Redis', createTime: '2026-08-03 09:00:00' },
  { id: 3, name: '数据库', createTime: '2026-08-03 09:00:00' },
]

/**
 * 3.16 的真实出参（2026-09-23 按后端 `community/vo/CommentVO.java` 与文档 v1.9 对齐）：
 *   一级评论带 `replies`（**前 2 条**）+ `replyCount`（该根回复总数）+ `replyUser`；
 *   `replies` 里的元素仍是同一结构，但 `replyCount` / `replies` 恒为 `null`。
 *
 * ⚠️ 旧 fixture 用的是 `children`，与真实后端不符 → 2 条断言必然失败（T4 报出，T4.5 更正）。
 */
const COMMENTS = [
  {
    id: 9001,
    articleId: 5001,
    user: { id: 2001, userName: 'lisi', avatar: '' },
    parentId: 0,
    content: '分布式锁那段讲得很清楚，之前踩过 Redisson 看门狗的坑。',
    createTime: '2026-06-01 13:00:00',
    replyUser: null,
    replyCount: 1,
    replies: [
      {
        id: 9002,
        articleId: 5001,
        user: { id: 1001, userName: 'zhangsan', avatar: '' },
        parentId: 9001,
        content: '看门狗默认 30 秒续期，确实容易忽略。',
        createTime: '2026-06-01 14:00:00',
        replyUser: { id: 2001, userName: 'lisi', avatar: '' },
        replyCount: null,
        replies: null,
      },
    ],
  },
  {
    id: 9003,
    articleId: 5001,
    user: { id: 1001, userName: 'zhangsan', avatar: '' },
    parentId: 0,
    content: '补充一点：Jedis 在连接池配置不当的情况下容易出现连接泄漏。',
    createTime: '2026-06-02 09:00:00',
    replyUser: null,
    replyCount: 0,
    replies: [],
  },
]

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
  })
}

const stubServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${STUB_PORT}`)
  const entry = {
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    contentType: req.headers['content-type'] ?? '',
    body: null,
    raw: null,
  }

  const json = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: 200, message: 'success', data }))
  }
  const fail = (msg = '服务器内部错误') => {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 500, message: msg, data: null }))
  }

  // body 记录：JSON 解析成对象；multipart 保留原文（用正则数同名字段）
  if (req.method === 'POST' || req.method === 'PUT') {
    const raw = await readBody(req)
    entry.raw = raw
    if (/application\/json/.test(entry.contentType)) {
      try {
        entry.body = raw ? JSON.parse(raw) : null
      } catch {
        entry.body = raw
      }
    } else {
      entry.body = raw
    }
  }
  requestLog.push(entry)

  /* ---- 用户信息 ---- */
  if (url.pathname === '/api/user/info') {
    if (!auth.loggedIn) return fail('未登录')
    return json({
      id: auth.myId,
      userName: 'zhangsan',
      avatar: '',
      intro: 'Java后端学习者',
      phone: '13800000000',
      createTime: '2026-01-01 10:00:00',
    })
  }
  if (url.pathname === '/api/notify/unread') return json(3)

  /* ---- 2.12 标签列表（需登录）：T5 起编辑器会拉它做标签候选集 ---- */
  if (url.pathname === '/api/tag/list') {
    if (!auth.loggedIn) return fail('未登录')
    const kw = url.searchParams.get('keyword')
    return json(kw ? TAG_LIST.filter((t) => t.name.includes(kw)) : TAG_LIST)
  }

  /* ---- 关注状态 ---- */
  if (url.pathname.startsWith('/api/user/follow/status/')) return json(false)
  if (url.pathname.startsWith('/api/user/follow/')) return json(null)
  if (url.pathname.startsWith('/api/user/cancelFollow/')) return json(null)

  /* ---- 点赞 / 收藏 ---- */
  if (url.pathname.match(/^\/api\/article\/\d+\/like$/) && req.method === 'POST') {
    if (stub.likeFails) return fail('点赞失败')
    return json(null)
  }
  if (url.pathname.match(/^\/api\/article\/\d+\/like$/) && req.method === 'DELETE') {
    return json(null)
  }
  if (url.pathname.match(/^\/api\/article\/\d+\/favorite$/) && req.method === 'POST') {
    return json(null)
  }
  if (url.pathname.match(/^\/api\/article\/\d+\/favorite$/) && req.method === 'DELETE') {
    return json(null)
  }

  /* ---- 评论 ---- */
  if (url.pathname === '/api/comment' && req.method === 'POST') {
    return json({ id: 9999 })
  }
  if (url.pathname.match(/^\/api\/comment\/\d+$/) && req.method === 'DELETE') {
    return json(null)
  }
  if (url.pathname.match(/^\/api\/article\/\d+\/comment$/)) {
    if (stub.commentsFail) return fail('评论服务不可用')
    return json({ total: COMMENTS.length, size: 20, current: 1, records: COMMENTS })
  }

  /* ---- 文章写操作 ---- */
  if (url.pathname === '/api/article' && req.method === 'POST') {
    if (stub.createFails) return fail('创建失败')
    /*
     * ⚠️ 这里必须返回**裸数字**，不能返回 `{ id: 7777 }`。
     *
     * 真实后端 `POST /api/article` 的响应是 `{"code":200,"data":32}` —— `data` 就是 id 本身
     * （T20 已实测并修正前端类型标注）。本桩早期写成对象，恰好「配合」了前端的
     * 错误标注（`res?.id`），于是掩盖了「创建后跳不到新文章详情」这个 bug；
     * T20 修好前端后，这条断言（`/articles/7777`）立刻由绿转红 —— **是桩过时了，不是产品退化**。
     */
    return json(7777)
  }
  if (url.pathname.match(/^\/api\/article\/\d+$/) && req.method === 'PUT') {
    return json(null)
  }

  /* ---- 文章详情 ---- */
  if (url.pathname.match(/^\/api\/article\/\d+$/) && req.method === 'GET') {
    if (stub.detailFails) return fail('文章不存在')
    return json(stub.detailCover === null ? DETAIL : { ...DETAIL, cover: stub.detailCover })
  }

  /* ---- 兜底：列表类 ---- */
  if (url.pathname.startsWith('/api/article/')) {
    return json({ total: 0, size: 10, current: 1, records: [] })
  }

  res.statusCode = 404
  res.end(JSON.stringify({ code: 404, message: 'not found', data: null }))
})
await new Promise((r) => stubServer.listen(STUB_PORT, r))

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

async function waitFor(cdp, expression, timeout = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return true
    await sleep(120)
  }
  return false
}

/**
 * 统计 multipart 原文里某个字段出现了几次。
 * 3.1 / 3.2 已改为 form-data 接口，body 不能 JSON.parse。
 */
function countField(raw, name) {
  return (raw?.match(new RegExp(`name="${name}"`, 'g')) ?? []).length
}

/** 取 multipart 里某个字段的值（字段值在空行之后、下一个 boundary 之前） */
function fieldValue(raw, name) {
  const m = raw?.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`))
  return m ? m[1] : null
}

const SNAP_DETAIL = `(() => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  return {
    url: location.pathname + location.search,
    title: document.title,
    h1: q('.cm-detail__title')?.textContent?.trim() ?? null,
    authorName: q('.cm-detail__author-name')?.textContent?.trim() ?? null,
    hasBody: !!q('.cm-detail__body'),
    bodyHtml: q('.cm-detail__body')?.innerHTML ?? '',
    h2Count: all('.cm-detail__body h2').length,
    codeBlockCount: all('.cm-detail__body pre code').length,
    tableCount: all('.cm-detail__body table').length,
    blockquoteCount: all('.cm-detail__body blockquote').length,
    xssFired: !!window.__XSS_FIRED__,
    scriptInBody: all('.cm-detail__body script').length,
    tags: all('.cm-detail__tag').map(e => e.textContent.trim()),
    metrics: all('.cm-detail__metric').map(e => ({
      label: e.querySelector('.cm-detail__metric-label')?.textContent?.trim(),
      value: e.querySelector('.cm-detail__metric-value')?.textContent?.trim(),
    })),
    likeBtn: q('.cm-detail__actions button.cm-detail__action'),
    likeText: q('.cm-detail__actions button.cm-detail__action')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    likeActive: !!q('.cm-detail__action.is-active'),
    hasFollow: all('.cm-detail__actions ~ * button, .cm-detail__meta button').some(b => /关注/.test(b.textContent)),
    hasEdit: all('.cm-detail__meta button').some(b => /编辑/.test(b.textContent)),
    commentItems: all('.cm-detail__comment').length,
    replyItems: all('.cm-detail__reply').length,
    commentTexts: all('.cm-detail__comment-text').map(e => e.textContent.trim()),
    deleteOpCount: all('.cm-detail__comment-op--danger').length,
    commentCount: q('.cm-detail__comments-count')?.textContent?.trim() ?? null,
    hasSkeleton: !!q('.cm-skeleton__row'),
    hasError: !!q('.cm-error'),
    hasEmpty: !!q('.cm-empty'),
    aiButtons: all('.cm-detail__ai-btn').map(e => e.textContent.trim()),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})()`

const SNAP_EDITOR = `(() => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  const titleInput = q('.cm-editor__title-input input')
  const textarea = q('.cm-editor__textarea textarea')
  return {
    url: location.pathname,
    h1: q('.cm-editor__title')?.textContent?.trim() ?? null,
    titleValue: titleInput?.value ?? null,
    contentValue: textarea?.value ?? null,
    selectedTags: all('.cm-editor__tags .el-tag').map(e => e.textContent.trim()),
    hasPreview: !!q('.cm-editor__preview-body .cm-markdown'),
    previewH2: all('.cm-editor__preview-body h2').length,
    previewHtml: q('.cm-editor__preview-body')?.innerHTML ?? '',
    dirtyBadge: !!q('.cm-editor__dirty'),
    publishBtn: all('.cm-editor__head-actions .el-button').map(e => e.textContent.trim()),
    coverPreviewSrc: q('.cm-editor__cover-preview img')?.getAttribute('src') ?? null,
    coverPlaceholder: !!q('.cm-editor__cover-placeholder'),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})()`

/* ==================== 主流程 ==================== */
let chromeProc = null
let viteServer = null
let profileDir = null
let coverPath = null
let bigCoverPath = null
let txtPath = null

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
    /* Windows 上可能仍被占用 */
  }
}

async function main() {
  const browserPath = await findBrowser()
  if (!browserPath) {
    console.log('未找到 Chrome/Edge，跳过浏览器验证')
    process.exit(0)
  }
  console.log(`浏览器：${browserPath}`)

  const PORT = 5197
  viteServer = await createServer({
    server: {
      port: PORT,
      strictPort: true,
      proxy: { '/api': { target: `http://localhost:${STUB_PORT}`, changeOrigin: true } },
    },
    logLevel: 'error',
  })
  await viteServer.listen()
  const base = `http://localhost:${PORT}`
  console.log(`Vite：${base}`)

  profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-chrome-detail-'))

  // 封面校验用的三种文件：合法图片 / 类型不对 / 体积超限
  coverPath = path.join(profileDir, 'cover.png')
  await fs.writeFile(
    coverPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  bigCoverPath = path.join(profileDir, 'too-big.png')
  await fs.writeFile(bigCoverPath, Buffer.alloc(6 * 1024 * 1024, 1))
  txtPath = path.join(profileDir, 'note.txt')
  await fs.writeFile(txtPath, 'not an image')

  const debugPort = 9335

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
      '--window-size=1440,1000',
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
  await cdp.send('DOM.enable')

  const grantClipboard = async () => {
    try {
      await cdp.send('Browser.grantPermissions', {
        origin: base,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      })
    } catch {
      /* 部分内核不支持，忽略 */
    }
  }
  await grantClipboard()

  /* ==================== 1. 未登录 · 详情渲染 ==================== */
  console.log('[1. 详情页渲染（未登录）]')
  auth.loggedIn = false
  // 必须先导航到同源页面才能访问 localStorage（about:blank 会抛 SecurityError）
  await cdp.send('Page.navigate', { url: base + '/articles/5001' })
  await sleep(1500)
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  requestLog.length = 0
  await cdp.send('Page.navigate', { url: base + '/articles/5001' })
  await sleep(2400)

  let d = await cdp.evaluate(SNAP_DETAIL)

  check('路由停在 /articles/5001', d.url === '/articles/5001', `实际 ${d.url}`)
  check('标题渲染正确', d.h1 === DETAIL.title, `实际 ${d.h1}`)
  check('作者名渲染', d.authorName === 'zhangsan', `实际 ${d.authorName}`)
  check('正文容器存在', d.hasBody)
  check('Markdown h2 渲染', d.h2Count >= 1, `实际 ${d.h2Count}`)
  check('代码块高亮渲染', d.codeBlockCount >= 1, `实际 ${d.codeBlockCount}`)
  check('表格渲染', d.tableCount === 1, `实际 ${d.tableCount}`)
  check('引用块渲染', d.blockquoteCount === 1, `实际 ${d.blockquoteCount}`)
  check('标签渲染', JSON.stringify(d.tags) === JSON.stringify(['Java', 'Redis']), `实际 ${JSON.stringify(d.tags)}`)
  check('未进入错误态', !d.hasError)
  check('未卡在骨架屏', !d.hasSkeleton)

  /* ---- XSS 清洗（关键安全项） ---- */
  console.log('\n[2. XSS 清洗]')
  check('正文中的 <script> 未被注入到 DOM', d.scriptInBody === 0, `实际 ${d.scriptInBody} 个`)
  check('XSS 载荷未执行', !d.xssFired, 'window.__XSS_FIRED__ 被置位说明清洗失败')
  check(
    '正文 HTML 里不含 <script 字样',
    !/<script/i.test(d.bodyHtml),
    'DOMPurify 应把 script 标签整个移除',
  )
  check(
    'img 的 onerror 属性被移除',
    !/onerror/i.test(d.bodyHtml),
    '内联事件处理器必须被清洗掉',
  )
  check('保留正常的内联代码/文本内容', d.bodyHtml.includes('Redisson'), '清洗不能把正文清空')

  /* ---- 指标条 ---- */
  console.log('\n[3. 指标条与评论数来源]')
  const metricLabels = d.metrics.map((m) => m.label)
  check(
    '四项指标：浏览/点赞/收藏/评论',
    JSON.stringify(metricLabels) === JSON.stringify(['浏览', '点赞', '收藏', '评论']),
    `实际 ${JSON.stringify(metricLabels)}`,
  )
  check(
    '评论数取自评论接口 total 而非详情字段',
    d.metrics.find((m) => m.label === '评论')?.value === String(COMMENTS.length),
    `实际 ${d.metrics.find((m) => m.label === '评论')?.value}`,
  )

  /* ---- 未登录交互 ---- */
  console.log('\n[4. 未登录点击点赞/收藏]')
  requestLog.length = 0
  await cdp.evaluate(`document.querySelector('.cm-detail__actions button.cm-detail__action').click()`)
  await waitFor(cdp, `location.pathname === '/login'`)
  const guestLike = await cdp.evaluate(`location.pathname + location.search`)

  check('未登录点赞 → 跳登录页', guestLike.startsWith('/login'), `实际 ${guestLike}`)
  check('带上 redirect 参数', guestLike.includes('redirect='), `实际 ${guestLike}`)
  check(
    '未登录不发点赞请求',
    !requestLog.some((r) => /\/like/.test(r.path)),
    `实际 ${JSON.stringify(requestLog.map((r) => r.path))}`,
  )

  /* ==================== 5. 已登录 · 点赞与收藏 ==================== */
  console.log('\n[5. 已登录点赞（乐观更新）]')
  auth.loggedIn = true
  // 作者设为别人，便于验证「关注按钮」
  auth.myId = 2002

  await cdp.evaluate(`localStorage.setItem('codemind_token', 'stub-token')`)
  await cdp.send('Page.navigate', { url: base + '/articles/5001' })
  await sleep(2400)
  d = await cdp.evaluate(SNAP_DETAIL)

  const beforeLike = d.metrics.find((m) => m.label === '点赞')?.value
  requestLog.length = 0
  await cdp.evaluate(`document.querySelector('.cm-detail__actions button.cm-detail__action').click()`)
  await sleep(900)
  d = await cdp.evaluate(SNAP_DETAIL)

  check(
    '点赞请求已发出（POST /api/article/5001/like）',
    requestLog.some((r) => r.path === '/api/article/5001/like' && r.method === 'POST'),
    `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`,
  )
  check('点赞按钮进入激活态', d.likeActive)
  check(
    '点赞数 +1',
    Number(d.metrics.find((m) => m.label === '点赞')?.value) === Number(beforeLike) + 1,
    `${beforeLike} → ${d.metrics.find((m) => m.label === '点赞')?.value}`,
  )
  check('按钮文案变为「已点赞」', (d.likeText ?? '').includes('已点赞'), `实际 ${d.likeText}`)

  /* ---- 再点一次取消 ---- */
  requestLog.length = 0
  await cdp.evaluate(`document.querySelector('.cm-detail__actions button.cm-detail__action').click()`)
  await sleep(900)
  d = await cdp.evaluate(SNAP_DETAIL)
  check(
    '取消点赞走 DELETE',
    requestLog.some((r) => r.path === '/api/article/5001/like' && r.method === 'DELETE'),
    `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`,
  )
  check('点赞态回到未激活', !d.likeActive)
  check('点赞数回到原值', d.metrics.find((m) => m.label === '点赞')?.value === beforeLike)

  /* ---- 点赞失败要回滚 ---- */
  console.log('\n[6. 点赞失败必须回滚]')
  stub.likeFails = true
  const beforeFail = (await cdp.evaluate(SNAP_DETAIL)).metrics.find((m) => m.label === '点赞')?.value
  await cdp.evaluate(`document.querySelector('.cm-detail__actions button.cm-detail__action').click()`)
  await sleep(1000)
  d = await cdp.evaluate(SNAP_DETAIL)
  check('失败后未停留在「已点赞」', !d.likeActive, '乐观更新必须回滚')
  check(
    '失败后计数还原',
    d.metrics.find((m) => m.label === '点赞')?.value === beforeFail,
    `实际 ${d.metrics.find((m) => m.label === '点赞')?.value}`,
  )
  stub.likeFails = false

  /* ---- 收藏 ---- */
  console.log('\n[7. 收藏]')
  requestLog.length = 0
  await cdp.evaluate(`document.querySelectorAll('.cm-detail__actions button.cm-detail__action')[1].click()`)
  await sleep(900)
  d = await cdp.evaluate(SNAP_DETAIL)
  check(
    '收藏请求已发出',
    requestLog.some((r) => r.path === '/api/article/5001/favorite' && r.method === 'POST'),
    `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`,
  )
  check(
    '收藏数 +1（原 32 → 33）',
    d.metrics.find((m) => m.label === '收藏')?.value === '33',
    `实际 ${d.metrics.find((m) => m.label === '收藏')?.value}`,
  )

  /* ==================== 8. 关注 / 编辑按钮 ==================== */
  console.log('\n[8. 作者身份决定按钮]')
  check('非作者显示「关注」按钮', d.hasFollow, `按钮：${JSON.stringify(d.publishBtn ?? [])}`)
  check('非作者不显示「编辑」', !d.hasEdit)

  requestLog.length = 0
  await cdp.send('Page.navigate', { url: base + '/articles/5001' })
  await sleep(2400)
  d = await cdp.evaluate(SNAP_DETAIL)
  check(
    '关注状态接口被调用',
    requestLog.some((r) => r.path === '/api/user/follow/status/1001'),
    `实际 ${JSON.stringify(requestLog.map((r) => r.path))}`,
  )

  /* ---- 切换为作者本人 ---- */
  auth.myId = 1001
  await cdp.send('Page.navigate', { url: base + '/articles/5001' })
  await sleep(2400)
  d = await cdp.evaluate(SNAP_DETAIL)
  check('作者本人显示「编辑」按钮', d.hasEdit)
  check('作者本人不显示「关注」', !d.hasFollow)

  /* ==================== 9. 评论区 ==================== */
  console.log('\n[9. 评论区]')
  check('渲染 2 条一级评论', d.commentItems === 2, `实际 ${d.commentItems}`)
  check('渲染 1 条二级回复', d.replyItems === 1, `实际 ${d.replyItems}`)
  check('评论数徽标显示 total', d.commentCount === String(COMMENTS.length), `实际 ${d.commentCount}`)
  check(
    '评论内容正确渲染',
    d.commentTexts.some((t) => t.includes('看门狗')),
    `实际 ${JSON.stringify(d.commentTexts)}`,
  )
  check(
    '只对自己的评论显示删除按钮（2 条：自己的一级评论 + 自己的回复）',
    d.deleteOpCount === 2,
    `实际 ${d.deleteOpCount} 个（lisi 那条与它下面的回复都不该出现删除）`,
  )

  /* ---- 发表评论 ---- */
  console.log('\n[10. 发表评论]')
  requestLog.length = 0
  // 空内容点发送：不应发请求
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-detail__composer-actions .el-button')]
    btns[btns.length - 1].click()
    return true
  })()`)
  await sleep(700)
  check(
    '空评论不发请求',
    !requestLog.some((r) => r.path === '/api/comment'),
    `实际 ${JSON.stringify(requestLog.map((r) => r.path))}`,
  )

  // 填内容再发
  await cdp.evaluate(`(() => {
    const ta = document.querySelector('.cm-detail__composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '这是一条自动化验证插入的评论')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  requestLog.length = 0
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-detail__composer-actions .el-button')]
    btns[btns.length - 1].click()
    return true
  })()`)
  await sleep(1200)
  const commentPost = requestLog.find((r) => r.path === '/api/comment' && r.method === 'POST')
  check('发表评论请求已发出', !!commentPost, `实际 ${JSON.stringify(requestLog.map((r) => r.path))}`)
  check(
    '评论体含 articleId / content / parentId=0',
    commentPost?.body?.articleId === 5001 &&
      commentPost?.body?.content === '这是一条自动化验证插入的评论' &&
      commentPost?.body?.parentId === 0,
    `实际 ${JSON.stringify(commentPost?.body)}`,
  )
  check('发完重新拉取评论列表', requestLog.some((r) => /\/comment$/.test(r.path) && r.method === 'GET'))

  /* ---- 回复评论 ---- */
  console.log('\n[11. 回复评论]')
  await cdp.evaluate(`document.querySelectorAll('.cm-detail__comment-op')[0].click()`)
  await sleep(600)
  const hasReplyBox = await cdp.evaluate(`!!document.querySelector('.cm-detail__reply-box')`)
  check('点「回复」展开内联输入框', hasReplyBox)

  await cdp.evaluate(`(() => {
    const ta = document.querySelector('.cm-detail__reply-box textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '回复内容验证')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  requestLog.length = 0
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-detail__reply-actions .el-button')]
    btns[btns.length - 1].click()
    return true
  })()`)
  await sleep(1200)
  const replyPost = requestLog.find((r) => r.path === '/api/comment' && r.method === 'POST')
  check('回复请求已发出', !!replyPost, `实际 ${JSON.stringify(requestLog.map((r) => r.path))}`)
  check(
    '回复带正确的 parentId',
    replyPost?.body?.parentId === 9001,
    `实际 parentId=${replyPost?.body?.parentId}`,
  )

  /* ==================== 12. AI 面板 ==================== */
  console.log('\n[12. AI 三个动作入口]')
  d = await cdp.evaluate(SNAP_DETAIL)
  check(
    '三个 AI 按钮：AI总结 / 知识点提取 / 生成面试题',
    JSON.stringify(d.aiButtons) === JSON.stringify(['AI 总结', '知识点提取', '生成面试题']),
    `实际 ${JSON.stringify(d.aiButtons)}`,
  )

  /* ==================== 13. 三态 ==================== */
  console.log('\n[13. 错误态与局部降级]')
  stub.commentsFail = true
  await cdp.send('Page.navigate', { url: base + '/articles/5001' })
  await sleep(2400)
  d = await cdp.evaluate(SNAP_DETAIL)
  check('评论接口挂掉时正文仍正常渲染', d.h1 === DETAIL.title && d.hasBody, `h1=${d.h1}`)
  check('评论区单独显示错误态', d.hasError, '应只有评论区块报错')
  check('评论错误不影响标签与指标', d.tags.length === 2 && d.metrics.length === 4)

  // 恢复评论，改为详情挂掉
  stub.commentsFail = false
  stub.detailFails = true
  await cdp.send('Page.navigate', { url: base + '/articles/5001' })
  await sleep(2400)
  d = await cdp.evaluate(SNAP_DETAIL)
  check('详情接口挂掉 → 整页错误态', d.hasError)
  check('错误态提供重试', await cdp.evaluate(`!!document.querySelector('.cm-error__actions .el-button')`))

  stub.detailFails = false
  // 明确点「重新加载」，而不是第一个按钮（第一个是"返回列表"）
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-error__actions .el-button')]
    const retry = btns.find(b => b.textContent.includes('重新加载'))
    retry.click()
    return true
  })()`)
  await waitFor(cdp, `document.querySelector('.cm-detail__title')`)
  d = await cdp.evaluate(SNAP_DETAIL)
  check('点重试后恢复正常', d.h1 === DETAIL.title, `实际 ${d.h1}`)

  /* ==================== 14. 编辑器 · 新建 ==================== */
  console.log('\n[14. 编辑器（新建模式）]')
  await cdp.send('Page.navigate', { url: base + '/articles/create' })
  await sleep(2400)
  let e = await cdp.evaluate(SNAP_EDITOR)

  check('停在 /articles/create', e.url === '/articles/create', `实际 ${e.url}`)
  check('标题为「写文章」', e.h1 === '写文章', `实际 ${e.h1}`)
  check('标题输入为空', e.titleValue === '', `实际 ${JSON.stringify(e.titleValue)}`)
  check(
    '按钮为「存为草稿 / 发布文章」',
    JSON.stringify(e.publishBtn) === JSON.stringify(['存为草稿', '发布文章']),
    `实际 ${JSON.stringify(e.publishBtn)}`,
  )
  check('无「未保存」标记（还没动过）', !e.dirtyBadge)

  /* ---- 校验：空标题不发请求 ---- */
  requestLog.length = 0
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-editor__head-actions .el-button')]
    btns[btns.length - 1].click()
    return true
  })()`)
  await sleep(900)
  check(
    '空标题点发布不发请求',
    !requestLog.some((r) => r.path === '/api/article' && r.method === 'POST'),
    `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`,
  )
  check('表单校验提示出现', await cdp.evaluate(`!!document.querySelector('.el-form-item__error')`))

  /* ---- 实时预览 ---- */
  console.log('\n[15. 实时预览]')
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.cm-editor__title-input input')
    const tsetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    tsetter.call(input, '验证用标题')
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const ta = document.querySelector('.cm-editor__textarea textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '## 预览标题\\n\\n这是一段**加粗**的正文。')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(700)
  e = await cdp.evaluate(SNAP_EDITOR)
  check('预览区渲染出内容', e.hasPreview, '左侧输入后右侧应实时渲染')
  check('预览中 h2 已生成', e.previewH2 >= 1, `实际 ${e.previewH2}`)
  check('预览保留了 <strong>', /<strong>/i.test(e.previewHtml), 'Basic Markdown 语法要生效')
  check('出现「未保存」标记', e.dirtyBadge)

  /* ---- 发布 ---- */
  console.log('\n[16. 发布提交（multipart）]')
  requestLog.length = 0
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-editor__head-actions .el-button')]
    btns[btns.length - 1].click()
    return true
  })()`)
  await sleep(1500)
  const createReq = requestLog.find((r) => r.path === '/api/article' && r.method === 'POST')
  check('发布请求已发出', !!createReq, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check(
    'Content-Type 是 multipart/form-data 且带 boundary',
    /^multipart\/form-data;\s*boundary=/.test(createReq?.contentType ?? ''),
    `实际 ${createReq?.contentType}`,
  )
  check(
    'boundary 由浏览器生成（没有手动覆盖 Content-Type）',
    /boundary=[\w-]{10,}/.test(createReq?.contentType ?? ''),
    `实际 ${createReq?.contentType}`,
  )
  check('status = 1（发布）', fieldValue(createReq?.raw, 'status') === '1', `实际 ${fieldValue(createReq?.raw, 'status')}`)
  check('title 正确提交', fieldValue(createReq?.raw, 'title') === '验证用标题', `实际 ${fieldValue(createReq?.raw, 'title')}`)
  check(
    'content 正确提交（含 Markdown）',
    (fieldValue(createReq?.raw, 'content') ?? '').includes('**加粗**'),
    `实际 ${JSON.stringify((fieldValue(createReq?.raw, 'content') ?? '').slice(0, 40))}`,
  )
  check(
    '未选标签时 tagIds 字段不出现（不是空数组字面量）',
    countField(createReq?.raw, 'tagIds') === 0,
    `实际 ${countField(createReq?.raw, 'tagIds')} 次`,
  )
  check(
    '未选封面时 file 字段不出现',
    countField(createReq?.raw, 'file') === 0,
    `实际 ${countField(createReq?.raw, 'file')} 次`,
  )
  await sleep(600)
  const afterCreate = await cdp.evaluate(`location.pathname`)
  check('创建后跳到详情页（用返回的 id）', afterCreate === '/articles/7777', `实际 ${afterCreate}`)

  /* ==================== 17. 编辑器 · 编辑模式 ==================== */
  console.log('\n[17. 编辑器（编辑模式回显）]')
  await cdp.send('Page.navigate', { url: base + '/articles/5001/edit' })
  await sleep(2400)
  e = await cdp.evaluate(SNAP_EDITOR)

  check('停在 /articles/5001/edit', e.url === '/articles/5001/edit', `实际 ${e.url}`)
  check('标题为「编辑文章」', e.h1 === '编辑文章', `实际 ${e.h1}`)
  check('标题已回显', e.titleValue === DETAIL.title, `实际 ${JSON.stringify(e.titleValue)}`)
  check(
    '正文已回显（含 Markdown 源码）',
    (e.contentValue ?? '').includes('## 背景'),
    `实际 ${JSON.stringify((e.contentValue ?? '').slice(0, 40))}`,
  )
  check(
    '标签已回显 2 个（多选控件里选中 2 个）',
    JSON.stringify(e.selectedTags) === JSON.stringify(['Java', 'Redis']),
    `实际 ${JSON.stringify(e.selectedTags)}`,
  )
  // T5 更新：标签多选已实现，候选集来自 2.12（实测可用）
  check(
    '存在标签多选控件',
    await cdp.evaluate(`!!document.querySelector('.cm-editor__tags .el-select')`),
  )
  check(
    '整页请求了 /api/tag/list 拉候选集（旧结论「不该请求」已作废）',
    requestLog.some((r) => r.path === '/api/tag/list'),
    `实际请求：${requestLog.map((r) => r.path).join(', ')}`,
  )
  check(
    '按钮为「保存草稿 / 更新文章」',
    JSON.stringify(e.publishBtn) === JSON.stringify(['保存草稿', '更新文章']),
    `实际 ${JSON.stringify(e.publishBtn)}`,
  )
  check('刚载入时不算未保存', !e.dirtyBadge)

  /* ---- 编辑提交：已有标签必须原样带回 ---- */
  console.log('\n[18. 编辑提交 —— 标签多选但必须原样提交（multipart）]')
  const tagsBefore = await cdp.evaluate(
    `document.querySelectorAll('.cm-editor__tags .el-tag').length`,
  )
  check('提交前标签仍为 2 个', tagsBefore === 2, `实际 ${tagsBefore} 个`)

  requestLog.length = 0
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-editor__head-actions .el-button')]
    btns[btns.length - 1].click()
    return true
  })()`)
  await sleep(1500)
  const updateReq = requestLog.find((r) => r.path === '/api/article/5001' && r.method === 'PUT')
  check('更新请求已发出（PUT）', !!updateReq, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check(
    '更新也是 multipart/form-data（带 boundary）',
    /^multipart\/form-data;\s*boundary=/.test(updateReq?.contentType ?? ''),
    `实际 ${updateReq?.contentType}`,
  )
  check(
    '**已有标签原样提交**：tagIds 重复 append 2 次（后端不传即清空，漏传就丢标签）',
    countField(updateReq?.raw, 'tagIds') === 2,
    `实际 ${countField(updateReq?.raw, 'tagIds')} 次`,
  )
  check(
    'tagIds 的值是真实标签 id（1 / 2），不是 null',
    /name="tagIds"\r?\n\r?\n1\r?\n/.test(updateReq?.raw ?? '') &&
      /name="tagIds"\r?\n\r?\n2\r?\n/.test(updateReq?.raw ?? ''),
    `实际 raw 片段：${JSON.stringify((updateReq?.raw ?? '').match(/name="tagIds"[\s\S]{0,12}/g))}`,
  )
  check(
    'tagIds 不出现数组字面量',
    !/name="tagIds"\r?\n\r?\n\[/.test(updateReq?.raw ?? ''),
    'FormData 里重复 append 才是正确做法',
  )
  check('status = 1（更新即发布态）', fieldValue(updateReq?.raw, 'status') === '1', `实际 ${fieldValue(updateReq?.raw, 'status')}`)
  check(
    '编辑时未选新封面 → 不传 file 字段（保留原封面）',
    countField(updateReq?.raw, 'file') === 0,
    `实际 ${countField(updateReq?.raw, 'file')} 次`,
  )

  /* ==================== 18.5 编辑器 · 封面上传 ==================== */
  console.log('\n[18.5 编辑器 · 封面上传（file 字段）]')
  await cdp.send('Page.navigate', { url: base + '/articles/create' })
  await sleep(2400)

  /** 用 CDP 把文件塞进原生 file input（JS 无法直接给 input.files 赋值） */
  async function upload(selector, filePath) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId })
    await sleep(400)
    // setFileInputFiles 一般会派发 change；保险起见补一次（重复触发无副作用）
    if (!(await cdp.evaluate(`!!document.querySelector('.cm-editor__cover-preview img')`))) {
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new Event('change', { bubbles: true }))`,
      )
      await sleep(300)
    }
  }

  await cdp.evaluate(`(() => {
    const set = (el, v) => {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(document.querySelector('.cm-editor__title-input input'), '带封面的文章')
    set(document.querySelector('.cm-editor__textarea textarea'), '# 正文\\n\\n验证封面上传。')
    return true
  })()`)
  await sleep(500)
  let e2 = await cdp.evaluate(SNAP_EDITOR)
  check('新建模式初始没有封面（显示占位）', e2.coverPlaceholder, `实际 placeholder=${e2.coverPlaceholder}`)

  await upload('.cm-editor__file-input', txtPath)
  e2 = await cdp.evaluate(SNAP_EDITOR)
  check('非图片文件被拒', e2.coverPreviewSrc === null, `实际 ${e2.coverPreviewSrc}`)
  check(
    '提示「封面只支持图片文件」',
    await cdp.evaluate(
      `[...document.querySelectorAll('.el-message--error')].some(m => /只支持图片文件/.test(m.textContent))`,
    ),
  )

  await upload('.cm-editor__file-input', bigCoverPath)
  e2 = await cdp.evaluate(SNAP_EDITOR)
  check('超过 5MB 的图片被拒', e2.coverPreviewSrc === null, `实际 ${e2.coverPreviewSrc}`)
  check(
    '提示「不能超过 5 MB」',
    await cdp.evaluate(
      `[...document.querySelectorAll('.el-message--error')].some(m => /5 MB/.test(m.textContent))`,
    ),
  )

  await upload('.cm-editor__file-input', coverPath)
  e2 = await cdp.evaluate(SNAP_EDITOR)
  check(
    '合法图片生成本地预览（blob: URL）',
    (e2.coverPreviewSrc ?? '').startsWith('blob:'),
    `实际 ${e2.coverPreviewSrc}`,
  )
  check('选中文件后出现「撤销选择」', await cdp.evaluate(
    `[...document.querySelectorAll('.cm-editor__cover-ops .el-button')].some(b => /撤销选择/.test(b.textContent))`,
  ))

  requestLog.length = 0
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-editor__head-actions .el-button')]
    btns[btns.length - 1].click()
    return true
  })()`)
  await sleep(1600)
  const coverReq = requestLog.find((r) => r.path === '/api/article' && r.method === 'POST')
  check('带封面发布请求已发出', !!coverReq, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check('带上了 file 字段', countField(coverReq?.raw, 'file') === 1, `实际 ${countField(coverReq?.raw, 'file')} 次`)
  check(
    'file 字段带文件名与图片 MIME',
    /filename="cover\.png"/.test(coverReq?.raw ?? '') &&
      /Content-Type: image\/png/.test(coverReq?.raw ?? ''),
    'multipart 里必须带 filename 与 part 的 Content-Type',
  )
  check('status = 1', fieldValue(coverReq?.raw, 'status') === '1', `实际 ${fieldValue(coverReq?.raw, 'status')}`)

  /* ---- 编辑模式：已有封面不能假装删掉 ---- */
  console.log('\n[18.6 编辑模式 · 已有封面的回显与「不能删除」]')
  stub.detailCover = 'https://example.com/old-cover.png'
  await cdp.send('Page.navigate', { url: base + '/articles/5001/edit' })
  await sleep(2400)
  e2 = await cdp.evaluate(SNAP_EDITOR)
  check('编辑模式回显已有封面', e2.coverPreviewSrc === stub.detailCover, `实际 ${e2.coverPreviewSrc}`)
  check(
    '已有封面时**不提供**删除按钮（接口没有删除封面的能力）',
    !(await cdp.evaluate(
      `[...document.querySelectorAll('.cm-editor__cover-ops .el-button')].some(b => /撤销选择|移除封面/.test(b.textContent))`,
    )),
    '点了删不掉却让界面看起来删掉了，属于欺骗用户',
  )
  check(
    '改为如实提示「接口不支持删除已有封面」',
    await cdp.evaluate(
      `/接口不支持删除已有封面/.test(document.querySelector('.cm-editor__cover-hint')?.textContent ?? '')`,
    ),
    `实际 ${await cdp.evaluate(`document.querySelector('.cm-editor__cover-hint')?.textContent?.trim()`)}`,
  )

  // 选新图 → 出现撤销；撤销后应把原封面显示回来，而不是留空
  await upload('.cm-editor__file-input', coverPath)
  e2 = await cdp.evaluate(SNAP_EDITOR)
  check('选新图后预览变成 blob', (e2.coverPreviewSrc ?? '').startsWith('blob:'), `实际 ${e2.coverPreviewSrc}`)
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.cm-editor__cover-ops .el-button')]
      .find(x => /撤销选择/.test(x.textContent))
    b.click()
    return true
  })()`)
  await sleep(500)
  e2 = await cdp.evaluate(SNAP_EDITOR)
  check(
    '撤销选择后把原封面显示回来（不是留空）',
    e2.coverPreviewSrc === stub.detailCover,
    `实际 ${e2.coverPreviewSrc}`,
  )
  stub.detailCover = null

  /* ---- 存草稿提交 status=0 ---- */
  console.log('\n[18.7 编辑器 · 存草稿 status=0]')
  await cdp.send('Page.navigate', { url: base + '/articles/create' })
  await sleep(2200)
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.cm-editor__title-input input')
    const tsetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    tsetter.call(input, '草稿验证')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const ta = document.querySelector('.cm-editor__textarea textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '草稿正文')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(500)
  requestLog.length = 0
  await cdp.evaluate(`document.querySelectorAll('.cm-editor__head-actions .el-button')[0].click()`)
  await sleep(1500)
  const draftReq = requestLog.find((r) => r.path === '/api/article' && r.method === 'POST')
  check('存草稿请求已发出', !!draftReq, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check(
    'status = 0（草稿）',
    fieldValue(draftReq?.raw, 'status') === '0',
    `实际 ${fieldValue(draftReq?.raw, 'status')}`,
  )

  /* ==================== 19. 响应式 ==================== */
  console.log('\n[19. 响应式与横向溢出]')
  await cdp.send('Page.navigate', { url: base + '/articles/5001' })
  await sleep(2400)
  for (const w of [390, 768, 1440]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(500)
    const ov = await cdp.evaluate(
      `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
    )
    check(`${w}px 下详情页无横向溢出`, ov <= 0, `溢出 ${ov}px`)
  }

  await cdp.send('Page.navigate', { url: base + '/articles/create' })
  await sleep(2400)
  for (const w of [390, 1024, 1440]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(500)
    const info = await cdp.evaluate(
      `({ ov: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cols: document.querySelector('.cm-editor__panes') ? getComputedStyle(document.querySelector('.cm-editor__panes')).gridTemplateColumns : null })`,
    )
    check(`${w}px 下编辑器无横向溢出`, info.ov <= 0, `溢出 ${info.ov}px`)
    if (w === 390) {
      check('390px 下编辑器退化为单栏', (info.cols ?? '').split(' ').length === 1, `实际 ${info.cols}`)
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  /* ==================== 20. 运行时健康度 ==================== */
  console.log('\n[20. 运行时健康度]')
  const consoleErrors = cdp.consoleErrors().filter((e) => !/favicon/i.test(e))
  const exceptions = cdp.exceptions()

  check('无未捕获的 JS 异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

  if (exceptions.length) {
    console.log('  ── 未捕获异常 ──')
    exceptions.slice(0, 6).forEach((x) => console.log('   ', x.split('\n')[0]))
  }
  if (consoleErrors.length) {
    console.log('  ── console.error ──')
    consoleErrors.slice(0, 6).forEach((x) => console.log('   ', x.split('\n')[0]))
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
