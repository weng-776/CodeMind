/**
 * 登录页与登录流程验证（真实 Chrome）
 * ------------------------------------------------------------------
 * 覆盖：
 *   1. 双 Tab 切换、表单渲染、图标、样式生效性
 *   2. 手机号格式校验（错误号码不发请求）
 *   3. 发送验证码 → 按钮进入倒计时且被禁用
 *   4. 验证码登录成功 → token 落 localStorage → 跳转 redirect
 *   5. 密码登录成功 → 跳转首页
 *   6. 登录失败 → 停留原页、给出提示、按钮恢复可用
 *   7. redirectIfAuthed：已登录访问 /login 自动跳首页
 *
 * 用法：node scripts/verify-login.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'vite'
import { createServer as createHttp } from 'node:http'

const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ==================== 桩后端 ==================== */
let stubLog = []
const stub = createHttp((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    stubLog.push({ method: req.method, url: req.url, body })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')

    const ok = (data) => res.end(JSON.stringify({ code: 200, message: 'ok', data }))
    const bad = (msg) => res.end(JSON.stringify({ code: 500, message: msg, data: null }))

    if (req.url.startsWith('/api/user/sendCode')) return ok(true)

    if (req.url.startsWith('/api/user/login/code')) {
      const parsed = JSON.parse(body || '{}')
      // 刻意留一个失败分支：验证码 000000 视为错误
      if (parsed.code === '000000') return bad('验证码错误或已过期')
      return ok({ token: 'stub-token-by-code' })
    }

    if (req.url.startsWith('/api/user/login/password')) {
      const parsed = JSON.parse(body || '{}')
      if (parsed.password === 'wrongpass') return bad('手机号或密码错误')
      return ok({ token: 'stub-token-by-password' })
    }

    if (req.url.startsWith('/api/user/info')) {
      return ok({
        id: 1,
        userName: '阿燃',
        phone: '13800138000',
        avatar: '',
        intro: '正在构建 CodeMind',
        fansCount: 12,
        followCount: 8,
        noteCount: 5,
        articleCount: 3,
      })
    }

    if (req.url.startsWith('/api/notify/unread')) return ok(5)

    if (req.url.includes('/article/')) {
      return ok({ total: 0, size: 10, current: 1, records: [] })
    }

    res.statusCode = 404
    res.end(JSON.stringify({ code: 404, message: 'not found', data: null }))
  })
})
await new Promise((r) => stub.listen(8130, r))

/* ==================== Vite ==================== */
const vite = await createServer({
  server: {
    port: 5205,
    strictPort: true,
    proxy: { '/api': { target: 'http://localhost:8130', changeOrigin: true } },
  },
  logLevel: 'error',
})
await vite.listen()

/* ==================== Chrome ==================== */
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-login-'))
const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--remote-debugging-port=9340',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1440,1000',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

for (let i = 0; i < 40; i++) {
  await sleep(250)
  try {
    if ((await fetch('http://127.0.0.1:9340/json/version')).ok) break
  } catch {
    /* 等待 */
  }
}

