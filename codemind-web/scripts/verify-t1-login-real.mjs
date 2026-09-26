/**
 * T1 验收：登录链路（真实后端，不桩任何接口）
 * ------------------------------------------------------------------
 * 覆盖工单 T1 的「做什么」与「验收」：
 *   1. 验证码登录跑通（真实验证码从 Redis 取）+ 密码登录跑通（贴响应片段）
 *   2. 手机号格式非法 → 本地拦下，一个请求都不发
 *   3. 60 秒倒计时；60 秒内重复发码 → 429 文案「请稍后再试」要有提示
 *   4. 登录失败不写 token；成功后拉用户信息 + 未读数
 *   5. 用户 id 走 userInfo.id ?? JWT.userId 兜底
 *   6. 已登录访问 /login 被弹回首页
 *   7. redirect 内层 query（/articles/12?tab=hot）原样还原
 *   8. 过期 token → 401「登陆过期请重新登陆」+ 跳登录；
 *      游客（无 token）打受保护接口 → 401 但不清 token、不跳登录
 *
 * 前置：后端 8080；Redis 可达（读验证码）；账号 13800000002 / 123456。
 * 用法：node scripts/verify-t1-login-real.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, waitFor, setInput, clickByText } from './lib/cdp-harness.mjs'

const REDIS = {
  host: process.env.REDIS_HOST || '192.168.238.186',
  port: 6379,
  password: process.env.REDIS_PASSWORD || '123456',
}
const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5208
const DEBUG_PORT = 9344
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const PHONE = '13800000002'
const PASSWORD = '123456'
const REDIRECT_TARGET = '/articles/12?tab=hot'

const { check, summary } = createReporter()

/* ==================== Redis 只读取验证码 ==================== */
function redisGet(key) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: REDIS.host, port: REDIS.port })
    let raw = ''
    sock.setTimeout(4000)
    sock.on('connect', () =>
      sock.write(`AUTH ${REDIS.password}\r\n*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`),
    )
    sock.on('data', (d) => (raw += d.toString('utf8')))
    sock.on('timeout', () => {
      sock.destroy()
      resolve(raw)
    })
    sock.on('error', reject)
    sock.on('close', () => resolve(raw))
  })
}
function parseBulk(raw) {
  const rest = raw.slice(raw.indexOf('\r\n') + 2)
  if (!rest.startsWith('$')) return null
  const nl = rest.indexOf('\r\n')
  const len = Number(rest.slice(1, nl))
  return len < 0 ? null : rest.slice(nl + 2, nl + 2 + len)
}

/* ==================== 前置：后端可达 ==================== */
try {
  const status = await fetch(`${BACKEND}/api/article/latest`).then((r) => r.status)
  if (status !== 200) throw new Error(`latest=${status}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端。`)
  process.exit(1)
}

