/**
 * T1.5 验收：请求层错误码透传 + 提示职责收敛（真实后端，不桩任何接口）
 * ------------------------------------------------------------------
 * 覆盖：
 *   a. 无 token + 密码错误 → 提示「手机号或密码错误」，且**只弹一次**
 *   b. localStorage 先塞旧 token + 密码错 → 提示**只弹一次**（本单核心回归点）
 *   c. ApiError 的 code 取值：业务失败=响应体 code、传输层失败=HTTP status、
 *      无响应=NETWORK_ERROR_CODE(-1)
 *   d. message 取值与重构前一致（页面文案不变）
 *   e. 静态检查：LoginView 内已无 message 文本匹配
 *
 * 前置：后端 8080；账号 13800000002 / 123456。
 * 用法：node scripts/verify-t15-error-code.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, setInput, clickByText } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5209
const DEBUG_PORT = 9345
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

/* ==================== 静态检查：LoginView 不再按文本判错 ==================== */
const loginSrc = await fs.readFile(
  path.resolve(process.cwd(), 'src/views/auth/LoginView.vue'),
  'utf8',
)
check('LoginView 内无 message 文本匹配', !/message\s*===|message\.includes\(/.test(loginSrc))
check('LoginView 按 ApiError.code 判断', /err\.code\s*===\s*401/.test(loginSrc))

/* ==================== Vite + Chrome ==================== */
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
  /**
   * 强刷导航：先跳 about:blank 再跳目标地址。
   * ⚠️ 直接 Page.navigate 到「与当前完全相同的 URL」时页面可能不重新加载，
   * 于是登录页会保留上一次点过的 Tab（密码模式），后面的用例就会错位。
   */
  const goto = async (url, wait = 2200) => {
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(150)
    await cdp.send('Page.navigate', { url })
    await sleep(wait)
  }
  /** 高频采样错误 toast 的最大共存数量（两个提示同时弹时必须能被数到 2） */
  const maxErrorToasts = async (ms = 2600) => {
    let max = 0
    let texts = []
    const start = Date.now()
    while (Date.now() - start < ms) {
      const snap = await cdp.evaluate(`[...document.querySelectorAll('.el-message--error')].map(e => e.textContent.trim())`)
      if (snap.length > max) {
        max = snap.length
        texts = snap
      }
      await sleep(80)
    }
    return { max, texts }
  }
  const fillPasswordForm = async (password) => {
    await clickByText(cdp, '.cm-login__tab', '密码登录')
    await sleep(400)
    await setInput(cdp, '.cm-login__form input:nth-of-type(1)', PHONE)
    await setInput(cdp, '.cm-login__form input[type="password"]', password)
    await sleep(250)
  }

  /* ==================== a. 无 token + 密码错误 → 只弹一次 ==================== */
  console.log('\n[a] 无 token 时密码错误（提示只弹一次）')
  await goto(`http://localhost:${PORT}/login`)
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  await fillPasswordForm('wrongpwd')
  await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
  const a = await maxErrorToasts()
  check(
    '弹出「手机号或密码错误」',
    a.texts.some((t) => t.includes('手机号或密码错误')),
    `实际 ${JSON.stringify(a.texts)}`,
  )
  check('提示只弹一次（不是 0 次也不是 2 次）', a.max === 1, `实际 ${a.max} 个共存 toast`)
  const aState = await cdp.evaluate(`({
    token: localStorage.getItem('codemind_token'),
    path: location.pathname,
  })`)
  check('失败不写 token', aState.token === null, `实际 ${aState.token}`)
  check('停留在 /login', aState.path === '/login', `实际 ${aState.path}`)
  await shoot('t15-a-no-token-wrong-pwd.png')

  /* ==================== b. 旧 token + 密码错误 → 只弹一次（核心回归） ==================== */
  console.log('\n[b] localStorage 带旧 token 时密码错误（核心回归：不许弹两次）')
  await goto(`http://localhost:${PORT}/login`)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(REAL_TOKEN)})`)
  await fillPasswordForm('wrongpwd')
  await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
  const b = await maxErrorToasts()
  check(
    '弹出「手机号或密码错误」（后端原文）',
    b.texts.some((t) => t.includes('手机号或密码错误')),
    `实际 ${JSON.stringify(b.texts)}`,
  )
  check('提示只弹一次（修复前为 2 次）', b.max === 1, `实际 ${b.max} 个共存 toast`)
  const bState = await cdp.evaluate(`({
    token: localStorage.getItem('codemind_token'),
    path: location.pathname,
  })`)
  check('请求层按约定清掉了旧 token', bState.token === null, `实际 ${bState.token}`)
  check('仍停留在 /login（不生硬跳转）', bState.path === '/login', `实际 ${bState.path}`)
  await shoot('t15-b-stale-token-wrong-pwd.png')

  /* ==================== c. ApiError 的 code 取值 ==================== */
  console.log('\n[c] ApiError.code：业务 code / HTTP status / 无响应 -1')
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(REAL_TOKEN)})`)

  // c1. 业务失败：文章不存在 → {code:404}
  const biz = await cdp.evaluate(`(async () => {
    const req = await import('/src/api/request.ts')
    const { getUserProfile } = await import('/src/api/user.ts')
    try {
      await getUserProfile(999999)
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        isApiError: e instanceof req.ApiError,
        name: e.name,
        code: e.code,
        message: e.message,
      }
    }
  })()`)
  check('业务失败抛的是 ApiError', biz.isApiError === true && biz.name === 'ApiError', JSON.stringify(biz))
  check('业务失败 code = 响应体 code（404，用户不存在）', biz.code === 404, JSON.stringify(biz))
  check('message 取值未变（后端原文）', biz.message === '用户不存在', `实际 ${biz.message}`)

  // c2. 传输层失败：不带 token 打受保护接口 → HTTP 401（真实非 2xx）
  //     （注意：后端对「不存在的路径」也是 HTTP 200 + body code=404，测不出传输层分支）
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  cdp.clearEvents()
  const transport = await cdp.evaluate(`(async () => {
    const req = await import('/src/api/request.ts')
    try {
      await req.http.get('/user/info')
      return { ok: true }
    } catch (e) {
      return { ok: false, code: e.code, message: e.message }
    }
  })()`)
  const httpStatus = cdp.events
    .filter((e) => e.method === 'Network.responseReceived' && e.params.response.url.includes('/api/user/info'))
    .map((e) => e.params.response.status)[0]
  check('传输层失败实测 HTTP 401', httpStatus === 401, `实际 ${httpStatus}`)
  check(
    '传输层失败 code = HTTP status',
    transport.code === httpStatus,
    `ApiError.code=${transport.code}，Network status=${httpStatus}`,
  )

  // c3. 无响应（离线）→ code = -1
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  })
  const offline = await cdp.evaluate(`(async () => {
    const req = await import('/src/api/request.ts')
    try {
      await req.http.get('/user/info')
      return { ok: true }
    } catch (e) {
      return { ok: false, code: e.code, message: e.message }
    }
  })()`)
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  check('无响应时 code = NETWORK_ERROR_CODE(-1)', offline.code === -1, JSON.stringify(offline))
  check('断网文案未变（网络异常，无法连接服务器）', offline.message === '网络异常，无法连接服务器', `实际 ${offline.message}`)

  /* ==================== d. 400 业务失败：仍是请求层弹一次 ==================== */
  console.log('\n[d] 验证码错误（400）→ 请求层弹一次、页面不重复弹')
  await goto(`http://localhost:${PORT}/login`)
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  await setInput(cdp, '.cm-login__form input:nth-of-type(1)', PHONE)
  await sleep(200)
  const codeFilled = await setInput(cdp, '.cm-login__form input[placeholder*="验证码"]', '000000')
  check('验证码登录 Tab 下能定位到验证码输入框（未被上一次的 Tab 状态污染）', codeFilled === true)
  await sleep(250)
  await cdp.evaluate(`document.querySelector('.cm-login__submit').click()`)
  const d = await maxErrorToasts()
  check('提示只弹一次', d.max === 1, `实际 ${d.max} 个共存 toast：${JSON.stringify(d.texts)}`)
  check(
    '出现验证码相关提示（后端原文）',
    d.texts.some((t) => /验证码/.test(t)),
    `实际 ${JSON.stringify(d.texts)}`,
  )
  await shoot('t15-d-code-login-failed.png')

  /* ==================== e. 运行时健康度 ==================== */
  console.log('\n[e] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp.consoleErrors().filter((t) => !/40\d|429|Failed to load resource/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（4xx 资源日志除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
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
console.log(`截图证据已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
