/**
 * 笔记模块端到端验证（真实浏览器 CDP + 桩后端）
 * ------------------------------------------------------------------
 * 覆盖四张页面 / 22 组用例：
 *
 * 【笔记列表 /notes】
 *   1. 未登录访问被守卫拦到登录页，且带上 redirect
 *   2. 列表渲染：标题 / 分类名 / 公开私密标记 / 草稿标记 / 字数
 *   3. 筛选条件全部落在 URL 上，且原样带到请求参数
 *   4. 关键词搜索 300ms 防抖：连打三个字符只发一次请求
 *   5. 过期响应丢弃：慢的分类请求先发、快的后发，最终必须显示后发的结果
 *   6. 可见性切换是乐观更新（数字/标记立刻变），失败回滚
 *   7. 删除要二次确认；删掉当前页最后一条时自动退回上一页
 *   8. 空态 / 错误态 + 重试
 *
 * 【笔记详情 /notes/:id】
 *   9. Markdown 正文渲染（标题/代码块/表格）+ XSS 清洗
 *  10. 作者视角有可见性切换与编辑入口，非作者没有
 *  11. 可见性切换乐观更新 + 失败回滚
 *  12. 草稿 / 私密提示（2.4 确实返回 status 与 visibility，可以可靠判断）
 *  13. 详情页错误态按 ApiError.code 分诊：404 不存在 / 403 无权（私密或草稿，文案中性）/ 未知码兜底
 *
 * 【笔记编辑器 /notes/create 与 /notes/:id/edit】
 *  14. 新建模式空表单；标题/正文/分类缺失时不发请求
 *  15. 一个分类都没有时提前阻断（categoryId 必填），并给出「去创建分类」出路
 *  16. 编辑模式回显，提交走 multipart/form-data（带 boundary）
 *  17. tagIds 必须重复 append 成多个同名字段，不能传数组
 *  18. 封面：类型/大小校验、本地预览、编辑时不选文件则不传 file 字段
 *  19. 「未保存」标记实时生效；有改动离开被拦；保存成功后离开不再被拦
 *
 * 【分类管理 /categories】
 *  20. 多级树渲染与缩进、折叠展开、概览统计
 *  21. 新建顶级 / 新建子分类 / 从下拉选父分类，parentId 必须正确
 *  22. 重命名与排序上移下移（sort 值越大越靠前，必须真的更大/更小）
 *  23. 删除的后果提示（笔记分类置空；有子分类时说明文档未定义）
 *
 * 用法：node scripts/verify-note.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'vite'

/* ==================== 桩后端 ==================== */
const STUB_PORT = 18082

const requestLog = []

/** 1x1 透明 PNG，用于验证封面上传链路 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function initialTree() {
  return [
    {
      id: 1,
      name: 'Java',
      sort: 2,
      children: [
        { id: 5, name: 'Spring', sort: 1, children: [] },
        { id: 6, name: 'JVM', sort: 0, children: [] },
      ],
    },
    {
      id: 2,
      name: 'Redis',
      sort: 1,
      children: [{ id: 7, name: '缓存', sort: 0, children: [] }],
    },
    { id: 3, name: '前端', sort: 0, children: [] },
  ]
}

/** 12 篇笔记 → 第一页 10 条、第二页 2 条，方便测翻页回退 */
function initialNotes() {
  const base = [
    {
      id: 7001,
      title: 'Redisson 看门狗机制笔记',
      summary: '看门狗如何续期，以及锁释放的正确姿势。',
      cover: '',
      visibility: 1,
      status: 1,
      wordCount: 1200,
      categoryId: 5,
      categoryName: 'Spring',
      tags: [
        { id: 1, name: 'Java' },
        { id: 2, name: 'Redis' },
      ],
      createTime: '2026-06-01 10:00:00',
      updateTime: '2026-06-10 09:00:00',
    },
    {
      id: 7002,
      title: 'JVM 内存区域与 GC 调优',
      summary: '堆、栈、方法区，以及常用 GC 参数。',
      cover: 'https://example.com/cover-2.png',
      visibility: 0,
      status: 1,
      wordCount: 2600,
      categoryId: 6,
      categoryName: 'JVM',
      tags: [{ id: 1, name: 'Java' }],
      createTime: '2026-06-02 10:00:00',
      updateTime: '2026-06-11 09:00:00',
    },
    {
      id: 7003,
      title: '未写完的草稿：缓存穿透',
      summary: '',
      cover: '',
      visibility: 0,
      status: 0,
      wordCount: 80,
      categoryId: null,
      categoryName: null,
      tags: [],
      createTime: '2026-06-03 10:00:00',
      updateTime: '2026-06-12 09:00:00',
    },
  ]

  for (let i = 4; i <= 12; i += 1) {
    const isRedis = i % 3 === 0
    base.push({
      id: 7000 + i,
      title: `第 ${i} 篇笔记：分布式一致性随笔`,
      summary: `这是第 ${i} 篇笔记的摘要。`,
      cover: '',
      visibility: i % 2 === 0 ? 1 : 0,
      status: 1,
      wordCount: 300 + i * 10,
      categoryId: isRedis ? 2 : 1,
      categoryName: isRedis ? 'Redis' : 'Java',
      tags: [],
      createTime: '2026-06-05 10:00:00',
      updateTime: '2026-06-13 09:00:00',
    })
  }

  return base
}

/** 正文里混入 XSS 向量，验证清洗链路 */
const NOTE_CONTENT = `## 看门狗是什么

Redisson 在加锁成功后会启动一个后台任务，每隔 \`lockWatchdogTimeout / 3\` 续期一次。

\`\`\`java
RLock lock = redisson.getLock("order:1001");
lock.lock(30, TimeUnit.SECONDS);
try {
    // 业务逻辑
} finally {
    lock.unlock();
}
\`\`\`

### 常见误区

| 误区 | 后果 |
| --- | --- |
| 手动指定 leaseTime | 看门狗不再续期 |
| 忘记 unlock | 锁要等到超时 |

> 结论：不确定持有时长时，不要传 leaseTime。

<script>window.__NOTE_XSS_FIRED__ = true</script>
<img src=x onerror="window.__NOTE_XSS_FIRED__ = true">
`

const NOTE_DETAIL = {
  id: 7001,
  user: { id: 1001, userName: 'zhangsan', avatar: '', intro: 'Java 后端学习者' },
  title: 'Redisson 看门狗机制笔记',
  content: NOTE_CONTENT,
  summary: '看门狗如何续期，以及锁释放的正确姿势。',
  cover: '',
  category: { id: 5, name: 'Spring' },
  tags: [
    { id: 1, name: 'Java' },
    // id 故意**避开** 2.12 候选集的 id 段（1~9）：Redis 不在预置标签里，
    // 这样正好覆盖「已有标签不在候选集里也要能回显」的合并逻辑。
    // 若这里写成 id:2，会与候选集的「Spring Boot」撞号 → el-select 按 id 取 label，
    // 回显就变成「Java / Spring Boot」，看起来像 bug、其实是 fixture 撞号。
    { id: 99, name: 'Redis' },
  ],
  visibility: 1,
  status: 1,
  wordCount: 1200,
  createTime: '2026-06-01 10:00:00',
  updateTime: '2026-06-10 09:00:00',
}

/** 桩的开关：用例通过改这些字段来切换场景 */
const stub = {
  /** 当前登录用户 id —— 决定详情页是不是「作者视角」 */
  myId: 1001,
  loggedIn: true,

  /** 列表：error 模式 / 强制空 */
  listFails: false,
  listEmpty: false,
  /** 按 categoryId 给列表请求加延迟，用于验证过期响应丢弃 */
  listDelays: {},

  /** 分类树 */
  treeFails: false,
  treeEmpty: false,

  /** 笔记详情 */
  detailFails: false,
  /**
   * 详情失败时**具体的错误码**（401 / 403 / 404…）。
   *
   * 原先的 `fail()` 恒返回 HTTP 500 + code=500，导致页面的「按 ApiError.code 分诊」
   * 逻辑在桩里根本走不到 —— 401/403/404 三条分支只有真实后端脚本覆盖得到。
   * T7 把详情页改成按 code 分诊（T1.5 项目级约定 D：禁止按 message 文本判断失败类型），
   * 所以桩必须能造出指定的 code，否则这里永远是「通用失败」一条路。
   */
  detailFailCode: null,
  /** 详情字段覆盖，用于构造草稿 / 私密场景 */
  detailOverride: null,

  /** 可见性切换 */
  visibilityFails: false,
  visibilityDelay: 0,

  /** 提交失败开关 */
  createFails: false,
  updateFails: false,

  notes: initialNotes(),
  tree: initialTree(),
  nextId: 9000,
}

function resetStub() {
  stub.myId = 1001
  stub.loggedIn = true
  stub.listFails = false
  stub.listEmpty = false
  stub.listDelays = {}
  stub.treeFails = false
  stub.treeEmpty = false
  stub.detailFails = false
  stub.detailFailCode = null
  stub.detailOverride = null
  stub.visibilityFails = false
  stub.visibilityDelay = 0
  stub.createFails = false
  stub.updateFails = false
  stub.notes = initialNotes()
  stub.tree = initialTree()
  stub.nextId = 9000
  requestLog.length = 0
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 递归找节点（含其父数组引用） */
function findInTree(nodes, id) {
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].id === id) return { node: nodes[i], siblings: nodes, index: i }
    const found = findInTree(nodes[i].children ?? [], id)
    if (found) return found
  }
  return null
}

