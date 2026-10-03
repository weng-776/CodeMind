/**
 * T16 验收：管理端地基 + 数据看板（真实后端 + 真实 Chrome）
 * ------------------------------------------------------------------
 * 覆盖工单 T16 的验收项（`管理端前端设计说明.md` §6）：
 *   0. 后端契约核验：401 / 403 / 400 三种失败形态、看板 12 字段、死信队列 6 条
 *   1. **未登录**访问 /admin/* → 跳 `/login?redirect=…`
 *   2. 管理员（小明）UI 密码登录 → 落到 /admin
 *   3. ⭐ 看板 12 个数字与 `GET /api/admin/dashboard/overview` **逐项一致**
 *   4. Header 出现「管理后台」入口（仅管理员）
 *   5. 4 条管理路由都能打开（T17~T19 的三个页面此时是占位，但不许白屏）
 *   6. 所有 `/api/admin/*` 请求头都是 `token`
 *   7. **接口 403 兜底**：会话中途被降权（Pinia 仍是 admin、token 已换）→ 仍渲染 403 态
 *   8. **非管理员**（小红）访问 /admin → 明确「无管理员权限」，**不是**白屏/加载失败
 *   9. 控制台 0 未捕获异常、0 console.error
 *   10. vue-tsc 0 错误（由外部命令跑，本脚本只做运行期断言）
 *
 * 前置：后端 8080 在跑。
 * 用法（package.json 在禁止清单里，用绝对路径跑）：
 *   "/c/Users/翁甲燃/.workbuddy/binaries/node/versions/22.22.2-3/node" scripts/verify-t16-admin.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'

import {
  clickByText,
  createReporter,
  launchBrowser,
  setInput,
  sleep,
} from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
/** 端口与既有脚本错开（T6=5217/9351 … T14=5226/9360） */
const PORT = 5227
const DEBUG_PORT = 9361
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const ADMIN = { phone: '13800000002', password: '123456', name: '小明' }
const NORMAL = { phone: '13800000003', password: '123456', name: '小红' }

/** 看板 12 个字段（顺序即页面展示顺序） */
const TOTAL_KEYS = [
  'userCount',
  'articleCount',
  'noteCount',
  'commentCount',
  'likeCount',
  'favoriteCount',
]
const TODAY_KEYS = [
  'todayUserCount',
  'todayArticleCount',
  'todayNoteCount',
  'todayCommentCount',
  'todayLikeCount',
  'todayFavoriteCount',
]
const ALL_KEYS = [...TOTAL_KEYS, ...TODAY_KEYS]

const { check, summary } = createReporter()

/* ==================== 前置：后端可达 ==================== */
try {
  const status = await fetch(`${BACKEND}/api/article/latest`).then((r) => r.status)
  if (status !== 200) throw new Error(`latest=${status}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端。`)
  process.exit(1)
}

