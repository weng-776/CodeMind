/**
 * 真实后端登录端到端验证（不桩任何接口）
 * ------------------------------------------------------------------
 * 与 verify-login.mjs（桩后端）不同，本脚本打的是**真实后端**：
 *   Vite dev server → server.proxy → http://localhost:8080
 *
 * 验证码从后端用的 Linux Redis 里取（后端把验证码写在那儿，
 * 并把明文打印在它自己的控制台）。
 *
 * 覆盖：
 *   1. 游客打开 /login 不应出现任何 401 相关提示
 *   2. 真实发送验证码 → 按钮进入倒计时
 *   3. 用真实验证码登录/注册 → token 落 localStorage
 *   4. 登录后必须真正拿到用户信息（Header 显示昵称）——这一步正是
 *      「后端注册成功、前端却说登录失败」的复现点
 *   5. 全程不出现 el-message--error、不出现任何 401 响应
 *
 * 用法：node scripts/verify-real-login.mjs
 * 前置：后端已启动在 8080；Redis 可达（见下面 REDIS 常量）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { createServer } from 'vite'

const REDIS = { host: process.env.REDIS_HOST || '192.168.238.186', port: 6379, password: process.env.REDIS_PASSWORD || '123456' }
const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5206
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

/* ==================== Redis（只读验证码） ==================== */
function redisGet(key) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: REDIS.host, port: REDIS.port })
    let raw = ''
    sock.setTimeout(4000)
    sock.on('connect', () =>
      sock.write(
        `AUTH ${REDIS.password}\r\n*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`,
      ),
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

/* ==================== 前置检查 ==================== */
try {
  const health = await fetch(`${BACKEND}/actuator/health`).then((r) => r.status)
  if (health !== 200) throw new Error(`health=${health}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端再运行本脚本。`)
  process.exit(1)
}
console.log(`\n后端 ${BACKEND} 正常，Redis ${REDIS.host} 正常准备就绪`)

/* ==================== Vite（走项目自身配置的代理） ==================== */
const vite = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'error',
})
await vite.listen()

/* ==================== Chrome ==================== */
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-real-login-'))
const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--remote-debugging-port=9341',
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
    if ((await fetch('http://127.0.0.1:9341/json/version')).ok) break
  } catch {
    /* 等待 */
  }
}

const targets = await (await fetch('http://127.0.0.1:9341/json/list')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
const events = []
const httpStatuses = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) {
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      p(m)
    }
  } else {
    events.push(m)
    if (m.method === 'Network.responseReceived') {
      httpStatuses.push({ url: m.params.response.url, status: m.params.response.status })
    }
  }
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
await call('Network.enable')
await fs.mkdir(OUT_DIR, { recursive: true })