const targets = await (await fetch('http://127.0.0.1:9340/json/list')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) {
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      p(m)
    }
  } else events.push(m)
})
const call = async (method, params = {}) => {
  const m = await new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`)
  return m.result
}
const ev = async (expr) =>
  (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
    .result.value

await call('Page.enable')
await call('Runtime.enable')
await fs.mkdir(OUT_DIR, { recursive: true })

async function shoot(name) {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
}

async function goto(url, wait = 2200) {
  await call('Page.navigate', { url })
  await sleep(wait)
}

/** 在输入框里填值 —— 必须派发 input 事件，否则 v-model 不更新 */
async function fill(selector, value) {
  await ev(`(() => {
    const el = document.querySelector('${selector}')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
}

console.log('\n--- 登录页验证 ---')

/* ==================== 1. 渲染与样式 ==================== */
console.log('\n[1. 页面渲染]')
await goto('http://localhost:5205/login')

const view = await ev(`(() => {
  const q = (s) => document.querySelector(s)
  const t = (s) => q(s)?.textContent?.trim() ?? null
  const allInputs = [...document.querySelectorAll('.cm-login__form input')]
  return {
    title: document.title,
    slogan: t('.cm-login__slogan'),
    cardTitle: t('.cm-login__title'),
    tabs: [...document.querySelectorAll('.cm-login__tab')].map(e => e.textContent.trim()),
    activeTab: q('.cm-login__tab.is-active')?.textContent?.trim() ?? null,
    brandVisible: q('.cm-login__brand') ? getComputedStyle(q('.cm-login__brand')).display !== 'none' : false,
    inputCount: allInputs.length,
    placeholders: allInputs.map(i => i.placeholder),
    hasCodeButton: !!q('.cm-login__code-btn'),
    codeBtnText: t('.cm-login__code-btn'),
    codeBtnDisabled: q('.cm-login__code-btn')?.disabled ?? null,
    submitText: t('.cm-login__submit'),
    // 样式生效性
    submitBg: q('.cm-login__submit') ? getComputedStyle(q('.cm-login__submit')).backgroundColor : null,
    gridCols: q('.cm-login') ? getComputedStyle(q('.cm-login')).gridTemplateColumns.split(' ').length : null,
    brandBg: q('.cm-login__brand') ? getComputedStyle(q('.cm-login__brand')).backgroundImage.slice(0, 30) : null,
    logoMarkBg: q('.cm-login__logo-mark') ? getComputedStyle(q('.cm-login__logo-mark')).backgroundColor : null,
  }
})()`)

check('文档标题为「登录 · CodeMind」', view.title === '登录 · CodeMind', `实际 ${view.title}`)
check('品牌标语渲染', (view.slogan ?? '').includes('把技术沉淀下来'), `实际 ${view.slogan}`)
check('表单标题渲染', view.cardTitle === '登录 CodeMind', `实际 ${view.cardTitle}`)
check(
  '两个 Tab 且默认验证码登录',
  JSON.stringify(view.tabs) === JSON.stringify(['验证码登录', '密码登录']) && view.activeTab === '验证码登录',
  `tabs=${JSON.stringify(view.tabs)} active=${view.activeTab}`,
)
check('品牌区在宽屏可见', view.brandVisible)
check('默认渲染 2 个输入框（手机号 + 验证码）', view.inputCount === 2, `实际 ${view.inputCount}`)
check('验证码模式下有「获取验证码」按钮', view.hasCodeButton)
check('手机号未填时发码按钮禁用', view.codeBtnDisabled === true, `实际 disabled=${view.codeBtnDisabled}`)
check('提交按钮文案为「登录 / 注册」', view.submitText === '登录 / 注册', `实际 ${view.submitText}`)

const submitBg = view.submitBg
check('提交按钮套用主题色', submitBg === 'rgb(58, 85, 212)', `实际 ${submitBg}`)
check('Logo 底色为主题色', view.logoMarkBg === 'rgb(58, 85, 212)', `实际 ${view.logoMarkBg}`)
check('左右两栏布局', view.gridCols === 2, `实际 ${view.gridCols} 列`)
check('品牌区有径向底纹', (view.brandBg ?? '').includes('gradient'), `实际 ${view.brandBg}`)

await shoot('login-code-tab.png')

/* ==================== 2. Tab 切换 ==================== */
console.log('\n[2. 切换到密码登录]')
await ev(`document.querySelectorAll('.cm-login__tab')[1].click()`)
await sleep(500)

const pwd = await ev(`(() => {
  const q = (s) => document.querySelector(s)
  const inputs = [...document.querySelectorAll('.cm-login__form input')]
  return {
    activeTab: q('.cm-login__tab.is-active')?.textContent?.trim() ?? null,
    inputCount: inputs.length,
    types: inputs.map(i => i.type),
    hasCodeButton: !!q('.cm-login__code-btn'),
    submitText: q('.cm-login__submit')?.textContent?.trim() ?? null,
    labels: [...document.querySelectorAll('.el-form-item__label')].map(e => e.textContent.replace('*','').trim()),
  }
})()`)

check('Tab 切换到密码登录', pwd.activeTab === '密码登录', `实际 ${pwd.activeTab}`)
check('仍为 2 个输入框（手机号 + 密码）', pwd.inputCount === 2, `实际 ${pwd.inputCount}`)
check('存在 password 类型输入框', pwd.types.includes('password'), `实际 ${JSON.stringify(pwd.types)}`)
check('密码模式下无发码按钮', !pwd.hasCodeButton)
check('提交按钮文案变为「登录」', pwd.submitText === '登录', `实际 ${pwd.submitText}`)
check(
  '表单标签为「手机号 / 密码」',
  JSON.stringify(pwd.labels) === JSON.stringify(['手机号', '密码']),
  `实际 ${JSON.stringify(pwd.labels)}`,
)

await shoot('login-password-tab.png')

/* ==================== 3. 手机号校验 ==================== */
console.log('\n[3. 手机号格式校验]')
await ev(`document.querySelectorAll('.cm-login__tab')[0].click()`)
await sleep(400)

stubLog = []
await fill('.cm-login__form input', '12345')
const afterBadPhone = await ev(`(() => {
  const b = document.querySelector('.cm-login__code-btn')
  return { disabled: b?.disabled ?? null, text: b?.textContent?.trim() }
})()`)
check('非法手机号时发码按钮仍禁用', afterBadPhone.disabled === true, `实际 ${afterBadPhone.disabled}`)

const sentBefore = stubLog.filter((l) => l.url.includes('sendCode')).length
check('未触发 sendCode 请求', sentBefore === 0, `实际发了 ${sentBefore} 次`)

/* ==================== 4. 发送验证码 → 倒计时 ==================== */
console.log('\n[4. 发送验证码与倒计时]')
await fill('.cm-login__form input', '13800138000')
await sleep(200)

const afterGoodPhone = await ev(`document.querySelector('.cm-login__code-btn')?.disabled`)
check('合法手机号后发码按钮可用', afterGoodPhone === false, `实际 disabled=${afterGoodPhone}`)

stubLog = []
await ev(`document.querySelector('.cm-login__code-btn').click()`)
await sleep(1300)

const afterSend = await ev(`(() => {
  const b = document.querySelector('.cm-login__code-btn')
  return { text: b?.textContent?.trim(), disabled: b?.disabled ?? null }
})()`)
const sendCalls = stubLog.filter((l) => l.url.includes('sendCode')).length

check('已发起 sendCode 请求', sendCalls === 1, `实际 ${sendCalls} 次`)
check('按钮进入倒计时', /秒后重发/.test(afterSend.text ?? ''), `实际文案 ${afterSend.text}`)
check('倒计时期间按钮禁用', afterSend.disabled === true, `实际 disabled=${afterSend.disabled}`)

// 等待 2 秒确认真的在递减
const t1 = afterSend.text
await sleep(2100)
const t2 = await ev(`document.querySelector('.cm-login__code-btn')?.textContent?.trim()`)
check('倒计时数字在递减', t1 !== t2 && /秒后重发/.test(t2 ?? ''), `${t1} → ${t2}`)

/* ==================== 5. 验证码登录失败 ==================== */
console.log('\n[5. 登录失败（验证码错误）]')
await fill('.cm-login__form input:nth-of-type(1)', '13800138000')
// 验证码输入框是第二个
await ev(`(() => {
  const inputs = [...document.querySelectorAll('.cm-login__form input')]
  const el = inputs[1]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, '000000')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(200)

await ev(`document.querySelector('.cm-login__submit').click()`)
await sleep(1500)

const afterFail = await ev(`({
  path: location.pathname,
  token: localStorage.getItem('codemind_token'),
  hasErrorMsg: !!document.querySelector('.el-message--error'),
  submitDisabled: document.querySelector('.cm-login__submit')?.disabled ?? null,
})`)

check('失败后仍停留在 /login', afterFail.path === '/login', `实际 ${afterFail.path}`)
check('失败时未写入 token', !afterFail.token, `实际 token=${afterFail.token}`)
check('失败时弹出错误提示', afterFail.hasErrorMsg)
check('失败后提交按钮恢复可用', afterFail.submitDisabled === false, `实际 ${afterFail.submitDisabled}`)

await shoot('login-error.png')

/* ==================== 6. 验证码登录成功 + redirect ==================== */
console.log('\n[6. 登录成功并跳转 redirect]')
await goto('http://localhost:5205/login?redirect=%2Farticles%3Ftab%3Dhot')

await fill('.cm-login__form input:nth-of-type(1)', '13800138000')
await ev(`(() => {
  const inputs = [...document.querySelectorAll('.cm-login__form input')]
  const el = inputs[1]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, '123456')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(250)

await ev(`document.querySelector('.cm-login__submit').click()`)
await sleep(2200)

const afterSuccess = await ev(`({
  path: location.pathname + location.search,
  token: localStorage.getItem('codemind_token'),
  headerUserName: document.querySelector('.cm-header__username')?.textContent?.trim() ?? null,
  badge: document.querySelector('.cm-header__badge')?.textContent?.trim() ?? null,
  hasSuccessMsg: !!document.querySelector('.el-message--success'),
})`)

check('登录成功写入 token', afterSuccess.token === 'stub-token-by-code', `实际 ${afterSuccess.token}`)
check(
  '按 redirect 跳转到 /articles?tab=hot',
  afterSuccess.path === '/articles?tab=hot',
  `实际 ${afterSuccess.path}`,
)
check('跳转后 Header 显示用户名', afterSuccess.headerUserName === '阿燃', `实际 ${afterSuccess.headerUserName}`)
check('跳转后 Header 显示未读红点 5', afterSuccess.badge === '5', `实际 ${afterSuccess.badge}`)
check('弹出登录成功提示', afterSuccess.hasSuccessMsg)

await shoot('after-login.png')

/* ==================== 7. redirectIfAuthed ==================== */
console.log('\n[7. 已登录访问 /login 自动跳首页]')
await goto('http://localhost:5205/login')
await sleep(800)

const authed = await ev(`({ path: location.pathname, title: document.title })`)
check('已登录访问 /login 被重定向到 /', authed.path === '/', `实际 ${authed.path}`)

/* ==================== 8. 密码登录 ==================== */
console.log('\n[8. 密码登录]')
await ev(`localStorage.removeItem('codemind_token')`)
await goto('http://localhost:5205/login')
await ev(`document.querySelectorAll('.cm-login__tab')[1].click()`)
await sleep(400)

await fill('.cm-login__form input:nth-of-type(1)', '13800138000')
await ev(`(() => {
  const inputs = [...document.querySelectorAll('.cm-login__form input')]
  const el = inputs[1]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, 'mypassword123')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(250)

stubLog = []
await ev(`document.querySelector('.cm-login__submit').click()`)
await sleep(2200)

const pwdLogin = await ev(`({ path: location.pathname, token: localStorage.getItem('codemind_token') })`)
const pwdCalls = stubLog.filter((l) => l.url.includes('login/password')).length

check('发起密码登录请求', pwdCalls === 1, `实际 ${pwdCalls} 次`)
check('密码登录成功写入对应 token', pwdLogin.token === 'stub-token-by-password', `实际 ${pwdLogin.token}`)
check('无 redirect 时跳首页', pwdLogin.path === '/', `实际 ${pwdLogin.path}`)

/* ==================== 9. 窄屏 ==================== */
console.log('\n[9. 窄屏适配]')
await ev(`localStorage.removeItem('codemind_token')`)
await call('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await goto('http://localhost:5205/login')

const mobile = await ev(`(() => {
  const q = (s) => document.querySelector(s)
  const de = document.documentElement
  const offenders = [...document.querySelectorAll('*')].filter(el => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.right > de.clientWidth + 1
  }).map(el => el.className?.toString().slice(0,40))
  return {
    brandHidden: q('.cm-login__brand') ? getComputedStyle(q('.cm-login__brand')).display === 'none' : null,
    overflow: de.scrollWidth - de.clientWidth,
    offenders: offenders.slice(0, 3),
  }
})()`)

check('窄屏隐藏品牌区', mobile.brandHidden === true, `实际 ${mobile.brandHidden}`)
check('窄屏无横向溢出', mobile.overflow === 0, `溢出 ${mobile.overflow}px: ${JSON.stringify(mobile.offenders)}`)

await shoot('login-mobile.png')

/* ==================== 10. 运行时健康度 ==================== */
console.log('\n[10. 运行时健康度]')
const exceptions = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails.exception?.description ?? '未知')
const consoleErrors = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  .filter((t) => !/404|Failed to load resource/i.test(t))

check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

chrome.kill()
await vite.close()
stub.close()
try {
  await fs.rm(profileDir, { recursive: true, force: true })
} catch {
  /* 忽略 */
}

console.log(`\n========== 通过 ${pass}，失败 ${fail} ==========`)
if (problems.length) console.log(`失败项：${problems.join(' / ')}`)
console.log()
process.exit(fail > 0 ? 1 : 0)
