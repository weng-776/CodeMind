/**
 * T4 验收：文章详情（真实后端）
 * ------------------------------------------------------------------
 * 覆盖工单 T4 的验收项：
 *   1. 未登录打开详情 → 「登录后查看」（不是「加载失败」，也不跳登录页）
 *   2. 点赞乐观更新 + **失败回滚**（用 CDP Fetch 把 3.7 扣住 → 看已翻转；再 failRequest → 看回滚）
 *   3. 评论区两级结构（一级 + 回复），且不存在第三级；「查看全部 N 条回复」走 3.20
 *   4. Console 0 未捕获异常；请求头带 `token`
 * 另覆盖：Markdown+高亮+XSS 清洗、评论数取自评论列表 total、评论失败只降级评论区、
 *         作者本人可见「编辑/删除」。
 *
 * ⚠️ 测试数据：为了验证两级结构，会在**文章 14（作者就是测试账号本人）**下建
 *   1 条一级评论 + 3 条回复，验完删除一级评论（后端级联删回复）。
 *   自己评论自己的文章不产生通知（API 文档 4.5），因此不会污染别人的消息列表。
 *
 * 前置：后端 8080；账号 13800000002 / 123456（= 文章 14 的作者）。
 * 用法：node scripts/verify-t4-article-detail.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, clickByText } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5214
const DEBUG_PORT = 9349
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const PHONE = '13800000002'
const PASSWORD = '123456'
/** 文章 14 的作者就是测试账号（小明），自评自回复不会触发通知 */
const ARTICLE_ID = 14

const { check, summary } = createReporter()

