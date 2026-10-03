/**
 * T20 验收：修「创建接口返回裸数字 id」的前端契约（真实后端 + 真实 Chrome）
 * ------------------------------------------------------------------
 * 覆盖工单 T20 的验收清单（`管理端前端设计说明.md` §0.6 · T20）：
 *   [0] 后端契约：`POST /api/article` 与 `POST /api/comment` 的 `data` 确实是**裸数字**
 *   [0.5] 源码级断言：两处泛型已改成 `number`；`ArticleEditView` 直接取数字 + 数字守卫
 *   [1] ⭐ **端到端**：创建一篇草稿文章 → 真的落到 `/articles/<新 id>`
 *       - URL 里的 id **等于** `POST /api/article` 响应里的数字
 *       - **不是** `/profile/articles`（旧 bug 也会「跳转」，只是跳到「我的文章」）
 *       - 详情页渲染出**刚建的内容**（标题 + 正文），不是空页
 *   [2] 数据清理：造的草稿用 `DELETE /api/admin/articles/{id}` 删掉，
 *       并回查 `GET /api/admin/articles?keyword=<标题>` 的 `total === 0`
 *   [3] 控制台 0 未捕获异常、0 console.error
 *
 * ⚠️ 关于「`newId` 实测是 number」这条断言：
 *    `newId` 是 `ArticleEditView` 里 `submit()` 的**函数内局部变量**，黑盒浏览器测试
 *    无法直接读到它（挂到 window 上就是往生产代码里塞测试钩子，不可接受）。
 *    所以这里用三层证据把它的类型钉死：
 *      ① 源码级：`const newId = await createArticle(...)` + `typeof newId === 'number'`
 *         + `Number.isFinite(newId)`，且文件里**不再出现** `res?.id`；
 *      ② 契约级：响应 `data` 的 `typeof` 就是 `number`；
 *      ③ 行为级：SPA 实际 push 的 URL 是 `/articles/<那个数字>`（hook `history.pushState` 抓的），
 *         而不是旧 bug 会走到的 `/profile/articles`。
 *    ③ 是决定性的：旧代码 `res?.id` 恒 `undefined`，**必然**落到 `/profile/articles`。
 *
 * 前置：后端 8080 在跑。
 * 用法（package.json 在禁止清单里，用绝对路径跑）：
 *   "/c/Users/翁甲燃/.workbuddy/binaries/node/versions/22.22.2-3/node" scripts/verify-t20-article-id.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'

import {
  createReporter,
  launchBrowser,
  setInput,
  sleep,
} from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
/** 端口与既有脚本错开（… T19=5230/9364） */
const PORT = 5231
const DEBUG_PORT = 9365
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const ADMIN = { phone: '13800000002', password: '123456', name: '小明' }
/** 评论挂在这篇文章下（种子数据，仅用于挂载） */
const HOST_ARTICLE_ID = 8

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
const adminHeaders = { token: adminToken }
const adminDelete = (p) =>
  fetch(`${BACKEND}${p}`, { method: 'DELETE', headers: adminHeaders }).then((r) => r.json())

/** 造的样本 id（清理用） */
let apiArticleId = null
let uiArticleId = null
let apiCommentId = null

/** 标题前缀：用于回查是否清理干净 */
const TITLE_PREFIX = `T20验收${Date.now()}`

async function cleanup() {
  for (const [label, id] of [
    ['UI 草稿文章', uiArticleId],
    ['契约文章', apiArticleId],
  ]) {
    if (!id) continue
    try {
      const r = await adminDelete(`/api/admin/articles/${id}`)
      console.log(`    ↩ 清理${label} id=${id} → code=${r?.code}${r?.code === 404 ? '（已删过）' : ''}`)
    } catch (e) {
      console.log(`    ⚠ 清理${label}失败：${e.message}`)
    }
  }
  if (apiCommentId) {
    try {
      const r = await adminDelete(`/api/admin/comments/${apiCommentId}`)
      console.log(`    ↩ 清理契约评论 id=${apiCommentId} → code=${r?.code}`)
    } catch (e) {
      console.log(`    ⚠ 清理评论失败：${e.message}`)
    }
  }
}

/* ==================== [0] 后端契约核验 ==================== */
console.log('\n[0] 后端契约核验（直接打后端，不经过页面）')
check('管理员可密码登录', typeof adminToken === 'string' && adminToken.length > 20)

// 0.1 POST /api/article → data 是裸数字
const artForm = new FormData()
artForm.append('title', `${TITLE_PREFIX} 契约文章`)
artForm.append('content', `# ${TITLE_PREFIX}\n\nT20 契约核验样本。`)
artForm.append('status', '0')
const artRes = await fetch(`${BACKEND}/api/article`, {
  method: 'POST',
  headers: { token: adminToken },
  body: artForm,
}).then((r) => r.json())
console.log(`    POST /api/article → ${JSON.stringify(artRes)}`)
check('POST /api/article 返回 code=200', artRes?.code === 200, JSON.stringify(artRes))
check('POST /api/article 的 data **是 number**（不是 {id}）', typeof artRes?.data === 'number', `${typeof artRes?.data}: ${JSON.stringify(artRes?.data)}`)
check('data 是正整数', Number.isInteger(artRes?.data) && artRes.data > 0, String(artRes?.data))
check('data 不是对象（旧标注 {id} 是错的）', typeof artRes?.data !== 'object' || artRes?.data === null)
apiArticleId = artRes?.data

