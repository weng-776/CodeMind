/**
 * T17 验收：管理端 · 用户治理（真实后端 + 真实 Chrome）
 * ------------------------------------------------------------------
 * 覆盖工单 T17 的验收项（`管理端前端设计说明.md` §6）：
 *   0. 后端契约核验：分页字段、keyword 双字段匹配、400/404/封自己 错误分支
 *   1. **未登录**访问 /admin/users → 跳 `/login?redirect=…`
 *   2. 管理员登录 → 表格渲染，6 列齐全（头像/昵称/手机号/角色/状态/注册时间）
 *   3. **管理员自己那行**的操作按钮禁用（后端会 400）
 *   4. 搜索：手机号一次、昵称一次（URL 带 keyword，结果正确）
 *   5. 搜索无结果 → 空态（不是错误态）
 *   6. 分页：URL 带 page，内容真的换了页
 *   7. loading 态可见（用 CDP 网络延迟逼出）
 *   8. error 态可见且带重试（用 CDP 阻断请求逼出，恢复后能重试成功）
 *   9. 封禁：**二次确认文案如实说明后果**；点取消 → 不发请求、状态不变；
 *      点确认 → PUT 带 `?status=0`（**query 不是 body**）→ 该行变「已封禁」→ 后端已落库
 *  10. 解封：状态回到「正常」，后端已落库
 *  11. **非管理员**访问 → 明确「无管理员权限」
 *  12. 所有 `/api/admin/*` 请求头都是 `token`
 *  13. 控制台 0 未捕获异常、0 console.error
 *
 * ⚠️ 本脚本会**临时封禁一个真实用户再解封**（`finally` 里强制还原 status=1）。
 *    选中的是「非管理员、非当前登录用户」的第一条记录。
 * ⚠️ 库里原本只有 7 个用户，**不足 2 页**，翻页器根本不会出现。
 *    所以脚本会先注册若干测试用户把总数顶到 11（用手机验证码登录自动注册，
 *    验证码从 Redis 明文读）。**后端没有删除用户的接口，这些账号会留在库里** ——
 *    号码是 `13500008801~13500008804`，要清理直接删这几行即可。
 *    因此本脚本的前置多一条：**Redis 可达**。
 *
 * 前置：后端 8080 在跑；Redis 192.168.238.186:6379 可达。
 * 用法（package.json 在禁止清单里，用绝对路径跑）：
 *   "/c/Users/翁甲燃/.workbuddy/binaries/node/versions/22.22.2-3/node" scripts/verify-t17-admin.mjs
 */
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { createServer } from 'vite'

import {
  cancelMessageBox,
  clickByText,
  confirmMessageBox,
  createReporter,
  launchBrowser,
  setInput,
  sleep,
} from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
/** 端口与既有脚本错开（… T16=5227/9361） */
const PORT = 5228
const DEBUG_PORT = 9362
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const ADMIN = { phone: '13800000002', password: '123456', name: '小明' }
const NORMAL = { phone: '13800000003', password: '123456', name: '小红' }
/** 搜索用例用的关键词（实测：手机号与昵称各命中 1 条） */
const SEARCH_PHONE = '13800000003'
const SEARCH_NAME = '小红'

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

/** 从 JWT payload 取 userId（前端 `userStore.userId` 也是这么兜底的，见 05 §约束 12） */
function userIdFromJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).userId
  } catch {
    return null
  }
}

/* ==================== Redis：只读取验证码（用于注册测试用户） ==================== */
const REDIS = {
  host: process.env.REDIS_HOST || '192.168.238.186',
  port: 6379,
  password: process.env.REDIS_PASSWORD || '123456',
}

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

/** 用手机验证码登录（后端会自动注册新用户），返回是否成功 */
async function registerUser(phone) {
  const send = await fetch(`${BACKEND}/api/user/sendCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  }).then((r) => r.json())
  if (send?.code !== 200) return { ok: false, reason: `sendCode code=${send?.code} ${send?.message}` }

  let code = null
  for (let i = 0; i < 12 && !code; i += 1) {
    code = parseBulk(await redisGet(`codemind:user:code:${phone}`))
    if (!code) await sleep(300)
  }
  if (!code) return { ok: false, reason: 'Redis 里没读到验证码' }

  const login = await fetch(`${BACKEND}/api/user/login/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  }).then((r) => r.json())
  return { ok: login?.code === 200, reason: `login code=${login?.code} ${login?.message}` }
}

