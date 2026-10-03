/**
 * T18 验收：管理端 · 内容治理（真实后端 + 真实 Chrome）
 * ------------------------------------------------------------------
 * 覆盖工单 T18 的验收项（`管理端前端设计说明.md` §6）：
 *   0. 后端契约核验：三个列表的分页/筛选字段、400/404 错误分支
 *   1. **未登录**访问 /admin/content → 跳 `/login?redirect=…`
 *   2. 管理员登录 → 默认「文章」tab 渲染，列齐全
 *   3. 文章：**草稿标签可见**；下架 → 恢复 能往返
 *   4. 文章：状态筛选（草稿 / 公开）
 *   5. 文章：分页
 *   6. 文章：**删除二次确认**，文案如实说明后果（连带删标签/评论/点赞/收藏、移出向量库）；
 *      点取消 → 不发请求、行还在；点确认 → 行消失 + 后端 404
 *   7. 笔记：切 tab；**草稿 / 私密标签都可见**；可见性筛选；恢复 → 转草稿
 *   8. 笔记：删除
 *   9. 评论：切 tab；列表；按文章 ID 筛选；删除
 *  10. loading 态可见（CDP 延迟逼出）；error 态带重试（CDP 阻断逼出）
 *  11. **非管理员** → 明确「无管理员权限」
 *  12. 所有 `/api/admin/*` 请求头都是 `token`
 *  13. 控制台 0 未捕获异常、0 console.error
 *
 * ⚠️ 删除不可逆，所以本脚本**全部自造自清**：开始时造 1 篇草稿文章、1 篇私密草稿笔记、
 *    1 条评论，`finally` 里兜底删掉（删不到就是 404，无害）。**不碰任何种子数据。**
 *
 * ⚠️ 实测坑（写脚本前先踩过）：
 *    - `POST /api/article` 与 `POST /api/comment` 的 `data` 是**裸数字 id**，不是 `{id}`；
 *      `POST /api/note/createNote` 也是裸数字。前端 `api/article.ts` 里写的 `{ id: number }` 与之不符
 *      （见交接块「遗留问题」）。
 *    - 列表排序是 **createTime DESC**，所以新造的数据排在第 1 条；但仍统一用 `keyword` 定位，最稳。
 *
 * 前置：后端 8080 在跑。
 * 用法（package.json 在禁止清单里，用绝对路径跑）：
 *   "/c/Users/翁甲燃/.workbuddy/binaries/node/versions/22.22.2-3/node" scripts/verify-t18-admin.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'

import {
  cancelMessageBox,
  clickByText,
  confirmMessageBox,
  createReporter,
  launchBrowser,
  setInput,
  sleep,
} from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
/** 端口与既有脚本错开（… T17=5228/9362） */
const PORT = 5229
const DEBUG_PORT = 9363
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const ADMIN = { phone: '13800000002', password: '123456', name: '小明' }
const NORMAL = { phone: '13800000003', password: '123456', name: '小红' }
/** 造数据用的分类（2.1 的 categoryId 必填，挂到已有分类下） */
const CATEGORY_ID = 7
/** 评论挂在这篇文章下（种子数据，仅用于挂载，不动它） */
const HOST_ARTICLE_ID = 8

/** 本轮的样本前缀，用于 keyword 精确定位 */
const PREFIX = `T18验收${Date.now()}`

const { check, summary } = createReporter()

/* ==================== 前置：后端可达 ==================== */
try {
  const status = await fetch(`${BACKEND}/api/article/latest`).then((r) => r.status)
  if (status !== 200) throw new Error(`latest=${status}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端。`)
  process.exit(1)
}