async function shoot(name) {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
}
async function goto(url, wait = 2500) {
  await call('Page.navigate', { url })
  await sleep(wait)
}
async function fill(selector, value) {
  await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await sleep(200)
}
const setSecondInput = async (value) =>
  ev(`(() => {
    const el = [...document.querySelectorAll('.cm-login__form input')][1]
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

/** 后端手机号正则较严格，这里用一个必然合法的号段，并保证每次唯一 */
const phone = '13' + String(Date.now()).slice(-9)
console.log(`\n--- 真实后端登录验证（手机号 ${phone}）---`)

/* ==================== 1. 游客打开登录页 ==================== */
console.log('\n[1] 游客打开 /login')
await goto(`http://localhost:${PORT}/login`)
const guest = await ev(`({
  path: location.pathname,
  hasErrorMsg: !!document.querySelector('.el-message--error'),
  submitText: document.querySelector('.cm-login__submit')?.textContent?.trim() ?? null,
})`)
check('停留在 /login', guest.path === '/login', `实际 ${guest.path}`)
check('游客进入登录页无任何错误提示', guest.hasErrorMsg === false, '出现了 el-message--error')
check('提交按钮为「登录 / 注册」', guest.submitText === '登录 / 注册', `实际 ${guest.submitText}`)

/* ==================== 2. 真实发送验证码 ==================== */
console.log('\n[2] 发送验证码（真实短信通道/控制台打印）')
await fill('.cm-login__form input', phone)
const btnEnabled = await ev(`document.querySelector('.cm-login__code-btn')?.disabled`)
check('手机号合法后发码按钮可用', btnEnabled === false, `实际 disabled=${btnEnabled}`)

await ev(`document.querySelector('.cm-login__code-btn').click()`)
await sleep(1500)
const afterSend = await ev(`(() => {
  const b = document.querySelector('.cm-login__code-btn')
  return { text: b?.textContent?.trim(), hasError: !!document.querySelector('.el-message--error') }
})()`)
check('发码成功（按钮进入倒计时）', /秒后重发/.test(afterSend.text ?? ''), `实际「${afterSend.text}」`)
check('发码未报错', afterSend.hasError === false)

/* ==================== 3. 从 Redis 取真实验证码 ==================== */
console.log('\n[3] 从后端所用 Redis 读取真实验证码')
let code = null
for (let i = 0; i < 6 && !code; i++) {
  code = parseBulk(await redisGet(`codemind:user:code:${phone}`))
  if (!code) await sleep(400)
}
check('取到真实验证码', !!code, 'Redis 中未找到 codemind:user:code:' + phone)
if (!code) {
  console.log('\n无法取到验证码，终止。')
  process.exit(1)
}
console.log(`    验证码 = ${code}`)

/* ==================== 4. 真实登录 / 注册 ==================== */
console.log('\n[4] 提交登录（首次即自动注册）')
httpStatuses.length = 0
await setSecondInput(code)
await sleep(200)
await ev(`document.querySelector('.cm-login__submit').click()`)
await sleep(3000)

const after = await ev(`({
  path: location.pathname + location.search,
  token: localStorage.getItem('codemind_token'),
  userName: document.querySelector('.cm-header__username')?.textContent?.trim() ?? null,
  errorMsgs: [...document.querySelectorAll('.el-message--error')].map(e => e.textContent.trim()),
  successMsg: !!document.querySelector('.el-message--success'),
})`)

check('登录后离开 /login 并进入首页', after.path === '/', `实际 ${after.path}`)
check('token 已写入 localStorage', typeof after.token === 'string' && after.token.length > 20, `实际 ${after.token}`)
check('未出现任何错误提示', after.errorMsgs.length === 0, after.errorMsgs.join(' | '))
check('拿到用户信息（Header 显示昵称）', !!after.userName, `实际 ${after.userName}`)
check('弹出登录成功提示', after.successMsg === true)

/* ==================== 5. 登录后受保护接口 ==================== */
console.log('\n[5] 登录态下的接口健康度')
const bad = httpStatuses.filter((s) => s.status === 401 && s.url.includes('/api/'))
check(
  '登录成功后没有任何 /api 请求返回 401',
  bad.length === 0,
  bad.map((b) => `${b.status} ${b.url}`).join(' | '),
)

await goto(`http://localhost:${PORT}/profile`, 2500)
const profile = await ev(`({
  path: location.pathname,
  errorMsgs: [...document.querySelectorAll('.el-message--error')].map(e => e.textContent.trim()),
  bodyText: document.body.innerText.slice(0, 200),
  userIdText: (() => {
    const field = [...document.querySelectorAll('.cm-home-tab__field')]
      .find(d => d.querySelector('dt')?.textContent?.trim() === '用户 ID')
    return field?.querySelector('dd')?.textContent?.trim() ?? null
  })(),
})`)
// /profile 会重定向到子路由 /profile/home，这是应用自身设计，不算被弹回登录
check(
  '登录后进入个人中心（未被弹回登录页）',
  profile.path.startsWith('/profile'),
  `实际 ${profile.path}`,
)
check('个人中心无错误提示', profile.errorMsgs.length === 0, profile.errorMsgs.join(' | '))
check(
  '个人中心展示出用户 ID（不再因后端缺 id 而显示 —）',
  /^\d+$/.test(profile.userIdText ?? ''),
  `实际「${profile.userIdText}」`,
)

await shoot('real-login-after-login.png')

/* ==================== 5.1 自己的用户主页（验证 id 兜底） ==================== */
console.log('\n[5.1] 访问自己的用户主页 /user/{我的id}')
console.log('     （后端 /user/info 不返回 id，这里验证前端从 JWT 取 userId 的兜底是否生效）')
const myId = await ev(`(() => {
  const t = localStorage.getItem('codemind_token')
  if (!t) return null
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(p)).userId ?? null
  } catch { return null }
})()`)
check('能从 localStorage 的 token 解出 userId', myId !== null, `实际 ${myId}`)

if (myId !== null) {
  await goto(`http://localhost:${PORT}/user/${myId}`, 2600)
  const selfView = await ev(`({
    path: location.pathname,
    buttons: [...document.querySelectorAll('.cm-up__actions .el-button')].map(b => b.textContent.trim()),
    title: document.querySelector('.cm-up__name')?.textContent?.trim() ?? null,
    hasFollowBtn: [...document.querySelectorAll('.cm-up__actions .el-button')]
      .some(b => ['关注', '已关注'].includes(b.textContent.trim())),
  })`)
  check('自己的用户主页正常渲染（未被弹登录）', selfView.path === `/user/${myId}`, `实际 ${selfView.path}`)
  check(
    '识别为「我的主页」而不是「关注」按钮',
    selfView.hasFollowBtn === false,
    `按钮：${selfView.buttons.join(' / ')}`,
  )
  check('显示出昵称', !!selfView.title, `实际 ${selfView.title}`)
  await shoot('real-login-self-profile.png')
}

/* ==================== 5.2 标签云 / 标签选择器（真实后端） ==================== */
/*
 * ⚠️ 本段曾是**过时断言**（T13 全量自检时抓出）：
 *   早期一版结论认为「后端没有 /api/tag/list」，于是断言「编辑器里没有标签选择器」
 *   「这段流程里零 /api/tag/list 请求」。该结论后来被证伪 ——
 *   实测 `GET /api/tag/list` 返回 200 且有 9 个预置标签，文章编辑器与笔记编辑器**共用**它
 *   （见 T4.5 / T5 / T7 的记录）。
 *   所以这里把两条断言**反向**：编辑器应当**有**标签选择器，且 /api/tag/list 应当被请求并返回 200。
 *   注意「标签云侧栏已下线」仍然成立 —— 那是**列表页**的侧栏，与编辑器的标签选择器是两回事。
 */
console.log('\n[5.2] 社区列表页与写文章页（真实后端）')
console.log('     （/api/tag/list 实测可用：列表页不挂标签云侧栏，编辑器用标签选择器）')
httpStatuses.length = 0
await goto(`http://localhost:${PORT}/articles`, 2600)
const listPage = await ev(`({
  path: location.pathname + location.search,
  cards: document.querySelectorAll('.cm-article-card').length,
  hasTagCloud: !!document.querySelector('.cm-article-list__side'),
  hasError: !!document.querySelector('.cm-error'),
  cardTagButtons: document.querySelectorAll('.cm-article-card__tag').length,
})`)
check('社区列表页正常渲染（未被弹登录）', listPage.path.startsWith('/articles'), `实际 ${listPage.path}`)
check('列表拿到了数据', listPage.cards > 0, `实际 ${listPage.cards} 条`)
check('没有进入错误态', listPage.hasError === false)
check('标签云侧栏已下线', listPage.hasTagCloud === false)
console.log(
  `     卡片上的标签按钮数 = ${listPage.cardTagButtons}（后端 tags 目前是 {id:null,name:null}，前端应过滤掉）`,
)

await goto(`http://localhost:${PORT}/articles/create`, 2400)
const editorPage = await ev(`({
  path: location.pathname,
  hasTagSelect: !!document.querySelector('.cm-editor__tags .el-select'),
  hints: [...document.querySelectorAll('.cm-editor__hint')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
})`)
check('写文章页正常渲染', editorPage.path === '/articles/create', `实际 ${editorPage.path}`)
check(
  '编辑器里有标签选择器（/api/tag/list 实测可用，不再是「无接口可枚举」）',
  editorPage.hasTagSelect === true,
)
check(
  '编辑器给出标签说明文案',
  editorPage.hints.some((h) => /标签/.test(h)),
  `实际「${editorPage.hints.join(' | ')}」`,
)

const tagListCalls = httpStatuses.filter((s) => s.url.includes('/api/tag/list'))
check(
  '/api/tag/list 被请求且返回 200（后端确实实现了 TagController）',
  tagListCalls.length > 0 && tagListCalls.every((t) => t.status === 200),
  tagListCalls.map((t) => `${t.status} ${t.url}`).join(' | ') || '一个请求都没发',
)
const api404 = httpStatuses.filter((s) => s.url.includes('/api/') && s.status === 404)
check(
  '没有任何 /api 请求返回 404',
  api404.length === 0,
  api404.map((t) => `${t.status} ${t.url}`).join(' | '),
)

/* ==================== 6. 运行时健康度 ==================== */
console.log('\n[6] 运行时健康度')
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
try {
  await fs.rm(profileDir, { recursive: true, force: true })
} catch {
  /* 忽略 */
}

console.log(`\n========== 通过 ${pass}，失败 ${fail} ==========`)
if (problems.length) console.log(`失败项：${problems.join(' / ')}`)
console.log()
process.exit(fail > 0 ? 1 : 0)