const adminToken = await apiLogin(ADMIN.phone, ADMIN.password)
const normalToken = await apiLogin(NORMAL.phone, NORMAL.password)
const adminId = userIdFromJwt(adminToken)

const adminHeaders = { token: adminToken }
const getUsers = (qs) =>
  fetch(`${BACKEND}/api/admin/users${qs}`, { headers: adminHeaders }).then((r) => r.json())
const putStatus = (id, status) =>
  fetch(`${BACKEND}/api/admin/users/${id}/status?status=${status}`, {
    method: 'PUT',
    headers: adminHeaders,
  }).then((r) => r.json())

/**
 * 兜底还原：无论中途怎么失败，都要把测试用户恢复成「正常」。
 *
 * ⚠️ 还原结果**必须断言**，不能只 `console.log`（核验方 §12.4：T17/T18/T19
 * 连续三单同一缺陷 —— 清理失败时脚本照样报全绿、照样 EXIT=0，
 * 会静默留下被封禁的真实用户）。
 */
async function restoreUser(userId) {
  if (!userId) return
  try {
    const res = await putStatus(userId, 1)
    console.log(`    ↩ 兜底还原 userId=${userId} → code=${res?.code}`)
    check(`兜底还原用户 ${userId} 为「正常」`, res?.code === 200, JSON.stringify(res))
  } catch (e) {
    console.log(`    ⚠ 兜底还原失败：${e.message}`)
    check(`兜底还原用户 ${userId} 为「正常」`, false, e.message)
  }
}

let targetUser = null

/* ==================== [0] 后端契约核验 ==================== */
console.log('\n[0] 后端契约核验（直接打后端，不经过页面）')
check('管理员可密码登录', typeof adminToken === 'string' && adminToken.length > 20)
check('普通用户可密码登录', typeof normalToken === 'string' && normalToken.length > 20)
check('能从 JWT 解出管理员 userId', Number.isInteger(adminId), String(adminId))

const page1 = await getUsers('?page=1&size=2')
const page1Data = page1?.data ?? {}
console.log(
  `    page=1&size=2 → total=${page1Data.total} size=${page1Data.size} current=${page1Data.current} pages=${page1Data.pages} records=${page1Data.records?.length}`,
)
check('分页响应含 records/total/size/current/pages', ['records', 'total', 'size', 'current', 'pages'].every((k) => k in page1Data))
check('响应**没有** `page` 字段（一律读 current）', !('page' in page1Data))
check('size 生效（返回 2 条）', page1Data.records?.length === 2, String(page1Data.records?.length))

const firstRecord = page1Data.records?.[0] ?? {}
const expectedKeys = ['id', 'phone', 'userName', 'avatar', 'intro', 'status', 'role', 'createTime']
const missingKeys = expectedKeys.filter((k) => !(k in firstRecord))
console.log(`    记录字段：${Object.keys(firstRecord).join(', ')}`)
check('列表项 8 个字段一个不少', missingKeys.length === 0, `缺少 ${JSON.stringify(missingKeys)}`)
check('响应里没有 password（后端刻意手写字段拷贝）', !('password' in firstRecord))

const byPhone = await getUsers(`?keyword=${SEARCH_PHONE}`)
console.log(`    keyword=${SEARCH_PHONE} → total=${byPhone?.data?.total}，命中 ${JSON.stringify(byPhone?.data?.records?.map((r) => r.userName))}`)
check('keyword 模糊匹配手机号（命中 1 条）', byPhone?.data?.total === 1, String(byPhone?.data?.total))

const byName = await getUsers(`?keyword=${encodeURIComponent(SEARCH_NAME)}`)
console.log(`    keyword=${SEARCH_NAME} → total=${byName?.data?.total}，命中 ${JSON.stringify(byName?.data?.records?.map((r) => r.userName))}`)
check('keyword 模糊匹配昵称（命中 1 条）', byName?.data?.total === 1, String(byName?.data?.total))

const noMatch = await getUsers('?keyword=__no_such_user_zzz__')
check('无匹配 → total=0（页面应进空态）', noMatch?.data?.total === 0, String(noMatch?.data?.total))

const overSize = await fetch(`${BACKEND}/api/admin/users?page=1&size=51`, { headers: adminHeaders }).then((r) => r.json())
console.log(`    size=51 → code=${overSize?.code}「${overSize?.message}」`)
check('size=51 → 业务 code 400', overSize?.code === 400, JSON.stringify(overSize))

