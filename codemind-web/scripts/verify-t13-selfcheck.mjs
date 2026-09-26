#!/usr/bin/env node
/**
 * T13 交付前自检：需要「真实浏览器证据」的几条清单项
 * ------------------------------------------------------------------
 * 端口：vite 5224（proxy → 真实后端 8080）、CDP 9358
 *
 * 覆盖 05 手册 §8 里靠读代码证不了的几条：
 *   1. 所有请求的请求头都是 `token`（Network 逐个确认）
 *   2. 未登录访问受保护页面 → 跳登录且带 `redirect`
 *   3. 后端停止时页面进错误态 + 有重试（不白屏）
 *   4. 控制台 0 未捕获异常、0 console.error
 *
 * 其余清单项由 `npm test` / `npm run test:*` / `npm run shot:*` 与 T12 脚本覆盖。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep, startVite, launchBrowser, shutdown, createReporter } from './lib/cdp-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = 5224
const DEBUG_PORT = 9358
const BACKEND = 'http://localhost:8080'
const BASE = `http://localhost:${PORT}`
const API_PREFIX = `${BASE}/api/`

const { check, summary } = createReporter()

/** 这几个接口本来就不该带 token（登录/注册） */
const NO_TOKEN_ENDPOINTS = [/\/api\/user\/login\//, /\/api\/user\/register/, /\/api\/user\/code/]

async function login(phone) {
  const res = await fetch(`${BACKEND}/api/user/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password: '123456' }),
  })
  const json = await res.json()
  if (json.code !== 200) throw new Error(`登录失败：${json.message}`)
  return json.data.token
}

let viteServer
let browser
let cdp

try {
  console.log('[准备] 启动 vite(5224 → 后端 8080) 与无头浏览器')
  viteServer = await startVite({ port: PORT, stubPort: 8080 })
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1440,1000' })
  cdp = browser.cdp

  /* ==================== 2. 未登录 → 跳登录且带 redirect ==================== */
  console.log('\n[自检 2] 未登录访问受保护页面')
  /*
   * ⚠️ 两个别踩的坑（第一版都写错了）：
   *   1. `/profile` 会被路由重定向到它的默认子路由 `/profile/home`，
   *      所以 `redirect` 是 `/profile/home` 而不是 `/profile` —— 这是**正确行为**，
   *      断言不能用全等，要用「以目标开头」。
   *   2. 登录页**默认是「验证码登录」Tab**，密码输入框只有切到密码 Tab 才渲染
   *      （LoginView 里是 `v-if/v-else`）。用 `input[type=password]` 判断「不是白屏」
   *      必然为假。改用登录卡片本身 + 手机号输入框。
   */
  for (const target of ['/articles/create', '/notes/create', '/notifications', '/profile']) {
    await cdp.send('Page.navigate', { url: `${BASE}${target}` })
    await sleep(1500)
    const info = await cdp.evaluate(`({
      url: location.pathname + location.search,
      redirect: new URLSearchParams(location.search).get('redirect'),
      card: !!document.querySelector('.cm-login'),
      phoneInput: !!document.querySelector('.cm-login input'),
    })`)
    console.log(`    ${target} → ${info.url}`)
    check(`未登录访问 ${target} 被送到登录页`, info.url.startsWith('/login'), info.url)
    check(
      `登录页带上了 redirect（指向 ${target}）`,
      typeof info.redirect === 'string' && info.redirect.startsWith(target),
      String(info.redirect),
    )
    check('登录页渲染出表单（不是白屏）', info.card === true && info.phoneInput === true)
  }

  /* ==================== 1. 请求头都是 token ==================== */
  console.log('\n[自检 1] 所有 /api 请求都带 `token` 请求头')
  const token = await login('13800000002')
  await cdp.send('Page.navigate', { url: `${BASE}/login` })
  await sleep(800)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(token)})`)

  cdp.clearEvents()
  // 走一圈主要页面，把各类请求都发出来
  for (const p of ['/', '/articles', '/notes', '/notifications', '/profile']) {
    await cdp.send('Page.navigate', { url: `${BASE}${p}` })
    await sleep(1600)
  }

  const apiReqs = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => e.params.request)
    .filter((r) => r.url.startsWith(API_PREFIX))

  const needToken = apiReqs.filter((r) => !NO_TOKEN_ENDPOINTS.some((re) => re.test(r.url)))
  const missing = needToken.filter((r) => !r.headers.token)
  console.log(`    /api 请求共 ${apiReqs.length} 条，其中需带 token 的 ${needToken.length} 条`)
  console.log(`    样本：${needToken.slice(0, 3).map((r) => new URL(r.url).pathname).join(', ')}`)
  check('需要认证的 /api 请求全部带了 `token` 头', missing.length === 0, missing.map((r) => r.url).join(' | '))
  check('确实发过需认证的请求（不是空集合）', needToken.length > 0, String(needToken.length))

  const paths = [...new Set(needToken.map((r) => new URL(r.url).pathname))]
  console.log(`    覆盖到的接口：${paths.join(', ')}`)

  /* ==================== 3. 后端停止 → 错误态 + 重试 ==================== */
  console.log('\n[自检 3] 后端不可用时进错误态 + 有重试（不白屏）')
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: `${API_PREFIX}*`, requestStage: 'Request' }],
  })
  // 挂一个自己的监听，把接口请求全部打死
  cdp.ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.method !== 'Fetch.requestPaused') return
    const { requestId, request } = msg.params
    if (request.url.startsWith(API_PREFIX)) {
      void cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {})
    } else {
      void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
  })

  for (const p of ['/articles', '/notes', '/notifications']) {
    await cdp.send('Page.navigate', { url: `${BASE}${p}` })
    await sleep(2000)
    const st = await cdp.evaluate(`({
      error: !!document.querySelector('.cm-error'),
      retry: [...document.querySelectorAll('.cm-error__actions button')].map(b => b.textContent.trim()),
      bodyLen: document.body.innerText.trim().length,
    })`)
    console.log(`    ${p} → 错误态=${st.error}｜按钮=${JSON.stringify(st.retry)}`)
    check(`${p} 后端不可用时进错误态`, st.error === true)
    check(`${p} 提供了重试入口`, st.retry.some((t) => t.includes('重新')), JSON.stringify(st.retry))
    check(`${p} 没有白屏`, st.bodyLen > 50, String(st.bodyLen))
  }
  await cdp.send('Fetch.disable').catch(() => {})

  /* ==================== 4. 控制台健康度 ==================== */
  console.log('\n[自检 4] 控制台')
  const exs = cdp.exceptions()
  const errs = cdp.consoleErrors().filter((t) => !/Failed to load resource|net::ERR/i.test(t))
  console.log(`    未捕获异常 ${exs.length} 条｜console.error（已滤掉网络类）${errs.length} 条`)
  check('0 未捕获异常', exs.length === 0, JSON.stringify(exs.slice(0, 2)))
  check('0 console.error（不含网络请求失败）', errs.length === 0, JSON.stringify(errs.slice(0, 2)))
} catch (err) {
  console.error('\n[脚本异常]', err)
  process.exitCode = 1
} finally {
  await shutdown({
    cdp,
    proc: browser?.proc,
    profileDir: browser?.profileDir,
    viteServer,
  })
  const failCount = summary()
  process.exitCode = failCount > 0 ? 1 : 0
}
