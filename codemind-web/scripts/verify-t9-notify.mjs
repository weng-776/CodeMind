/**
 * T9 验收：消息通知（真实后端）
 * ------------------------------------------------------------------
 * 覆盖工单 T9 的 4 条验收：
 *   1. 三类通知各出现一次；未读数与列表状态一致
 *   2. 点一条已失效的通知 → 已读状态变化（未读数 -1）+ 提示「内容已删除」+ **未发生跳转**
 *   3. 全部已读后未读数归零、角标消失
 *   4. 断网时标已读 → 回滚（贴前后未读数）
 * 另覆盖「做什么」与提醒：
 *   - 分页（URL 派生 + 翻页）
 *   - 未读数 >99 收敛为 99+（用受控响应注入 120，造 100 条真实通知不现实）
 *   - type2 两个标记都要看；type3 恒 false；失效通知照常先调 4.3
 *   - 「类型筛选」实测后端不支持（见交接块）
 *
 * ⚠️ 数据副作用（脚本会在 finally 里尽量还原，但有一项**无法还原**）：
 *   - 关注关系：测试期间让小红关注小明（用来造 type=3 通知），结束时取消关注
 *   - **通知本身无法删除**（通知是事件流水，接口没有删除能力）。所以本脚本
 *     每跑一次就会给小明留下若干条 type=3「小红关注了你」通知。
 *   - 已读状态**不可逆**（没有「标记未读」接口）。分页阶段刻意放在最后，
 *     用 10 次「关注/取关」循环产生 10 条**新的未读**通知，
 *     这样跑完账号里仍有未读，后续工单不至于拿到一个「未读永远为 0」的环境。
 *
 * 前置：后端 8080；账号 小明 13800000002 / 123456、小红 13800000003 / 123456。
 * 用法：node scripts/verify-t9-notify.mjs > t9.log 2>&1   ← 不要接 head/tail
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
/** 端口避开 T6/T7/T8 用的 5217 / 5218 / 5220 */
const PORT = 5221
const DEBUG_PORT = 9355
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const MING = { phone: '13800000002', password: '123456', id: 2, label: '小明(用户2)' }
const HONG = { phone: '13800000003', password: '123456', id: 3, label: '小红(用户3)' }

/** 与 NotificationView 里的 PAGE_SIZE 保持一致 */
const PAGE_SIZE = 20

const { check, summary } = createReporter()

/* ==================== 前置 ==================== */
try {
  const status = await fetch(`${BACKEND}/api/article/latest`).then((r) => r.status)
  if (status !== 200) throw new Error(`latest=${status}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端。`)
  process.exit(1)
}