const badPage = await fetch(`${BACKEND}/api/admin/users?page=0`, { headers: adminHeaders }).then((r) => r.json())
console.log(`    page=0 → code=${badPage?.code}「${badPage?.message}」`)
check('page=0 → 业务 code 400', badPage?.code === 400, JSON.stringify(badPage))

const badStatus = await putStatus(firstRecord.id ?? 7, 2)
console.log(`    status=2 → code=${badStatus?.code}「${badStatus?.message}」`)
check('status=2 → 业务 code 400', badStatus?.code === 400, JSON.stringify(badStatus))

const notFound = await putStatus(999999, 1)
console.log(`    不存在用户 → code=${notFound?.code}「${notFound?.message}」`)
check('用户不存在 → 业务 code 404', notFound?.code === 404, JSON.stringify(notFound))

const banSelf = await putStatus(adminId, 0)
console.log(`    封自己(userId=${adminId}) → code=${banSelf?.code}「${banSelf?.message}」`)
check('封自己 → 业务 code 400', banSelf?.code === 400, JSON.stringify(banSelf))

// 选一个「非管理员、非自己」的用户作为封禁测试对象
const all = await getUsers('?page=1&size=50')
targetUser =
  (all?.data?.records ?? []).find((u) => u.role !== 1 && u.id !== adminId) ?? null
console.log(`    封禁测试对象：${JSON.stringify(targetUser && { id: targetUser.id, userName: targetUser.userName, status: targetUser.status })}`)
check('找到可封禁的测试用户', Boolean(targetUser))
check('测试用户当前是正常状态（前置）', targetUser?.status === 1, String(targetUser?.status))

