/**
 * T2 验收：布局与首页（真实后端）
 * ------------------------------------------------------------------
 * 覆盖：
 *   1. 未登录首页：导航 5 项 + 登录入口、**不发** 4.2 未读请求（贴截图）
 *   2. 首页两个列表取自真实接口：抓 Network 的 URL + 响应体里的 total（不是页面自证）
 *   3. 未登录点「消息」→ /login?redirect=...（不是 401 报错页）
 *   4. 已登录：导航「消息」带未读角标；>99 收敛 99+
 *   5. 响应式：1280 / 1024 无横向溢出（贴截图）
 *   6. 「后端停止」错误态：用**代理指向死端口**的第二台 Vite 复现（不杀用户的后端），
 *      两个区块各自进错误态 + 有重试（贴截图）
 *
 * 前置：后端 8080；账号 13800000002 / 123456。
 * 用法：node scripts/verify-t2-layout-home.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, waitFor } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5210
/** 第二台 Vite：代理指向一个没人监听的端口，用来复现「后端停止」 */
const DEAD_PORT = 5211
const DEAD_TARGET = 'http://localhost:8100'
const DEBUG_PORT = 9346
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const PHONE = '13800000002'
const PASSWORD = '123456'

const { check, summary } = createReporter()

/* ==================== 前置 ==================== */
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
const REAL_TOKEN = loginRes?.data?.token
if (!REAL_TOKEN) {
  console.log('密码登录失败：', JSON.stringify(loginRes))
  process.exit(1)
}

const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()
const viteDead = await createServer({
  server: {
    port: DEAD_PORT,
    strictPort: true,
    proxy: { '/api': { target: DEAD_TARGET, changeOrigin: true } },
  },
  logLevel: 'error',
})
await viteDead.listen()