async function apiLogin(phone, password) {
  const res = await fetch(`${BACKEND}/api/user/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  }).then((r) => r.json())
  return res?.data?.token ?? null
}

const adminToken = await apiLogin(ADMIN.phone, ADMIN.password)
const normalToken = await apiLogin(NORMAL.phone, NORMAL.password)
const adminHeaders = { token: adminToken }

const adminGet = (p) => fetch(`${BACKEND}${p}`, { headers: adminHeaders }).then((r) => r.json())
const adminDelete = (p) =>
  fetch(`${BACKEND}${p}`, { method: 'DELETE', headers: adminHeaders }).then((r) => r.json())

/** 造的样本 id（清理用） */
let articleId = null
let noteId = null
let commentId = null

/**
 * 兜底清理：把本轮造的样本删掉。
 *
 * ⚠️ 返回值是**每条删除的结果**，由调用方（`finally`）纳入 `check()` ——
 * 核验方 §12.4：T17/T18/T19 连续三单的清理段都只有 `console.log`，
 * 清理失败时脚本照样全绿、EXIT=0，会静默留下 `is_delete=0` 的**活数据**
 * （出现在管理列表里、影响计数）。
 */
async function cleanup() {
  const results = []
  const targets = [
    ['评论', commentId && `/api/admin/comments/${commentId}`],
    ['笔记', noteId && `/api/admin/notes/${noteId}`],
    ['文章', articleId && `/api/admin/articles/${articleId}`],
  ]
  for (const [label, url] of targets) {
    if (!url) continue
    try {
      const r = await adminDelete(url)
      console.log(`    ↩ 清理${label} → code=${r?.code}${r?.code === 404 ? '（已删过）' : ''}`)
      results.push({ label, code: r?.code ?? null })
    } catch (e) {
      console.log(`    ⚠ 清理${label}失败：${e.message}`)
      results.push({ label, code: null, error: e.message })
    }
  }
  return results
}

/* ==================== [0] 后端契约核验 ==================== */
console.log('\n[0] 后端契约核验（直接打后端，不经过页面）')
check('管理员可密码登录', typeof adminToken === 'string' && adminToken.length > 20)
check('普通用户可密码登录', typeof normalToken === 'string' && normalToken.length > 20)

// 0.1 三个列表的分页字段
for (const [label, p] of [
  ['文章', '/api/admin/articles'],
  ['笔记', '/api/admin/notes'],
  ['评论', '/api/admin/comments'],
]) {
  const d = (await adminGet(`${p}?page=1&size=2`))?.data ?? {}
  console.log(`    ${label}：total=${d.total} size=${d.size} current=${d.current} pages=${d.pages} records=${d.records?.length}`)
  check(`${label} 分页字段齐全（无 page 字段）`, ['records', 'total', 'size', 'current', 'pages'].every((k) => k in d) && !('page' in d))
  check(`${label} size 生效`, d.records?.length === 2, String(d.records?.length))
}

// 0.2 列表 VO 字段
const art0 = (await adminGet('/api/admin/articles?page=1&size=1'))?.data?.records?.[0] ?? {}
console.log(`    文章字段：${Object.keys(art0).join(', ')}`)
check(
  '文章 VO 字段齐全（含 author 对象）',
  ['id', 'userId', 'author', 'title', 'summary', 'cover', 'viewCount', 'likeCount', 'favoriteCount', 'status', 'createTime'].every((k) => k in art0),
  JSON.stringify(Object.keys(art0)),
)
check('文章列表**不含正文 content**（刻意设计）', !('content' in art0))
check('author 是内嵌对象', typeof art0.author === 'object' && 'userName' in (art0.author ?? {}))

const note0 = (await adminGet('/api/admin/notes?page=1&size=1'))?.data?.records?.[0] ?? {}
console.log(`    笔记字段：${Object.keys(note0).join(', ')}`)
check(
  '笔记 VO 有 categoryId / visibility / wordCount',
  ['categoryId', 'visibility', 'wordCount'].every((k) => k in note0),
  JSON.stringify(Object.keys(note0)),
)
check('笔记列表不含正文 content', !('content' in note0))

const cmt0 = (await adminGet('/api/admin/comments?page=1&size=1'))?.data?.records?.[0] ?? {}
console.log(`    评论字段：${Object.keys(cmt0).join(', ')}`)
check(
  '评论 VO 有 articleId / parentId / content',
  ['id', 'articleId', 'userId', 'author', 'parentId', 'content', 'createTime'].every((k) => k in cmt0),
  JSON.stringify(Object.keys(cmt0)),
)

// 0.3 筛选参数
const vis0 = await adminGet('/api/admin/notes?page=1&size=3&visibility=0')
console.log(`    notes?visibility=0 → total=${vis0?.data?.total}（私密笔记，设计意图不是越权）`)
check('notes 支持 visibility=0（能拿到私密笔记）', (vis0?.data?.total ?? 0) > 0, String(vis0?.data?.total))
check('私密笔记的 visibility 都是 0', (vis0?.data?.records ?? []).every((r) => r.visibility === 0))

const cmtByArticle = await adminGet(`/api/admin/comments?page=1&size=5&articleId=${HOST_ARTICLE_ID}`)
console.log(`    comments?articleId=${HOST_ARTICLE_ID} → total=${cmtByArticle?.data?.total}`)
check(
  'comments 支持 articleId 筛选',
  (cmtByArticle?.data?.records ?? []).every((r) => r.articleId === HOST_ARTICLE_ID),
  JSON.stringify((cmtByArticle?.data?.records ?? []).map((r) => r.articleId)),
)

// 0.4 错误分支
const badArtStatus = await adminGet('/api/admin/articles?status=2')
console.log(`    articles?status=2 → code=${badArtStatus?.code}「${badArtStatus?.message}」`)
check('文章 status=2 → 业务 code 400', badArtStatus?.code === 400, JSON.stringify(badArtStatus))

const badNoteStatus = await adminGet('/api/admin/notes?status=2')
console.log(`    notes?status=2 → code=${badNoteStatus?.code}「${badNoteStatus?.message}」`)
check('笔记 status=2 → 业务 code 400', badNoteStatus?.code === 400, JSON.stringify(badNoteStatus))

const badVisibility = await adminGet('/api/admin/notes?visibility=2')
console.log(`    notes?visibility=2 → code=${badVisibility?.code}「${badVisibility?.message}」`)
check('笔记 visibility=2 → 业务 code 400', badVisibility?.code === 400, JSON.stringify(badVisibility))

const overSize = await adminGet('/api/admin/articles?page=1&size=51')
check('size=51 → 业务 code 400', overSize?.code === 400, JSON.stringify(overSize))

const putMissing = await fetch(`${BACKEND}/api/admin/articles/999999/status?status=1`, {
  method: 'PUT',
  headers: adminHeaders,
}).then((r) => r.json())
console.log(`    PUT 不存在文章 → code=${putMissing?.code}「${putMissing?.message}」`)
check('PUT 不存在文章 → 业务 code 404', putMissing?.code === 404, JSON.stringify(putMissing))

const delMissing = await adminDelete('/api/admin/comments/999999')
console.log(`    DELETE 不存在评论 → code=${delMissing?.code}「${delMissing?.message}」`)
check('DELETE 不存在评论 → 业务 code 404', delMissing?.code === 404, JSON.stringify(delMissing))

// 0.5 权限三分支
const noToken = await fetch(`${BACKEND}/api/admin/articles`)
check('无 token → HTTP 401', noToken.status === 401, String(noToken.status))
const normalRes = await fetch(`${BACKEND}/api/admin/articles`, { headers: { token: normalToken } })
const normalBody = await normalRes.json()
console.log(`    非管理员 → HTTP ${normalRes.status}，code=${normalBody?.code}`)
check('非管理员 → HTTP 403 + 业务 code 403', normalRes.status === 403 && normalBody?.code === 403, `${normalRes.status}/${normalBody?.code}`)

/* ==================== [0.5] 造数据 ==================== */
console.log(`\n[0.5] 造样本（前缀 ${PREFIX}）`)

// 草稿文章
const artForm = new FormData()
artForm.append('title', `${PREFIX} 草稿文章`)
artForm.append('content', `# ${PREFIX}\n\nT18 验收样本，用于草稿标签 / 下架恢复 / 删除。`)
artForm.append('status', '0')
const artRes = await fetch(`${BACKEND}/api/article`, {
  method: 'POST',
  headers: { token: adminToken },
  body: artForm,
}).then((r) => r.json())
articleId = artRes?.data // ⚠️ 裸数字，不是 {id}
console.log(`    草稿文章 id=${articleId}（响应 data 是裸数字）`)
check('草稿文章创建成功（data 是裸数字 id）', typeof articleId === 'number' && articleId > 0, JSON.stringify(artRes))

// 私密草稿笔记
const noteForm = new FormData()
noteForm.append('title', `${PREFIX} 私密草稿笔记`)
noteForm.append('content', `# ${PREFIX}\n\nT18 验收样本，用于草稿/私密标签与删除。`)
noteForm.append('categoryId', String(CATEGORY_ID))
noteForm.append('visibility', '0')
noteForm.append('status', '0')
const noteRes = await fetch(`${BACKEND}/api/note/createNote`, {
  method: 'POST',
  headers: { token: adminToken },
  body: noteForm,
}).then((r) => r.json())
noteId = noteRes?.data
console.log(`    私密草稿笔记 id=${noteId}（响应 data 是裸数字）`)
check('私密草稿笔记创建成功', typeof noteId === 'number' && noteId > 0, JSON.stringify(noteRes))

// 评论
const cmtRes = await fetch(`${BACKEND}/api/comment`, {
  method: 'POST',
  headers: { token: adminToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({ articleId: HOST_ARTICLE_ID, content: `${PREFIX} 测试评论`, parentId: 0 }),
}).then((r) => r.json())
commentId = cmtRes?.data
console.log(`    评论 id=${commentId}（响应 data 是裸数字）`)
check('评论创建成功', typeof commentId === 'number' && commentId > 0, JSON.stringify(cmtRes))

// 三个 keyword 都能精确命中样本
const artHit = await adminGet(`/api/admin/articles?keyword=${encodeURIComponent(PREFIX)}`)
const noteHit = await adminGet(`/api/admin/notes?keyword=${encodeURIComponent(PREFIX)}`)
const cmtHit = await adminGet(`/api/admin/comments?keyword=${encodeURIComponent(PREFIX)}`)
console.log(`    keyword 命中：文章 ${artHit?.data?.total} / 笔记 ${noteHit?.data?.total} / 评论 ${cmtHit?.data?.total}`)
check('keyword 精确命中草稿文章', artHit?.data?.records?.[0]?.id === articleId, JSON.stringify(artHit?.data?.total))
check('keyword 精确命中私密草稿笔记', noteHit?.data?.records?.[0]?.id === noteId, JSON.stringify(noteHit?.data?.total))
check('keyword 精确命中评论', cmtHit?.data?.records?.[0]?.id === commentId, JSON.stringify(cmtHit?.data?.total))

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
let cdp

try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1440,1000' })
  cdp = browser.cdp
  await fs.mkdir(OUT_DIR, { recursive: true })

  const shoot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
  }
  const goto = async (url, wait = 2400) => {
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(150)
    await cdp.send('Page.navigate', { url })
    await sleep(wait)
  }
  const urlOf = () => cdp.evaluate(`location.pathname + location.search`)
  const bodyText = () => cdp.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').trim()`)
  const clearToken = () => cdp.evaluate(`localStorage.removeItem('codemind_token')`)

  const loginViaUi = async (account, redirect) => {
    await goto(`http://localhost:${PORT}/login`, 1600)
    await clearToken()
    const target = redirect
      ? `http://localhost:${PORT}/login?redirect=${encodeURIComponent(redirect)}`
      : `http://localhost:${PORT}/login`
    await goto(target, 2200)
    await clickByText(cdp, '.cm-login__tab', '密码登录')
    await sleep(500)
    await setInput(cdp, '.cm-login__form input:nth-of-type(1)', account.phone)
    await setInput(cdp, '.cm-login__form input[type="password"]', account.password)
    await sleep(300)
    await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
    await sleep(2800)
  }

  /** 读表格：表头 + 每行的单元格文本、标签、操作按钮 */
  const readTable = () =>
    cdp.evaluate(`(() => {
      const table = document.querySelector('.cm-table')
      if (!table) return null
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
      const rows = [...table.querySelectorAll('tbody tr')].map((tr) => ({
        cells: [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\\s+/g, ' ').trim()),
        title: tr.querySelector('.cm-table__title')?.textContent?.trim() ?? '',
        comment: tr.querySelector('.cm-table__comment')?.textContent?.trim() ?? '',
        badges: [...tr.querySelectorAll('.cm-badge')].map((b) => b.textContent.trim()),
        buttons: [...tr.querySelectorAll('td:last-child button')].map((b) => ({
          text: b.textContent.replace(/\\s+/g, ''),
          disabled: b.disabled === true,
        })),
      }))
      return { heads, rows }
    })()`)

  /** 点某行的操作按钮（按单元格内的标识文本定位；每次重查，避免引用脱离文档） */
  const clickRowButton = (matchSelector, matchText, btnText) =>
    cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.cm-table tbody tr')]
      const tr = rows.find((r) => (r.querySelector(${JSON.stringify(matchSelector)})?.textContent?.trim() ?? '') === ${JSON.stringify(matchText)})
      if (!tr) return false
      const btn = [...tr.querySelectorAll('td:last-child button')].find((b) => b.textContent.replace(/\\s+/g, '') === ${JSON.stringify(btnText)})
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()`)

  /**
   * 读**当前可见**的确认弹窗。
   * ⚠️ 不能直接 `querySelector('.el-message-box__message')`：关掉的弹窗可能仍留在 DOM，
   *    取到的会是**上一个**弹窗的文案（本轮要连开三个不同的删除确认）。
   *    所以取「尺寸非 0 的弹窗」里的**最后一个**。
   */
  const dialogInfo = () =>
    cdp.evaluate(`(() => {
      const boxes = [...document.querySelectorAll('.el-message-box')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      const box = boxes[boxes.length - 1]
      if (!box) return { visible: false, text: '' }
      return {
        visible: true,
        text: (box.querySelector('.el-message-box__message')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      }
    })()`)

  const adminRequests = () =>
    cdp.events.filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        e.params.request.url.includes('/api/admin/') &&
        !e.params.request.url.includes('/api/admin/dashboard'),
    )
  const writeRequests = () =>
    cdp.events.filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        e.params.request.url.includes('/api/admin/') &&
        ['PUT', 'DELETE'].includes(e.params.request.method),
    )

  const setLatency = (ms) =>
    cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: ms,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })

  /** 切到某个内容 tab（SPA 内点击，不刷新页面） */
  const switchContentTab = async (label, wait = 1800) => {
    await clickByText(cdp, '.cm-tabs__item', label)
    await sleep(wait)
  }
  /** 用 keyword 把样本搜出来 */
  const searchKeyword = async (text, wait = 1700) => {
    await setInput(cdp, '.cm-filters__search input', text)
    await sleep(wait)
  }
  const clearKeyword = async (wait = 1800) => {
    await setInput(cdp, '.cm-filters__search input', '')
    await sleep(wait)
  }

  /* ==================== [1] 未登录 ==================== */
  console.log('\n[1] 未登录访问 /admin/content')
  await goto(`http://localhost:${PORT}/`, 1600)
  await clearToken()
  await goto(`http://localhost:${PORT}/admin/content`, 2800)
  const anonUrl = await urlOf()
  console.log(`    地址：${anonUrl}`)
  check('被送到 /login', anonUrl.startsWith('/login'), anonUrl)
  check('redirect 保留了 /admin/content', decodeURIComponent(anonUrl).includes('redirect=/admin/content'), anonUrl)

  /* ==================== [2] 管理员登录 → 文章 tab ==================== */
  console.log('\n[2] 管理员登录 → 内容治理')
  await loginViaUi(ADMIN, '/admin/content')
  const listUrl = await urlOf()
  console.log(`    地址：${listUrl}`)
  check('登录后落到 /admin/content', listUrl.startsWith('/admin/content'), listUrl)

  const tabsText = await cdp.evaluate(
    `[...document.querySelectorAll('.cm-tabs__item')].map((b) => b.textContent.trim()).join(',')`,
  )
  console.log(`    内容 tab：${tabsText}`)
  check('三个 tab 都在（文章/笔记/评论）', tabsText === '文章,笔记,评论', tabsText)

  const articleTable = await readTable()
  console.log(`    表头：${JSON.stringify(articleTable?.heads)}`)
  console.log(`    行数：${articleTable?.rows.length}`)
  check('默认在文章 tab 且渲染了表格', (articleTable?.rows.length ?? 0) > 0, String(articleTable?.rows.length))
  check(
    '文章表头齐全',
    JSON.stringify(articleTable?.heads) === JSON.stringify(['文章', '作者', '数据', '状态', '发布时间', '操作']),
    JSON.stringify(articleTable?.heads),
  )
  check('每行都有状态标签', articleTable?.rows.every((r) => r.badges.length >= 1))
  await shoot('t18-1-article-tab.png')

  /* ==================== [3] 文章：草稿标签 + 下架/恢复 ==================== */
  console.log(`\n[3] 文章：草稿标签 + 下架/恢复（样本 id=${articleId}）`)
  await searchKeyword(PREFIX)
  const draftUrl = await urlOf()
  let draftTable = await readTable()
  let draftRow = draftTable?.rows?.[0]
  console.log(`    URL：${draftUrl}`)
  console.log(`    样本行：${JSON.stringify(draftRow)}`)
  check('keyword 把样本文章搜出来了', draftTable?.rows.length === 1, String(draftTable?.rows.length))
  check('URL 带上 keyword', decodeURIComponent(draftUrl).includes(`keyword=${PREFIX}`), draftUrl)
  check('草稿文章显示「草稿 / 已下架」标签', draftRow?.badges.includes('草稿 / 已下架') === true, JSON.stringify(draftRow?.badges))
  check('草稿文章的按钮是「恢复」', draftRow?.buttons?.[0]?.text === '恢复', JSON.stringify(draftRow?.buttons))
  check('作者列显示「小明」', (draftRow?.cells?.[1] ?? '').includes(ADMIN.name), String(draftRow?.cells?.[1]))
  check('数据列显示浏览/赞/藏', /浏览/.test(draftRow?.cells?.[2] ?? '') && /赞/.test(draftRow?.cells?.[2] ?? ''), String(draftRow?.cells?.[2]))
  await shoot('t18-2-draft-badge.png')

  // 恢复 → 公开
  cdp.clearEvents()
  const restored = await clickRowButton('.cm-table__title', `${PREFIX} 草稿文章`, '恢复')
  await sleep(2000)
  let rowAfterRestore = (await readTable())?.rows?.[0]
  console.log(`    恢复后：${JSON.stringify(rowAfterRestore?.badges)} 按钮=${JSON.stringify(rowAfterRestore?.buttons)}`)
  check('点「恢复」成功', restored === true)
  check('恢复后标签变「公开」', rowAfterRestore?.badges.includes('公开') === true, JSON.stringify(rowAfterRestore?.badges))
  check('恢复后按钮变「下架」', rowAfterRestore?.buttons?.[0]?.text === '下架', JSON.stringify(rowAfterRestore?.buttons))
  const restoredApi = await adminGet(`/api/admin/articles?keyword=${encodeURIComponent(PREFIX)}`)
  check('后端已落库 status=1', restoredApi?.data?.records?.[0]?.status === 1, String(restoredApi?.data?.records?.[0]?.status))

  // 下架 → 草稿
  cdp.clearEvents()
  await clickRowButton('.cm-table__title', `${PREFIX} 草稿文章`, '下架')
  await sleep(2000)
  const rowAfterDown = (await readTable())?.rows?.[0]
  console.log(`    下架后：${JSON.stringify(rowAfterDown?.badges)} 按钮=${JSON.stringify(rowAfterDown?.buttons)}`)
  check('下架后标签回到「草稿 / 已下架」', rowAfterDown?.badges.includes('草稿 / 已下架') === true, JSON.stringify(rowAfterDown?.badges))
  const downApi = await adminGet(`/api/admin/articles?keyword=${encodeURIComponent(PREFIX)}`)
  check('后端已落库 status=0', downApi?.data?.records?.[0]?.status === 0, String(downApi?.data?.records?.[0]?.status))
  const putReqs = writeRequests().filter((e) => e.params.request.method === 'PUT')
  console.log(`    PUT 请求：${putReqs.map((e) => e.params.request.url).join(' | ')}`)
  check('下架走的是 query（?status=0）', putReqs.some((e) => e.params.request.url.includes('status=0')), putReqs.length)

  /* ==================== [4] 文章：状态筛选 ==================== */
  console.log('\n[4] 文章：状态筛选')
  await clearKeyword()
  await clickByText(cdp, '[aria-label="状态筛选"] .cm-seg__item', '草稿')
  await sleep(1800)
  const draftFilterUrl = await urlOf()
  const draftOnly = await readTable()
  console.log(`    草稿筛选 URL：${draftFilterUrl}，行数=${draftOnly?.rows.length}`)
  check('URL 带上 status=0', draftFilterUrl.includes('status=0'), draftFilterUrl)
  check(
    '筛选后每行都是草稿标签',
    (draftOnly?.rows ?? []).every((r) => r.badges.includes('草稿 / 已下架')),
    JSON.stringify((draftOnly?.rows ?? []).map((r) => r.badges)),
  )
  check('样本草稿出现在草稿筛选里', (draftOnly?.rows ?? []).some((r) => r.title === `${PREFIX} 草稿文章`))
  await shoot('t18-3-status-filter.png')

  await clickByText(cdp, '[aria-label="状态筛选"] .cm-seg__item', '公开')
  await sleep(1800)
  const pubOnly = await readTable()
  console.log(`    公开筛选行数=${pubOnly?.rows.length}`)
  check('筛选「公开」后样本草稿不在其中', !(pubOnly?.rows ?? []).some((r) => r.title === `${PREFIX} 草稿文章`))
  check('公开筛选里都是「公开」标签', (pubOnly?.rows ?? []).every((r) => r.badges.includes('公开')))

  await clickByText(cdp, '[aria-label="状态筛选"] .cm-seg__item', '全部')
  await sleep(1800)
  check('切回「全部」后 URL 不带 status', !(await urlOf()).includes('status='), await urlOf())

  /* ==================== [5] 文章：分页 ==================== */
  console.log('\n[5] 文章：分页')
  const artPage1 = await readTable()
  const pagerOk = await clickByText(cdp, '.cm-content-pager .el-pager li', '2')
  await sleep(1800)
  const artPage2Url = await urlOf()
  const artPage2 = await readTable()
  console.log(`    点第 2 页=${pagerOk}，URL=${artPage2Url}，行数=${artPage2?.rows.length}`)
  check('文章翻页器可点第 2 页', pagerOk === true)
  check('URL 带上 page=2', artPage2Url.includes('page=2'), artPage2Url)
  check(
    '第 2 页内容与第 1 页不同',
    JSON.stringify(artPage2?.rows?.map((r) => r.title)) !== JSON.stringify(artPage1?.rows?.map((r) => r.title)),
  )
  await shoot('t18-4-article-page2.png')
  await clickByText(cdp, '.cm-content-pager .el-pager li', '1')
  await sleep(1800)

  /* ==================== [6] 文章：删除（二次确认） ==================== */
  console.log('\n[6] 文章：删除二次确认')
  await searchKeyword(PREFIX)
  cdp.clearEvents()
  const delClicked = await clickRowButton('.cm-table__title', `${PREFIX} 草稿文章`, '删除')
  await sleep(800)
  const delInfo = await dialogInfo()
  console.log(`    删除确认文案：${delInfo.text}`)
  check('点删除弹出了二次确认', delClicked === true && delInfo.visible === true, delInfo.text)
  check('文案如实说明后果（连带删标签/评论/点赞/收藏）', delInfo.text.includes('将连带删除其标签、评论、点赞、收藏'), delInfo.text)
  check('文案说明会从向量库移除', delInfo.text.includes('向量库'), delInfo.text)
  check('文案说明不可恢复', delInfo.text.includes('不可恢复'), delInfo.text)
  await shoot('t18-5-delete-confirm.png')

  // 取消 → 不发请求、行还在
  await cancelMessageBox(cdp)
  await sleep(1200)
  const afterCancel = await readTable()
  console.log(`    取消后行数=${afterCancel?.rows.length}，写请求数=${writeRequests().length}`)
  check('取消后没有发出任何 PUT/DELETE 请求', writeRequests().length === 0, String(writeRequests().length))
  check('取消后样本文章还在', afterCancel?.rows.some((r) => r.title === `${PREFIX} 草稿文章`) === true)

  // 确认 → 真删
  cdp.clearEvents()
  await clickRowButton('.cm-table__title', `${PREFIX} 草稿文章`, '删除')
  await sleep(700)
  await confirmMessageBox(cdp)
  await sleep(2200)
  const afterDelete = await readTable()
  const delApi = await adminGet(`/api/admin/articles?keyword=${encodeURIComponent(PREFIX)}`)
  console.log(`    删除后页面行数=${afterDelete?.rows.length}，后端 total=${delApi?.data?.total}`)
  check('删除后样本从列表消失', !(afterDelete?.rows ?? []).some((r) => r.title === `${PREFIX} 草稿文章`))
  check('后端已查不到该文章', delApi?.data?.total === 0, String(delApi?.data?.total))
  const delReqs = writeRequests().filter((e) => e.params.request.method === 'DELETE')
  console.log(`    DELETE 请求：${delReqs.map((e) => e.params.request.url).join(' | ')}`)
  check('DELETE 请求带上了正确的文章 id', delReqs.some((e) => e.params.request.url.endsWith(`/api/admin/articles/${articleId}`)), delReqs.length)
  articleId = null // 已删，清理时跳过

  /* ==================== [7] 笔记 tab ==================== */
  console.log('\n[7] 笔记 tab：草稿 / 私密标签')
  await switchContentTab('笔记')
  const noteTabUrl = await urlOf()
  console.log(`    切 tab 后 URL：${noteTabUrl}`)
  check('URL 带上 tab=note', noteTabUrl.includes('tab=note'), noteTabUrl)
  check('切 tab 清空了上一 tab 的筛选', !noteTabUrl.includes('keyword='), noteTabUrl)

  const noteTable = await readTable()
  console.log(`    笔记表头：${JSON.stringify(noteTable?.heads)}`)
  check(
    '笔记表头齐全',
    JSON.stringify(noteTable?.heads) === JSON.stringify(['笔记', '作者', '数据', '状态', '创建时间', '操作']),
    JSON.stringify(noteTable?.heads),
  )
  const allBadges = (noteTable?.rows ?? []).flatMap((r) => r.badges)
  console.log(`    首屏标签样本：${JSON.stringify(allBadges.slice(0, 8))}`)
  check('笔记列表出现「草稿」标签', allBadges.includes('草稿'))
  check('笔记列表出现「私密」标签', allBadges.includes('私密'))
  check('笔记列表出现「公开」标签', allBadges.includes('公开'))
  await shoot('t18-6-note-tab.png')

  // 可见性筛选
  await clickByText(cdp, '[aria-label="可见性筛选"] .cm-seg__item', '私密')
  await sleep(1800)
  const privateUrl = await urlOf()
  const privateTable = await readTable()
  console.log(`    私密筛选 URL：${privateUrl}，行数=${privateTable?.rows.length}`)
  check('URL 带上 visibility=0', privateUrl.includes('visibility=0'), privateUrl)
  check(
    '筛选后每行都是「私密」',
    (privateTable?.rows ?? []).every((r) => r.badges.includes('私密')),
    JSON.stringify((privateTable?.rows ?? []).map((r) => r.badges)),
  )
  await shoot('t18-7-note-private.png')

  // 样本笔记（私密+草稿）：恢复 → 转草稿
  await searchKeyword(PREFIX)
  const noteRow = (await readTable())?.rows?.[0]
  console.log(`    样本笔记行：${JSON.stringify(noteRow)}`)
  check('样本笔记同时有「草稿」和「私密」标签', noteRow?.badges.includes('草稿') === true && noteRow?.badges.includes('私密') === true, JSON.stringify(noteRow?.badges))
  check('样本笔记按钮是「恢复」', noteRow?.buttons?.[0]?.text === '恢复', JSON.stringify(noteRow?.buttons))

  cdp.clearEvents()
  await clickRowButton('.cm-table__title', `${PREFIX} 私密草稿笔记`, '恢复')
  await sleep(2000)
  const noteRestored = (await readTable())?.rows?.[0]
  console.log(`    恢复后：${JSON.stringify(noteRestored?.badges)} 按钮=${JSON.stringify(noteRestored?.buttons)}`)
  check('恢复后状态标签变「正常」', noteRestored?.badges.includes('正常') === true, JSON.stringify(noteRestored?.badges))
  check('恢复后仍是「私密」（可见性不受影响）', noteRestored?.badges.includes('私密') === true, JSON.stringify(noteRestored?.badges))
  check('恢复后按钮变「转草稿」', noteRestored?.buttons?.[0]?.text === '转草稿', JSON.stringify(noteRestored?.buttons))

  await clickRowButton('.cm-table__title', `${PREFIX} 私密草稿笔记`, '转草稿')
  await sleep(2000)
  const noteBack = (await readTable())?.rows?.[0]
  check('转草稿后标签回到「草稿」', noteBack?.badges.includes('草稿') === true, JSON.stringify(noteBack?.badges))
  const noteApi = await adminGet(`/api/admin/notes?keyword=${encodeURIComponent(PREFIX)}`)
  check('后端笔记已落库 status=0', noteApi?.data?.records?.[0]?.status === 0, String(noteApi?.data?.records?.[0]?.status))

  /* ==================== [8] 笔记：删除 ==================== */
  console.log('\n[8] 笔记：删除')
  cdp.clearEvents()
  await clickRowButton('.cm-table__title', `${PREFIX} 私密草稿笔记`, '删除')
  await sleep(800)
  const noteDelInfo = await dialogInfo()
  console.log(`    笔记删除文案：${noteDelInfo.text}`)
  check('笔记删除也有二次确认', noteDelInfo.visible === true, noteDelInfo.text)
  check('文案说明不可恢复', noteDelInfo.text.includes('不可恢复'), noteDelInfo.text)
  await confirmMessageBox(cdp)
  await sleep(2200)
  const noteDelApi = await adminGet(`/api/admin/notes?keyword=${encodeURIComponent(PREFIX)}`)
  console.log(`    删除后后端 total=${noteDelApi?.data?.total}`)
  check('笔记已从后端删除', noteDelApi?.data?.total === 0, String(noteDelApi?.data?.total))
  noteId = null

  /* ==================== [9] 评论 tab ==================== */
  console.log('\n[9] 评论 tab')
  await switchContentTab('评论')
  const commentTabUrl = await urlOf()
  console.log(`    切 tab 后 URL：${commentTabUrl}`)
  check('URL 带上 tab=comment', commentTabUrl.includes('tab=comment'), commentTabUrl)

  const commentTable = await readTable()
  console.log(`    评论表头：${JSON.stringify(commentTable?.heads)}`)
  console.log(`    首行：${JSON.stringify(commentTable?.rows?.[0])}`)
  check(
    '评论表头齐全',
    JSON.stringify(commentTable?.heads) === JSON.stringify(['评论内容', '作者', '所属文章', '层级', '时间', '操作']),
    JSON.stringify(commentTable?.heads),
  )
  check('评论行有层级标签', (commentTable?.rows ?? []).every((r) => r.badges.length === 1))
  check('评论行有「所属文章」#id', (commentTable?.rows ?? []).every((r) => /^#\d+$/.test(r.cells[2] ?? '')), JSON.stringify((commentTable?.rows ?? []).map((r) => r.cells[2])))
  await shoot('t18-8-comment-tab.png')

  // 按文章 ID 筛选
  await setInput(cdp, '.cm-filters__article-id input', String(HOST_ARTICLE_ID))
  await sleep(1800)
  const cmtFilterUrl = await urlOf()
  const cmtFiltered = await readTable()
  console.log(`    文章 ID 筛选 URL：${cmtFilterUrl}，行数=${cmtFiltered?.rows.length}`)
  check('URL 带上 articleId', cmtFilterUrl.includes(`articleId=${HOST_ARTICLE_ID}`), cmtFilterUrl)
  check(
    `筛选后所属文章都是 #${HOST_ARTICLE_ID}`,
    (cmtFiltered?.rows ?? []).every((r) => r.cells[2] === `#${HOST_ARTICLE_ID}`),
    JSON.stringify((cmtFiltered?.rows ?? []).map((r) => r.cells[2])),
  )
  check('样本评论出现在筛选结果里', (cmtFiltered?.rows ?? []).some((r) => r.comment.includes(PREFIX)))
  await shoot('t18-9-comment-filter.png')

  // 删除评论
  cdp.clearEvents()
  const cmtDelClicked = await clickRowButton('.cm-table__comment', `${PREFIX} 测试评论`, '删除')
  await sleep(800)
  const cmtDelInfo = await dialogInfo()
  console.log(`    评论删除文案：${cmtDelInfo.text}`)
  check('评论删除弹出了二次确认', cmtDelClicked === true && cmtDelInfo.visible === true, cmtDelInfo.text)
  await confirmMessageBox(cdp)
  await sleep(2200)
  const cmtDelApi = await adminGet(`/api/admin/comments?keyword=${encodeURIComponent(PREFIX)}`)
  console.log(`    删除后后端 total=${cmtDelApi?.data?.total}`)
  check('评论已从后端删除', cmtDelApi?.data?.total === 0, String(cmtDelApi?.data?.total))
  commentId = null

  /* ==================== [10] loading / error 态 ==================== */
  console.log('\n[10] loading 态（CDP 延迟逼出）')
  await switchContentTab('文章')
  await setLatency(2200)
  await setInput(cdp, '.cm-filters__search input', 'JVM')
  await sleep(1100)
  const loadingVisible = await cdp.evaluate(`Boolean(document.querySelector('.cm-skeleton'))`)
  console.log(`    骨架屏可见=${loadingVisible}`)
  check('加载中有骨架屏（loading 态）', loadingVisible === true)
  await shoot('t18-10-loading.png')
  await setLatency(0)
  await sleep(2600)

  console.log('\n[10b] error 态（CDP 阻断逼出）+ 重试')
  await cdp.send('Network.setBlockedURLs', { urls: ['*/api/admin/articles*'] })
  await setInput(cdp, '.cm-filters__search input', 'JVM 内存')
  await sleep(2000)
  const errText = await bodyText()
  const hasRetry = await cdp.evaluate(`Boolean([...document.querySelectorAll('.cm-error button')].find((b) => b.textContent.includes('重新加载')))`)
  console.log(`    正文片段：${errText.slice(0, 110)}`)
  check('进错误态（「内容列表加载失败」）', errText.includes('内容列表加载失败'), errText.slice(0, 110))
  check('错误态带「重新加载」按钮', hasRetry === true)
  await shoot('t18-11-error.png')

  await cdp.send('Network.setBlockedURLs', { urls: [] })
  await cdp.evaluate(`[...document.querySelectorAll('.cm-error button')].find((b) => b.textContent.includes('重新加载'))?.click()`)
  await sleep(2200)
  const recovered = await readTable()
  check('解除阻断后重试成功', (recovered?.rows?.length ?? 0) > 0, String(recovered?.rows?.length))

  // 空态
  await setInput(cdp, '.cm-filters__search input', '__no_such_content_zzz__')
  await sleep(1800)
  const emptyText = await bodyText()
  check('搜索无结果 → 空态「没有匹配的内容」', emptyText.includes('没有匹配的内容'), emptyText.slice(0, 110))
  check('空态不是错误态', !emptyText.includes('内容列表加载失败'))
  await shoot('t18-12-empty.png')

  /* ==================== [12] 请求头 ==================== */
  console.log('\n[12] 请求头核验')
  const reqs = adminRequests()
  const badHeader = reqs.filter((e) => !e.params.request.headers.token)
  console.log(`    捕获 ${reqs.length} 个 /api/admin/*（非 dashboard）请求`)
  check('确实发出过管理端请求', reqs.length > 0, String(reqs.length))
  check('所有请求都带 token 头', badHeader.length === 0, badHeader.map((e) => e.params.request.url).join(' | '))

  /* ==================== [11] 非管理员 ==================== */
  console.log('\n[11] 非管理员（小红）访问 /admin/content')
  cdp.clearEvents()
  await loginViaUi(NORMAL, '/admin/content')
  const normalUrl = await urlOf()
  const normalText = await bodyText()
  console.log(`    地址：${normalUrl}`)
  console.log(`    正文片段：${normalText.slice(0, 130)}`)
  check('停在 /admin/content', normalUrl.startsWith('/admin/content'), normalUrl)
  check('页面明确提示「无管理员权限」', normalText.includes('无管理员权限'), normalText.slice(0, 130))
  check('不是「加载失败」', !normalText.includes('加载失败'), normalText.slice(0, 130))
  const normalAdminReqs = adminRequests()
  check('非管理员本地预检生效：未发出管理端请求', normalAdminReqs.length === 0, String(normalAdminReqs.length))
  await shoot('t18-13-forbidden.png')

  /* ==================== [13] 运行时健康度 ==================== */
  console.log('\n[13] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp
    .consoleErrors()
    .filter((t) => !/Failed to load resource|ERR_|net::|MinIO|404 \(Not Found\)/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（网络/图片失败除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  /*
   * 兜底清理 + **断言结果**（核验方 §12.4）。
   * 主流程已经删过样本，这里通常没东西可删 —— 但只要真删了，就必须断言成功；
   * 最后再按标题前缀回查一次，确认没有静默残留的活数据。
   */
  const cleaned = await cleanup()
  check(
    '兜底清理：样本都删掉或已不存在',
    cleaned.every((r) => r.code === 200 || r.code === 404),
    JSON.stringify(cleaned),
  )
  const leftover = await fetch(
    `${BACKEND}/api/admin/articles?keyword=${encodeURIComponent(PREFIX)}`,
    { headers: adminHeaders },
  )
    .then((r) => r.json())
    .catch(() => null)
  check('兜底清理：按标题前缀回查无残留', leftover?.data?.total === 0, JSON.stringify(leftover?.data?.total))
  try {
    cdp?.ws?.close()
  } catch {
    /* 忽略 */
  }
  try {
    browser?.proc?.kill()
  } catch {
    /* 忽略 */
  }
  try {
    await vite?.close()
  } catch {
    /* 忽略 */
  }
  try {
    if (browser?.profileDir) await fs.rm(browser.profileDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

const fail = summary()
console.log(`截图已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
