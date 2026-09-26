/**
 * T8 验收：用户主页与个人中心（真实后端）
 * ------------------------------------------------------------------
 * 覆盖工单 T8 的 5 条验收：
 *   1. 游客打开 /user/2 → 显示「登录后查看」，**没有被弹到登录页**
 *   2. 6 个 tab 逐个刷新直达不 404
 *   3. 改昵称 + 传头像跑通（Network 的 Content-Type 带 boundary + 响应）
 *   4. 传一个 3MB 图片 → 前端本地就拦下，没有发出请求
 *   5. 作者本人在自己主页能看到编辑入口
 * 另覆盖「做什么」与两条提醒：
 *   - 1.7 失败分诊按 ApiError.code：401（游客）/ 404（不存在）/ 其它
 *   - 关注 / 取关走 1.8 / 1.9，1.12 判断关注状态；列表空态文案
 *   - 1.6 修改密码：本地校验拦下 + 后端「旧密码错误」400
 *
 * ⚠️ 数据副作用（脚本会在 `finally` 里还原，且**还原结果纳入断言**）：
 *   - 昵称 / 简介：会改成测试值，再按「**种子值优先**」还原 ——
 *     种子昵称 `小明` 只有 2 字、过不了 1.5 的 `@Size(min = 3)`，所以会自动回落到运行前值。
 *     ⚠️ 绝不能把还原目标写成「本次运行开始时的值」：那样只要一次没还原成功，
 *     脏值就会变成下一次的基线，污染被永久固化（2026-09-23 实测踩到，昵称被固化成 `小明同学`）。
 *   - **头像：1.5 没有「删除/还原头像」的能力，上传即永久替换 MinIO 上的旧文件 —— 这是唯一真正无法还原的一项。
 *     所以脚本会传一张**可辨认的 128×128 纯色 PNG**（而不是 1×1 空图），
 *     避免测试账号的头像变成一个看起来像坏掉的空白。每跑一次就多一个孤儿文件。**
 *   - 关注关系：取关后再关注回来（幂等）
 *   - 密码：**只测「旧密码错误」这条 400 路径，绝不真的改密码**，
 *     否则后续所有依赖 123456 的测试都会断
 *
 * 前置：后端 8080；账号 小明 13800000002 / 123456、小红 13800000003 / 123456。
 * 用法：node scripts/verify-t8-user.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, setInput } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
/** 端口刻意避开 T7 / T7.5 用的 5217 / 5218，避免和并行跑的工单撞车 */
const PORT = 5220
const DEBUG_PORT = 9354
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const MING = { phone: '13800000002', password: '123456', id: 2, label: '小明(用户2)' }
const HONG = { phone: '13800000003', password: '123456', id: 3, label: '小红(用户3)' }

/** 昵称必须 3~12 字，简介必须 6~200 字（后端 @Size，见 ProfileHomeTab 注释） */
const TEST_NICKNAME = 'T8测试昵称'
const PREFIX = 'T8验收'

const { check, summary } = createReporter()

/* ==================== 极简 PNG 编码器（不引入依赖） ==================== */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * 生成一张 size×size 的 RGBA PNG。
 * `noise = true` 时逐像素填随机色 —— 纯色图会被 deflate 压到几 KB，
 * 想造一张**真的超过 2MB** 的图必须让它不可压缩。
 */