/** 后端按 sort 倒序返回，桩也照做，保证「上移/下移」断言有意义 */
function sortTree(nodes) {
  nodes.sort((a, b) => b.sort - a.sort)
  nodes.forEach((n) => sortTree(n.children ?? []))
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

  const json = (data, delay = 0) => {
    const send = () => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ code: 200, message: 'success', data }))
    }
    if (delay > 0) setTimeout(send, delay)
    else send()
  }
  const fail = (msg = '服务器内部错误') => {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 500, message: msg, data: null }))
  }

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
      entry.body = raw // multipart 原文，用例里用正则数同名字段
    }
  }
  requestLog.push(entry)

  /* ---- 用户信息 / 未读数 ---- */
  if (url.pathname === '/api/user/info') {
    if (!stub.loggedIn) return fail('未登录')
    return json({
      id: stub.myId,
      userName: stub.myId === 1001 ? 'zhangsan' : 'lisi',
      avatar: '',
      intro: 'Java 后端学习者',
      phone: '13800000000',
      createTime: '2026-01-01 10:00:00',
    })
  }
  if (url.pathname === '/api/notify/unread') return json(0)

  /* ---- 2.12 标签列表（需登录、无分页）----
     旧注释写的是「已弃用且后端未实现，桩里不提供该路由」，那是 2026-09-16 的结论。
     `TagController` 于 2026-09-17 新增，T5 / T7 都已接入（编辑器标签多选），
     所以桩必须提供这条路由 —— 不提供的话，断言「没有标签选择控件」会**恒真**（假通过）。
     注意候选集里**故意不含 Redis**：NOTE_DETAIL 的已有标签是 Java / Redis，
     这样正好覆盖「已有标签不在候选集里也要能回显」的合并逻辑。 */
  if (url.pathname === '/api/tag/list') {
    return json([
      { id: 1, name: 'Java', createTime: '2026-01-01 10:00:00' },
      { id: 2, name: 'Spring Boot', createTime: '2026-01-01 10:00:00' },
      { id: 3, name: '数据库', createTime: '2026-01-01 10:00:00' },
      { id: 4, name: '前端', createTime: '2026-01-01 10:00:00' },
      { id: 5, name: '算法', createTime: '2026-01-01 10:00:00' },
      { id: 6, name: '面试', createTime: '2026-01-01 10:00:00' },
      { id: 7, name: '实战', createTime: '2026-01-01 10:00:00' },
      { id: 8, name: '踩坑记录', createTime: '2026-01-01 10:00:00' },
      { id: 9, name: '设计', createTime: '2026-01-01 10:00:00' },
    ])
  }

  /* ---- 分类树 ---- */
  if (url.pathname === '/api/category/tree') {
    if (stub.treeFails) return fail('分类服务不可用')
    if (stub.treeEmpty) return json([])
    sortTree(stub.tree)
    return json(stub.tree)
  }

  /* ---- 2.7 创建分类 ---- */
  if (url.pathname === '/api/category/createCategory' && req.method === 'POST') {
    const payload = entry.body ?? {}
    const id = (stub.nextId += 1)
    const node = { id, name: payload.name, sort: payload.sort ?? 0, children: [] }
    const parentId = Number(payload.parentId ?? 0)
    if (!parentId) {
      stub.tree.push(node)
    } else {
      const found = findInTree(stub.tree, parentId)
      if (!found) return fail('父分类不存在')
      found.node.children = found.node.children ?? []
      found.node.children.push(node)
    }
    return json({ id })
  }

  /* ---- 2.8 修改分类 ---- */
  if (/^\/api\/category\/\d+$/.test(url.pathname) && req.method === 'PUT') {
    const id = Number(url.pathname.split('/').pop())
    const found = findInTree(stub.tree, id)
    if (!found) return fail('分类不存在')
    const payload = entry.body ?? {}
    if (payload.name !== undefined) found.node.name = payload.name
    if (payload.sort !== undefined) found.node.sort = payload.sort
    return json(null)
  }

  /* ---- 2.9 删除分类 ---- */
  if (/^\/api\/category\/\d+$/.test(url.pathname) && req.method === 'DELETE') {
    const id = Number(url.pathname.split('/').pop())
    const found = findInTree(stub.tree, id)
    if (!found) return fail('分类不存在')
    // 文档：删除后该分类下的笔记分类置为 null
    stub.notes.forEach((n) => {
      if (n.categoryId === id) {
        n.categoryId = null
        n.categoryName = null
      }
    })
    found.siblings.splice(found.index, 1)
    return json(null)
  }

  /* ---- 2.5 我的笔记列表 ---- */
  if (url.pathname === '/api/note/list' && req.method === 'GET') {
    if (stub.listFails) return fail('笔记服务不可用')

    const q = entry.query
    let rows = [...stub.notes]

    if (stub.listEmpty) rows = []
    if (q.categoryId) rows = rows.filter((n) => n.categoryId === Number(q.categoryId))
    if (q.visibility !== undefined) rows = rows.filter((n) => n.visibility === Number(q.visibility))
    if (q.status !== undefined) rows = rows.filter((n) => n.status === Number(q.status))
    if (q.keyword) rows = rows.filter((n) => n.title.includes(q.keyword))

    const page = Number(q.page ?? 1)
    const size = Number(q.size ?? 10)
    const records = rows.slice((page - 1) * size, page * size).map((n) => ({
      id: n.id,
      title: n.title,
      summary: n.summary,
      cover: n.cover,
      visibility: n.visibility,
      status: n.status,
      wordCount: n.wordCount,
      categoryName: n.categoryName,
      tags: n.tags,
      createTime: n.createTime,
      updateTime: n.updateTime,
    }))

    const delay = stub.listDelays[String(q.categoryId ?? '')] ?? 0
    return json({ total: rows.length, size, current: page, records }, delay)
  }

  /* ---- 2.1 创建笔记（multipart） ---- */
  if (url.pathname === '/api/note/createNote' && req.method === 'POST') {
    if (stub.createFails) return fail('创建失败')
    return json({ id: 8801 })
  }

  /* ---- 2.6 切换可见性 ---- */
  if (/^\/api\/note\/\d+\/visibility$/.test(url.pathname) && req.method === 'PUT') {
    if (stub.visibilityFails) return fail('修改可见性失败')
    const id = Number(url.pathname.split('/')[3])
    const payload = entry.body ?? {}
    const target = stub.notes.find((n) => n.id === id)
    if (target) target.visibility = payload.visibility
    return json(null, stub.visibilityDelay)
  }

  /* ---- 2.11 笔记标签 ---- */
  if (/^\/api\/note\/\d+\/tag$/.test(url.pathname) && req.method === 'POST') return json(null)

  /* ---- 2.2 编辑笔记（multipart） ---- */
  if (/^\/api\/note\/\d+$/.test(url.pathname) && req.method === 'PUT') {
    if (stub.updateFails) return fail('保存失败')
    return json(null)
  }

  /* ---- 2.3 删除笔记 ---- */
  if (/^\/api\/note\/\d+$/.test(url.pathname) && req.method === 'DELETE') {
    const id = Number(url.pathname.split('/').pop())
    stub.notes = stub.notes.filter((n) => n.id !== id)
    return json(null)
  }

  /* ---- 2.4 笔记详情 ---- */
  if (/^\/api\/note\/\d+$/.test(url.pathname) && req.method === 'GET') {
    // 指定错误码优先：让「按 ApiError.code 分诊」的 401/403/404 分支在桩里也能被覆盖
    if (stub.detailFailCode !== null) {
      const code = stub.detailFailCode
      const message =
        { 401: '登陆过期请重新登陆', 403: '私密笔记只能作者自己看', 404: '笔记不存在' }[code] ??
        '服务器内部错误'
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ code, message, data: null }))
    }
    if (stub.detailFails) return fail('笔记不存在')
    return json({ ...NOTE_DETAIL, ...(stub.detailOverride ?? {}) })
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

async function waitFor(cdp, expression, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return true
    await sleep(120)
  }
  return false
}

/* ==================== 页面交互小工具 ==================== */

/** 原生 setter + input 事件，才能驱动 Vue 的 v-model */
function setInput(cdp, selector, value) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

function clickByText(cdp, selector, text) {
  return cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = els.find(e => e.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)
}

function textOf(cdp, selector) {
  return cdp.evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.textContent?.replace(/\\s+/g,' ').trim() ?? null`,
  )
}

/**
 * 点「当前打开着的」下拉里的某一项。
 *
 * ⚠️ 必须过滤掉**不可见**的项，不能直接用 clickByText：
 * Element Plus 的 el-select 下拉内容是懒渲染后**常驻 DOM** 的，一旦某个 select 有了候选数据，
 * 它的 `.el-select-dropdown__item` 就会一直留在文档里（`height === 0`）。
 * 而 clickByText 取的是**文档顺序里第一个**「文本包含」的项 ——
 * 于是点分类的「Spring」会命中标签下拉里隐藏的「Spring Boot」，点了等于没点。
 * 这里按可见高度过滤（与 verify-t7 的 selectOption 同一套做法）。
 */
function clickVisibleOption(cdp, text) {
  return cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.el-select-dropdown__item')]
      .filter(e => e.getBoundingClientRect().height > 0)
    const el = items.find(e => e.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)
}

/** 点某条笔记卡片上的操作按钮（避免点到别的卡片） */
function clickItemOp(cdp, noteTitle, opText) {
  return cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.cm-note-list__item')]
    const card = cards.find(c =>
      c.querySelector('.cm-note-card__title')?.textContent.trim() === ${JSON.stringify(noteTitle)})
    if (!card) return false
    const op = [...card.querySelectorAll('.cm-note-list__op')]
      .find(o => o.textContent.replace(/\\s+/g,'').includes(${JSON.stringify(opText)}))
    if (!op) return false
    op.click()
    return true
  })()`)
}