// 0.2 这个 id 真的能读到文章
const artDetail = await fetch(`${BACKEND}/api/article/${apiArticleId}`, { headers: adminHeaders }).then((r) => r.json())
console.log(`    GET /api/article/${apiArticleId} → code=${artDetail?.code} title=${JSON.stringify(artDetail?.data?.title)}`)
check('用返回的 id 能读到刚建的文章', artDetail?.code === 200 && artDetail?.data?.id === apiArticleId, JSON.stringify(artDetail?.code))

// 0.3 POST /api/comment → data 也是裸数字
const cmtRes = await fetch(`${BACKEND}/api/comment`, {
  method: 'POST',
  headers: { token: adminToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({ articleId: HOST_ARTICLE_ID, content: `${TITLE_PREFIX} 契约评论`, parentId: 0 }),
}).then((r) => r.json())
console.log(`    POST /api/comment → ${JSON.stringify(cmtRes)}`)
check('POST /api/comment 的 data **是 number**（不是 {id}）', typeof cmtRes?.data === 'number', `${typeof cmtRes?.data}: ${JSON.stringify(cmtRes?.data)}`)
apiCommentId = cmtRes?.data

/* ==================== [0.5] 源码级断言 ==================== */
console.log('\n[0.5] 源码级断言（类型标注与守卫是否真的改了）')
const apiSource = await fs.readFile(path.resolve(process.cwd(), 'src/api/article.ts'), 'utf8')
const viewSource = await fs.readFile(
  path.resolve(process.cwd(), 'src/views/article/ArticleEditView.vue'),
  'utf8',
)

check(
  'api/article.ts: createArticle 泛型是 number',
  /http\.post<number>\(\s*'\/article'/.test(apiSource),
  '未找到 http.post<number>(\'/article\'',
)
check(
  'api/article.ts: createComment 泛型是 number',
  /http\.post<number>\(\s*'\/comment'/.test(apiSource),
  '未找到 http.post<number>(\'/comment\'',
)
check(
  'api/article.ts: 已不存在 http.post<{ id: number }>',
  !/http\.post<\{\s*id:\s*number\s*\}>/.test(apiSource),
  '仍有旧的 { id: number } 标注',
)
check(
  'ArticleEditView: 直接取创建返回值（const newId = await createArticle）',
  /const newId = await createArticle\(/.test(viewSource),
  '未找到 const newId = await createArticle(',
)
check('ArticleEditView: 有 typeof newId === \'number\' 守卫', /typeof newId === 'number'/.test(viewSource))
check('ArticleEditView: 有 Number.isFinite(newId) 守卫', /Number\.isFinite\(newId\)/.test(viewSource))
check('ArticleEditView: 已不存在 res?.id 的旧写法', !/res\?\.id/.test(viewSource), '仍有 res?.id')

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
  const bodyOf = async (requestId) => {
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId })
      return JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body)
    } catch {
      return null
    }
  }

  /* ==================== [1] 端到端：建草稿 → 跳新详情页 ==================== */
  console.log('\n[1] 端到端：创建草稿文章 → 跳到新文章详情页')

  // 先用真实后端拿 token（登录链路本身由 T1 覆盖，这里不重复测）
  await goto(`http://localhost:${PORT}/login`, 1500)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(adminToken)})`)
  await goto(`http://localhost:${PORT}/articles/create`, 3000)

  const editorPath = await urlOf()
  console.log(`    编辑器地址：${editorPath}`)
  check('停在 /articles/create', editorPath.startsWith('/articles/create'), editorPath)

  // 挂钩 history.pushState，抓住 SPA 真正推入的 URL（比「看最终地址」更硬）
  await cdp.evaluate(`(() => {
    window.__pushed = []
    if (!window.__pushHooked) {
      window.__pushHooked = true
      const orig = history.pushState.bind(history)
      history.pushState = function (state, title, url) {
        window.__pushed.push(String(url))
        return orig(state, title, url)
      }
    }
    return true
  })()`)

  const UI_TITLE = `${TITLE_PREFIX} UI 草稿文章`
  const UI_BODY = `# ${TITLE_PREFIX}\n\n这是 T20 验收用正文，用来确认详情页真的渲染出了刚建的内容。`
  await setInput(cdp, '.cm-editor__title-input input', UI_TITLE)
  await setInput(cdp, '.cm-editor__textarea textarea', UI_BODY)
  await sleep(400)
  await shoot('t20-1-editor-filled.png')

  cdp.clearEvents()
  // index 0 = 存为草稿
  await cdp.evaluate(`document.querySelectorAll('.cm-editor__head-actions .el-button')[0].click()`)
  await sleep(3000)

  const createReq = cdp.events.find(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.method === 'POST' && e.params.request.url.endsWith('/api/article'),
  )
  const createResp = cdp.events.find(
    (e) => e.method === 'Network.responseReceived' && e.params.response.url.endsWith('/api/article'),
  )
  const createBody = createResp ? await bodyOf(createResp.params.requestId) : null
  const returnedId = createBody?.data
  /*
   * ⚠️ Vue Router 往 `history.pushState` 推的是**绝对 URL**（`http://host:port/articles/39`），
   * 不是路径。所以要在页面里先归一化成 pathname+search 再比对 ——
   * 否则 `pushed.includes('/articles/39')` 会假红，而 `/profile/articles` 那条又会**空过**。
   */
  const pushed = await cdp.evaluate(`(window.__pushed ?? []).map((u) => {
    try { const parsed = new URL(u, location.origin); return parsed.pathname + parsed.search } catch { return String(u) }
  })`)
  const finalUrl = await urlOf()

  console.log(`    POST /api/article 响应：${JSON.stringify(createBody)}`)
  console.log(`    SPA 推入的 URL：${JSON.stringify(pushed)}`)
  console.log(`    最终地址：${finalUrl}`)

  check('发出了 POST /api/article', Boolean(createReq))
  check('响应 code=200', createBody?.code === 200, JSON.stringify(createBody))
  check(
    '响应 data 是 number（契约级证据）',
    typeof returnedId === 'number' && Number.isInteger(returnedId) && returnedId > 0,
    `${typeof returnedId}: ${JSON.stringify(returnedId)}`,
  )
  uiArticleId = typeof returnedId === 'number' ? returnedId : null

  check(
    '⭐ 最终落到 /articles/<新 id>（id 与响应数字一致）',
    finalUrl === `/articles/${returnedId}`,
    `最终=${finalUrl} 期望=/articles/${returnedId}`,
  )
  check(
    '⭐ SPA push 的 URL 也是 /articles/<新 id>（行为级证据）',
    pushed.includes(`/articles/${returnedId}`),
    JSON.stringify(pushed),
  )
  check(
    '**不是** /profile/articles（旧 bug 的落点）',
    !finalUrl.startsWith('/profile/articles') && !pushed.some((u) => u.startsWith('/profile/articles')),
    JSON.stringify({ finalUrl, pushed }),
  )

  // 详情页真的渲染出刚建的内容
  await sleep(1200)
  const detailTitle = await cdp.evaluate(
    `document.querySelector('.cm-detail__title')?.textContent?.trim() ?? null`,
  )
  const detailText = await bodyText()
  console.log(`    详情页标题：${JSON.stringify(detailTitle)}`)
  check('详情页标题 = 刚建的标题', detailTitle === UI_TITLE, JSON.stringify(detailTitle))
  check('详情页渲染出刚建的正文', detailText.includes('这是 T20 验收用正文'), detailText.slice(0, 140))
  check('详情页不是错误/空白页', !detailText.includes('内容不存在') && detailText.length > 60, String(detailText.length))
  await shoot('t20-2-new-article-detail.png')

  // 后端确认这篇文章真存在、id 对得上
  const persisted = await fetch(`${BACKEND}/api/article/${uiArticleId}`, { headers: adminHeaders }).then((r) => r.json())
  console.log(`    后端回查：code=${persisted?.code} id=${persisted?.data?.id} title=${JSON.stringify(persisted?.data?.title)}`)
  check('后端回查该 id 能读到这篇文章', persisted?.code === 200 && persisted?.data?.id === uiArticleId, JSON.stringify(persisted?.code))
  check('后端回查标题一致', persisted?.data?.title === UI_TITLE, JSON.stringify(persisted?.data?.title))

  /* ==================== [2] 数据清理 ==================== */
  console.log('\n[2] 数据清理（脚本结束后回查 total=0）')
  await cleanup()
  uiArticleId = null
  apiArticleId = null
  apiCommentId = null

  const leftover = await fetch(
    `${BACKEND}/api/admin/articles?keyword=${encodeURIComponent(TITLE_PREFIX)}`,
    { headers: adminHeaders },
  ).then((r) => r.json())
  console.log(`    回查 keyword=${TITLE_PREFIX} → total=${leftover?.data?.total}`)
  check('清理干净：按标题前缀回查 total=0', leftover?.data?.total === 0, String(leftover?.data?.total))

  const leftoverCmt = await fetch(
    `${BACKEND}/api/admin/comments?keyword=${encodeURIComponent(TITLE_PREFIX)}`,
    { headers: adminHeaders },
  ).then((r) => r.json())
  check('契约评论也清理干净', leftoverCmt?.data?.total === 0, String(leftoverCmt?.data?.total))

  /* ==================== [3] 运行时健康度 ==================== */
  console.log('\n[3] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp
    .consoleErrors()
    .filter((t) => !/Failed to load resource|ERR_|net::|MinIO|404 \(Not Found\)/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（网络/图片失败除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  await cleanup()
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