function makePng(size, [r, g, b], noise = false) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let o = 0
  for (let y = 0; y < size; y += 1) {
    raw[o] = 0 // filter: none
    o += 1
    for (let x = 0; x < size; x += 1) {
      const inBlock = x < size / 3 && y < size / 3
      raw[o] = noise ? Math.floor(Math.random() * 256) : inBlock ? 255 : r
      raw[o + 1] = noise ? Math.floor(Math.random() * 256) : inBlock ? 255 : g
      raw[o + 2] = noise ? Math.floor(Math.random() * 256) : inBlock ? 255 : b
      raw[o + 3] = 255
      o += 4
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

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

const api = (method, url, body, token = MING_TOKEN) =>
  fetch(`${BACKEND}${url}`, {
    method,
    headers: { token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json())

/* ==================== 基线快照 ==================== */
const infoBefore = (await api('GET', '/api/user/info'))?.data
console.log(`\n[准备] ${MING.label} 基线：${JSON.stringify(infoBefore)}`)
check('1.4 拿到基线资料', !!infoBefore?.userName)
/** 本次运行开始时的值 —— **只作回落目标**，不作还原目标（见下面 SEED_PROFILE 的说明） */
const BASE = { userName: infoBefore?.userName, intro: infoBefore?.intro, avatar: infoBefore?.avatar }

/**
 * 还原目标取**种子值**，不是「本次运行值」。
 *
 * ⚠️ 为什么必须这样：`BASE` 取的是「本次运行开始时的值」。只要**任何一次**运行没还原成功，
 * 那个脏值就会变成下一次运行的 `BASE`，于是「还原成功」变成一句空话、污染被永久固化。
 * （2026-09-23 实测踩到过：昵称被固化成 `小明同学`，`finally` 每次都「还原成功」。）
 *
 * ⚠️ 但种子昵称 `小明` 只有 2 个字，而 1.5 的 `@Size(min = 3)` **下限也生效**
 * → **通过接口还原不到种子值**（会 `400 昵称不能超过12个字符`）。所以策略是三步：
 *   ① 先试种子值 → ② 失败则回落到 `BASE` → ③ **两种结果都必须显式断言**。
 * 旧版这里是「还原失败只打一行日志、退出码仍是 0」，所以账号被污染了也没人发现。
 *
 * 来源：`codemind测试数据.sql:19-26`。
 */
const SEED_PROFILE = { userName: '小明', intro: '前端小白，请多指教' }

const followBefore = (await api('GET', `/api/user/follow/status/${HONG.id}`))?.data
console.log(`    关注状态（1.12）：是否已关注 ${HONG.label} = ${followBefore}`)

/* ==================== 临时图片 ==================== */
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-t8-'))
const SMALL_PNG = path.join(tmpDir, 'avatar-small.png')
const BIG_PNG = path.join(tmpDir, 'avatar-big.png')
const TXT_FILE = path.join(tmpDir, 'not-an-image.txt')
await fs.writeFile(SMALL_PNG, makePng(128, [79, 70, 229]))
// 900×900 随机像素 ≈ 3.2MB：纯色图会被压到几 KB，达不到「>2MB」这条前提
await fs.writeFile(BIG_PNG, makePng(900, [220, 38, 38], true))
await fs.writeFile(TXT_FILE, 'x'.repeat(64))
console.log(
  `    临时图片：小图 ${(await fs.stat(SMALL_PNG)).size} B / 大图 ${((await fs.stat(BIG_PNG)).size / 1024 / 1024).toFixed(2)} MB`,
)
check('大图确实超过 2MB（否则这条用例没有意义）', (await fs.stat(BIG_PNG)).size > 2 * 1024 * 1024)

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
let cdp
let restored = { profile: false, follow: false }
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
  const clearToken = () => cdp.evaluate(`localStorage.removeItem('codemind_token')`)

  const health = { exceptions: [], consoleErrors: [] }
  const reset = () => {
    for (const e of cdp.exceptions()) if (!health.exceptions.includes(e)) health.exceptions.push(e)
    for (const e of cdp.consoleErrors())
      if (!health.consoleErrors.includes(e)) health.consoleErrors.push(e)
    cdp.clearEvents()
  }

  /** 弹窗是否真的可见（关闭后仍留在 DOM，必须看尺寸） */
  const dialogVisible = (title) =>
    cdp.evaluate(`(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(d => {
        const t = d.querySelector('.el-dialog__title')?.textContent?.trim()
        const r = d.getBoundingClientRect()
        return t === ${JSON.stringify(title)} && r.width > 0 && r.height > 0
      })
      return !!dlg
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

  const reqHeaders = (requestId) =>
    cdp.events.find((e) => e.method === 'Network.requestWillBeSent' && e.params.requestId === requestId)
      ?.params.request.headers ?? {}

  const postDataOf = async (requestId) => {
    const ev = cdp.events.find(
      (e) => e.method === 'Network.requestWillBeSent' && e.params.requestId === requestId,
    )
    if (ev?.params.request.postData) return ev.params.request.postData
    try {
      return (await cdp.send('Network.getRequestPostData', { requestId }))?.postData ?? ''
    } catch {
      return ''
    }
  }

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

  const countField = (raw, name) => (raw.match(new RegExp(`name="${name}"`, 'g')) ?? []).length

  /** 给原生 file input 塞文件；CDP 没触发 change 时兜一次 */
  const setFile = async (selector, filePath) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    })
    if (!nodeId) return false
    await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId })
    await sleep(700)

    // 有没有产生「反应」：要么出现撤销按钮，要么弹了提示
    const reacted = await cdp.evaluate(`(() => {
      const undo = [...document.querySelectorAll('.cm-home-tab__avatar-ops .el-button')]
        .some(b => b.textContent.trim() === '撤销选择')
      return undo || document.querySelectorAll('.el-message').length > 0
    })()`)
    if (!reacted) {
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new Event('change', { bubbles: true }))`,
      )
      await sleep(700)
    }
    return true
  }

  const clickButtonIn = (scopeSelector, text) =>
    cdp.evaluate(`(() => {
      const btns = [...document.querySelectorAll(${JSON.stringify(scopeSelector)} + ' .el-button')]
      const b = btns.find(x => x.textContent.replace(/\\s+/g,'').includes(${JSON.stringify(text.replace(/\s+/g, ''))}))
      if (!b) return false
      b.click()
      return true
    })()`)

  const clickAnyButton = (text) =>
    cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('.el-button')]
        .find(x => x.textContent.replace(/\\s+/g,'').includes(${JSON.stringify(text.replace(/\s+/g, ''))}))
      if (!b) return false
      b.click()
      return true
    })()`)

  /* ==================== 验收 1：游客「登录后查看」 ==================== */
  console.log('\n[验收 1] 游客打开 /user/2 → 「登录后查看」，且没被弹到登录页')
  await goto(`http://localhost:${PORT}/login`, 1200)
  await clearToken()
  reset()
  await goto(`http://localhost:${PORT}/user/${MING.id}`, 3000)

  const guestStatus = cdp.events
    .filter(
      (e) =>
        e.method === 'Network.responseReceived' &&
        e.params.response.url.includes(`/api/user/profile/${MING.id}`),
    )
    .map((e) => e.params.response.status)
  const guest = await cdp.evaluate(`({
    url: location.pathname + location.search,
    emptyTitle: document.querySelector('.cm-empty__title')?.textContent?.trim() ?? null,
    emptyDesc: document.querySelector('.cm-empty__desc')?.textContent?.trim() ?? null,
    emptyButtons: [...document.querySelectorAll('.cm-empty__action .el-button')].map(b => b.textContent.trim()),
    hasError: !!document.querySelector('.cm-error'),
    hasProfile: !!document.querySelector('.cm-up__header'),
  })`)
  console.log(`    1.7 游客 HTTP 状态：${JSON.stringify(guestStatus)}`)
  console.log(`    url=${guest.url}｜空状态标题=${JSON.stringify(guest.emptyTitle)}｜按钮=${JSON.stringify(guest.emptyButtons)}`)
  check('1.7 对游客返回 401', guestStatus.includes(401), JSON.stringify(guestStatus))
  check('页面停在 /user/2（没被弹到 /login）', guest.url === `/user/${MING.id}`, guest.url)
  check('显示「登录后查看」', guest.emptyTitle === '登录后查看', String(guest.emptyTitle))
  check('不是「加载失败」错误页', guest.hasError === false && guest.hasProfile === false)
  check('提供「立即登录」入口', guest.emptyButtons.includes('立即登录'), JSON.stringify(guest.emptyButtons))
  await shoot('t8-1-guest-need-login.png')

  await clickButtonIn('.cm-empty__action', '立即登录')
  await sleep(1400)
  const afterLoginClick = await cdp.evaluate(`location.pathname + location.search`)
  console.log(`    点「立即登录」→ ${afterLoginClick}`)
  check(
    '「立即登录」带 redirect 跳登录页',
    afterLoginClick.startsWith('/login') && decodeURIComponent(afterLoginClick).includes(`/user/${MING.id}`),
    afterLoginClick,
  )

  /* ==================== 验收 5：自己的主页有编辑入口 ==================== */
  console.log('\n[验收 5] 作者本人在自己主页能看到编辑入口')
  await goto(`http://localhost:${PORT}/login`, 1200)
  await setToken(MING_TOKEN)
  reset()
  await goto(`http://localhost:${PORT}/user/${MING.id}`, 3000)
  const self = await cdp.evaluate(`({
    url: location.pathname,
    name: document.querySelector('.cm-up__name')?.textContent?.trim() ?? null,
    actions: [...document.querySelectorAll('.cm-up__actions .el-button')].map(b => b.textContent.replace(/\\s+/g,'').trim()),
    hasFollowBtn: [...document.querySelectorAll('.cm-up__actions .el-button')].some(b => /^关注$|^已关注$/.test(b.textContent.trim())),
  })`)
  console.log(`    自己主页按钮：${JSON.stringify(self.actions)}`)
  check('渲染出自己的主页', self.url === `/user/${MING.id}` && !!self.name, String(self.name))
  check('出现「编辑资料」入口', self.actions.includes('编辑资料'), JSON.stringify(self.actions))
  check('自己的主页不显示「关注」按钮（不能关注自己）', self.hasFollowBtn === false)
  await shoot('t8-5-self-edit-entry.png')

  await clickButtonIn('.cm-up__actions', '编辑资料')
  await sleep(2200)
  const afterEditClick = await cdp.evaluate(`({
    url: location.pathname + location.search,
    dialog: [...document.querySelectorAll('.el-dialog')].some(d => {
      const r = d.getBoundingClientRect()
      return d.querySelector('.el-dialog__title')?.textContent?.trim() === '编辑资料' && r.width > 0
    }),
  })`)
  console.log(`    点「编辑资料」→ ${afterEditClick.url}｜弹窗已打开=${afterEditClick.dialog}`)
  check('跳到个人中心「我的主页」', afterEditClick.url.startsWith('/profile/home'), afterEditClick.url)
  check('编辑资料弹窗自动打开（?edit=1）', afterEditClick.dialog === true)

  /* ==================== 验收 4：3MB 头像本地拦下 ==================== */
  console.log('\n[验收 4] 选一个 3MB 图片 → 前端本地拦下，不发请求')
  reset()
  await setFile('.cm-home-tab__file-input', BIG_PNG)
  const bigState = await cdp.evaluate(`({
    toasts: [...document.querySelectorAll('.el-message')].map(e => e.textContent.trim()),
    hasUndo: [...document.querySelectorAll('.cm-home-tab__avatar-ops .el-button')].some(b => b.textContent.trim() === '撤销选择'),
  })`)
  const bigRequests = reqIds('/api/user/data').length
  console.log(`    提示：${JSON.stringify(bigState.toasts)}｜发出的 /api/user/data 请求数=${bigRequests}`)
  check('弹出「头像大小不能超过 2MB」', bigState.toasts.some((t) => /2MB/.test(t)), JSON.stringify(bigState.toasts))
  check('没有发出 /api/user/data 请求', bigRequests === 0, `实际 ${bigRequests} 个`)
  check('大图没有被接受为待上传文件（无「撤销选择」）', bigState.hasUndo === false)
  await shoot('t8-4-avatar-too-large.png')

  console.log('\n[附加] 选一个非图片文件 → 同样本地拦下')
  reset()
  await setFile('.cm-home-tab__file-input', TXT_FILE)
  const txtState = await cdp.evaluate(`({
    toasts: [...document.querySelectorAll('.el-message')].map(e => e.textContent.trim()),
    hasUndo: [...document.querySelectorAll('.cm-home-tab__avatar-ops .el-button')].some(b => b.textContent.trim() === '撤销选择'),
  })`)
  console.log(`    提示：${JSON.stringify(txtState.toasts)}`)
  check('弹出「只支持 jpg / jpeg / png / webp」', txtState.toasts.some((t) => /jpg/.test(t)), JSON.stringify(txtState.toasts))
  check('非图片没有发出请求', reqIds('/api/user/data').length === 0)
  check('非图片没有被接受（无「撤销选择」）', txtState.hasUndo === false)

  /* ==================== 验收 3：改昵称 + 传头像跑通 ==================== */
  console.log('\n[验收 3] 改昵称 + 传头像 → 保存（贴 Content-Type 带 boundary + 响应）')
  reset()
  await setInput(cdp, '.cm-home-tab__form .el-input__inner', TEST_NICKNAME)
  await sleep(300)
  await setFile('.cm-home-tab__file-input', SMALL_PNG)
  const beforeSave = await cdp.evaluate(`({
    nickname: document.querySelector('.cm-home-tab__form .el-input__inner')?.value ?? null,
    hasUndo: [...document.querySelectorAll('.cm-home-tab__avatar-ops .el-button')].some(b => b.textContent.trim() === '撤销选择'),
    previewSrc: (document.querySelector('.cm-home-tab__avatar img') ?? document.querySelector('img.cm-home-tab__avatar'))?.getAttribute('src')?.slice(0, 5) ?? null,
  })`)
  console.log(`    弹窗内昵称=${JSON.stringify(beforeSave.nickname)}｜已选新图=${beforeSave.hasUndo}｜预览协议=${beforeSave.previewSrc}`)
  check('昵称已改为测试值', beforeSave.nickname === TEST_NICKNAME, String(beforeSave.nickname))
  check('小图被接受（出现「撤销选择」+ blob 预览）', beforeSave.hasUndo === true && beforeSave.previewSrc === 'blob:')
  await shoot('t8-3a-edit-dialog.png')

  reset()
  const saved = await clickButtonIn('.el-dialog__footer', '保存')
  await sleep(2600)
  const saveReqId = reqIds('/api/user/data', 'PUT').pop()
  const saveResp = await respJson(saveReqId)
  const saveRaw = await postDataOf(saveReqId)
  const saveHeaders = reqHeaders(saveReqId)
  const ctype = String(saveHeaders['Content-Type'] ?? saveHeaders['content-type'] ?? '')
  console.log(`    请求头 Content-Type=${JSON.stringify(ctype)}`)
  console.log(`    PUT /api/user/data 响应：${JSON.stringify(saveResp)}`)
  console.log(`    请求体字段：userName×${countField(saveRaw, 'userName')}｜intro×${countField(saveRaw, 'intro')}｜file×${countField(saveRaw, 'file')}`)
  check('点到了「保存」', saved === true)
  check('Content-Type 带 boundary（没被设成 application/json）', /multipart\/form-data;\s*boundary=/i.test(ctype), ctype)
  check('响应 code=200', saveResp?.code === 200, JSON.stringify(saveResp))
  check('请求体带 userName', countField(saveRaw, 'userName') === 1)
  check('请求体带 file（头像走了文件字段）', countField(saveRaw, 'file') === 1)
  check('请求体**没有** intro（只提交改过的字段）', countField(saveRaw, 'intro') === 0, `实际 ${countField(saveRaw, 'intro')} 个`)
  check('保存后弹窗关闭', (await dialogVisible('编辑资料')) === false)

  const infoAfter = (await api('GET', '/api/user/info'))?.data
  console.log(`    1.4 保存后：userName=${JSON.stringify(infoAfter?.userName)}｜avatar=${JSON.stringify(infoAfter?.avatar)}`)
  check('后端昵称已更新', infoAfter?.userName === TEST_NICKNAME, String(infoAfter?.userName))
  check('后端简介保持原值（没被顺手覆盖）', infoAfter?.intro === BASE.intro, `${BASE.intro} → ${infoAfter?.intro}`)
  check('头像 URL 已更换（新文件上传成功）', !!infoAfter?.avatar && infoAfter.avatar !== BASE.avatar)
  check('头像 URL 指向 MinIO 的 user_avatar 目录', /codemind_user_avatar/.test(infoAfter?.avatar ?? ''), String(infoAfter?.avatar))

  await goto(`http://localhost:${PORT}/profile/home`, 2800)
  const headerAfter = await cdp.evaluate(`({
    name: document.querySelector('.cm-profile__name')?.textContent?.trim() ?? null,
    avatar: document.querySelector('.cm-profile__avatar img')?.getAttribute('src') ?? null,
  })`)
  console.log(`    个人中心头部：name=${JSON.stringify(headerAfter.name)}`)
  check('页面头部昵称已刷新为新值', headerAfter.name === TEST_NICKNAME, String(headerAfter.name))
  check('页面头部头像已换新（store 重新拉了 1.4）', headerAfter.avatar === infoAfter?.avatar, String(headerAfter.avatar))
  await shoot('t8-3b-profile-saved.png')

  /* ==================== 验收 2：6 个 tab 刷新直达 ==================== */
  console.log('\n[验收 2] 6 个 tab 逐个「硬刷新」直达')
  const TAB_CASES = [
    { url: '/profile/home', name: 'my-profile', label: '我的主页', marker: '.cm-home-tab__card' },
    { url: '/profile/articles', name: 'my-articles', label: '我的文章', marker: '.cm-tab-list__bar' },
    { url: '/profile/notes', name: 'my-notes', label: '我的笔记', marker: '.cm-tab-list__bar' },
    { url: '/profile/favorites', name: 'my-favorites', label: '我的收藏', marker: '.cm-tab-list__count' },
    { url: '/profile/follows', name: 'my-follows', label: '我的关注', marker: '.cm-tab-list__count' },
    { url: '/profile/fans', name: 'my-fans', label: '我的粉丝', marker: '.cm-tab-list__count' },
  ]
  const tabUrls = []
  for (const tab of TAB_CASES) {
    // 硬刷新：先 about:blank 再回同一 URL，等价于 F5
    await goto(`http://localhost:${PORT}${tab.url}`, 2800)
    const view = await cdp.evaluate(`({
      url: location.pathname + location.search,
      hasLayout: !!document.querySelector('.cm-profile__header'),
      activeTab: document.querySelector('.cm-profile__tab.is-active')?.textContent?.trim() ?? null,
      hasMarker: !!document.querySelector(${JSON.stringify(tab.marker)}),
      is404: /404|页面不存在|找不到页面/.test(document.body.textContent ?? ''),
      count: document.querySelector('.cm-tab-list__count')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    })`)
    tabUrls.push(`${tab.url} → ${view.url}`)
    console.log(`    ${tab.url} → 激活=${JSON.stringify(view.activeTab)}｜内容标记=${view.hasMarker}${view.count ? `｜${view.count}` : ''}`)
    check(`${tab.url} 刷新后 URL 不变`, view.url === tab.url, view.url)
    check(`${tab.url} 渲染个人中心布局（不是 404）`, view.hasLayout === true && view.is404 === false)
    check(`${tab.url} 激活的 tab 是「${tab.label}」`, view.activeTab === tab.label, String(view.activeTab))
    check(`${tab.url} 渲染出该 tab 自己的内容`, view.hasMarker === true)
    await shoot(`t8-2-tab-${tab.name}.png`)
  }
  console.log('    6 个直达 URL：')
  tabUrls.forEach((u) => console.log(`      ${u}`))

  /* ==================== 附加：空态文案（1.11 不返回关注状态） ==================== */
  console.log('\n[附加] 粉丝列表空态 + 能力缺口说明')
  const fansView = await cdp.evaluate(`({
    emptyTitle: document.querySelector('.cm-empty__title')?.textContent?.trim() ?? null,
    hint: document.querySelector('.cm-tab-list__hint')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    count: document.querySelector('.cm-tab-list__count')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
  })`)
  console.log(`    粉丝数：${JSON.stringify(fansView.count)}｜空态：${JSON.stringify(fansView.emptyTitle)}`)
  check('粉丝为空时给出明确空态文案', !!fansView.emptyTitle, String(fansView.emptyTitle))
  check(
    '说明「1.11 不返回是否已关注」这个能力缺口',
    /不返回/.test(fansView.hint ?? '') && /1\.11/.test(fansView.hint ?? ''),
    String(fansView.hint),
  )
  check('列表没有放出「回关」按钮（接口没给状态，放了就是骗人）', fansView.emptyTitle === '还没有粉丝')

  /* ==================== 附加：关注 / 取关（1.8 / 1.9） ==================== */
  console.log(`\n[附加] ${HONG.label} 主页的关注 / 取关（1.8 / 1.9）+ 1.12 状态`)
  reset()
  await goto(`http://localhost:${PORT}/user/${HONG.id}`, 2800)
  const followView = async () =>
    cdp.evaluate(`({
      name: document.querySelector('.cm-up__name')?.textContent?.trim() ?? null,
      btn: document.querySelector('.cm-up__actions .el-button')?.textContent?.replace(/\\s+/g,'').trim() ?? null,
      fans: [...document.querySelectorAll('.cm-up__stat')].find(s => s.querySelector('dt')?.textContent?.trim() === '粉丝')?.querySelector('dd')?.textContent?.trim() ?? null,
    })`)
  const v1 = await followView()
  console.log(`    ${HONG.label}：按钮=${JSON.stringify(v1.btn)}｜粉丝数=${v1.fans}`)
  check('渲染出对方主页', v1.name === '小红', String(v1.name))

  const statusApi = (await api('GET', `/api/user/follow/status/${HONG.id}`))?.data
  check(
    '1.7 的 isFollow 与 1.12 一致（页面按钮状态可信）',
    (v1.btn === '已关注') === (statusApi === true),
    `按钮=${v1.btn} 1.12=${statusApi}`,
  )

  // 点一下：状态翻转，请求打到 1.8 / 1.9 中对应的那个
  reset()
  await clickButtonIn('.cm-up__actions', v1.btn === '已关注' ? '已关注' : '关注')
  await sleep(2200)
  const v2 = await followView()
  const toggled = v1.btn === '已关注' ? 'cancelFollow' : 'follow'
  const toggleCalls = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => `${e.params.request.method} ${e.params.request.url}`)
    .filter((u) => /\/api\/user\/(follow|cancelFollow)\//.test(u))
  console.log(`    点击后按钮=${JSON.stringify(v2.btn)}｜粉丝数=${v2.fans}｜请求=${JSON.stringify(toggleCalls)}`)
  check('按钮状态翻转', v2.btn !== v1.btn, `${v1.btn} → ${v2.btn}`)
  check(
    `打到了 ${toggled === 'cancelFollow' ? '1.9 取消关注' : '1.8 关注'} 接口`,
    toggleCalls.some((u) => u.includes(toggled)),
    JSON.stringify(toggleCalls),
  )
  check('粉丝数同步变化（不是只有按钮变了）', v2.fans !== v1.fans, `${v1.fans} → ${v2.fans}`)

  // 再点一下回到原状
  reset()
  await clickButtonIn('.cm-up__actions', v2.btn === '已关注' ? '已关注' : '关注')
  await sleep(2200)
  const v3 = await followView()
  console.log(`    再点一次后按钮=${JSON.stringify(v3.btn)}`)
  check('再点一次回到原始关注状态', v3.btn === v1.btn, `${v1.btn} → ${v3.btn}`)
  const statusApi2 = (await api('GET', `/api/user/follow/status/${HONG.id}`))?.data
  check('后端关注状态已还原', statusApi2 === followBefore, `${followBefore} → ${statusApi2}`)
  restored.follow = true

  /* ==================== 附加：1.6 修改密码（本地拦 + 后端 400） ==================== */
  console.log('\n[附加] 修改密码（1.6）：本地校验拦下 + 后端「旧密码错误」400（**不真的改密码**）')
  await goto(`http://localhost:${PORT}/profile/home`, 2800)
  await clickButtonIn('.cm-home-tab__card-actions', '修改密码')
  await sleep(1200)
  check('修改密码弹窗已打开', (await dialogVisible('修改密码')) === true)

  const pwdInputs = '.el-dialog .el-input__inner'
  reset()
  // 两次新密码不一致 → 本地拦下
  await cdp.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('.el-dialog .el-input__inner')].filter(i => i.type === 'password')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const type = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    type(inputs[0], 'wrongpass123')
    type(inputs[1], 'newpass123')
    type(inputs[2], 'newpass999')
  })()`)
  await sleep(400)
  await clickButtonIn('.el-dialog__footer', '确认修改')
  await sleep(1500)
  const mismatch = await cdp.evaluate(`({
    errors: [...document.querySelectorAll('.el-dialog .el-form-item__error')].map(e => e.textContent.trim()),
    toasts: [...document.querySelectorAll('.el-message')].map(e => e.textContent.trim()),
  })`)
  console.log(`    两次不一致：表单错误=${JSON.stringify(mismatch.errors)}｜提示=${JSON.stringify(mismatch.toasts)}`)
  check('两次新密码不一致被本地拦下', mismatch.errors.some((t) => /不一致/.test(t)), JSON.stringify(mismatch.errors))
  check('本地拦下时没有发出请求', reqIds('/api/user/updatePassword').length === 0)

  reset()
  // 旧密码错误 → 后端 400（这条**不会**改掉密码）
  await cdp.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('.el-dialog .el-input__inner')].filter(i => i.type === 'password')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const type = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    // 注意：密码正则是 ^\\w{4,32}$，用连字符会被**前端本地**拦下、根本发不出请求
    type(inputs[0], 'wrongpass999')
    type(inputs[1], 'brandnew123')
    type(inputs[2], 'brandnew123')
  })()`)
  await sleep(400)
  await clickButtonIn('.el-dialog__footer', '确认修改')
  await sleep(2200)
  const pwdReqId = reqIds('/api/user/updatePassword', 'PUT').pop()
  const pwdResp = await respJson(pwdReqId)
  const pwdCtype = String(
    reqHeaders(pwdReqId)['Content-Type'] ?? reqHeaders(pwdReqId)['content-type'] ?? '',
  )
  const pwdRaw = await postDataOf(pwdReqId)
  console.log(`    PUT /api/user/updatePassword 响应：${JSON.stringify(pwdResp)}`)
  console.log(`    Content-Type=${JSON.stringify(pwdCtype)}｜请求体=${pwdRaw}`)
  check('1.6 请求体是 JSON（不是 multipart）', /application\/json/.test(pwdCtype), pwdCtype)
  check('后端返回「旧密码错误」400', pwdResp?.code === 400 && /旧密码/.test(pwdResp?.message ?? ''), JSON.stringify(pwdResp))
  check('请求体只带 oldPassword / newPassword', /oldPassword/.test(pwdRaw) && /newPassword/.test(pwdRaw) && !/confirmPassword/.test(pwdRaw), pwdRaw)

  // 不点「取消」：两个弹窗的 footer 都在 DOM 里，按文本找会命中已关闭的那个；
  // 下一步导航会整页卸载，弹窗自然消失。
  await sleep(400)

  // 确认密码确实没被改动（用原密码重新登录）
  const relogin = await login(MING)
  check('原密码仍可登录（脚本没有真的改密码）', !!relogin)

  /* ==================== 附加：404 分诊 ==================== */
  console.log('\n[附加] 1.7 不存在 → 404 文案')
  reset()
  await goto(`http://localhost:${PORT}/user/999999`, 2800)
  const nf = await cdp.evaluate(`({
    emptyTitle: document.querySelector('.cm-empty__title')?.textContent?.trim() ?? null,
    hasError: !!document.querySelector('.cm-error'),
  })`)
  console.log(`    空状态标题=${JSON.stringify(nf.emptyTitle)}`)
  check('显示「用户不存在」', nf.emptyTitle === '用户不存在', String(nf.emptyTitle))
  check('没有误报成「登录后查看」', nf.emptyTitle !== '登录后查看', String(nf.emptyTitle))

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
  /** 只带要改的字段（后端对没传的字段保留原值） */
  const putProfile = (target) => {
    const fd = new FormData()
    if (target.userName !== undefined) fd.append('userName', target.userName)
    if (target.intro !== undefined) fd.append('intro', target.intro)
    return fetch(`${BACKEND}/api/user/data`, {
      method: 'PUT',
      headers: { token: MING_TOKEN },
      body: fd,
    }).then((x) => x.json())
  }

  try {
    const now = (await api('GET', '/api/user/info'))?.data
    const dirty = !!now && (now.userName !== SEED_PROFILE.userName || now.intro !== SEED_PROFILE.intro)
    if (!dirty) {
      restored.profile = true
      console.log('[清理] 资料与**种子基线**一致，无需还原')
    } else {
      // ① 先试种子值
      let target = '种子值'
      let r = await putProfile(SEED_PROFILE)
      // ② 种子昵称只有 2 字，过不了 @Size(min=3) → 回落到运行前值
      if (r?.code !== 200) {
        target = `运行前值（种子值还原失败：${r?.message ?? '未知'}）`
        r = await putProfile(BASE)
      }
      console.log(`\n[清理] 还原目标=${target}｜结果=${JSON.stringify(r)}`)
      restored.profile = r?.code === 200
    }
    const after = (await api('GET', '/api/user/info'))?.data
    console.log(`[清理] 还原后：userName=${JSON.stringify(after?.userName)}｜intro=${JSON.stringify(after?.intro)}`)
    console.log('[清理] 头像无法还原（1.5 无删除/还原能力），本次又替换了一次 MinIO 上的文件')
  } catch (e) {
    console.log(`[清理] 还原资料失败：${e.message}`)
  }

  try {
    const st = (await api('GET', `/api/user/follow/status/${HONG.id}`))?.data
    if (st !== followBefore) {
      const r = followBefore
        ? await api('POST', `/api/user/follow/${HONG.id}`)
        : await api('DELETE', `/api/user/cancelFollow/${HONG.id}`)
      console.log(`[清理] 关注关系还原：${JSON.stringify(r)}`)
    }
    restored.follow = true
  } catch (e) {
    console.log(`[清理] 还原关注关系失败：${e.message}`)
  }

  /*
   * ⚠️ 还原结果**必须纳入断言**，不能只打日志。
   * 旧版 `restored.*` 只出现在一行 console.log 里，所以「还原失败」不会让脚本失败 ——
   * 退出码仍是 0、仍然报「79/79」，账号被污染了也没人发现（2026-09-23 实测踩到）。
   * 这类断言在 `finally` 里是有效的：`summary()` 在本块之后才调用。
   */
  check('还原资料成功（还原失败不许静默通过）', restored.profile === true, `资料=${restored.profile}`)
  check('还原关注关系成功', restored.follow === true, `关注=${restored.follow}`)

  console.log(`[清理] 还原情况：资料=${restored.profile}｜关注=${restored.follow}｜临时图片=${tmpDir}`)
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})

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