/** 直接打后端，拿登录 token */
async function apiLogin(phone, password) {
  const res = await fetch(`${BACKEND}/api/user/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  }).then((r) => r.json())
  return res?.data?.token ?? null
}

/* ==================== [0] 后端契约核验 ==================== */
console.log('\n[0] 后端契约核验（直接打后端，不经过页面）')

const adminToken = await apiLogin(ADMIN.phone, ADMIN.password)
const normalToken = await apiLogin(NORMAL.phone, NORMAL.password)
check('管理员可密码登录', typeof adminToken === 'string' && adminToken.length > 20)
check('普通用户可密码登录', typeof normalToken === 'string' && normalToken.length > 20)

// 0.1 /user/info 必须带 role（T16 的前置阻塞）
const adminInfo = await fetch(`${BACKEND}/api/user/info`, {
  headers: { token: adminToken },
}).then((r) => r.json())
console.log(`    /user/info：role=${adminInfo?.data?.role}，字段=${Object.keys(adminInfo?.data ?? {}).join(',')}`)
check('1.4 返回 role 字段（T16 前置）', 'role' in (adminInfo?.data ?? {}))
check('管理员 role === 1', adminInfo?.data?.role === 1, String(adminInfo?.data?.role))
const normalInfo = await fetch(`${BACKEND}/api/user/info`, {
  headers: { token: normalToken },
}).then((r) => r.json())
check('普通用户 role === 0', normalInfo?.data?.role === 0, String(normalInfo?.data?.role))

// 0.2 三种失败形态（§2.1）
const noToken = await fetch(`${BACKEND}/api/admin/dashboard/overview`)
const noTokenBody = await noToken.json()
console.log(`    无 token → HTTP ${noToken.status}，code=${noTokenBody?.code}`)
check('无 token → HTTP 401', noToken.status === 401, String(noToken.status))
check('无 token → 业务 code 401', noTokenBody?.code === 401, JSON.stringify(noTokenBody))

const normalRes = await fetch(`${BACKEND}/api/admin/dashboard/overview`, {
  headers: { token: normalToken },
})
const normalBody = await normalRes.json()
console.log(`    普通用户 → HTTP ${normalRes.status}，code=${normalBody?.code}「${normalBody?.message}」`)
check('非管理员 → HTTP 403（走 error 分支）', normalRes.status === 403, String(normalRes.status))
check('非管理员 → 业务 code 403', normalBody?.code === 403, JSON.stringify(normalBody))

const overSize = await fetch(`${BACKEND}/api/admin/users?page=1&size=51`, {
  headers: { token: adminToken },
})
const overSizeBody = await overSize.json()
console.log(`    size=51 → HTTP ${overSize.status}，code=${overSizeBody?.code}「${overSizeBody?.message}」`)
check('size=51 → HTTP 200（传输层成功）', overSize.status === 200, String(overSize.status))
check('size=51 → 业务 code 400', overSizeBody?.code === 400, JSON.stringify(overSizeBody))

const badPage = await fetch(`${BACKEND}/api/admin/users?page=0`, {
  headers: { token: adminToken },
}).then((r) => r.json())
console.log(`    page=0 → code=${badPage?.code}「${badPage?.message}」`)
check('page=0 → 业务 code 400', badPage?.code === 400, JSON.stringify(badPage))

// 0.3 看板 12 字段
const overviewRes = await fetch(`${BACKEND}/api/admin/dashboard/overview`, {
  headers: { token: adminToken },
}).then((r) => r.json())
const overview = overviewRes?.data ?? {}
const missing = ALL_KEYS.filter((k) => !(k in overview))
const extra = Object.keys(overview).filter((k) => !ALL_KEYS.includes(k))
console.log(`    看板字段：${JSON.stringify(overview)}`)
check('看板 12 个字段一个不少', missing.length === 0, `缺少 ${JSON.stringify(missing)}`)
check('看板没有多余字段（无「今日关注数」）', extra.length === 0, `多余 ${JSON.stringify(extra)}`)
check(
  '12 个字段都是数字',
  ALL_KEYS.every((k) => typeof overview[k] === 'number'),
  JSON.stringify(ALL_KEYS.map((k) => [k, typeof overview[k]])),
)

// 0.4 死信队列固定 6 条
const queues = await fetch(`${BACKEND}/api/admin/mq/queues`, {
  headers: { token: adminToken },
}).then((r) => r.json())
const queueList = queues?.data ?? []
console.log(`    队列：${queueList.map((q) => q.queueName).join(' | ')}`)
check('死信队列固定 6 条', Array.isArray(queueList) && queueList.length === 6, String(queueList.length))
check(
  '队列名带点号（原样保留，不截断）',
  queueList.every((q) => typeof q.queueName === 'string' && q.queueName.includes('.')),
)
check(
  '每个队列有 messageCount / consumerCount',
  queueList.every((q) => 'messageCount' in q && 'consumerCount' in q),
)

// 0.5 封自己 → 400（前端要提前禁用该行按钮）
const adminId = adminInfo?.data?.id ?? 2
const banSelf = await fetch(`${BACKEND}/api/admin/users/${adminId}/status?status=0`, {
  method: 'PUT',
  headers: { token: adminToken },
}).then((r) => r.json())
console.log(`    封自己(userId=${adminId}) → code=${banSelf?.code}「${banSelf?.message}」`)
check('封自己 → 业务 code 400', banSelf?.code === 400, JSON.stringify(banSelf))

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

  /** 用真实登录页登录（含「密码登录」Tab 切换），走的是与用户完全相同的链路 */
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

  /** 打开右上角用户下拉，返回菜单文本（用于判断管理入口是否存在） */
  const openUserMenu = async () => {
    await cdp.evaluate(`document.querySelector('.cm-header__user')?.click()`)
    await sleep(700)
    return cdp.evaluate(
      `document.querySelector('.el-dropdown-menu')?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''`,
    )
  }
  const closeUserMenu = async () => {
    await cdp.evaluate(`document.body.click()`)
    await sleep(400)
  }

  /* ==================== [1] 未登录访问 /admin ==================== */
  console.log('\n[1] 未登录访问 /admin')
  await goto(`http://localhost:${PORT}/`, 1600)
  await clearToken()
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/admin`, 2800)
  const anonUrl = await urlOf()
  console.log(`    地址：${anonUrl}`)
  check('被送到 /login', anonUrl.startsWith('/login'), anonUrl)
  check('redirect 保留了 /admin', decodeURIComponent(anonUrl).includes('redirect=/admin'), anonUrl)
  await shoot('t16-1-anon-redirect-login.png')

  /* ==================== [2] 管理员登录 → /admin ==================== */
  console.log('\n[2] 管理员（小明）UI 密码登录')
  cdp.clearEvents()
  await loginViaUi(ADMIN, '/admin')
  const adminUrl = await urlOf()
  console.log(`    登录后地址：${adminUrl}`)
  check('登录后落到 /admin', adminUrl.startsWith('/admin'), adminUrl)

  /* ==================== [3] ⭐ 看板 12 个数字逐项核对 ==================== */
  console.log('\n[3] 看板 12 个数字 vs 接口')
  const domStats = await cdp.evaluate(`(() => {
    const out = {}
    document.querySelectorAll('[data-stat]').forEach((el) => {
      out[el.getAttribute('data-stat')] = el.textContent.replace(/\\s+/g, '').trim()
    })
    return out
  })()`)
  // 页面渲染后再拉一次接口，避免中途数据变动导致的假红
  const liveOverview = await fetch(`${BACKEND}/api/admin/dashboard/overview`, {
    headers: { token: adminToken },
  }).then((r) => r.json())
  const live = liveOverview?.data ?? {}
  console.log(`    页面：${JSON.stringify(domStats)}`)
  console.log(`    接口：${JSON.stringify(live)}`)
  const renderedKeys = Object.keys(domStats)
  check('页面上 12 个数字都渲染出来了', renderedKeys.length === 12, `实际 ${renderedKeys.length} 个`)
  const mismatched = ALL_KEYS.filter((k) => domStats[k] !== String(live[k] ?? 0))
  check('12 个数字与接口逐项一致', mismatched.length === 0, `不一致：${JSON.stringify(mismatched.map((k) => [k, domStats[k], live[k]]))}`)
  const todayAllZero = TODAY_KEYS.every((k) => (live[k] ?? 0) === 0)
  if (todayAllZero) {
    check(
      '今日全为 0 时仍照常显示 0（不是空态）',
      TODAY_KEYS.every((k) => domStats[k] === '0'),
      JSON.stringify(TODAY_KEYS.map((k) => [k, domStats[k]])),
    )
  }
  const dashboardText = await bodyText()
  check('看板没有落进空态/错误态', !dashboardText.includes('暂无统计数据') && !dashboardText.includes('加载失败'))
  await shoot('t16-2-dashboard-admin.png')

  /* ==================== [4] Header 管理入口 ==================== */
  console.log('\n[4] Header「管理后台」入口')
  const adminMenu = await openUserMenu()
  console.log(`    管理员下拉菜单：${adminMenu}`)
  check('管理员可见「管理后台」入口', adminMenu.includes('管理后台'), adminMenu)
  await shoot('t16-3-admin-entry-menu.png')
  await closeUserMenu()

  /* ==================== [5] 4 条管理路由都能打开 ==================== */
  console.log('\n[5] 4 条管理路由')
  cdp.clearEvents()
  const routes = [
    { path: '/admin', expect: '数据看板' },
    { path: '/admin/users', expect: '用户治理' },
    { path: '/admin/content', expect: '内容治理' },
    { path: '/admin/mq', expect: '死信队列' },
  ]
  for (const r of routes) {
    await goto(`http://localhost:${PORT}${r.path}`, 2200)
    const text = await bodyText()
    const ok = text.includes(r.expect) && text.length > 40
    check(`${r.path} 正常渲染（含「${r.expect}」）`, ok, text.slice(0, 120))
  }
  await goto(`http://localhost:${PORT}/admin/users`, 2000)
  await shoot('t16-4-users-placeholder.png')

  /* ==================== [6] 请求头都是 token ==================== */
  console.log('\n[6] 请求头核验')
  const adminReqs = cdp.events.filter(
    (e) =>
      e.method === 'Network.requestWillBeSent' &&
      e.params.request.url.includes('/api/admin/'),
  )
  console.log(`    捕获到 ${adminReqs.length} 个 /api/admin/* 请求`)
  check('确实发出过 /api/admin/* 请求', adminReqs.length > 0, String(adminReqs.length))
  const badHeader = adminReqs.filter((e) => !e.params.request.headers.token)
  check(
    '所有 /api/admin/* 请求都带 token 头',
    badHeader.length === 0,
    badHeader.map((e) => e.params.request.url).join(' | '),
  )
  const dashboardReq = adminReqs.find((e) => e.params.request.url.includes('dashboard/overview'))
  check('看板请求命中 /api/admin/dashboard/overview', Boolean(dashboardReq))

  /* ==================== [7] 接口 403 兜底：会话中途被降权 ==================== */
  /*
   * 这一条专门验证 §0.1 纪律 2 的「不能只靠守卫」：
   *   `userInfo` 是**登录时拉一次的缓存** → 管理员被降权后前端可能仍是 admin。
   * 手法：保持**不刷新页面**（Pinia 不丢，role 仍是 1），只把 localStorage 里的
   *      token 换成非管理员的 → 看板会真的把请求发出去 → 后端 403 → 页面渲染 403 态。
   * 断言「请求确实发出了」很关键：它把「接口 403 兜底」与「本地 isAdmin 预检」
   * 两条路区分开 —— 后者不会发请求。
   */
  console.log('\n[7] 接口 403 兜底（Pinia 仍是 admin，token 已被换成非管理员）')
  await goto(`http://localhost:${PORT}/admin`, 2400)
  cdp.clearEvents()
  // SPA 内切走再切回（不刷新页面 → 守卫的 ensureUserInfo 因 infoLoaded 直接返回）
  await clickByText(cdp, '.cm-admin-tabs__item', '死信队列')
  await sleep(900)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(normalToken)})`)
  await clickByText(cdp, '.cm-admin-tabs__item', '数据看板')
  await sleep(2400)
  const downgradeText = await bodyText()
  const downgradeReqs = cdp.events.filter(
    (e) =>
      e.method === 'Network.requestWillBeSent' &&
      e.params.request.url.includes('/api/admin/dashboard/overview'),
  )
  console.log(`    降权后看板请求数：${downgradeReqs.length}`)
  console.log(`    正文片段：${downgradeText.slice(0, 140)}`)
  check(
    '降权后请求确实发出了（走的是接口 403 分支，不是本地预检）',
    downgradeReqs.length > 0,
    String(downgradeReqs.length),
  )
  check('接口 403 → 渲染「无管理员权限」', downgradeText.includes('无管理员权限'), downgradeText.slice(0, 140))
  check('接口 403 → 不是「加载失败」', !downgradeText.includes('加载失败'), downgradeText.slice(0, 140))
  await shoot('t16-6-forbidden-api-403.png')

  /* ==================== [8] 非管理员访问 /admin ==================== */
  console.log('\n[8] 非管理员（小红）访问 /admin')
  cdp.clearEvents()
  await loginViaUi(NORMAL, '/admin')
  const normalUrl = await urlOf()
  const normalText = await bodyText()
  console.log(`    地址：${normalUrl}`)
  console.log(`    正文片段：${normalText.slice(0, 160)}`)
  check('停在 /admin（守卫不跳走，交给页面渲染）', normalUrl.startsWith('/admin'), normalUrl)
  check('页面明确提示「无管理员权限」', normalText.includes('无管理员权限'), normalText.slice(0, 120))
  check('不是白屏（正文有内容）', normalText.length > 40, `长度 ${normalText.length}`)
  check(
    '不是「加载失败」这类通用错误',
    !normalText.includes('加载失败') && !normalText.includes('内容加载失败'),
    normalText.slice(0, 120),
  )
  const normalMenu = await openUserMenu()
  console.log(`    普通用户下拉菜单：${normalMenu}`)
  check('普通用户看不到「管理后台」入口', !normalMenu.includes('管理后台'), normalMenu)
  /*
   * 本地预检的旁证：已知非管理员时页面**不发** /api/admin/* 请求，
   * 避免制造一条注定 403 的请求 + 一条「没有权限执行该操作」的全局提示。
   */
  const normalAdminReqs = cdp.events.filter(
    (e) =>
      e.method === 'Network.requestWillBeSent' &&
      e.params.request.url.includes('/api/admin/'),
  )
  check('非管理员本地预检生效：未发出 /api/admin/* 请求', normalAdminReqs.length === 0, String(normalAdminReqs.length))
  await shoot('t16-5-forbidden-normal-user.png')
  await closeUserMenu()

  /* ==================== [9] 运行时健康度 ==================== */
  console.log('\n[9] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp
    .consoleErrors()
    .filter((t) => !/Failed to load resource|ERR_|net::|MinIO|404 \(Not Found\)/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（网络/图片失败除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
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
    if (browser?.profileDir) await fs.rm(browser.profileDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

const fail = summary()
console.log(`截图已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