let browser
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1280,900' })
  const cdp = browser.cdp
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
  const reqUrls = (part) =>
    cdp.events
      .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes(part))
      .map((e) => e.params.request.url)
  /** 取某个接口的响应体 JSON（用来拿 total，而不是只看页面渲染） */
  const respBody = async (part) => {
    const hit = cdp.events
      .filter((e) => e.method === 'Network.responseReceived' && e.params.response.url.includes(part))
      .map((e) => e.params.requestId)[0]
    if (!hit) return null
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId: hit })
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  const pageSnapshot = () =>
    cdp.evaluate(`({
      path: location.pathname + location.search,
      navItems: [...document.querySelectorAll('.cm-header__nav-item')].map(e => e.textContent.trim()),
      hasLoginBtn: [...document.querySelectorAll('.cm-header__actions .el-button')].some(b => b.textContent.trim() === '登录'),
      badgeText: document.querySelector('.cm-header__badge--nav')?.textContent?.trim() ?? null,
      latestCards: document.querySelectorAll('.cm-home__main .cm-article-card').length,
      hotItems: document.querySelectorAll('.cm-home__hot-list .cm-article-card').length,
      errorBlocks: document.querySelectorAll('.cm-error, .cm-error-state, [class*="error"]').length,
      retryButtons: [...document.querySelectorAll('.cm-container button')]
        .filter(b => /重试|重新加载|再试/.test(b.textContent)).length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`)

  /* ==================== 1. 未登录首页 ==================== */
  console.log('\n[1] 未登录首页（1280px）')
  await cdp.evaluate(`localStorage.clear()`).catch(() => {})
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/`)
  await sleep(1500)
  const guest = await pageSnapshot()

  check(
    '导航含 首页/社区/我的知识库/AI 助手/消息',
    ['首页', '社区', '我的知识库', 'AI 助手', '消息'].every((t) => guest.navItems.join('|').includes(t)),
    `实际 ${JSON.stringify(guest.navItems)}`,
  )
  check('未登录显示登录入口', guest.hasLoginBtn === true)
  check('未登录不显示未读角标', guest.badgeText === null, `实际 ${guest.badgeText}`)
  check(
    '未登录**不发** /api/notify/unread',
    reqUrls('/api/notify/unread').length === 0,
    `实际 ${reqUrls('/api/notify/unread').length} 次`,
  )
  check('1280px 无横向溢出', guest.overflowX <= 0, `overflowX=${guest.overflowX}`)
  await shoot('t2-1-home-guest-1280.png')

  /* ==================== 2. 两个列表取自真实接口 ==================== */
  console.log('\n[2] 首页两个列表的真实接口证据')
  const latestUrl = reqUrls('/api/article/latest')[0]
  const hotUrl = reqUrls('/api/article/hot')[0]
  const latestBody = await respBody('/api/article/latest')
  const hotBody = await respBody('/api/article/hot')
  console.log(`    最新请求：${latestUrl}`)
  console.log(`    最新响应：code=${latestBody?.code} total=${latestBody?.data?.total} records=${latestBody?.data?.records?.length}`)
  console.log(`    热门请求：${hotUrl}`)
  console.log(`    热门响应：code=${hotBody?.code} total=${hotBody?.data?.total} records=${hotBody?.data?.records?.length}`)
  check('已发起 /api/article/latest', !!latestUrl && latestUrl.includes('page=1'))
  check('已发起 /api/article/hot', !!hotUrl && hotUrl.includes('page=1'))
  check('latest 响应 code=200', latestBody?.code === 200)
  check('latest 渲染卡片数 = 响应 records 数', guest.latestCards === (latestBody?.data?.records?.length ?? -1), `页面 ${guest.latestCards}，接口 ${latestBody?.data?.records?.length}`)
  check('hot 响应 code=200', hotBody?.code === 200)
  check('hot 渲染条目数 = 响应 records 数', guest.hotItems === (hotBody?.data?.records?.length ?? -1), `页面 ${guest.hotItems}，接口 ${hotBody?.data?.records?.length}`)
  await fs.writeFile(
    path.join(OUT_DIR, 't2-home-api-evidence.json'),
    JSON.stringify(
      {
        latest: { url: latestUrl, code: latestBody?.code, total: latestBody?.data?.total, rendered: guest.latestCards, firstId: latestBody?.data?.records?.[0]?.id },
        hot: { url: hotUrl, code: hotBody?.code, total: hotBody?.data?.total, rendered: guest.hotItems, firstId: hotBody?.data?.records?.[0]?.id },
      },
      null,
      2,
    ),
  )

  /* ==================== 3. 未登录点「消息」 ==================== */
  console.log('\n[3] 未登录点导航「消息」')
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('.cm-header__nav-item')].find(a => a.textContent.trim() === '消息')
    el.click()
  })()`)
  await sleep(1600)
  const afterMsgClick = await cdp.evaluate(`({
    path: location.pathname + location.search,
    pathname: location.pathname,
  })`)
  check(
    '跳到 /login 且 redirect=/notifications',
    afterMsgClick.path.startsWith('/login') &&
      decodeURIComponent(afterMsgClick.path).includes('redirect=/notifications'),
    `实际 ${afterMsgClick.path}`,
  )
  check(
    '没有真的进入消息页（不是 401 报错页，而是登录页）',
    afterMsgClick.pathname === '/login',
    `实际 pathname=${afterMsgClick.pathname}`,
  )
  await shoot('t2-3-guest-message-login.png')

  /* ==================== 4. 已登录：角标与 99+ ==================== */
  console.log('\n[4] 已登录首页（未读角标 / 99+ 收敛）')
  await goto(`http://localhost:${PORT}/login`)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(REAL_TOKEN)})`)
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/`)
  await sleep(1800)
  const authed = await pageSnapshot()
  const unreadCalls = reqUrls('/api/notify/unread')
  check('登录后拉取了 4.2 未读数', unreadCalls.length >= 1, `实际 ${unreadCalls.length} 次`)
  check('导航「消息」上有未读角标', typeof authed.badgeText === 'string' && authed.badgeText.length > 0, `实际 ${authed.badgeText}`)
  const realUnread = await respBody('/api/notify/unread')
  console.log(`    4.2 响应 data=${JSON.stringify(realUnread?.data)}，角标显示「${authed.badgeText}」`)
  check(
    '角标文案 = 未读数（>99 才收敛 99+）',
    realUnread?.data > 99 ? authed.badgeText === '99+' : String(realUnread?.data) === authed.badgeText,
    `接口 ${realUnread?.data}，页面 ${authed.badgeText}`,
  )
  await shoot('t2-2-home-authed-1280.png')

  // >99 收敛：直接改 store 的未读数（不动接口，只验证显示规则）
  const bigBadge = await cdp.evaluate(`(async () => {
    const mod = await import('/src/stores/user.ts')
    const store = mod.useUserStore()
    store.unreadCount = 137
    await new Promise(r => setTimeout(r, 120))
    return document.querySelector('.cm-header__badge--nav')?.textContent?.trim() ?? null
  })()`)
  check('未读数 137 → 显示 99+', bigBadge === '99+', `实际「${bigBadge}」`)

  /* ==================== 5. 响应式 1024px ==================== */
  console.log('\n[5] 1024px 响应式')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1024,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(700)
  const at1024 = await pageSnapshot()
  check('1024px 无横向溢出', at1024.overflowX <= 0, `overflowX=${at1024.overflowX}`)
  check('1024px 导航仍显示（>860 断点）', at1024.navItems.length === 5, `实际 ${at1024.navItems.length} 项`)
  await shoot('t2-4-home-1024.png')
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  /* ==================== 6. 后端不可达时的错误态 ==================== */
  console.log('\n[6] 后端不可达（代理指向死端口）→ 首页错误态 + 重试')
  await goto(`http://localhost:${DEAD_PORT}/`, 3500)
  await sleep(1500)
  const down = await pageSnapshot()
  const downText = await cdp.evaluate(`document.body.innerText.slice(0, 400)`)
  check('首页照样渲染出骨架（没白屏）', down.latestCards === 0 && down.overflowX === 0)
  check('出现错误态与重试入口', down.retryButtons >= 2, `重试按钮 ${down.retryButtons} 个`)
  check('页面文案不是「加载中」卡死', !/正在加载/.test(downText.slice(0, 200)), downText.slice(0, 120))
  console.log(`    页面文案片段：${downText.replace(/\s+/g, ' ').slice(0, 160)}`)
  await shoot('t2-5-home-backend-down.png')

  /* ==================== 7. 运行时健康度 ==================== */
  console.log('\n[7] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp
    .consoleErrors()
    .filter((t) => !/Failed to load resource|ERR_|net::/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（资源加载失败除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
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
    await viteDead?.close()
  } catch {
    /* 忽略 */
  }
  try {
    if (browser?.profileDir) await fs.rm(browser.profileDir, { recursive: true, force: true })
  } catch {
    /* Windows 上目录可能仍被占用 */
  }
}

const fail = summary()
console.log(`截图与接口证据已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