/* ==================== Vite（走项目自身的代理 → 8080） ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT })
  const cdp = browser.cdp
  await fs.mkdir(OUT_DIR, { recursive: true })

  const shoot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
  }
  const goto = async (url, wait = 2200) => {
    await cdp.send('Page.navigate', { url })
    await sleep(wait)
  }
  const toasts = () =>
    cdp.evaluate(`[...document.querySelectorAll('.el-message')].map(e => e.textContent.trim())`)
  const state = () =>
    cdp.evaluate(`({
      path: location.pathname + location.search,
      token: localStorage.getItem('codemind_token'),
      userName: document.querySelector('.cm-header__username')?.textContent?.trim() ?? null,
      badge: document.querySelector('.cm-header__badge')?.textContent?.trim() ?? null,
      errorToasts: [...document.querySelectorAll('.el-message--error')].map(e => e.textContent.trim()),
    })`)
  const apiCalls = (part) =>
    cdp.events.filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes(part))
  const apiResponses = (part) =>
    cdp.events.filter((e) => e.method === 'Network.responseReceived' && e.params.response.url.includes(part))
  const errors = () =>
    cdp
      .consoleErrors()
      .filter((t) => !/40[134]|429|Failed to load resource/i.test(t))

  /* ==================== A. 游客访问受保护路由 → 带 redirect 去登录页 ==================== */
  // 注意：/articles/:id 与 /notes/:id 的 meta.requiresAuth 是 **false**
  // （05 §3.2：详情页允许游客停留并自行显示「登录后查看」），守卫不会拦。
  // 这里用真正 requiresAuth: true 且带多个 query 的路由，验证 redirect 的完整性。
  const GUARDED_TARGET = '/notes?page=2&visibility=1'
  console.log('\n[A] 未登录访问受保护路由（带内层 query）')
  await goto(`http://localhost:${PORT}${GUARDED_TARGET}`)
  const guard = await cdp.evaluate(`({
    path: location.pathname + location.search,
    rawSearch: location.search,
  })`)
  check(
    '被送到 /login 且 redirect 带完整 fullPath（含内层 query）',
    guard.path.startsWith('/login') && decodeURIComponent(guard.rawSearch).includes(GUARDED_TARGET),
    `实际 ${guard.path}`,
  )
  await shoot('t1-1-guard-redirect.png')

  /* ==================== B. 手机号非法：本地拦下，不发请求 ==================== */
  console.log('\n[B] 手机号格式非法 → 不发任何登录请求')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/login?redirect=${encodeURIComponent(REDIRECT_TARGET)}`)
  await setInput(cdp, '.cm-login__form input:nth-of-type(1)', '12345')
  await sleep(300)
  const badPhone = await cdp.evaluate(`({
    codeBtnDisabled: document.querySelector('.cm-login__code-btn')?.disabled ?? null,
  })`)
  check('手机号非法时发码按钮禁用', badPhone.codeBtnDisabled === true)
  await cdp.evaluate(`document.querySelector('.cm-login__code-btn').click()`)
  await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
  await sleep(1200)
  check('未发起 sendCode 请求', apiCalls('/api/user/sendCode').length === 0)
  check('未发起任何 login 请求', apiCalls('/api/user/login').length === 0)
  check('仍停留在 /login', (await state()).path.startsWith('/login'))

  /* ==================== C. 验证码登录（真实验证码）+ redirect 还原 ==================== */
  console.log('\n[C] 验证码登录（真实验证码从 Redis 取）')
  await setInput(cdp, '.cm-login__form input:nth-of-type(1)', PHONE)
  await sleep(250)
  cdp.clearEvents()
  await cdp.evaluate(`document.querySelector('.cm-login__code-btn').click()`)
  await sleep(1500)
  const afterSend = await cdp.evaluate(
    `document.querySelector('.cm-login__code-btn')?.textContent?.trim() ?? null`,
  )
  check('发码成功 → 按钮进入 60s 倒计时', /秒后重发/.test(afterSend ?? ''), `实际「${afterSend}」`)

  let code = null
  for (let i = 0; i < 8 && !code; i += 1) {
    code = parseBulk(await redisGet(`codemind:user:code:${PHONE}`))
    if (!code) await sleep(400)
  }
  check('从 Redis 取到真实验证码', !!code)
  if (code) {
    console.log(`    验证码 = ${code}`)
    await cdp.evaluate(`(() => {
      const el = [...document.querySelectorAll('.cm-login__form input')][1]
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(code)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(250)
    cdp.clearEvents()
    await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
    await sleep(2800)
    const after = await state()
    check('登录成功写入 token', typeof after.token === 'string' && after.token.length > 20)
    check(
      `redirect 原样还原到 ${REDIRECT_TARGET}`,
      after.path === REDIRECT_TARGET,
      `实际 ${after.path}`,
    )
    /*
     * ⚠️ 不要写死种子昵称。
     * 这条断言要证明的是「Header 把 1.4 拉到的昵称渲染出来了」，而不是「昵称等于某个字面量」。
     * 写死 `=== '小明'` 的版本在测试账号昵称被改动后必然失败（2026-09-23 实测 28/29），
     * 但它失败时并不能说明 Header 有问题 —— 属于依赖种子数据的脆断言。
     * 正确做法：拿 1.4 的返回值交叉验证（数据无关）。
     */
    const infoApi = await fetch(`${BACKEND}/api/user/info`, {
      headers: { token: after.token },
    }).then((r) => r.json())
    check(
      'Header 昵称与 1.4 的返回值一致',
      !!infoApi?.data?.userName && after.userName === infoApi.data.userName,
      `Header=${JSON.stringify(after.userName)} vs /user/info=${JSON.stringify(infoApi?.data?.userName)}`,
    )
    check('Header 昵称非空', !!after.userName, `实际 ${JSON.stringify(after.userName)}`)
    check('Header 未读数已拉取（4.2）', after.badge !== null, `实际 ${after.badge}`)
    await shoot('t1-2-code-login-redirect.png')
  }

  /* ==================== D. 60s 内重复发码 → 429 提示 ==================== */
  console.log('\n[D] 60 秒内重复发码（真实后端返回 code=429 请稍后再试）')
  cdp.clearEvents()
  await cdp.evaluate(`(async () => {
    const m = await import('/src/api/user.ts')
    try { await m.sendCode({ phone: ${JSON.stringify(PHONE)} }) } catch { /* 请求层已提示 */ }
  })()`)
  await sleep(1200)
  const limitToasts = await toasts()
  check(
    '弹出「请稍后再试」提示',
    limitToasts.some((t) => t.includes('请稍后再试')),
    `实际 ${JSON.stringify(limitToasts)}`,
  )
  await shoot('t1-3-sendcode-limit.png')

  /* ==================== E. 已登录访问 /login → 弹回首页 ==================== */
  console.log('\n[E] 已登录访问 /login')
  await goto(`http://localhost:${PORT}/login`)
  const authed = await cdp.evaluate(`location.pathname`)
  check('已登录访问 /login 被弹回首页', authed === '/', `实际 ${authed}`)

  /* ==================== F. 密码登录（贴 Network 响应片段） ==================== */
  console.log('\n[F] 密码登录（13800000002 / 123456）')
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  await goto(`http://localhost:${PORT}/login`)
  await clickByText(cdp, '.cm-login__tab', '密码登录')
  await sleep(500)
  await setInput(cdp, '.cm-login__form input:nth-of-type(1)', PHONE)
  await setInput(cdp, '.cm-login__form input[type="password"]', PASSWORD)
  await sleep(300)
  cdp.clearEvents()
  await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
  await sleep(2800)

  const loginRes = apiResponses('/api/user/login/password')
  const reqId = loginRes[0]?.params?.requestId
  let bodyText = null
  if (reqId) {
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId: reqId })
      bodyText = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
    } catch {
      bodyText = null
    }
  }
  check('密码登录响应 HTTP 200', loginRes[0]?.params?.response?.status === 200)
  check(
    '响应体 code=200 且 data.token 存在',
    !!bodyText && /"code":\s*200/.test(bodyText) && /"token":/.test(bodyText),
    `实际 ${bodyText}`,
  )
  const pwdAfter = await state()
  check('登录后跳转首页（无 redirect 时）', pwdAfter.path === '/', `实际 ${pwdAfter.path}`)
  check('密码登录写入 token', typeof pwdAfter.token === 'string' && pwdAfter.token.length > 20)
  if (bodyText) {
    await fs.writeFile(
      path.join(OUT_DIR, 't1-4-password-login-response.json'),
      JSON.stringify(JSON.parse(bodyText), null, 2),
    )
  }
  await shoot('t1-5-password-login-ok.png')

  /* ==================== G. 密码错误 → 有可读提示 + 不写 token ==================== */
  console.log('\n[G] 密码登录失败（错误密码 / 4 位密码边界）')
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  await goto(`http://localhost:${PORT}/login`)
  await clickByText(cdp, '.cm-login__tab', '密码登录')
  await sleep(500)
  await setInput(cdp, '.cm-login__form input:nth-of-type(1)', PHONE)
  await setInput(cdp, '.cm-login__form input[type="password"]', 'wrongpwd')
  await sleep(300)
  cdp.clearEvents()
  await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
  await sleep(2500)
  const failed = await state()
  check('密码错误时弹出「手机号或密码错误」', failed.errorToasts.some((t) => t.includes('手机号或密码错误')), `实际 ${JSON.stringify(failed.errorToasts)}`)
  check('登录失败不写 token', !failed.token, `实际 ${failed.token}`)
  check('失败后仍停留在 /login', failed.path.startsWith('/login'), `实际 ${failed.path}`)
  await shoot('t1-6-password-failed.png')

  // 4 位密码：后端 ^\w{4,32}$ 允许，前端不许提前拦
  cdp.clearEvents()
  await setInput(cdp, '.cm-login__form input[type="password"]', '1234')
  await sleep(300)
  await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
  await sleep(1800)
  check(
    '4 位密码不再被前端本地拦下（请求真的发出去了）',
    apiCalls('/api/user/login/password').length >= 1,
    `实际 ${apiCalls('/api/user/login/password').length} 次`,
  )

  /* ==================== H. 过期 token → 401 + 跳登录 ==================== */
  console.log('\n[H] 带过期 token 请求受保护接口')
  const EXPIRED =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJYIiwiZXhwIjoxMDAwMDAwMDAwLCJ1c2VySWQiOjJ9.aaa'
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(EXPIRED)})`)
  await goto(`http://localhost:${PORT}/notifications`, 3000)
  const expired = await state()
  const expiredToasts = await toasts()
  check(
    '提示「登陆过期请重新登陆」（后端原文）',
    expiredToasts.some((t) => t.includes('登陆过期请重新登陆')),
    `实际 ${JSON.stringify(expiredToasts)}`,
  )
  check('过期 token 已被清掉', expired.token === null, `实际 ${expired.token}`)
  check('被送去 /login 且带 redirect', expired.path.startsWith('/login'), `实际 ${expired.path}`)
  await shoot('t1-7-expired-token.png')

  /* ==================== I. 游客（无 token）→ 401 不清不跳 ==================== */
  console.log('\n[I] 游客访问需要登录的页面（无 token 的 401）')
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  await goto(`http://localhost:${PORT}/articles/14`, 3000)
  const guest = await state()
  check('游客停留在原页面（没有跳 /login）', guest.path.startsWith('/articles/14'), `实际 ${guest.path}`)
  check(
    '游客不会看到「登录状态已失效」',
    !guest.errorToasts.some((t) => t.includes('登录状态已失效')),
    `实际 ${JSON.stringify(guest.errorToasts)}`,
  )
  const guestText = await cdp.evaluate(
    `document.querySelector('.cm-detail')?.innerText?.slice(0, 120) ?? ''`,
  )
  check(
    '游客请求 401 时页面不弹全局错误提示（只有页面内错误态）',
    guest.errorToasts.length === 0,
    `实际 ${JSON.stringify(guest.errorToasts)}`,
  )
  // 观察项（不属 T1 范围，详情页的游客态归 T4/T7）：
  // 05 §3.2 要求详情页对游客给「登录后查看」，当前实现给的是「文章加载失败」。
  console.log(`    ⚠ 观察：游客看到的页面文案 = 「${guestText.replace(/\s+/g, ' ').trim()}」`)
  console.log('      → 05 §3.2 要求「登录后查看」，属文章/笔记详情页职责（T4/T7），已记入交接块')
  await shoot('t1-8-guest-401.png')

  /* ==================== J. 运行时健康度 ==================== */
  console.log('\n[J] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = errors()
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（401/429 资源日志除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
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
    /* Windows 上目录可能仍被占用 */
  }
}

const fail = summary()
console.log(`截图与响应证据已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