/** 点某一行分类上的操作按钮 */
function clickCategoryOp(cdp, categoryName, opText) {
  return cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cm-categories__row')]
    const row = rows.find(r =>
      r.querySelector('.cm-categories__name')?.textContent.trim() === ${JSON.stringify(categoryName)})
    if (!row) return false
    const op = [...row.querySelectorAll('.cm-categories__op')]
      .find(o => (o.title || o.textContent).replace(/\\s+/g,'').includes(${JSON.stringify(opText)}))
    if (!op) return false
    op.click()
    return true
  })()`)
}

/** 确认 Element Plus 的 MessageBox（点主按钮） */
function confirmMessageBox(cdp) {
  return cdp.evaluate(`(() => {
    const btn = document.querySelector('.el-message-box__btns .el-button--primary')
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

/** 点弹窗底部的主按钮（创建 / 保存） */
function confirmDialog(cdp) {
  return cdp.evaluate(`(() => {
    const btn = document.querySelector('.el-dialog__footer .el-button--primary')
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

/** 统计 multipart 原文里某个字段出现了几次 */
function countField(raw, name) {
  return (raw?.match(new RegExp(`name="${name}"`, 'g')) ?? []).length
}

/**
 * 编辑器下拉里的子分类带树形前缀（'　└ Spring'），这是刻意用缩进表达层级，
 * 断言时剥掉前缀再比较，避免把展示细节当成数据错误。
 */
function stripTreePrefix(text) {
  return (text ?? '').replace(/[\u3000└\s]/g, '')
}

/* ==================== 页面快照 ==================== */

const SNAP_NOTE_LIST = `(() => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  return {
    url: location.pathname + location.search,
    title: q('.cm-note-list__title')?.textContent?.trim() ?? null,
    subtitle: q('.cm-note-list__subtitle')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    items: all('.cm-note-card').length,
    itemTitles: all('.cm-note-card__title').map(e => e.textContent.trim()),
    itemCategories: all('.cm-note-card__category').map(e => e.textContent.trim()),
    flags: all('.cm-note-card__flag').map(e => e.textContent.replace(/\\s+/g,'').trim()),
    cats: all('.cm-note-list__cat').map(e => e.textContent.trim()),
    activeCat: q('.cm-note-list__cat.is-active')?.textContent?.trim() ?? null,
    // el-select 的占位文案渲染在 .el-select__placeholder 里，不在 input 的 placeholder 属性上
    filterPlaceholders: all('.cm-note-list__filter-select').map(e => {
      const span = e.querySelector('.el-select__placeholder')
      const input = e.querySelector('input')
      return (span?.textContent || input?.placeholder || '').trim()
    }),
    hasSkeleton: !!q('.cm-skeleton__row'),
    hasError: !!q('.cm-error'),
    hasEmpty: !!q('.cm-empty'),
    emptyTitle: q('.cm-empty__title')?.textContent?.trim() ?? null,
    hasPager: !!q('.el-pagination'),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})()`

const SNAP_NOTE_DETAIL = `(() => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  return {
    url: location.pathname,
    title: q('.cm-note-detail__title')?.textContent?.trim() ?? null,
    authorName: q('.cm-note-detail__author-name')?.textContent?.trim() ?? null,
    category: q('.cm-note-detail__category')?.textContent?.trim() ?? null,
    meta: q('.cm-note-detail__meta-right')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    hasBody: !!q('.cm-note-detail__body'),
    bodyHtml: q('.cm-note-detail__body')?.innerHTML ?? '',
    h2Count: all('.cm-note-detail__body h2').length,
    codeBlockCount: all('.cm-note-detail__body pre code').length,
    tableCount: all('.cm-note-detail__body table').length,
    blockquoteCount: all('.cm-note-detail__body blockquote').length,
    xssFired: !!window.__NOTE_XSS_FIRED__,
    scriptInBody: all('.cm-note-detail__body script').length,
    tags: all('.cm-note-detail__tag').map(e => e.textContent.trim()),
    banners: all('.cm-note-detail__banner').map(e => e.textContent.replace(/\\s+/g,' ').trim()),
    actionTexts: all('.cm-note-detail__action').map(e => e.textContent.replace(/\\s+/g,' ').trim()),
    visibilityBtn: all('.cm-note-detail__action').find(e => /公开|私密/.test(e.textContent))
      ?.textContent.replace(/\\s+/g,' ').trim() ?? null,
    visibilityBtnActive: !!all('.cm-note-detail__action').find(e => /公开|私密/.test(e.textContent))?.classList.contains('is-active'),
    hasEdit: all('.cm-note-detail__action, .el-button').some(e => /编辑/.test(e.textContent)),
    aiButtons: all('.cm-note-detail__ai-btn').map(e => e.textContent.trim()),
    hasError: !!q('.cm-error'),
    // T7 起详情页按 ApiError.code 分诊，标题会随 code 变（403 / 404 / 通用），必须一起断言
    errorTitle: q('.cm-error__title')?.textContent?.trim() ?? null,
    errorDesc: q('.cm-error__desc')?.textContent?.trim() ?? null,
    hasSkeleton: !!q('.cm-loading'),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})()`

const SNAP_NOTE_EDITOR = `(() => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  const titleInput = q('.cm-note-editor__title-input input')
  const textarea = q('.cm-note-editor__textarea textarea')
  // el-select 的已选项不是 input.value，而在 .el-select__selected-item 里，取整个控件的文本最稳
  const selectTexts = all('.cm-note-editor__control').map(e => e.textContent.replace(/\\s+/g,' ').trim())
  return {
    url: location.pathname,
    h1: q('.cm-note-editor__title')?.textContent?.trim() ?? null,
    titleValue: titleInput?.value ?? null,
    contentValue: textarea?.value ?? null,
    summaryValue: all('.cm-note-editor textarea')[1]?.value ?? null,
    categoryText: selectTexts[0] ?? null,
    tagText: selectTexts[1] ?? null,
    selectedTagChips: all('.cm-note-editor__control .el-tag').map(e => e.textContent.trim()),
    visibilityActive: q('.cm-note-editor__visibility .el-radio-button.is-active')?.textContent?.trim() ?? null,
    hasPreview: !!q('.cm-note-editor__preview-body .cm-markdown'),
    previewH2: all('.cm-note-editor__preview-body h2').length,
    dirtyBadge: !!q('.cm-note-editor__dirty'),
    blocker: !!q('.cm-note-editor__blocker'),
    blockerText: q('.cm-note-editor__blocker')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    headButtons: all('.cm-note-editor__head-actions .el-button').map(e => e.textContent.trim()),
    headButtonsDisabled: all('.cm-note-editor__head-actions .el-button').map(e => e.disabled),
    coverPreviewSrc: q('.cm-note-editor__cover-preview img')?.getAttribute('src') ?? null,
    coverPlaceholder: !!q('.cm-note-editor__cover-placeholder'),
    coverRemoveBtn: all('.cm-note-editor__cover-ops .el-button')
      .some(b => /撤销选择|移除封面/.test(b.textContent)),
    coverHint: q('.cm-note-editor__cover-hint')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    hasError: !!q('.cm-error'),
    hasLoading: !!q('.cm-loading'),
    messageBox: !!q('.el-message-box'),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})()`

const SNAP_CATEGORIES = `(() => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  // el-dialog 关闭后仍留在 DOM 里（display:none），必须用尺寸判断是否可见
  const dlgRect = q('.el-dialog')?.getBoundingClientRect()
  return {
    url: location.pathname,
    title: q('.cm-categories__title')?.textContent?.trim() ?? null,
    rows: all('.cm-categories__row').map(r => ({
      name: r.querySelector('.cm-categories__name')?.textContent.trim() ?? null,
      indent: r.style.paddingLeft,
      meta: r.querySelector('.cm-categories__meta')?.textContent.replace(/\\s+/g,' ').trim() ?? null,
      hasToggle: !!r.querySelector('.cm-categories__toggle:not(.cm-categories__toggle--leaf)'),
      ops: [...r.querySelectorAll('.cm-categories__op')].map(o => o.title || o.textContent.replace(/\\s+/g,'').trim()),
      upDisabled: [...r.querySelectorAll('.cm-categories__op')][0]?.disabled ?? null,
      downDisabled: [...r.querySelectorAll('.cm-categories__op')][1]?.disabled ?? null,
    })),
    names: all('.cm-categories__name').map(e => e.textContent.trim()),
    /** 只取顶级分类名，用于断言同级排序 */
    topNames: all('.cm-categories__row')
      .filter(r => r.style.paddingLeft === '8px')
      .map(r => r.querySelector('.cm-categories__name')?.textContent.trim() ?? null),
    stats: all('.cm-categories__stat').map(s => ({
      label: s.querySelector('dt')?.textContent.trim(),
      value: s.querySelector('dd')?.textContent.trim(),
    })),
    hasEmpty: !!q('.cm-empty'),
    hasError: !!q('.cm-error'),
    hasSkeleton: !!q('.cm-skeleton__row'),
    dialogOpen: !!dlgRect && dlgRect.width > 0 && dlgRect.height > 0,
    messageBox: !!q('.el-message-box'),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})()`

/* ==================== 主流程 ==================== */
let chromeProc = null
let viteServer = null
let profileDir = null
let coverPath = null

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

  const PORT = 5198
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

  profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-chrome-note-'))
  coverPath = path.join(profileDir, 'cover.png')
  await fs.writeFile(coverPath, Buffer.from(PNG_BASE64, 'base64'))
  const bigCoverPath = path.join(profileDir, 'too-big.png')
  await fs.writeFile(bigCoverPath, Buffer.alloc(6 * 1024 * 1024, 1))
  const txtPath = path.join(profileDir, 'note.txt')
  await fs.writeFile(txtPath, 'not an image')

  const debugPort = 9337
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

  /** 设置/清除登录态。必须先到同源页面，about:blank 上访问 localStorage 会抛 SecurityError */
  async function setLoggedIn(on) {
    await cdp.send('Page.navigate', { url: base + '/notes' })
    await sleep(1200)
    await cdp.evaluate(
      on
        ? `localStorage.setItem('codemind_token', 'stub-token-abc')`
        : `localStorage.removeItem('codemind_token')`,
    )
  }

  async function goto(pathname, wait = 2200) {
    await cdp.send('Page.navigate', { url: base + pathname })
    await sleep(wait)
  }

  /* ==================== 1. 列表页 · 鉴权与渲染 ==================== */
  console.log('[1. 笔记列表页 · 未登录拦截]')
  resetStub()
  stub.loggedIn = false
  await setLoggedIn(false)
  await goto('/notes')
  let snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check(
    '未登录访问 /notes 被拦到登录页',
    snap.url.startsWith('/login'),
    `实际 ${snap.url}`,
  )
  check(
    'redirect 参数保留原目标',
    decodeURIComponent(snap.url).includes('redirect=/notes'),
    `实际 ${snap.url}`,
  )

  console.log('\n[2. 笔记列表页 · 渲染]')
  resetStub()
  await setLoggedIn(true)
  await goto('/notes')
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('路由停在 /notes', snap.url === '/notes', `实际 ${snap.url}`)
  check('页标题正确', snap.title === '我的知识库', `实际 ${snap.title}`)
  check('第一页渲染 10 条', snap.items === 10, `实际 ${snap.items}`)
  check('副标题显示总数 12', /共 12 篇笔记/.test(snap.subtitle ?? ''), `实际 ${snap.subtitle}`)
  check(
    '首条标题正确',
    snap.itemTitles[0] === 'Redisson 看门狗机制笔记',
    `实际 ${snap.itemTitles[0]}`,
  )
  check('分类名渲染', snap.itemCategories[0] === 'Spring', `实际 ${snap.itemCategories[0]}`)
  check(
    '公开/私密标记渲染',
    snap.flags.includes('公开') && snap.flags.includes('私密'),
    `实际 ${JSON.stringify(snap.flags.slice(0, 6))}`,
  )
  check('草稿标记渲染', snap.flags.includes('草稿'), `实际 ${JSON.stringify(snap.flags)}`)
  check('分类侧栏渲染 6 个分类', snap.cats.length === 6, `实际 ${snap.cats.length}`)
  check(
    '筛选下拉的占位文案有语义（不是默认的「请选择」）',
    JSON.stringify(snap.filterPlaceholders) === JSON.stringify(['全部状态', '全部可见性']),
    `实际 ${JSON.stringify(snap.filterPlaceholders)}`,
  )
  check('分页器出现', snap.hasPager)
  check('未进入错误态', !snap.hasError)
  check('未卡在骨架屏', !snap.hasSkeleton)

  /* ==================== 2. 筛选走 URL ==================== */
  console.log('\n[3. 笔记列表页 · 筛选条件落在 URL]')
  resetStub()
  await goto('/notes')
  requestLog.length = 0
  await clickByText(cdp, '.cm-note-list__cat', 'Redis')
  await sleep(1200)
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  let listReq = requestLog.filter((r) => r.path === '/api/note/list').pop()
  check('点分类后 URL 带 categoryId', snap.url === '/notes?categoryId=2', `实际 ${snap.url}`)
  check('请求参数带上 categoryId', listReq?.query?.categoryId === '2', `实际 ${listReq?.query?.categoryId}`)
  check('侧栏高亮切到 Redis', snap.activeCat === 'Redis', `实际 ${snap.activeCat}`)
  check('列表只剩 Redis 分类的 3 条', snap.items === 3, `实际 ${snap.items}`)
  check(
    '列表项分类名都是 Redis',
    snap.itemCategories.every((c) => c === 'Redis'),
    `实际 ${JSON.stringify(snap.itemCategories)}`,
  )

  requestLog.length = 0
  await cdp.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.cm-note-list__filter-select')][0]
    const input = sel.querySelector('input')
    input.click()
    return true
  })()`)
  await sleep(500)
  await clickVisibleOption(cdp, '草稿')
  await sleep(1200)
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  listReq = requestLog.filter((r) => r.path === '/api/note/list').pop()
  check(
    '选状态后 URL 同时带 categoryId 与 status',
    snap.url.includes('categoryId=2') && snap.url.includes('status=0'),
    `实际 ${snap.url}`,
  )
  check('请求参数带上 status=0', listReq?.query?.status === '0', `实际 ${listReq?.query?.status}`)

  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.cm-note-list__filters .el-button')]
    const b = btns.find(e => e.textContent.includes('清空筛选'))
    if (b) b.click()
    return true
  })()`)
  await sleep(1200)
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('清空筛选后 URL 回到 /notes', snap.url === '/notes', `实际 ${snap.url}`)

  /* ==================== 3. 关键词防抖 ==================== */
  console.log('\n[4. 笔记列表页 · 关键词搜索防抖]')
  resetStub()
  await goto('/notes')
  requestLog.length = 0
  for (const v of ['看', '看门', '看门狗']) {
    await setInput(cdp, '.cm-note-list__search input', v)
    await sleep(90)
  }
  await sleep(1000)
  const kwReqs = requestLog.filter((r) => r.path === '/api/note/list')
  check('连续输入三个字符只发一次列表请求', kwReqs.length === 1, `实际 ${kwReqs.length} 次`)
  check('请求 keyword 是最终值', kwReqs[0]?.query?.keyword === '看门狗', `实际 ${kwReqs[0]?.query?.keyword}`)
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('URL 写入 keyword', snap.url.includes('keyword='), `实际 ${snap.url}`)
  check('命中 1 条笔记', snap.items === 1, `实际 ${snap.items}`)

  /* ==================== 4. 过期响应丢弃 ==================== */
  console.log('\n[5. 笔记列表页 · 过期响应丢弃]')
  resetStub()
  stub.listDelays = { '2': 1200 } // Redis 的响应很慢
  await goto('/notes')
  await clickByText(cdp, '.cm-note-list__cat', 'Redis')
  await sleep(200)
  await clickByText(cdp, '.cm-note-list__cat', 'Java')
  await sleep(1900) // 等到慢响应（1200ms）已经返回
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('URL 停在最后点击的 Java', snap.url === '/notes?categoryId=1', `实际 ${snap.url}`)
  check('高亮停在 Java', snap.activeCat === 'Java', `实际 ${snap.activeCat}`)
  check(
    '慢的 Redis 响应被丢弃，显示的是 Java 的 6 条',
    snap.items === 6,
    `实际 ${snap.items} 条（若是 3 条说明过期响应覆盖了新结果）`,
  )
  check(
    '列表内容确为 Java 分类',
    snap.itemCategories.every((c) => c === 'Java'),
    `实际 ${JSON.stringify(snap.itemCategories)}`,
  )

  /* ==================== 5. 可见性乐观更新 ==================== */
  console.log('\n[6. 笔记列表页 · 可见性乐观更新与回滚]')
  resetStub()
  stub.visibilityDelay = 900
  await goto('/notes')
  requestLog.length = 0
  await clickItemOp(cdp, 'Redisson 看门狗机制笔记', '设为私密')
  await sleep(200) // 远早于 900ms 的响应
  let flagNow = await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.cm-note-list__item')]
      .find(c => c.querySelector('.cm-note-card__title')?.textContent.trim() === 'Redisson 看门狗机制笔记')
    return card?.querySelector('.cm-note-card__flag:not(.cm-note-card__flag--draft)')?.textContent.replace(/\\s+/g,'').trim() ?? null
  })()`)
  check('点击后 200ms 内标记已变为「私密」（乐观更新）', flagNow === '私密', `实际 ${flagNow}`)

  await sleep(1200)
  let visReq = requestLog.find((r) => /\/visibility$/.test(r.path))
  check('打到正确的可见性接口', visReq?.path === '/api/note/7001/visibility', `实际 ${visReq?.path}`)
  check('提交 visibility=0', visReq?.body?.visibility === 0, `实际 ${JSON.stringify(visReq?.body)}`)

  resetStub()
  stub.visibilityFails = true
  await goto('/notes')
  await clickItemOp(cdp, 'Redisson 看门狗机制笔记', '设为私密')
  await sleep(1400)
  flagNow = await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.cm-note-list__item')]
      .find(c => c.querySelector('.cm-note-card__title')?.textContent.trim() === 'Redisson 看门狗机制笔记')
    return card?.querySelector('.cm-note-card__flag:not(.cm-note-card__flag--draft)')?.textContent.replace(/\\s+/g,'').trim() ?? null
  })()`)
  check('接口失败后标记回滚为「公开」', flagNow === '公开', `实际 ${flagNow}`)
  check(
    '失败提示已弹出',
    await cdp.evaluate(`!!document.querySelector('.el-message--error')`),
  )

  /* ==================== 6. 删除与翻页回退 ==================== */
  console.log('\n[7. 笔记列表页 · 删除与翻页回退]')
  resetStub()
  await goto('/notes?page=2')
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('第二页有 2 条', snap.items === 2, `实际 ${snap.items}`)
  const page2Titles = [...snap.itemTitles]

  await clickItemOp(cdp, page2Titles[0], '删除')
  await sleep(600)
  const boxText = await textOf(cdp, '.el-message-box__message')
  check('删除弹出二次确认', !!boxText, `实际 ${boxText}`)
  check('确认文案提示无法恢复', /无法恢复/.test(boxText ?? ''), `实际 ${boxText}`)
  await confirmMessageBox(cdp)
  await sleep(1200)
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('第二页只剩 1 条', snap.items === 1, `实际 ${snap.items}`)
  check('删除的笔记已消失', !snap.itemTitles.includes(page2Titles[0]), `实际 ${JSON.stringify(snap.itemTitles)}`)

  await clickItemOp(cdp, snap.itemTitles[0], '删除')
  await sleep(600)
  await confirmMessageBox(cdp)
  await sleep(1500)
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check(
    '删掉本页最后一条后自动退回第 1 页',
    snap.url === '/notes' && snap.items === 10,
    `实际 url=${snap.url} items=${snap.items}`,
  )

  /* ==================== 7. 三态 ==================== */
  console.log('\n[8. 笔记列表页 · 空态与错误态]')
  resetStub()
  stub.listEmpty = true
  await goto('/notes')
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('无数据时进入空态', snap.hasEmpty, `实际 hasEmpty=${snap.hasEmpty}`)
  check('空态文案面向知识库', snap.emptyTitle === '知识库还是空的', `实际 ${snap.emptyTitle}`)

  resetStub()
  stub.listFails = true
  await goto('/notes')
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('接口 500 时进入错误态', snap.hasError)
  check('错误态不显示列表', snap.items === 0, `实际 ${snap.items}`)

  stub.listFails = false
  await cdp.evaluate(
    `[...document.querySelectorAll('.cm-error__actions .el-button')][0]?.click()`,
  )
  await sleep(1400)
  snap = await cdp.evaluate(SNAP_NOTE_LIST)
  check('点重试后恢复列表', !snap.hasError && snap.items === 10, `实际 items=${snap.items}`)

  /* ==================== 8. 详情页 · 渲染与 XSS ==================== */
  console.log('\n[9. 笔记详情页 · 渲染与 XSS 清洗]')
  resetStub()
  await goto('/notes/7001')
  let d = await cdp.evaluate(SNAP_NOTE_DETAIL)
  check('路由停在 /notes/7001', d.url === '/notes/7001', `实际 ${d.url}`)
  check('标题渲染正确', d.title === NOTE_DETAIL.title, `实际 ${d.title}`)
  check('作者名渲染', d.authorName === 'zhangsan', `实际 ${d.authorName}`)
  check('分类渲染', d.category === 'Spring', `实际 ${d.category}`)
  check('正文容器存在', d.hasBody)
  check('Markdown h2 渲染', d.h2Count >= 1, `实际 ${d.h2Count}`)
  check('代码块渲染', d.codeBlockCount >= 1, `实际 ${d.codeBlockCount}`)
  check('表格渲染', d.tableCount === 1, `实际 ${d.tableCount}`)
  check('引用块渲染', d.blockquoteCount === 1, `实际 ${d.blockquoteCount}`)
  check('标签渲染', JSON.stringify(d.tags) === JSON.stringify(['Java', 'Redis']), `实际 ${JSON.stringify(d.tags)}`)
  check('字数与阅读时长显示', /1200 字/.test(d.meta ?? ''), `实际 ${d.meta}`)
  check('未进入错误态', !d.hasError)

  check('正文中的 <script> 未被注入 DOM', d.scriptInBody === 0, `实际 ${d.scriptInBody} 个`)
  check('XSS 载荷未执行', !d.xssFired, 'window.__NOTE_XSS_FIRED__ 被置位说明清洗失败')
  check('正文 HTML 不含 <script 字样', !/<script/i.test(d.bodyHtml))
  check('img 的 onerror 属性被移除', !/onerror/i.test(d.bodyHtml))
  check('保留正常正文内容', d.bodyHtml.includes('Redisson'), '清洗不能把正文清空')

  /* ==================== 9. 详情页 · 作者操作 ==================== */
  console.log('\n[10. 笔记详情页 · 作者视角与可见性切换]')
  resetStub()
  stub.visibilityDelay = 900
  await goto('/notes/7001')
  d = await cdp.evaluate(SNAP_NOTE_DETAIL)
  check('作者能看到可见性切换按钮', d.visibilityBtn !== null, `实际 ${d.visibilityBtn}`)
  check('初始为公开且未激活私密态', /公开/.test(d.visibilityBtn ?? ''), `实际 ${d.visibilityBtn}`)
  check('作者能看到编辑入口', d.hasEdit)
  check(
    'AI 助手三动作齐全',
    JSON.stringify(d.aiButtons) === JSON.stringify(['AI 总结', '知识点提取', '生成面试题']),
    `实际 ${JSON.stringify(d.aiButtons)}`,
  )

  requestLog.length = 0
  await clickByText(cdp, '.cm-note-detail__action', '公开')
  await sleep(200)
  let visBtnText = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.cm-note-detail__action')].find(e => /公开|私密/.test(e.textContent))
    return b?.textContent.replace(/\\s+/g,' ').trim() ?? null
  })()`)
  check('点击后 200ms 内按钮已显示「私密」（乐观更新）', /私密/.test(visBtnText ?? ''), `实际 ${visBtnText}`)
  await sleep(1200)
  visReq = requestLog.find((r) => /\/visibility$/.test(r.path))
  check('提交 visibility=0', visReq?.body?.visibility === 0, `实际 ${JSON.stringify(visReq?.body)}`)

  resetStub()
  stub.visibilityFails = true
  await goto('/notes/7001')
  await clickByText(cdp, '.cm-note-detail__action', '公开')
  await sleep(1400)
  visBtnText = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.cm-note-detail__action')].find(e => /公开|私密/.test(e.textContent))
    return b?.textContent.replace(/\\s+/g,' ').trim() ?? null
  })()`)
  check('失败后按钮回滚为「公开」', /公开/.test(visBtnText ?? ''), `实际 ${visBtnText}`)

  /* ==================== 10. 详情页 · 草稿/私密/非作者 ==================== */
  console.log('\n[11. 笔记详情页 · 草稿私密提示与非作者视角]')
  resetStub()
  stub.detailOverride = { status: 0, visibility: 0 }
  await goto('/notes/7001')
  d = await cdp.evaluate(SNAP_NOTE_DETAIL)
  check('草稿提示出现', d.banners.some((b) => /草稿/.test(b)), `实际 ${JSON.stringify(d.banners)}`)
  check('私密提示出现', d.banners.some((b) => /私密笔记/.test(b)), `实际 ${JSON.stringify(d.banners)}`)

  resetStub()
  stub.myId = 2002 // 换成非作者
  await goto('/notes/7001')
  d = await cdp.evaluate(SNAP_NOTE_DETAIL)
  check('非作者看不到可见性切换', d.visibilityBtn === null, `实际 ${d.visibilityBtn}`)
  check('非作者看不到编辑入口', !d.hasEdit)
  check('非作者仍可复制链接', d.actionTexts.some((t) => /复制链接/.test(t)), `实际 ${JSON.stringify(d.actionTexts)}`)
  check('非作者看不到草稿私密提示', d.banners.length === 0, `实际 ${JSON.stringify(d.banners)}`)

  /* ==================== 11. 详情页 · 错误态分诊 ==================== */
  console.log('\n[12. 笔记详情页 · 错误态分诊]')
  /*
   * T7 起详情页按 `ApiError.code` 分诊：403 私密 / 404 不存在 / 其它兜底。
   * 旧断言是「一句话同时覆盖『已删除』与『私密笔记』」——那是**合并文案时代**的写法，
   * 与 T1.5 项目级约定 D（禁止按 message 文本判断失败类型）冲突，已随 T7 废弃。
   * 这里改成三条分支各断各的，顺带覆盖桩原先造不出来的 403 / 404。
   */
  resetStub()
  stub.detailFailCode = 404
  await goto('/notes/7001')
  d = await cdp.evaluate(SNAP_NOTE_DETAIL)
  check('404：进入错误态', d.hasError)
  check('404：标题为「笔记不存在或已删除」', d.errorTitle === '笔记不存在或已删除', `实际 ${d.errorTitle}`)
  check('404：描述说明「已被作者删除」', /已被作者删除/.test(d.errorDesc ?? ''), `实际 ${d.errorDesc}`)
  check('404：没有误报成「无权查看」', !/无权/.test(d.errorTitle ?? ''), `实际 ${d.errorTitle}`)

  resetStub()
  stub.detailFailCode = 403
  await goto('/notes/7001')
  d = await cdp.evaluate(SNAP_NOTE_DETAIL)
  check('403：标题为「无权查看这篇笔记」', d.errorTitle === '无权查看这篇笔记', `实际 ${d.errorTitle}`)
  check(
    '403：描述中性（不把 403 说死成「私密」—— 草稿也是 403）',
    /只有作者本人/.test(d.errorDesc ?? '') && !/私密/.test(d.errorDesc ?? ''),
    `实际 ${d.errorDesc}`,
  )
  check('403：没有误报成「不存在」', !/不存在/.test(d.errorTitle ?? ''), `实际 ${d.errorTitle}`)

  resetStub()
  // 桩的 fail() 恒为 HTTP 500 + code=500 → 正好覆盖「未知 code 走通用兜底」这一条
  stub.detailFails = true
  await goto('/notes/7001')
  d = await cdp.evaluate(SNAP_NOTE_DETAIL)
  check('未知 code：落到通用「笔记加载失败」', d.errorTitle === '笔记加载失败', `实际 ${d.errorTitle}`)
  check(
    '未知 code：描述不泄露内部信息',
    /网络问题|后端服务/.test(d.errorDesc ?? ''),
    `实际 ${d.errorDesc}`,
  )

  resetStub()
  await clickByText(cdp, '.cm-error__actions .el-button', '重新加载')
  await sleep(1400)
  d = await cdp.evaluate(SNAP_NOTE_DETAIL)
  check('重试后恢复正常', !d.hasError && d.title === NOTE_DETAIL.title, `实际 title=${d.title}`)

  /* ==================== 12. 编辑器 · 新建 ==================== */
  console.log('\n[13. 笔记编辑器 · 新建与必填拦截]')
  resetStub()
  await goto('/notes/create')
  let e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('路由停在 /notes/create', e.url === '/notes/create', `实际 ${e.url}`)
  check('标题为「写笔记」', e.h1 === '写笔记', `实际 ${e.h1}`)
  check('标题输入框为空', e.titleValue === '', `实际 ${JSON.stringify(e.titleValue)}`)
  check('正文输入框为空', e.contentValue === '', `实际 ${JSON.stringify(e.contentValue)}`)
  check(
    '两个提交按钮（存为草稿 / 创建笔记）',
    JSON.stringify(e.headButtons) === JSON.stringify(['存为草稿', '创建笔记']),
    `实际 ${JSON.stringify(e.headButtons)}`,
  )
  check('默认可见性为私密', e.visibilityActive === '私密', `实际 ${e.visibilityActive}`)
  check('有封面占位', e.coverPlaceholder)

  requestLog.length = 0
  await clickByText(cdp, '.cm-note-editor__head-actions .el-button', '创建笔记')
  await sleep(800)
  check(
    '缺标题/正文/分类时不发请求',
    requestLog.filter((r) => /createNote/.test(r.path)).length === 0,
    `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`,
  )
  check('给出校验提示', await cdp.evaluate(`!!document.querySelector('.el-message--warning')`))

  /* ==================== 13. 编辑器 · 无分类阻断 ==================== */
  console.log('\n[14. 笔记编辑器 · 一个分类都没有时提前阻断]')
  resetStub()
  stub.treeEmpty = true
  await goto('/notes/create')
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('出现阻断横幅', e.blocker, `实际 ${e.blocker}`)
  check('横幅说明分类是必填', /分类是必填项/.test(e.blockerText ?? ''), `实际 ${e.blockerText}`)
  check('横幅给出「去创建分类」出路', /去创建分类/.test(e.blockerText ?? ''), `实际 ${e.blockerText}`)
  /*
   * T7 起**刻意不禁用**提交按钮：禁用按钮点下去零反馈，用户只会以为页面卡住；
   * 而且工单验收原文是「**点**提交 → 被阻断」，禁用按钮根本点不动、没法验。
   * 所以正确的不变量是「按钮可点 + 请求被 submit() 拦下 + 有明确提示」，不是「按钮禁用」。
   */
  check(
    '提交按钮保持可点（刻意不禁用：禁用了点下去零反馈）',
    JSON.stringify(e.headButtonsDisabled) === JSON.stringify([false, false]),
    `实际 ${JSON.stringify(e.headButtonsDisabled)}`,
  )
  requestLog.length = 0
  await clickByText(cdp, '.cm-note-editor__head-actions .el-button', '创建笔记')
  await sleep(900)
  check(
    '点提交被 submit() 拦下（0 个创建请求发出去）',
    requestLog.filter((r) => /createNote/.test(r.path)).length === 0,
    `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`,
  )
  check(
    '给出「先创建分类」的警告提示',
    await cdp.evaluate(
      `[...document.querySelectorAll('.el-message--warning')].some(e => /分类/.test(e.textContent))`,
    ),
  )

  /* ==================== 14. 编辑器 · 编辑回显 + multipart ==================== */
  console.log('\n[15. 笔记编辑器 · 编辑回显与 multipart 提交]')
  resetStub()
  await goto('/notes/7001/edit')
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('路由停在编辑态', e.url === '/notes/7001/edit', `实际 ${e.url}`)
  check('标题为「编辑笔记」', e.h1 === '编辑笔记', `实际 ${e.h1}`)
  check('标题回显', e.titleValue === NOTE_DETAIL.title, `实际 ${JSON.stringify(e.titleValue)}`)
  check('正文回显', (e.contentValue ?? '').includes('看门狗是什么'), `实际 ${(e.contentValue ?? '').slice(0, 30)}`)
  check(
    '分类回显为 Spring（下拉里带树形前缀）',
    stripTreePrefix(e.categoryText) === 'Spring',
    `实际 ${JSON.stringify(e.categoryText)}`,
  )
  check('可见性回显为公开', e.visibilityActive === '公开', `实际 ${e.visibilityActive}`)
  check(
    '两个已有标签都回显（Java / Redis）',
    JSON.stringify(e.selectedTagChips) === JSON.stringify(['Java', 'Redis']),
    `实际 chips=${JSON.stringify(e.selectedTagChips)} text=${e.tagText}`,
  )
  /*
   * 2.12 已于 2026-09-17 由 TagController 实现，T5 / T7 都已接入标签多选。
   * 旧断言「没有标签选择控件（后端无标签列表接口）」查的是 `.cm-note-editor__tags` 包裹层 ——
   * 该元素已随重构删掉，选择器恒为 null，断言**恒真**（假通过）。这里改成正面断言。
   */
  check(
    '标签是多选控件（不是只读胶囊）',
    await cdp.evaluate(
      `!!document.querySelector('.cm-note-editor__tag-select') &&
       !!document.querySelector('.cm-note-editor__tag-select .el-select__wrapper')`,
    ),
  )
  check(
    '整页请求了 2.12 /api/tag/list（候选集来自接口）',
    requestLog.some((r) => r.path === '/api/tag/list'),
    `实际请求：${requestLog.map((r) => r.path).join(', ')}`,
  )
  check('实时预览已渲染', e.hasPreview && e.previewH2 >= 1, `实际 previewH2=${e.previewH2}`)

  requestLog.length = 0
  await clickByText(cdp, '.cm-note-editor__head-actions .el-button', '更新笔记')
  await sleep(1600)
  const putReq = requestLog.find((r) => r.method === 'PUT' && /^\/api\/note\/7001$/.test(r.path))
  check('打到 PUT /api/note/7001', !!putReq, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check(
    'Content-Type 是 multipart/form-data 且带 boundary',
    /^multipart\/form-data;\s*boundary=/.test(putReq?.contentType ?? ''),
    `实际 ${putReq?.contentType}`,
  )
  check(
    '未手动设置 Content-Type（boundary 由浏览器生成）',
    /boundary=[\w-]{10,}/.test(putReq?.contentType ?? ''),
    `实际 ${putReq?.contentType}`,
  )
  check('title 字段存在', countField(putReq?.raw, 'title') === 1, `实际 ${countField(putReq?.raw, 'title')}`)
  check('categoryId 字段存在', countField(putReq?.raw, 'categoryId') === 1)
  check('status 字段为 1', /name="status"\r?\n\r?\n1\r?\n/.test(putReq?.raw ?? ''), '发布应提交 status=1')
  check(
    'tagIds 重复 append 两次（不是数组）',
    countField(putReq?.raw, 'tagIds') === 2,
    `实际 ${countField(putReq?.raw, 'tagIds')} 次`,
  )
  check(
    'tagIds 不出现数组字面量',
    !/name="tagIds"\r?\n\r?\n\[/.test(putReq?.raw ?? ''),
    'FormData 里重复 append 才是正确做法',
  )
  check(
    '编辑时未选新文件 → 不传 file 字段',
    countField(putReq?.raw, 'file') === 0,
    `实际 ${countField(putReq?.raw, 'file')} 次（不传即保留原封面）`,
  )
  check('保存成功后跳到详情页', (await cdp.evaluate(`location.pathname`)) === '/notes/7001', '保存后应跳详情')
  check(
    '保存成功后不再弹「未保存」确认框',
    !(await cdp.evaluate(`!!document.querySelector('.el-message-box')`)),
    'resetBaseline 没做的话这里会被守卫拦下',
  )

  /* ==================== 15. 编辑器 · 封面上传 ==================== */
  console.log('\n[16. 笔记编辑器 · 封面上传链路]')
  resetStub()
  await goto('/notes/create')
  await setInput(cdp, '.cm-note-editor__title-input input', '封面测试笔记')
  await setInput(cdp, '.cm-note-editor__textarea textarea', '# 正文\n\n用来验证封面链路。')

  // 选分类
  await cdp.evaluate(`(() => {
    const wrapper = [...document.querySelectorAll('.cm-note-editor__control')][0]
      ?.querySelector('.el-select__wrapper')
    wrapper?.click()
    return true
  })()`)
  await sleep(500)
  const catClicked = await clickVisibleOption(cdp, 'Spring')
  await sleep(400)
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check(
    '分类已选中 Spring',
    catClicked === true && stripTreePrefix(e.categoryText) === 'Spring',
    `点击命中=${catClicked}｜实际 ${JSON.stringify(e.categoryText)}`,
  )

  /** 用 CDP 把文件塞进原生 file input */
  async function upload(selector, filePath) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId })
    await sleep(400)
    // setFileInputFiles 一般会派发 change；保险起见补一次（重复触发无副作用）
    if (!(await cdp.evaluate(`!!document.querySelector('.cm-note-editor__cover-preview img')`))) {
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new Event('change', { bubbles: true }))`,
      )
      await sleep(300)
    }
  }

  await upload('.cm-note-editor__file-input', txtPath)
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('非图片文件被拒', e.coverPreviewSrc === null, `实际 ${e.coverPreviewSrc}`)
  check(
    '提示「封面只支持图片文件」',
    await cdp.evaluate(
      `[...document.querySelectorAll('.el-message--error')].some(m => /只支持图片文件/.test(m.textContent))`,
    ),
  )

  await upload('.cm-note-editor__file-input', bigCoverPath)
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('超过 5MB 的图片被拒', e.coverPreviewSrc === null, `实际 ${e.coverPreviewSrc}`)
  check(
    '提示「不能超过 5 MB」',
    await cdp.evaluate(
      `[...document.querySelectorAll('.el-message--error')].some(m => /5 MB/.test(m.textContent))`,
    ),
  )

  await upload('.cm-note-editor__file-input', coverPath)
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check(
    '合法图片生成本地预览（blob: URL）',
    (e.coverPreviewSrc ?? '').startsWith('blob:'),
    `实际 ${e.coverPreviewSrc}`,
  )
  check('选中文件后出现「撤销选择」', e.coverRemoveBtn, `实际 ${e.coverRemoveBtn}`)

  requestLog.length = 0
  await clickByText(cdp, '.cm-note-editor__head-actions .el-button', '创建笔记')
  await sleep(1600)
  const postReq = requestLog.find((r) => r.path === '/api/note/createNote')
  check('打到 POST /api/note/createNote', !!postReq, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check('status=1（发布）', /name="status"\r?\n\r?\n1\r?\n/.test(postReq?.raw ?? ''))
  check('带上了 file 字段', countField(postReq?.raw, 'file') === 1, `实际 ${countField(postReq?.raw, 'file')} 次`)
  check(
    'file 字段带文件名与图片 MIME',
    /filename="cover\.png"/.test(postReq?.raw ?? '') && /Content-Type: image\/png/.test(postReq?.raw ?? ''),
    'multipart 里必须带 filename 与 part 的 Content-Type',
  )
  check('无 tagIds 时不出现该字段', countField(postReq?.raw, 'tagIds') === 0, `实际 ${countField(postReq?.raw, 'tagIds')} 次`)

  /* ==================== 16.5 编辑器 · 已有封面不能假装删掉 ==================== */
  console.log('\n[16.5 笔记编辑器 · 已有封面的回显与「不能删除」]')
  resetStub()
  stub.detailOverride = { cover: 'https://example.com/old-note-cover.png' }
  await goto('/notes/7001/edit')
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check(
    '编辑模式回显已有封面',
    e.coverPreviewSrc === 'https://example.com/old-note-cover.png',
    `实际 ${e.coverPreviewSrc}`,
  )
  check(
    '已有封面时**不提供**删除按钮（接口没有删除封面的能力）',
    !e.coverRemoveBtn,
    '点了删不掉却让界面看起来删掉了，属于欺骗用户',
  )
  check(
    '改为如实提示「接口不支持删除已有封面」',
    /接口不支持删除已有封面/.test(e.coverHint ?? ''),
    `实际 ${e.coverHint}`,
  )

  await upload('.cm-note-editor__file-input', coverPath)
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('选新图后预览变成 blob', (e.coverPreviewSrc ?? '').startsWith('blob:'), `实际 ${e.coverPreviewSrc}`)
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.cm-note-editor__cover-ops .el-button')]
      .find(x => /撤销选择/.test(x.textContent))
    b.click()
    return true
  })()`)
  await sleep(500)
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check(
    '撤销选择后把原封面显示回来（不是留空）',
    e.coverPreviewSrc === 'https://example.com/old-note-cover.png',
    `实际 ${e.coverPreviewSrc}`,
  )

  /* ==================== 17. 编辑器 · 未保存守卫 ==================== */
  console.log('\n[17. 笔记编辑器 · 未保存标记与离开守卫]')
  resetStub()
  await goto('/notes/7001/edit')
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('刚进入时没有「未保存」标记', !e.dirtyBadge)

  await setInput(cdp, '.cm-note-editor__title-input input', '改了标题的笔记')
  await sleep(300)
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('输入后立刻出现「未保存」标记', e.dirtyBadge, 'deep watch 缺失时这里不会亮')

  await clickByText(cdp, '.cm-header__nav-item', '社区')
  await sleep(700)
  e = await cdp.evaluate(SNAP_NOTE_EDITOR)
  check('有改动时离开被拦下（弹确认框）', e.messageBox, `实际 messageBox=${e.messageBox}`)
  check('拦截后仍停在编辑页', e.url === '/notes/7001/edit', `实际 ${e.url}`)
  await cdp.evaluate(
    `[...document.querySelectorAll('.el-message-box__btns .el-button')].find(b => /取消/.test(b.textContent))?.click()`,
  )
  await sleep(400)

  /* ==================== 17. 分类管理 · 树与折叠 ==================== */
  console.log('\n[18. 分类管理 · 树渲染与折叠]')
  resetStub()
  await goto('/categories')
  let c = await cdp.evaluate(SNAP_CATEGORIES)
  check('路由停在 /categories', c.url === '/categories', `实际 ${c.url}`)
  check('页标题正确', c.title === '分类管理', `实际 ${c.title}`)
  check('渲染 6 行（含子分类）', c.rows.length === 6, `实际 ${c.rows.length}`)
  check(
    '顶级顺序按 sort 倒序：Java > Redis > 前端',
    JSON.stringify(c.topNames) === JSON.stringify(['Java', 'Redis', '前端']),
    `实际 ${JSON.stringify(c.topNames)}`,
  )
  check(
    'Java 的子分类紧随其后',
    JSON.stringify(c.names.slice(0, 3)) === JSON.stringify(['Java', 'Spring', 'JVM']),
    `实际 ${JSON.stringify(c.names.slice(0, 3))}`,
  )
  check('子分类缩进比父分类深', c.rows[1]?.indent === '30px', `实际 ${c.rows[1]?.indent}`)
  check('顶级分类缩进为 8px', c.rows[0]?.indent === '8px', `实际 ${c.rows[0]?.indent}`)
  check('有子分类的行有折叠箭头', c.rows[0]?.hasToggle === true)
  check('叶子分类没有折叠箭头', c.rows[2]?.hasToggle === false, `实际 ${c.rows[2]?.hasToggle}`)
  check(
    '概览：总数 6 / 顶级 3 / 最大层级 2',
    JSON.stringify(c.stats.map((s) => s.value)) === JSON.stringify(['6', '3', '2']),
    `实际 ${JSON.stringify(c.stats)}`,
  )
  check('第一个分类「上移」按钮禁用', c.rows[0]?.upDisabled === true)
  check('最后一个分类「下移」按钮禁用', c.rows[5]?.downDisabled === true)

  await cdp.evaluate(
    `[...document.querySelectorAll('.cm-categories__row')][0].querySelector('.cm-categories__toggle').click()`,
  )
  await sleep(400)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('折叠 Java 后剩 4 行', c.rows.length === 4, `实际 ${c.rows.length}`)
  check('折叠后 Java 的子分类消失', !c.names.includes('Spring'), `实际 ${JSON.stringify(c.names)}`)

  await cdp.evaluate(
    `[...document.querySelectorAll('.cm-categories__row')][0].querySelector('.cm-categories__toggle').click()`,
  )
  await sleep(400)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('再点一次恢复 6 行', c.rows.length === 6, `实际 ${c.rows.length}`)

  /* ==================== 18. 分类管理 · 新建 ==================== */
  console.log('\n[19. 分类管理 · 新建分类]')
  resetStub()
  await goto('/categories')
  requestLog.length = 0
  await clickByText(cdp, '.cm-categories__head-actions .el-button', '新建分类')
  await sleep(600)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('弹窗打开', c.dialogOpen)
  await setInput(cdp, '.el-dialog .el-form-item:nth-child(1) input.el-input__inner', 'Go 语言')
  await sleep(200)
  await confirmDialog(cdp)
  await sleep(1400)
  let catReq = requestLog.find((r) => r.path === '/api/category/createCategory')
  check('打到 POST /api/category/createCategory', !!catReq, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check('顶级分类提交 parentId=0', catReq?.body?.parentId === 0, `实际 ${JSON.stringify(catReq?.body)}`)
  check('提交 name 正确', catReq?.body?.name === 'Go 语言', `实际 ${catReq?.body?.name}`)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('创建后树自动刷新为 7 行', c.rows.length === 7, `实际 ${c.rows.length}`)
  check('新分类出现在列表里', c.names.includes('Go 语言'), `实际 ${JSON.stringify(c.names)}`)
  check('弹窗已关闭', !c.dialogOpen)

  console.log('\n[20. 分类管理 · 新建子分类与下拉选父分类]')
  resetStub()
  await goto('/categories')
  requestLog.length = 0
  await clickCategoryOp(cdp, 'Redis', '子分类')
  await sleep(600)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('从行内「子分类」打开弹窗', c.dialogOpen)
  await setInput(cdp, '.el-dialog .el-form-item:nth-child(1) input.el-input__inner', '持久化')
  await sleep(200)
  await confirmDialog(cdp)
  await sleep(1400)
  catReq = requestLog.find((r) => r.path === '/api/category/createCategory')
  check('parentId 预填为 Redis 的 id=2', catReq?.body?.parentId === 2, `实际 ${JSON.stringify(catReq?.body)}`)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('新子分类挂在 Redis 下（缩进为子级）', c.rows.some((r) => r.name === '持久化' && r.indent === '30px'), `实际 ${JSON.stringify(c.rows.map((r) => [r.name, r.indent]))}`)

  resetStub()
  await goto('/categories')
  requestLog.length = 0
  await clickByText(cdp, '.cm-categories__head-actions .el-button', '新建分类')
  await sleep(600)
  await setInput(cdp, '.el-dialog .el-form-item:nth-child(1) input.el-input__inner', '容器化')
  /*
   * ⚠️ 必须点 `.el-select__wrapper` 才是「打开下拉」。
   * 原来这里点的是 `.el-select` 根 div —— 它**不会**展开菜单，菜单内容却因为懒渲染后常驻 DOM
   * 而留在文档里（隐藏）。旧的 clickByText 会点到那个隐藏项，靠 el-option 自身的 click
   * 处理器把值改掉，于是断言「过了」但根本没验证「下拉能打开」。
   * 现在 clickVisibleOption 只点可见项，这个假通过被暴露出来 —— 是脚本的错，不是页面的错。
   */
  const parentSelectOpened = await cdp.evaluate(`(() => {
    const el = document.querySelector('.el-dialog .el-select')
    const trigger = el?.querySelector('.el-select__wrapper') ?? el
    if (!trigger) return false
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    trigger.click()
    return true
  })()`)
  await sleep(500)
  const parentPicked = await clickVisibleOption(cdp, '前端')
  if (!parentPicked) {
    console.log(
      '    [debug] 可见下拉项=',
      await cdp.evaluate(
        `JSON.stringify([...document.querySelectorAll('.el-select-dropdown__item')].map(e => ({t: e.textContent.replace(/\\s+/g,'').trim(), h: e.getBoundingClientRect().height})))`,
      ),
    )
  }
  await sleep(300)
  await confirmDialog(cdp)
  await sleep(1400)
  catReq = requestLog.find((r) => r.path === '/api/category/createCategory')
  check(
    '从下拉选父分类后 parentId 正确',
    parentSelectOpened === true && parentPicked === true && catReq?.body?.parentId === 3,
    `打开下拉=${parentSelectOpened}｜点中项=${parentPicked}｜实际 ${JSON.stringify(catReq?.body)}`,
  )

  /* ==================== 19. 分类管理 · 重命名与排序 ==================== */
  console.log('\n[21. 分类管理 · 重命名与排序]')
  resetStub()
  await goto('/categories')
  requestLog.length = 0
  await clickCategoryOp(cdp, '前端', '重命名')
  await sleep(600)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('重命名弹窗打开', c.dialogOpen)
  await setInput(cdp, '.el-dialog .el-form-item:nth-child(1) input.el-input__inner', '前端工程化')
  await sleep(200)
  await confirmDialog(cdp)
  await sleep(1400)
  const putCat = requestLog.find((r) => r.method === 'PUT' && r.path === '/api/category/3')
  check('打到 PUT /api/category/3', !!putCat, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check('提交新名称', putCat?.body?.name === '前端工程化', `实际 ${JSON.stringify(putCat?.body)}`)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('列表里名称已更新', c.names.includes('前端工程化'), `实际 ${JSON.stringify(c.names)}`)

  resetStub()
  await goto('/categories')
  requestLog.length = 0
  await clickCategoryOp(cdp, 'Redis', '上移')
  await sleep(1400)
  const sortUp = requestLog.find((r) => r.method === 'PUT' && r.path === '/api/category/2')
  check('上移打到 PUT /api/category/2', !!sortUp, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  check(
    '上移后 sort 严格大于前一个兄弟（值越大越靠前）',
    sortUp?.body?.sort === 3,
    `实际 sort=${sortUp?.body?.sort}（Java 是 2，应提交 3）`,
  )
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('Redis 升到第一位', c.topNames[0] === 'Redis', `实际 ${JSON.stringify(c.topNames)}`)

  resetStub()
  await goto('/categories')
  requestLog.length = 0
  await clickCategoryOp(cdp, 'Java', '下移')
  await sleep(1400)
  const sortDown = requestLog.find((r) => r.method === 'PUT' && r.path === '/api/category/1')
  check('下移打到 PUT /api/category/1', !!sortDown)
  check(
    '下移后 sort 严格小于后一个兄弟',
    sortDown?.body?.sort === 0,
    `实际 sort=${sortDown?.body?.sort}（Redis 是 1，应提交 0）`,
  )
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check(
    'Redis 升到第一位、Java 退到第二',
    JSON.stringify(c.topNames) === JSON.stringify(['Redis', 'Java', '前端']),
    `实际 ${JSON.stringify(c.topNames)}`,
  )

  /* ==================== 20. 分类管理 · 删除 ==================== */
  console.log('\n[22. 分类管理 · 删除与后果提示]')
  resetStub()
  await goto('/categories')
  await clickCategoryOp(cdp, '前端', '删除')
  await sleep(700)
  let boxMsg = await textOf(cdp, '.el-message-box__message')
  check('删除叶子分类弹出确认', !!boxMsg, `实际 ${boxMsg}`)
  check(
    '提示笔记分类会被置空（不是删笔记）',
    /笔记不会被删除/.test(boxMsg ?? '') && /分类会被置空/.test(boxMsg ?? ''),
    `实际 ${boxMsg}`,
  )
  requestLog.length = 0
  await confirmMessageBox(cdp)
  await sleep(1400)
  const delReq = requestLog.find((r) => r.method === 'DELETE' && r.path === '/api/category/3')
  check('打到 DELETE /api/category/3', !!delReq, `实际 ${JSON.stringify(requestLog.map((r) => `${r.method} ${r.path}`))}`)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('删除后树刷新为 5 行', c.rows.length === 5, `实际 ${c.rows.length}`)
  check('前端已从列表消失', !c.names.includes('前端'), `实际 ${JSON.stringify(c.names)}`)

  resetStub()
  await goto('/categories')
  await clickCategoryOp(cdp, 'Java', '删除')
  await sleep(700)
  boxMsg = await textOf(cdp, '.el-message-box__message')
  check(
    '删除含子分类的父分类时提示子分类处理方式未定义',
    /子分类/.test(boxMsg ?? '') && /文档未说明/.test(boxMsg ?? ''),
    `实际 ${boxMsg}`,
  )
  await cdp.evaluate(
    `[...document.querySelectorAll('.el-message-box__btns .el-button')].find(b => /取消/.test(b.textContent))?.click()`,
  )
  await sleep(500)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('点取消不删除，树保持 6 行', c.rows.length === 6, `实际 ${c.rows.length}`)

  /* ==================== 21. 分类管理 · 三态 ==================== */
  console.log('\n[23. 分类管理 · 空态与错误态]')
  resetStub()
  stub.treeEmpty = true
  await goto('/categories')
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('无分类时进入空态', c.hasEmpty)
  check('空态给出新建入口', await cdp.evaluate(`!!document.querySelector('.cm-empty__action')`))

  resetStub()
  stub.treeFails = true
  await goto('/categories')
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('分类接口失败时进入错误态', c.hasError)
  stub.treeFails = false
  await clickByText(cdp, '.cm-error__actions .el-button', '重新加载')
  await sleep(1400)
  c = await cdp.evaluate(SNAP_CATEGORIES)
  check('重试后恢复 6 行', c.rows.length === 6, `实际 ${c.rows.length}`)

  /* ==================== 22. 响应式 ==================== */
  console.log('\n[24. 响应式与横向溢出]')
  resetStub()
  const pages = [
    ['/notes', SNAP_NOTE_LIST, '笔记列表'],
    ['/notes/7001', SNAP_NOTE_DETAIL, '笔记详情'],
    ['/notes/create', SNAP_NOTE_EDITOR, '笔记编辑器'],
    ['/categories', SNAP_CATEGORIES, '分类管理'],
  ]
  for (const [p, snapExpr, label] of pages) {
    await goto(p)
    for (const w of [390, 768, 1440]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await sleep(450)
      const info = await cdp.evaluate(snapExpr)
      check(`${w}px 下${label}无横向溢出`, info.overflowX <= 0, `溢出 ${info.overflowX}px`)
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  /* ==================== 23. 运行时健康度 ==================== */
  console.log('\n[25. 运行时健康度]')
  const consoleErrors = cdp.consoleErrors().filter((x) => !/favicon/i.test(x))
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