/* ==================== 前置：后端 + token ==================== */
try {
  const status = await fetch(`${BACKEND}/api/article/latest`).then((r) => r.status)
  if (status !== 200) throw new Error(`latest=${status}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端。`)
  process.exit(1)
}
const loginRes = await fetch(`${BACKEND}/api/user/login/password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
}).then((r) => r.json())
const TOKEN = loginRes?.data?.token
if (!TOKEN) {
  console.log('密码登录失败：', JSON.stringify(loginRes))
  process.exit(1)
}

const api = async (method, url, body) => {
  const res = await fetch(`${BACKEND}${url}`, {
    method,
    headers: { token: TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

/* ==================== 造数据：一级评论 + 3 条回复 ==================== */
let rootCommentId = null
console.log('\n[准备] 在文章 %s 下建 1 条一级评论 + 3 条回复（验完删除）', ARTICLE_ID)
const rootRes = await api('POST', '/api/comment', {
  articleId: ARTICLE_ID,
  content: '[T4 验收] 一级评论：用于验证两级结构',
  parentId: 0,
})
rootCommentId = rootRes?.data
check('创建一级评论成功', typeof rootCommentId === 'number' && rootCommentId > 0, JSON.stringify(rootRes))

const replyIds = []
if (rootCommentId) {
  for (let i = 1; i <= 3; i += 1) {
    const r = await api('POST', '/api/comment', {
      articleId: ARTICLE_ID,
      content: `[T4 验收] 第 ${i} 条回复`,
      parentId: rootCommentId,
    })
    replyIds.push(r?.data)
  }
  check('创建 3 条回复成功', replyIds.filter((x) => typeof x === 'number').length === 3, JSON.stringify(replyIds))
}
const commentList = await api('GET', `/api/article/${ARTICLE_ID}/comment?page=1&size=20`)
const rootNode = commentList?.data?.records?.find((r) => r.id === rootCommentId)
console.log(
  `    3.16 回显：replyCount=${rootNode?.replyCount} replies=${rootNode?.replies?.length} total=${commentList?.data?.total}`,
)
check('3.16 每个根只带前 2 条 replies，replyCount 才是总数', rootNode?.replies?.length === 2 && rootNode?.replyCount === 3)

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1280,1100' })
  const cdp = browser.cdp
  await fs.mkdir(OUT_DIR, { recursive: true })

  const shoot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
  }
  const goto = async (url, wait = 2800) => {
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(150)
    await cdp.send('Page.navigate', { url })
    await sleep(wait)
  }

  /* ==================== 1. 游客：登录后查看 ==================== */
  console.log('\n[1] 未登录打开文章详情')
  await goto(`http://localhost:${PORT}/login`, 1500)
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  await goto(`http://localhost:${PORT}/articles/${ARTICLE_ID}`, 3200)
  const guest = await cdp.evaluate(`({
    path: location.pathname,
    text: document.querySelector('.cm-detail')?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 120) ?? '',
    loginBtn: [...document.querySelectorAll('.cm-detail button')].some(b => b.textContent.trim() === '立即登录'),
  })`)
  console.log(`    页面文案：${guest.text}`)
  check('显示「登录后查看」', /登录后查看/.test(guest.text), guest.text)
  check('不是「加载失败」', !/加载失败/.test(guest.text), guest.text)
  check('没有被跳去登录页', guest.path === `/articles/${ARTICLE_ID}`, `实际 ${guest.path}`)
  check('提供「立即登录」入口', guest.loginBtn === true)
  await shoot('t4-1-guest-login-required.png')

  /* ==================== 2. Markdown 渲染 / XSS 清洗 ==================== */
  console.log('\n[2] Markdown 渲染链（markdown-it → highlight.js → DOMPurify）')
  const mdCheck = await cdp.evaluate(`(async () => {
    const m = await import('/src/utils/markdown.ts')
    const html = m.renderMarkdown('# 标题\\n\\n\\u0060\\u0060\\u0060js\\nconst a = 1\\n\\u0060\\u0060\\u0060\\n\\n<img src=x onerror="alert(1)"><script>alert(2)</script>[链接](javascript:alert(3))')
    return {
      hasHeading: html.includes('<h1'),
      hasHighlight: html.includes('hljs'),
      hasScript: html.includes('<script'),
      hasOnerror: html.includes('onerror'),
      hasJsUrl: /href="javascript:/i.test(html),
    }
  })()`)
  check('Markdown 标题正常渲染', mdCheck.hasHeading === true)
  check('代码块经过 highlight.js 高亮', mdCheck.hasHighlight === true)
  check('XSS：<script> 被清洗', mdCheck.hasScript === false)
  check('XSS：onerror 被清洗', mdCheck.hasOnerror === false)
  check('XSS：javascript: 链接被清洗', mdCheck.hasJsUrl === false)

  /* ==================== 3. 登录态详情页 ==================== */
  console.log('\n[3] 登录态打开同一篇文章（作者本人视角）')
  await goto(`http://localhost:${PORT}/login`, 1200)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(TOKEN)})`)
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/articles/${ARTICLE_ID}`, 3400)
  const view = await cdp.evaluate(`({
    path: location.pathname,
    markdownBlocks: document.querySelectorAll('.cm-detail__body.cm-markdown').length,
    editBtn: [...document.querySelectorAll('.cm-detail button, .cm-detail .el-button')].some(b => /编辑/.test(b.textContent)),
    followBtn: [...document.querySelectorAll('.cm-detail .el-button')].some(b => ['关注','已关注'].includes(b.textContent.trim())),
    moreBtn: !!document.querySelector('.cm-detail__actions .el-dropdown'),
    commentRoots: document.querySelectorAll('.cm-detail__comment-list > .cm-detail__comment').length,
    inlineReplies: document.querySelectorAll('.cm-detail__replies > .cm-detail__reply').length,
    thirdLevel: document.querySelectorAll('.cm-detail__replies .cm-detail__replies').length,
    expandBtn: [...document.querySelectorAll('.cm-detail__replies-more button')].map(b => b.textContent.trim())[0] ?? null,
    metricComment: (() => {
      const items = [...document.querySelectorAll('.cm-detail__metric')]
      const hit = items.find(i => i.querySelector('dt')?.textContent?.trim() === '评论')
      return hit?.querySelector('dd')?.textContent?.trim() ?? null
    })(),
  })`)
  check('正文 Markdown 渲染出来', view.markdownBlocks >= 1)
  check('评论数取自评论列表 total', view.metricComment === String(commentList?.data?.total ?? -1), `页面 ${view.metricComment}，3.16 total ${commentList?.data?.total}`)
  check('作者本人看到「编辑」入口', view.editBtn === true)
  check('作者本人不显示「关注」按钮', view.followBtn === false)
  check('作者本人有更多操作（删除文章）', view.moreBtn === true)
  check('渲染出一级评论', view.commentRoots >= 1, `实际 ${view.commentRoots}`)
  check('一级下渲染出前 2 条回复', view.inlineReplies === 2, `实际 ${view.inlineReplies}`)
  check('不存在第三级回复', view.thirdLevel === 0, `实际 ${view.thirdLevel}`)
  check('出现「查看全部 3 条回复」', view.expandBtn === '查看全部 3 条回复', `实际 ${view.expandBtn}`)
  await shoot('t4-2-comment-two-levels.png')

  /* ---- 3.20 展开全部回复 ---- */
  console.log('    → 点「查看全部 3 条回复」，验证 3.20')
  cdp.clearEvents()
  await clickByText(cdp, '.cm-detail__replies-more button', '查看全部')
  await sleep(2000)
  const expanded = await cdp.evaluate(`({
    replies: document.querySelectorAll('.cm-detail__replies > .cm-detail__reply').length,
    thirdLevel: document.querySelectorAll('.cm-detail__replies .cm-detail__replies').length,
    expandBtn: document.querySelectorAll('.cm-detail__replies-more button').length,
    replyTo: document.querySelectorAll('.cm-detail__reply-to').length,
  })`)
  const repliesReq = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/replies'))
    .map((e) => e.params.request.url)
  console.log(`    请求：${repliesReq[0]}`)
  check('3.20 请求打到 /api/comment/{rootId}/replies', repliesReq.length === 1, JSON.stringify(repliesReq))
  check('展开后显示全部 3 条回复', expanded.replies === 3, `实际 ${expanded.replies}`)
  check('展开后仍没有第三级', expanded.thirdLevel === 0)
  check('全部显示后不再有「查看全部」按钮', expanded.expandBtn === 0, `实际 ${expanded.expandBtn}`)
  await shoot('t4-3-replies-expanded.png')

  /* ==================== 4. 点赞：乐观更新 + 失败回滚 ==================== */
  console.log('\n[4] 点赞：扣住 3.7 看乐观更新，再让它失败看回滚')
  const before = await cdp.evaluate(`(() => {
    const btn = document.querySelector('.cm-detail__actions .cm-detail__action')
    return { text: btn?.textContent?.replace(/\\s+/g, ' ').trim() ?? '', active: btn?.classList.contains('is-active') ?? null }
  })()`)
  console.log(`    点击前：${before.text}`)

  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/article/*/like*', requestStage: 'Request' }],
  })
  await cdp.evaluate(`document.querySelector('.cm-detail__actions .cm-detail__action').click()`)
  await sleep(600)
  const optimistic = await cdp.evaluate(`(() => {
    const btn = document.querySelector('.cm-detail__actions .cm-detail__action')
    return { text: btn?.textContent?.replace(/\\s+/g, ' ').trim() ?? '', active: btn?.classList.contains('is-active') ?? null }
  })()`)
  console.log(`    扣住请求时（乐观更新）：${optimistic.text}`)
  check(
    '请求还没回来，界面已翻转（乐观更新）',
    optimistic.active !== before.active,
    `${before.text} → ${optimistic.text}`,
  )
  await shoot('t4-4-like-optimistic.png')

  // 让这条被扣住的请求失败 → 必须回滚
  const heldIds = cdp.events
    .filter((e) => e.method === 'Fetch.requestPaused')
    .map((e) => e.params.requestId)
  for (const rid of heldIds) {
    await cdp.send('Fetch.failRequest', { requestId: rid, errorReason: 'Failed' }).catch(() => {})
  }
  await sleep(1600)
  const rolledBack = await cdp.evaluate(`(() => {
    const btn = document.querySelector('.cm-detail__actions .cm-detail__action')
    return {
      text: btn?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      active: btn?.classList.contains('is-active') ?? null,
      errorToast: [...document.querySelectorAll('.el-message--error')].map(e => e.textContent.trim()),
    }
  })()`)
  console.log(`    失败后：${rolledBack.text}｜提示：${JSON.stringify(rolledBack.errorToast)}`)
  check('UI 已回滚到点击前的状态', rolledBack.active === before.active, `点击前 ${before.active} → 现在 ${rolledBack.active}`)
  check(
    '失败提示只弹一次（请求层负责，页面不重复弹）',
    rolledBack.errorToast.length === 1,
    `实际 ${rolledBack.errorToast.length} 条：${JSON.stringify(rolledBack.errorToast)}`,
  )
  await shoot('t4-5-like-rollback.png')
  await cdp.send('Fetch.disable')

  /* ==================== 5. 评论失败只降级评论区 ==================== */
  console.log('\n[5] 评论接口失败 → 只降级评论区，正文照常')
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/article/*/comment*', requestStage: 'Request' }],
  })
  const failPoller = setInterval(async () => {
    const paused = cdp.events.filter((e) => e.method === 'Fetch.requestPaused')
    for (const p of paused) {
      cdp.send('Fetch.failRequest', { requestId: p.params.requestId, errorReason: 'Failed' }).catch(() => {})
    }
  }, 120)
  await goto(`http://localhost:${PORT}/articles/${ARTICLE_ID}`, 3600)
  clearInterval(failPoller)
  await sleep(600)
  const degraded = await cdp.evaluate(`({
    hasBody: document.querySelectorAll('.cm-detail__body.cm-markdown').length > 0,
    hasTitle: !!document.querySelector('.cm-detail__title')?.textContent?.trim(),
    commentError: /评论加载失败/.test(document.body.innerText),
    commentRetry: [...document.querySelectorAll('#cm-comments button, #cm-comments .el-button')].some(b => /重新加载|重试/.test(b.textContent)),
  })`)
  check('正文仍然正常显示', degraded.hasBody === true && degraded.hasTitle === true)
  check('评论区进入错误态', degraded.commentError === true)
  check('评论区提供重试', degraded.commentRetry === true)
  await shoot('t4-6-comments-degraded.png')
  await cdp.send('Fetch.disable')

  /* ==================== 6. 请求头 token ==================== */
  console.log('\n[6] Network 请求头检查')
  // 注意：不能只判 url.includes('/api/') —— Vite 的源码模块地址（/src/api/request.ts）
  // 也含这一段，会被误判成接口请求。必须解析出 pathname 再判前缀。
  const isApiCall = (url) => {
    try {
      return new URL(url).pathname.startsWith('/api/')
    } catch {
      return false
    }
  }
  const apiReqs = cdp.events.filter(
    (e) => e.method === 'Network.requestWillBeSent' && isApiCall(e.params.request.url),
  )
  const missingToken = apiReqs.filter((e) => !e.params.request.headers.token)
  const withAuthz = apiReqs.filter((e) => typeof e.params.request.headers.Authorization === 'string').length
  console.log(`    /api 请求共 ${apiReqs.length} 条，缺 token 头的 ${missingToken.length} 条；另带 Authorization 的 ${withAuthz} 条`)
  check('所有 /api 请求都带 token 头', missingToken.length === 0, missingToken.map((e) => e.params.request.url).join(' | '))
  await fs.writeFile(
    path.join(OUT_DIR, 't4-network-evidence.json'),
    JSON.stringify(
      {
        点赞请求: cdp.events
          .filter((e) => e.method === 'Network.requestWillBeSent' && /\/like/.test(e.params.request.url))
          .map((e) => ({ url: e.params.request.url, method: e.params.request.method, token: !!e.params.request.headers.token })),
        回复请求: repliesReq,
        评论结构: { 一级: view.commentRoots, 内联回复: view.inlineReplies, 展开后回复: expanded.replies, 第三级: expanded.thirdLevel },
      },
      null,
      2,
    ),
  )

  /* ==================== 7. 运行时健康度 ==================== */
  console.log('\n[7] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp.consoleErrors().filter((t) => !/Failed to load resource|ERR_|net::/i.test(t))
  console.log(`    未捕获异常 ${exceptions.length} 条；console.error ${consoleErrs.length} 条`)
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（网络失败日志除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  /* ==================== 清理测试数据 ==================== */
  if (rootCommentId) {
    const del = await api('DELETE', `/api/comment/${rootCommentId}`)
    console.log(`\n[清理] 删除一级评论 ${rootCommentId}（级联删除其回复）：${JSON.stringify(del)}`)
  }
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
console.log(`截图与证据已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