/* ==================== [0.5] 顶足分页数据 ==================== */
console.log('\n[0.5] 准备分页数据')
const SEED_PHONES = ['13500008801', '13500008802', '13500008803', '13500008804']
const totalBefore = (await getUsers('?page=1&size=50'))?.data?.total ?? 0
console.log(`    当前用户数：${totalBefore}`)
const seeded = []
for (const phone of SEED_PHONES) {
  if (totalBefore + seeded.length >= 11) break
  const r = await registerUser(phone)
  console.log(`    注册 ${phone} → ${r.ok ? '成功' : `失败（${r.reason}）`}`)
  if (r.ok) seeded.push(phone)
}
const totalAfter = (await getUsers('?page=1&size=50'))?.data?.total ?? 0
console.log(
  `    注册后用户数：${totalAfter}（本次新注册 ${seeded.length} 个${seeded.length ? `：${seeded.join(', ')}` : ''}）`,
)
check('用户数已超过 1 页（翻页器可测）', totalAfter > 10, String(totalAfter))
check(
  'page=1&size=2 的 pages 与总数自洽',
  (await getUsers('?page=1&size=2'))?.data?.pages === Math.ceil(totalAfter / 2),
  String((await getUsers('?page=1&size=2'))?.data?.pages),
)

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

  /** 读表格每一行（列顺序与模板一致） */
  const readRows = () =>
    cdp.evaluate(`(() => {
      return [...document.querySelectorAll('.cm-user-table tbody tr')].map((tr) => {
        const tds = tr.querySelectorAll('td')
        const btn = tds[5]?.querySelector('button')
        return {
          name: tr.querySelector('.cm-user-cell__name')?.textContent?.trim() ?? '',
          phone: tds[1]?.textContent?.trim() ?? '',
          role: tds[2]?.textContent?.trim() ?? '',
          status: tds[3]?.textContent?.trim() ?? '',
          time: tds[4]?.textContent?.trim() ?? '',
          action: btn?.textContent?.trim() ?? '',
          disabled: btn ? btn.disabled === true : null,
          hasAvatar: Boolean(tr.querySelector('.cm-user-cell__avatar')),
        }
      })
    })()`)

  /** 点某一行的操作按钮（按昵称定位；每次重查，避免重渲染后引用脱离文档） */
  const clickRowAction = (name) =>
    cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.cm-user-table tbody tr')]
      const tr = rows.find((r) => r.querySelector('.cm-user-cell__name')?.textContent?.trim() === ${JSON.stringify(name)})
      if (!tr) return false
      const btn = tr.querySelectorAll('td')[5]?.querySelector('button')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()`)

  const statusRequests = () =>
    cdp.events.filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        e.params.request.method === 'PUT' &&
        e.params.request.url.includes('/api/admin/users/') &&
        e.params.request.url.includes('/status'),
    )

  const setLatency = (ms) =>
    cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: ms,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })

  /* ==================== [1] 未登录访问 ==================== */
  console.log('\n[1] 未登录访问 /admin/users')
  await goto(`http://localhost:${PORT}/`, 1600)
  await clearToken()
  await goto(`http://localhost:${PORT}/admin/users`, 2800)
  const anonUrl = await urlOf()
  console.log(`    地址：${anonUrl}`)
  check('被送到 /login', anonUrl.startsWith('/login'), anonUrl)
  check('redirect 保留了 /admin/users', decodeURIComponent(anonUrl).includes('redirect=/admin/users'), anonUrl)

  /* ==================== [2] 管理员登录 → 表格 ==================== */
  console.log('\n[2] 管理员登录 → 用户列表')
  await loginViaUi(ADMIN, '/admin/users')
  const listUrl = await urlOf()
  console.log(`    地址：${listUrl}`)
  check('登录后落到 /admin/users', listUrl.startsWith('/admin/users'), listUrl)

  const rows = await readRows()
  console.log(`    行数：${rows.length}`)
  console.log(`    第一行：${JSON.stringify(rows[0])}`)
  check('表格渲染出行（每页 10 条，不足则全出）', rows.length === Math.min(10, totalAfter), `${rows.length} vs ${Math.min(10, totalAfter)}`)
  check('每行都有头像元素（加载失败走 el-avatar 兜底）', rows.every((r) => r.hasAvatar))
  check('昵称列有值', rows.every((r) => r.name.length > 0))
  check('手机号列是 11 位手机号', rows.every((r) => /^\d{11}$/.test(r.phone)), JSON.stringify(rows.map((r) => r.phone)))
  check('角色列有「管理员 / 普通用户」标签', rows.every((r) => ['管理员', '普通用户'].includes(r.role)), JSON.stringify(rows.map((r) => r.role)))
  check('状态列有「正常 / 已封禁」标签', rows.every((r) => ['正常', '已封禁'].includes(r.status)), JSON.stringify(rows.map((r) => r.status)))
  check('注册时间列有值', rows.every((r) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.time)), JSON.stringify(rows.map((r) => r.time)))
  check('普通行的操作按钮默认可用', rows.every((r) => r.disabled === false), JSON.stringify(rows.map((r) => r.disabled)))
  await shoot('t17-1-user-list.png')

  /* ==================== [3] 管理员自己那行 ==================== */
  console.log('\n[3] 管理员自己那行')
  /*
   * ⚠️ 不能直接在第 1 页找管理员：列表按 id 倒序，管理员的 id 最小（2），
   *    一旦总数超过 10 就会翻到第 2 页去。这里用搜索定位，才是稳的。
   */
  await setInput(cdp, '.cm-user-toolbar__search input', ADMIN.name)
  await sleep(1600)
  const selfRows = await readRows()
  const selfRow = selfRows.find((r) => r.phone === ADMIN.phone)
  console.log(`    搜「${ADMIN.name}」→ ${selfRows.length} 行：${JSON.stringify(selfRows)}`)
  check('搜索能定位到管理员自己', Boolean(selfRow))
  check('自己那行有「管理员」标记', selfRow?.role === '管理员', String(selfRow?.role))
  check('自己那行操作按钮**禁用**', selfRow?.disabled === true, JSON.stringify(selfRow))
  check('自己那行按钮文案是「封禁」', selfRow?.action === '封禁', String(selfRow?.action))
  await shoot('t17-2-self-disabled.png')

  // 清空搜索，回到全量
  await setInput(cdp, '.cm-user-toolbar__search input', '')
  await sleep(1800)

  /* ==================== [4][5] 搜索 ==================== */
  console.log('\n[4][5] 搜索（手机号 / 昵称）')
  await setInput(cdp, '.cm-user-toolbar__search input', SEARCH_PHONE)
  await sleep(1400)
  const afterPhone = await urlOf()
  const phoneRows = await readRows()
  console.log(`    手机号搜索后 URL：${afterPhone}，行数=${phoneRows.length}`)
  check('URL 带上 keyword（手机号）', decodeURIComponent(afterPhone).includes(`keyword=${SEARCH_PHONE}`), afterPhone)
  check('按手机号搜到 1 条', phoneRows.length === 1, String(phoneRows.length))
  check('搜到的正是小红', phoneRows[0]?.name === SEARCH_NAME, String(phoneRows[0]?.name))

  await setInput(cdp, '.cm-user-toolbar__search input', SEARCH_NAME)
  await sleep(1400)
  const afterName = await urlOf()
  const nameRows = await readRows()
  console.log(`    昵称搜索后 URL：${afterName}，行数=${nameRows.length}`)
  check('URL 带上 keyword（昵称）', decodeURIComponent(afterName).includes(`keyword=${SEARCH_NAME}`), afterName)
  check('按昵称搜到 1 条', nameRows.length === 1, String(nameRows.length))
  check('搜到的正是小红', nameRows[0]?.name === SEARCH_NAME, String(nameRows[0]?.name))
  await shoot('t17-3-search-result.png')

  /* ==================== [5b] 搜索无结果 → 空态 ==================== */
  console.log('\n[5b] 搜索无结果 → 空态')
  await setInput(cdp, '.cm-user-toolbar__search input', '__no_such_user_zzz__')
  await sleep(1600)
  const emptyText = await bodyText()
  const emptyHasError = await cdp.evaluate(`Boolean(document.querySelector('.cm-error'))`)
  console.log(`    正文片段：${emptyText.slice(0, 120)}`)
  check('进空态（「没有匹配的用户」）', emptyText.includes('没有匹配的用户'), emptyText.slice(0, 120))
  check('空态不是错误态', emptyHasError === false)
  check('没有表格行', (await readRows()).length === 0)
  await shoot('t17-4-empty.png')

  // 清空搜索回到全量（顺带验一下 el-input 的「×」清空按钮）
  await cdp.evaluate(`document.querySelector('.cm-user-toolbar__search .el-input__clear')?.click()`)
  await sleep(1800)
  const clearedUrl = await urlOf()
  const clearedRows = await readRows()
  console.log(`    清空后 URL：${clearedUrl}，行数=${clearedRows.length}`)
  check('点「×」清空后 URL 不带 keyword', !clearedUrl.includes('keyword'), clearedUrl)
  check('清空后回到 10 条', clearedRows.length === 10, String(clearedRows.length))

  /* ==================== [6] 分页 ==================== */
  console.log('\n[6] 分页')
  const pagerVisible = await cdp.evaluate(
    `Boolean(document.querySelector('.cm-user-pager .el-pager'))`,
  )
  check('总数超过 1 页时出现翻页器', pagerVisible === true)

  const beforePageNames = clearedRows.map((r) => r.name).join(',')
  const pagerOk = await clickByText(cdp, '.cm-user-pager .el-pager li', '2')
  await sleep(1800)
  const pagedUrl = await urlOf()
  const pagedRows = await readRows()
  console.log(`    点第 2 页：${pagerOk} → URL=${pagedUrl}，行数=${pagedRows.length}`)
  check('分页器可点第 2 页', pagerOk === true)
  check('URL 带上 page=2', pagedUrl.includes('page=2'), pagedUrl)
  check('第 2 页内容与第 1 页不同', pagedRows.map((r) => r.name).join(',') !== beforePageNames)
  check('第 2 页行数 = 总数 - 每页 10', pagedRows.length === totalAfter - 10, `${pagedRows.length} vs ${totalAfter - 10}`)
  await shoot('t17-5-page2.png')

  // 回第 1 页
  await clickByText(cdp, '.cm-user-pager .el-pager li', '1')
  await sleep(1800)
  const backUrl = await urlOf()
  const backRows = await readRows()
  console.log(`    回第 1 页：URL=${backUrl}，行数=${backRows.length}`)
  check('回到第 1 页后 URL 不带 page', !backUrl.includes('page='), backUrl)
  check('回到第 1 页后恢复 10 条', backRows.length === 10, String(backRows.length))

  /* ==================== [7] loading 态 ==================== */
  console.log('\n[7] loading 态（CDP 网络延迟逼出）')
  await setLatency(2200)
  cdp.clearEvents()
  await setInput(cdp, '.cm-user-toolbar__search input', '1')
  await sleep(1100) // 越过 300ms 防抖，请求已发出但还没回来
  const loadingVisible = await cdp.evaluate(`Boolean(document.querySelector('.cm-skeleton'))`)
  const loadingHint = await cdp.evaluate(
    `document.querySelector('.cm-user-toolbar__count')?.textContent?.replace(/\\s+/g,'') ?? ''`,
  )
  console.log(`    骨架屏可见=${loadingVisible}，计数文案=「${loadingHint}」`)
  check('加载中有骨架屏（loading 态）', loadingVisible === true)
  await shoot('t17-6-loading.png')
  await setLatency(0)
  await sleep(3000)

  /* ==================== [8] error 态 + 重试 ==================== */
  console.log('\n[8] error 态（CDP 阻断请求逼出）+ 重试')
  await cdp.send('Network.setBlockedURLs', { urls: ['*/api/admin/users*'] })
  await setInput(cdp, '.cm-user-toolbar__search input', '小')
  await sleep(2000)
  const errorText = await bodyText()
  const hasRetry = await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.cm-error button')].find((b) => b.textContent.includes('重新加载'))
    return Boolean(btn)
  })()`)
  console.log(`    正文片段：${errorText.slice(0, 120)}`)
  check('进错误态（「用户列表加载失败」）', errorText.includes('用户列表加载失败'), errorText.slice(0, 120))
  check('错误态带「重新加载」重试按钮', hasRetry === true)
  await shoot('t17-7-error.png')

  await cdp.send('Network.setBlockedURLs', { urls: [] })
  await cdp.evaluate(`[...document.querySelectorAll('.cm-error button')].find((b) => b.textContent.includes('重新加载'))?.click()`)
  await sleep(2200)
  const recoveredRows = await readRows()
  const recoveredText = await bodyText()
  console.log(`    重试后行数：${recoveredRows.length}`)
  check('解除阻断后重试成功（表格回来了）', recoveredRows.length > 0, String(recoveredRows.length))
  check('重试后不再是错误态', !recoveredText.includes('用户列表加载失败'))

  // 回到全量第 1 页（这里用直接写空值，避免依赖「×」按钮）
  await setInput(cdp, '.cm-user-toolbar__search input', '')
  await sleep(2000)

  /* ==================== [9] 封禁 ==================== */
  console.log(`\n[9] 封禁「${targetUser.userName}」`)
  cdp.clearEvents()
  // 目标用户可能不在第 1 页 —— 先用昵称搜出来
  await setInput(cdp, '.cm-user-toolbar__search input', targetUser.userName)
  await sleep(1600)
  const targetRows = await readRows()
  console.log(`    搜到 ${targetRows.length} 条：${JSON.stringify(targetRows.map((r) => [r.name, r.status, r.action]))}`)
  check('搜到了待封禁用户', targetRows.some((r) => r.name === targetUser.userName))
  check('待封禁用户当前是「正常」', targetRows.find((r) => r.name === targetUser.userName)?.status === '正常')

  // 9.1 点封禁 → 弹二次确认
  const clicked = await clickRowAction(targetUser.userName)
  await sleep(700)
  const confirmText = await cdp.evaluate(
    `document.querySelector('.el-message-box__message')?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''`,
  )
  console.log(`    确认弹窗文案：${confirmText}`)
  check('点封禁弹出了二次确认', clicked === true && confirmText.length > 0, confirmText)
  check('确认文案如实说明后果（该用户将无法登录）', confirmText.includes('该用户将无法登录'), confirmText)
  await shoot('t17-8-ban-confirm.png')

  // 9.2 取消 → 不发请求、状态不变
  await cancelMessageBox(cdp)
  await sleep(1200)
  const afterCancel = await readRows()
  console.log(`    取消后状态请求数：${statusRequests().length}`)
  check('取消后**没有**发出 PUT 请求', statusRequests().length === 0, String(statusRequests().length))
  check(
    '取消后该行状态仍是「正常」',
    afterCancel.find((r) => r.name === targetUser.userName)?.status === '正常',
    JSON.stringify(afterCancel.find((r) => r.name === targetUser.userName)),
  )

  // 9.3 确认 → 真的封禁
  cdp.clearEvents()
  await clickRowAction(targetUser.userName)
  await sleep(700)
  await confirmMessageBox(cdp)
  await sleep(2200)
  const banReqs = statusRequests()
  const banReqUrl = banReqs[0]?.params?.request?.url ?? ''
  const banBody = banReqs[0]?.params?.request?.postData ?? null
  console.log(`    PUT URL：${banReqUrl}`)
  console.log(`    PUT body：${JSON.stringify(banBody)}`)
  check('发出了 1 次 PUT .../status 请求', banReqs.length === 1, String(banReqs.length))
  /*
   * `status` 必须在 **query** 里、**不在 body** 里。
   * ⚠️ 不能断言「body 为空」：axios 用 `data: null` 时会发出字面量 `null`，
   *    断言 `!body` 会因为 `"null"` 是真值而假红。要断言的是「body 里没有 status」。
   */
  const bodyCarriesStatus = typeof banBody === 'string' && banBody.includes('status')
  check(
    'status 走的是 **query**（?status=0），不在 body 里',
    banReqUrl.includes('status=0') && !bodyCarriesStatus,
    `url=${banReqUrl} body=${JSON.stringify(banBody)}`,
  )
  const afterBan = await readRows()
  const bannedRow = afterBan.find((r) => r.name === targetUser.userName)
  console.log(`    封禁后该行：${JSON.stringify(bannedRow)}`)
  check('该行状态变为「已封禁」', bannedRow?.status === '已封禁', JSON.stringify(bannedRow))
  check('该行按钮变为「解封」', bannedRow?.action === '解封', String(bannedRow?.action))
  await shoot('t17-9-banned.png')

  // 9.4 后端真的落库了吗
  const persisted = await getUsers(`?keyword=${encodeURIComponent(targetUser.userName)}`)
  const persistedUser = persisted?.data?.records?.[0]
  console.log(`    后端回查：status=${persistedUser?.status}`)
  check('后端已落库 status=0', persistedUser?.status === 0, String(persistedUser?.status))

  /* ==================== [10] 解封 ==================== */
  console.log('\n[10] 解封')
  cdp.clearEvents()
  await clickRowAction(targetUser.userName)
  await sleep(2200)
  const unbanReqs = statusRequests()
  console.log(`    PUT URL：${unbanReqs[0]?.params?.request?.url ?? '(无)'}`)
  check('解封发出 PUT ?status=1', unbanReqs[0]?.params?.request?.url?.includes('status=1') === true, String(unbanReqs.length))
  const afterUnban = await readRows()
  const unbannedRow = afterUnban.find((r) => r.name === targetUser.userName)
  console.log(`    解封后该行：${JSON.stringify(unbannedRow)}`)
  check('该行状态回到「正常」', unbannedRow?.status === '正常', JSON.stringify(unbannedRow))
  check('该行按钮回到「封禁」', unbannedRow?.action === '封禁', String(unbannedRow?.action))
  const persisted2 = await getUsers(`?keyword=${encodeURIComponent(targetUser.userName)}`)
  check('后端已落库 status=1', persisted2?.data?.records?.[0]?.status === 1, String(persisted2?.data?.records?.[0]?.status))

  /* ==================== [12] 请求头都是 token ==================== */
  console.log('\n[12] 请求头核验')
  const adminReqs = cdp.events.filter(
    (e) =>
      e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/admin/'),
  )
  const badHeader = adminReqs.filter((e) => !e.params.request.headers.token)
  console.log(`    捕获 ${adminReqs.length} 个 /api/admin/* 请求`)
  check('所有 /api/admin/* 请求都带 token 头', badHeader.length === 0, badHeader.map((e) => e.params.request.url).join(' | '))

  /* ==================== [11] 非管理员 ==================== */
  console.log('\n[11] 非管理员（小红）访问 /admin/users')
  cdp.clearEvents()
  await loginViaUi(NORMAL, '/admin/users')
  const normalUrl = await urlOf()
  const normalText = await bodyText()
  console.log(`    地址：${normalUrl}`)
  console.log(`    正文片段：${normalText.slice(0, 140)}`)
  check('停在 /admin/users', normalUrl.startsWith('/admin/users'), normalUrl)
  check('页面明确提示「无管理员权限」', normalText.includes('无管理员权限'), normalText.slice(0, 140))
  check('不是「加载失败」', !normalText.includes('加载失败'), normalText.slice(0, 140))
  const normalAdminReqs = cdp.events.filter(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/admin/'),
  )
  check('非管理员本地预检生效：未发出 /api/admin/* 请求', normalAdminReqs.length === 0, String(normalAdminReqs.length))
  await shoot('t17-10-forbidden.png')

  /* ==================== [13] 运行时健康度 ==================== */
  console.log('\n[13] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp
    .consoleErrors()
    .filter((t) => !/Failed to load resource|ERR_|net::|MinIO|404 \(Not Found\)/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（网络/图片失败除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  await restoreUser(targetUser?.id)
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