async function login(cred) {
  const res = await fetch(`${BACKEND}/api/user/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: cred.phone, password: cred.password }),
  }).then((r) => r.json())
  return res?.data?.token ?? null
}

const MING_TOKEN = await login(MING)
const HONG_TOKEN = await login(HONG)
if (!MING_TOKEN || !HONG_TOKEN) {
  console.log('登录失败：', { ming: !!MING_TOKEN, hong: !!HONG_TOKEN })
  process.exit(1)
}
console.log(`登录成功：${MING.label} / ${HONG.label}`)

const api = (method, url, token = MING_TOKEN) =>
  fetch(`${BACKEND}${url}`, { method, headers: { token } }).then((r) => r.json())

const unread = async () => (await api('GET', '/api/notify/unread'))?.data
const listTotal = async () => (await api('GET', '/api/notify/list?page=1&size=50'))?.data?.total
const hongFollowsMing = async () =>
  (await api('GET', `/api/user/follow/status/${MING.id}`, HONG_TOKEN))?.data === true

/* ==================== 准备数据 ==================== */
console.log('\n[准备] 造一条 type=3（关注）通知 —— 当前数据里只有 type 1/2')
const followBefore = await hongFollowsMing()
if (!followBefore) {
  console.log(`    ${HONG.label} 关注 ${MING.label} …`)
  console.log(`    → ${JSON.stringify(await api('POST', `/api/user/follow/${MING.id}`, HONG_TOKEN))}`)
} else {
  console.log(`    ${HONG.label} 已经关注 ${MING.label}，跳过（历史遗留的通知仍在）`)
}

/*
 * 再造一条「目标已失效、且未读」的通知。
 *
 * 为什么要现造：历史数据里失效的那几条（id 17~22）在第一次跑验收时就被标成已读了，
 * 而**已读不可逆**（接口没有「标记未读」）。不复现的话，第二次跑就没有
 * 「未读 + 已失效」的样本，验收 2 直接没得测。
 *
 * 链路：小明发一篇临时文章 → 小红评论（产生 type=2 通知）→ 小明删掉文章
 *      → 通知仍在（事件流水），但 articleDeleted / commentDeleted 都变成 true。
 * 临时文章与评论随删除一起消失，除了那条通知不留别的垃圾。
 */
console.log('\n[准备] 造两条 type=2 通知：一条「目标还在」、一条「目标已失效」')
console.log('    链路：小明发临时文章 → 小红评论（产生通知）→ 按需删掉文章')

/**
 * 造一条「小红评论了小明的文章」通知（type=2，未读）。
 * @param keepArticle true = 保留文章（通知保持「未失效」）；false = 立刻删文章（通知变成「已失效」）
 */
async function seedCommentNotify(keepArticle) {
  const fd = new FormData()
  fd.append('title', `[T9验收] 临时文章 ${keepArticle ? 'A' : 'B'} ${Date.now()}`)
  fd.append('content', '# T9 验收临时文章\n\n只为制造一条通知，验收结束后会被删除。')
  fd.append('status', '1')
  const art = await fetch(`${BACKEND}/api/article`, {
    method: 'POST',
    headers: { token: MING_TOKEN },
    body: fd,
  }).then((r) => r.json())
  const articleId = typeof art?.data === 'number' ? art.data : art?.data?.id

  const cmt = await fetch(`${BACKEND}/api/comment`, {
    method: 'POST',
    headers: { token: HONG_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      articleId,
      content: `[T9验收] ${keepArticle ? '文章保留' : '文章随后删除'}`,
      parentId: 0,
    }),
  }).then((r) => r.json())

  if (!keepArticle) {
    const del = await fetch(`${BACKEND}/api/article/${articleId}`, {
      method: 'DELETE',
      headers: { token: MING_TOKEN },
    }).then((r) => r.json())
    console.log(`    3.3 删除临时文章 ${articleId} → ${JSON.stringify(del)}`)
  }

  console.log(
    `    ${keepArticle ? '保留' : '删除'}文章 ${articleId}：3.1=${art?.code} 3.13=${cmt?.code}（评论 id=${cmt?.data}）`,
  )
  return { articleId, ok: art?.code === 200 && cmt?.code === 200 }
}

const deadSeed = await seedCommentNotify(false)
check('造出「目标会失效」的通知（发布 → 评论 → 删除）', deadSeed.ok)
const aliveSeed = await seedCommentNotify(true)
check('造出「目标还在」的通知（发布 → 评论，文章保留）', aliveSeed.ok)

/*
 * 再补一条 **type=1（点赞）** 通知。
 *
 * 为什么必须现造：历史 type=1 通知都已经被标成已读，而列表排序是
 * 「未读在前、同状态按时间倒序」—— 攒下来的 type=3 关注通知会把旧的
 * type=1 挤到第 1 页之外，验收 1「三类各出现一次」就截不到图了。
 * 现造的这条是最新的，必然落在第 1 页顶部。
 */
const likeRes = await fetch(`${BACKEND}/api/article/${aliveSeed.articleId}/like`, {
  method: 'POST',
  headers: { token: HONG_TOKEN },
}).then((r) => r.json())
console.log(`    3.7 小红点赞临时文章 ${aliveSeed.articleId} → ${JSON.stringify(likeRes)}`)
check('造出「点赞」类型的通知（type=1）', likeRes?.code === 200, JSON.stringify(likeRes))

const totalBefore = await listTotal()
const unreadBeforeAll = await unread()
console.log(`    当前通知总数 ${totalBefore}，未读 ${unreadBeforeAll}`)

const fullList = (await api('GET', '/api/notify/list?page=1&size=50'))?.data?.records ?? []
const typeCount = fullList.reduce((acc, r) => {
  acc[r.type] = (acc[r.type] ?? 0) + 1
  return acc
}, {})
console.log(`    按类型分布：${JSON.stringify(typeCount)}`)
check('数据里有 type=3（关注）通知，否则验收 1 无法截图', (typeCount[3] ?? 0) > 0, JSON.stringify(typeCount))

/** 一条「文章还在」的通知（用来验证未失效时确实会跳转）。type=3 没有 articleId，必须排除 */
const aliveOne = fullList.find(
  (r) => !r.articleDeleted && !r.commentDeleted && r.articleId != null && r.type !== 3,
)
/** 一条「已失效」且未读的通知 */
const deadOne = fullList.find((r) => (r.articleDeleted || r.commentDeleted) && r.isRead === 0)
console.log(
  `    可跳转样本：id=${aliveOne?.id} type=${aliveOne?.type} articleId=${aliveOne?.articleId}｜` +
    `失效样本：id=${deadOne?.id} type=${deadOne?.type} aDel=${deadOne?.articleDeleted} cDel=${deadOne?.commentDeleted}`,
)
check('存在一条未失效的未读通知（验证正常跳转）', !!aliveOne)
check('存在一条已失效的未读通知（验证失效不跳转）', !!deadOne)

let aliveArticleExists = false
if (aliveOne?.articleId != null) {
  const art = await api('GET', `/api/article/${aliveOne.articleId}`)
  aliveArticleExists = art?.code === 200
  console.log(`    目标文章 ${aliveOne.articleId} 是否存在：${aliveArticleExists}`)
}
check('「可跳转样本」的目标文章确实还在', aliveArticleExists)

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
let cdp
let restored = false
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1360,1100' })
  cdp = browser.cdp
  await fs.mkdir(OUT_DIR, { recursive: true })

  const shoot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
  }
  const goto = async (url, wait = 2600) => {
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(150)
    await cdp.send('Page.navigate', { url })
    await sleep(wait)
  }
  const setToken = (token) =>
    cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(token)})`)

  const health = { exceptions: [], consoleErrors: [] }
  const reset = () => {
    for (const e of cdp.exceptions()) if (!health.exceptions.includes(e)) health.exceptions.push(e)
    for (const e of cdp.consoleErrors())
      if (!health.consoleErrors.includes(e)) health.consoleErrors.push(e)
    cdp.clearEvents()
  }

  /** 页面可观测状态 */
  const snap = () =>
    cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('.cm-notify__item')]
      return {
        url: location.pathname + location.search,
        badge: document.querySelector('.cm-header__badge--nav')?.textContent?.trim() ?? null,
        subtitle: document.querySelector('.cm-notify__subtitle')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
        count: items.length,
        unreadItems: items.filter(el => el.classList.contains('is-unread')).length,
        types: [...new Set(items.map(el => el.querySelector('.cm-notify__type')?.textContent?.trim()))],
        items: items.map((el, i) => ({
          i,
          type: el.querySelector('.cm-notify__type')?.textContent?.trim() ?? null,
          content: el.querySelector('.cm-notify__content')?.textContent?.trim() ?? null,
          unread: el.classList.contains('is-unread'),
          invalid: el.querySelector('.cm-notify__invalid')?.textContent?.trim() ?? null,
          link: el.querySelector('.cm-notify__link')?.textContent?.trim() ?? null,
        })),
        toasts: [...document.querySelectorAll('.el-message')].map(e => e.textContent.replace(/\\s+/g,' ').trim()),
        pager: !!document.querySelector('.cm-notify__pager .el-pagination'),
        pagerTotal: document.querySelector('.el-pagination')?.getAttribute('total') ?? null,
        emptyTitle: document.querySelector('.cm-empty__title')?.textContent?.trim() ?? null,
      }
    })()`)

  const clickItem = (index) =>
    cdp.evaluate(`(() => {
      const el = document.querySelectorAll('.cm-notify__item')[${index}]
      if (!el) return false
      el.click()
      return true
    })()`)

  const reqIds = (part, method) =>
    cdp.events
      .filter(
        (e) =>
          e.method === 'Network.requestWillBeSent' &&
          e.params.request.url.includes(part) &&
          (!method || e.params.request.method === method),
      )
      .map((e) => e.params.requestId)

  const respJson = async (requestId) => {
    if (!requestId) return null
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId })
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /* ==================== 登录 ==================== */
  await goto(`http://localhost:${PORT}/login`, 1200)
  await setToken(MING_TOKEN)

  /* ==================== 验收 1：三类通知 + 未读数一致 ==================== */
  console.log('\n[验收 1] 三类通知各出现一次；未读数与列表状态一致')
  reset()
  await goto(`http://localhost:${PORT}/notifications`, 3000)
  const v1 = await snap()
  const apiUnread = await unread()
  console.log(`    列表 ${v1.count} 条｜未读 ${v1.unreadItems} 条｜角标=${JSON.stringify(v1.badge)}｜副标题=${JSON.stringify(v1.subtitle)}`)
  console.log(`    出现的类型：${JSON.stringify(v1.types)}`)
  console.log(`    类型样本：`)
  for (const t of [1, 2, 3]) {
    const s = v1.items.find((x) => x.type === { 1: '点赞', 2: '评论', 3: '关注' }[t])
    console.log(`      type${t} → ${JSON.stringify(s?.content)}（失效=${JSON.stringify(s?.invalid)}）`)
  }
  check('列表里出现了「点赞」类型', v1.types.includes('点赞'), JSON.stringify(v1.types))
  check('列表里出现了「评论」类型', v1.types.includes('评论'), JSON.stringify(v1.types))
  check('列表里出现了「关注」类型', v1.types.includes('关注'), JSON.stringify(v1.types))
  check('4.2 未读数 > 0', apiUnread > 0, String(apiUnread))
  check('角标数字 = 4.2 返回的未读数', v1.badge === String(apiUnread), `角标 ${v1.badge} vs 4.2 ${apiUnread}`)
  // total(12) <= PAGE_SIZE(20) 时，列表一页装得下，未读条目数应与 4.2 相等
  const totalNow = await listTotal()
  if (totalNow <= PAGE_SIZE) {
    check('未读条目数 = 4.2 未读数（一页装得下时）', v1.unreadItems === apiUnread, `${v1.unreadItems} vs ${apiUnread}`)
  } else {
    // 未读数是全局的，第 1 页只是它的子集，不能直接相等
    check(
      '未读条目数不超过 4.2 未读数（跨页时页内只是子集）',
      v1.unreadItems > 0 && v1.unreadItems <= apiUnread,
      `${v1.unreadItems} vs ${apiUnread}`,
    )
  }
  check('未读条目带 is-unread 视觉标记', v1.unreadItems > 0 && v1.items.some((x) => x.unread))
  await shoot('t9-1-three-types.png')

  /* ==================== 验收 4：断网标已读 → 回滚 ==================== */
  console.log('\n[验收 4] 扣住 4.3 请求看乐观 -1，再让它失败看回滚')
  const targetIndex = v1.items.findIndex((x) => x.unread && x.invalid)
  const targetContent = v1.items[targetIndex]?.content
  console.log(`    目标条目 #${targetIndex}：${JSON.stringify(targetContent)}（${JSON.stringify(v1.items[targetIndex]?.invalid)}）`)
  check('找到一条「未读且已失效」的通知作为目标', targetIndex >= 0)

  const unreadBeforeRollback = await unread()
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/notify/read/*', requestStage: 'Request' }],
  })
  reset()
  await clickItem(targetIndex)
  await sleep(700)
  const optimistic = await snap()
  const optimisticBadge = optimistic.badge
  const optimisticUnreadItem = optimistic.items[targetIndex]?.unread
  console.log(`    请求被扣住时：角标=${JSON.stringify(optimisticBadge)}｜该条 is-unread=${optimisticUnreadItem}`)
  check(
    '乐观更新：角标立刻 -1',
    optimisticBadge === String(Math.max(0, unreadBeforeRollback - 1)),
    `${unreadBeforeRollback} → ${optimisticBadge}`,
  )
  check('乐观更新：该条立刻变成已读样式', optimisticUnreadItem === false)
  await shoot('t9-4a-optimistic.png')

  const held = cdp.events.filter((e) => e.method === 'Fetch.requestPaused').map((e) => e.params.requestId)
  console.log(`    扣住 ${held.length} 个 /api/notify/read/* 请求，现在全部让它失败（模拟断网）`)
  for (const rid of held) {
    await cdp.send('Fetch.failRequest', { requestId: rid, errorReason: 'Failed' }).catch(() => {})
  }
  await sleep(1800)
  const rolled = await snap()
  const apiAfterRollback = await unread()
  console.log(`    失败后：角标=${JSON.stringify(rolled.badge)}｜该条 is-unread=${rolled.items[targetIndex]?.unread}｜4.2 复核=${apiAfterRollback}`)
  console.log(`    提示：${JSON.stringify(rolled.toasts)}`)
  check('回滚：角标回到点击前的值', rolled.badge === String(unreadBeforeRollback), `${unreadBeforeRollback} → ${rolled.badge}`)
  check('回滚：该条恢复未读样式', rolled.items[targetIndex]?.unread === true)
  check('4.2 复核未读数未被扣掉', apiAfterRollback === unreadBeforeRollback, `${unreadBeforeRollback} → ${apiAfterRollback}`)
  check('失败提示只弹一次（请求层负责，页面不重复弹）', rolled.toasts.length === 1, JSON.stringify(rolled.toasts))
  await cdp.send('Fetch.disable')
  await shoot('t9-4b-rollback.png')

  /* ==================== 验收 2：点已失效的通知 ==================== */
  console.log('\n[验收 2] 点一条已失效的通知 → 标记已读 + 提示「内容已删除」+ 不跳转')
  const beforeClick = await snap()
  const idx = beforeClick.items.findIndex((x) => x.unread && x.invalid)
  const unreadBeforeClick = await unread()
  console.log(`    目标 #${idx}：${JSON.stringify(beforeClick.items[idx]?.content)}`)
  console.log(`    条目上的常驻原因：${JSON.stringify(beforeClick.items[idx]?.invalid)}`)
  check('目标条目上常驻显示失效原因', /已被删除/.test(beforeClick.items[idx]?.invalid ?? ''), String(beforeClick.items[idx]?.invalid))

  reset()
  await clickItem(idx)
  await sleep(2000)
  const afterClick = await snap()
  const apiAfterClick = await unread()
  const readReqId = reqIds('/api/notify/read/', 'PUT').pop()
  const readResp = await respJson(readReqId)
  console.log(`    PUT /api/notify/read/* 响应：${JSON.stringify(readResp)}`)
  console.log(`    url=${afterClick.url}｜角标=${JSON.stringify(afterClick.badge)}｜4.2=${apiAfterClick}`)
  console.log(`    提示：${JSON.stringify(afterClick.toasts)}`)
  check('4.3 被调用且返回 200', readResp?.code === 200, JSON.stringify(readResp))
  check('提示「内容已删除」', afterClick.toasts.some((t) => t.includes('内容已删除')), JSON.stringify(afterClick.toasts))
  check('**没有发生跳转**（仍停在 /notifications）', afterClick.url.startsWith('/notifications'), afterClick.url)
  check('未读数 -1', apiAfterClick === unreadBeforeClick - 1, `${unreadBeforeClick} → ${apiAfterClick}`)
  check('角标同步 -1', afterClick.badge === String(apiAfterClick), `${afterClick.badge} vs ${apiAfterClick}`)
  check('该条已变成已读样式', afterClick.items[idx]?.unread === false)
  await shoot('t9-2-invalid-no-jump.png')

  /* ==================== 附加：未失效的通知确实会跳转 ==================== */
  console.log('\n[附加] 点一条目标还在的通知 → 正常跳到文章详情')
  await goto(`http://localhost:${PORT}/notifications`, 3000)
  const vAlive = await snap()
  // 必须挑「有关联文章且未失效」的那条：type=3 关注通知也没有失效标记，
  // 但它本来就不该有「查看详情」、也不会跳转，拿它当样本是测错了对象
  const aliveIdx = vAlive.items.findIndex((x) => x.unread && x.link === '查看详情')
  console.log(`    目标 #${aliveIdx}：${JSON.stringify(vAlive.items[aliveIdx]?.content)}｜链接文案=${JSON.stringify(vAlive.items[aliveIdx]?.link)}`)
  check('找到一条「未读 + 有关联文章 + 未失效」的通知作为目标', aliveIdx >= 0)
  check('未失效的条目显示「查看详情」', vAlive.items[aliveIdx]?.link === '查看详情')
  check('未失效的条目不显示失效原因', !vAlive.items[aliveIdx]?.invalid)
  const followItem = vAlive.items.find((x) => x.type === '关注')
  check('关注类通知不显示「查看详情」（没有关联文章可跳）', followItem?.link === null, String(followItem?.link))
  reset()
  await clickItem(aliveIdx)
  await sleep(2200)
  const jumped = await cdp.evaluate(`location.pathname + location.search + location.hash`)
  console.log(`    点击后 url=${jumped}`)
  check('跳到了文章详情页', /^\/articles\/\d+/.test(jumped), jumped)
  await shoot('t9-3-jump-alive.png')

  /* ==================== 验收 3：全部已读 ==================== */
  console.log('\n[验收 3] 全部已读 → 未读数归零、角标消失')
  await goto(`http://localhost:${PORT}/notifications`, 3000)
  const beforeAll = await snap()
  const unreadBeforeAll2 = await unread()
  console.log(`    操作前：角标=${JSON.stringify(beforeAll.badge)}｜4.2=${unreadBeforeAll2}｜未读条目=${beforeAll.unreadItems}`)
  check('操作前确实还有未读（否则这条用例没有意义）', unreadBeforeAll2 > 0, String(unreadBeforeAll2))

  reset()
  const clickedAll = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.cm-notify__head .el-button')]
      .find(x => x.textContent.includes('全部已读'))
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(900)
  const confirmText = await cdp.evaluate(
    `document.querySelector('.el-message-box__message')?.textContent?.trim() ?? null`,
  )
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.el-message-box__btns .el-button')]
      .find(x => x.classList.contains('el-button--primary'))
    if (b) b.click()
  })()`)
  await sleep(2200)
  const afterAll = await snap()
  const apiAfterAll = await unread()
  const readAllResp = await respJson(reqIds('/api/notify/readAll', 'PUT').pop())
  console.log(`    二次确认文案：${JSON.stringify(confirmText)}`)
  console.log(`    PUT /api/notify/readAll 响应：${JSON.stringify(readAllResp)}`)
  console.log(`    操作后：角标=${JSON.stringify(afterAll.badge)}｜4.2=${apiAfterAll}｜未读条目=${afterAll.unreadItems}`)
  check('点到了「全部已读」', clickedAll === true)
  check('有二次确认', !!confirmText, String(confirmText))
  check('4.4 返回 200', readAllResp?.code === 200, JSON.stringify(readAllResp))
  check('4.2 未读数归零', apiAfterAll === 0, String(apiAfterAll))
  check('**顶栏角标消失**', afterAll.badge === null, String(afterAll.badge))
  check('列表里没有未读样式的条目了', afterAll.unreadItems === 0, String(afterAll.unreadItems))
  check('副标题变成「没有未读消息」', /没有未读消息/.test(afterAll.subtitle ?? ''), String(afterAll.subtitle))
  await shoot('t9-5-all-read.png')

  /* ==================== 附加：未读数 >99 收敛 99+ ==================== */
  console.log('\n[附加] 未读数 >99 → 角标显示 99+（用受控响应注入 120）')
  console.log('    说明：造 100 条真实通知不现实，这里只替换 4.2 的响应，验证渲染规则')
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/notify/unread*', requestStage: 'Request' }],
  })
  let stopPoller = false
  const handled = new Set()
  ;(async () => {
    while (!stopPoller) {
      const paused = cdp.events.filter(
        (e) => e.method === 'Fetch.requestPaused' && !handled.has(e.params.requestId),
      )
      for (const p of paused) {
        handled.add(p.params.requestId)
        await cdp
          .send('Fetch.fulfillRequest', {
            requestId: p.params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json;charset=utf-8' }],
            body: Buffer.from(
              JSON.stringify({ code: 200, message: '操作成功', data: 120 }),
            ).toString('base64'),
          })
          .catch(() => {})
      }
      await sleep(60)
    }
  })()
  await goto(`http://localhost:${PORT}/notifications`, 3000)
  const bigBadge = await cdp.evaluate(
    `document.querySelector('.cm-header__badge--nav')?.textContent?.trim() ?? null`,
  )
  console.log(`    注入 4.2=120 后角标=${JSON.stringify(bigBadge)}`)
  check('未读数 120 → 角标收敛为「99+」', bigBadge === '99+', String(bigBadge))
  await shoot('t9-6-badge-99plus.png')
  stopPoller = true
  await cdp.send('Fetch.disable')

  /* ==================== 附加：分页 ==================== */
  /*
   * 分页要有第 2 页，总数必须 > PAGE_SIZE。
   * 只补「差多少就造多少」，不要固定造 N 条 —— 通知删不掉，
   * 每次都硬造 10 条会把测试账号越堆越脏。
   */
  const totalBeforePad = await listTotal()
  const pad = Math.max(0, PAGE_SIZE + 1 - totalBeforePad)
  console.log(`\n[附加] 分页：当前 ${totalBeforePad} 条，还需补 ${pad} 条才能超过一页（${PAGE_SIZE}）`)
  console.log('    方式：小红「关注 → 取关」循环，每次关注都会给小明生成一条 type=3 通知')
  for (let i = 0; i < pad; i += 1) {
    await api('POST', `/api/user/follow/${MING.id}`, HONG_TOKEN)
    await api('DELETE', `/api/user/cancelFollow/${MING.id}`, HONG_TOKEN)
  }
  const totalAfter = await listTotal()
  const expectedPages = Math.ceil(totalAfter / PAGE_SIZE)
  console.log(`    通知总数 ${totalAfter} → 预期 ${expectedPages} 页`)
  check(`通知总数已超过一页（${PAGE_SIZE} 条）`, totalAfter > PAGE_SIZE, String(totalAfter))

  await goto(`http://localhost:${PORT}/notifications`, 3200)
  const page1 = await snap()
  console.log(`    第 1 页：${page1.count} 条｜分页器可见=${page1.pager}｜未读=${page1.unreadItems}`)
  check(`第 1 页满 ${PAGE_SIZE} 条`, page1.count === PAGE_SIZE, String(page1.count))
  check('分页器出现（total > pageSize）', page1.pager === true)
  await shoot('t9-7-pagination-1.png')

  reset()
  const goPage2 = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.el-pager li')].find(x => x.textContent.trim() === '2')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(2400)
  const page2 = await snap()
  const page2Req = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/notify/list'))
    .map((e) => e.params.request.url)
  // 总页数 = ceil(total / PAGE_SIZE)，第 2 页的条数取「剩余量」与「每页量」的较小值
  const rest = Math.min(PAGE_SIZE, totalAfter - PAGE_SIZE)
  console.log(`    点第 2 页后：url=${page2.url}｜${page2.count} 条｜请求=${JSON.stringify(page2Req)}`)
  check('点到了第 2 页', goPage2 === true)
  check('URL 变成 ?page=2（筛选/页码走 URL，可刷新直达）', page2.url.includes('page=2'), page2.url)
  check(`第 2 页剩余 ${rest} 条`, page2.count === rest, `${page2.count} vs ${rest}`)
  check('翻页请求带 page=2', page2Req.some((u) => /[?&]page=2/.test(u)), JSON.stringify(page2Req))
  await shoot('t9-8-pagination-2.png')

  /* ==================== 收尾：留一条未读，别把环境清成 0 ==================== */
  /*
   * 验收 3 会把未读清零，而「已读不可逆」—— 跑完就留下一个「未读恒为 0」的环境，
   * 后面工单再想看角标 / 未读样式就没数据了。
   * 所以刻意再制造一条未读通知（关注 → 立刻取关，通知会留下）。
   */
  console.log('\n[收尾] 留一条未读通知，避免把测试账号清成「未读恒为 0」')
  // 必须先确保「未关注」再关注：关注是幂等的，重复关注不会再生成通知
  await api('DELETE', `/api/user/cancelFollow/${MING.id}`, HONG_TOKEN)
  await api('POST', `/api/user/follow/${MING.id}`, HONG_TOKEN)
  await api('DELETE', `/api/user/cancelFollow/${MING.id}`, HONG_TOKEN)
  // 通知是异步落库的（后端走 MQ），立刻读会读到 0 —— 轮询等它出现
  let leftoverUnread = 0
  for (let i = 0; i < 12; i += 1) {
    leftoverUnread = await unread()
    if (leftoverUnread > 0) break
    await sleep(400)
  }
  console.log(`    收尾后未读数 = ${leftoverUnread}｜小红是否仍关注小明 = ${await hongFollowsMing()}`)
  check('收尾留下 1 条未读（后续工单仍有数据可看）', leftoverUnread === 1, String(leftoverUnread))
  check('收尾没有留下关注关系（不污染粉丝数）', (await hongFollowsMing()) === false)

  /* ==================== 健康度 ==================== */
  console.log('\n[健康度] 控制台（全程归档）')
  reset()
  const consoleErrs = health.consoleErrors.filter(
    (t) => !/Failed to load resource|ERR_|net::/i.test(t),
  )
  console.log(`    未捕获异常 ${health.exceptions.length} 条｜console.error ${consoleErrs.length} 条`)
  check('无未捕获异常', health.exceptions.length === 0, health.exceptions.slice(0, 2).join(' | '))
  check('无 console.error（网络失败日志除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  /* ==================== 还原 ==================== */
  try {
    // 清掉为「目标还在」那条通知准备的临时文章（评论与文章一起走）
    if (aliveSeed?.articleId) {
      const del = await fetch(`${BACKEND}/api/article/${aliveSeed.articleId}`, {
        method: 'DELETE',
        headers: { token: MING_TOKEN },
      }).then((r) => r.json())
      console.log(`\n[清理] 删除临时文章 ${aliveSeed.articleId}：${JSON.stringify(del)}`)
    }
  } catch (e) {
    console.log(`[清理] 删除临时文章失败：${e.message}`)
  }

  try {
    if (await hongFollowsMing()) {
      const r = await api('DELETE', `/api/user/cancelFollow/${MING.id}`, HONG_TOKEN)
      console.log(`\n[清理] 取消「${HONG.label} 关注 ${MING.label}」：${JSON.stringify(r)}`)
    } else {
      console.log(`\n[清理] ${HONG.label} 未关注 ${MING.label}，无需还原`)
    }
    restored = !(await hongFollowsMing())
    const info = (await api('GET', '/api/user/info'))?.data
    console.log(`[清理] 关注关系已还原=${restored}｜小明 fansCount=${info?.fansCount}`)
    console.log(`[清理] 小明未读数=${await unread()}（已读不可逆；分页阶段留下的是新的未读通知）`)
    console.log('[清理] 通知本身无法删除（接口无此能力），本次新增若干条 type=3「小红关注了你」')
  } catch (e) {
    console.log(`[清理] 还原失败：${e.message}`)
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
console.log(`截图已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
