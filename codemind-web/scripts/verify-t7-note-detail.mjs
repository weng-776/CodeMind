/**
 * T7 验收：笔记详情与笔记编辑器（真实后端）
 * ------------------------------------------------------------------
 * 覆盖工单 T7 的 5 条验收：
 *   1. 草稿笔记详情 → 草稿横幅；私密笔记详情 → 私密横幅
 *   2. 无分类时点提交 → 被阻断并出现「去创建分类」入口
 *   3. 创建 + 编辑各一次跑通（贴 Network 响应 code）
 *   4. 编辑后标签保留（贴详情响应）
 *   5. 未登录打开笔记详情 → 「登录后查看」
 * 另覆盖「做什么」与两条提醒：
 *   - 详情失败按 ApiError.code 分诊：401 / 403 / 404 三态文案各不相同
 *   - 编辑器 multipart 四条硬约束（不设 Content-Type、tagIds 重复 append、
 *     不传 file 保留封面、tagIds 回传当前集合）
 *   - 2.11「为笔记添加标签」是 JSON，不是 multipart（API 层单独验证）
 *
 * ⚠️ 测试数据：新建 3 篇笔记（标题都带 `[T7验收]` 前缀），
 *   验收结束（含失败）全部删除。公开那篇带一张 1×1 PNG 封面，
 *   用来证明「编辑时不选新文件 = 保留原封面」。
 *
 * 前置：后端 8080；账号 小明 13800000002 / 123456、小红 13800000003 / 123456。
 * 用法：node scripts/verify-t7-note-detail.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, setInput } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5218
const DEBUG_PORT = 9352
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const MING = { phone: '13800000002', password: '123456', label: '小明(用户2)' }
const HONG = { phone: '13800000003', password: '123456', label: '小红(用户3)' }

/** 小明名下已有的顶级分类（2.10 实测存在），T7 只借用、不修改 */
const CATEGORY_ID = 7
const CATEGORY_NAME = 'React'
/** 2.12 实测存在的公共标签 */
const TAG_IDS = [1, 2]
const TAG_NAMES = ['Java', 'Spring Boot']

const PREFIX = '[T7验收]'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

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

const api = async (method, url, body, token = MING_TOKEN) => {
  const res = await fetch(`${BACKEND}${url}`, {
    method,
    headers: { token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

/** 直接用 multipart 造数据（绕开页面，页面本身在验收里单独测） */
async function createNote({ title, content, visibility, status, tagIds = [], withCover = false }) {
  const fd = new FormData()
  fd.append('title', title)
  fd.append('content', content)
  fd.append('categoryId', String(CATEGORY_ID))
  fd.append('visibility', String(visibility))
  fd.append('status', String(status))
  tagIds.forEach((id) => fd.append('tagIds', String(id)))
  if (withCover) fd.append('file', new Blob([PNG], { type: 'image/png' }), 't7-cover.png')
  return fetch(`${BACKEND}/api/note/createNote`, {
    method: 'POST',
    headers: { token: MING_TOKEN },
    body: fd,
  }).then((r) => r.json())
}

/* ==================== 造数据 ==================== */
console.log('\n[准备] 新建 3 篇笔记（公开带封面+标签 / 私密 / 草稿）')
const createdIds = []

const rPublic = await createNote({
  title: `${PREFIX} 公开笔记`,
  content: `# ${PREFIX} 公开笔记\n\n用于验证「编辑后标签与封面保留」。`,
  visibility: 1,
  status: 1,
  tagIds: TAG_IDS,
  withCover: true,
})
const rPrivate = await createNote({
  title: `${PREFIX} 私密笔记`,
  content: `# ${PREFIX} 私密笔记\n\n用于验证私密横幅与 403 分诊。`,
  visibility: 0,
  status: 1,
})
const rDraft = await createNote({
  title: `${PREFIX} 草稿笔记`,
  content: `# ${PREFIX} 草稿笔记\n\n用于验证草稿横幅。`,
  visibility: 1,
  status: 0,
})
for (const r of [rPublic, rPrivate, rDraft]) {
  if (typeof r?.data === 'number') createdIds.push(r.data)
}
check('3 篇测试笔记创建成功', createdIds.length === 3, JSON.stringify([rPublic, rPrivate, rDraft]))

const PUBLIC_ID = rPublic?.data
const PRIVATE_ID = rPrivate?.data
const DRAFT_ID = rDraft?.data

const seedDetail = await api('GET', `/api/note/${PUBLIC_ID}`)
console.log(`    公开笔记 id=${PUBLIC_ID}｜tags=${JSON.stringify(seedDetail?.data?.tags)}`)
console.log(`    封面=${JSON.stringify(seedDetail?.data?.cover)}`)
const SEED_COVER = seedDetail?.data?.cover ?? ''
check('测试数据：公开笔记带 2 个标签', seedDetail?.data?.tags?.length === 2)
check('测试数据：公开笔记封面非空（MinIO 已收到文件）', !!SEED_COVER)

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
let cdp
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

  /**
   * 运行时要覆盖**全程**，但 `cdp.clearEvents()` 是逐段清理的 ——
   * 所以每次清理前先把异常/console.error 归档，最后统一断言。
   */
  const health = { exceptions: [], consoleErrors: [] }
  const reset = () => {
    for (const e of cdp.exceptions()) if (!health.exceptions.includes(e)) health.exceptions.push(e)
    for (const e of cdp.consoleErrors())
      if (!health.consoleErrors.includes(e)) health.consoleErrors.push(e)
    cdp.clearEvents()
  }

  /** 详情页可观测状态 */
  const viewDetail = () =>
    cdp.evaluate(`({
      url: location.pathname + location.search,
      title: document.querySelector('.cm-note-detail__title')?.textContent?.trim() ?? null,
      banners: [...document.querySelectorAll('.cm-note-detail__banner')].map(b => b.textContent.replace(/\\s+/g,' ').trim()),
      draftBanner: !!document.querySelector('.cm-note-detail__banner--draft'),
      privateBanner: !!document.querySelector('.cm-note-detail__banner--private'),
      tags: [...document.querySelectorAll('.cm-note-detail__tag')].map(t => t.textContent.trim()),
      cover: document.querySelector('.cm-note-detail__cover')?.getAttribute('src') ?? null,
      emptyTitle: document.querySelector('.cm-empty__title')?.textContent?.trim() ?? null,
      emptyDesc: document.querySelector('.cm-empty__desc')?.textContent?.trim() ?? null,
      emptyButtons: [...document.querySelectorAll('.cm-empty__action .el-button')].map(b => b.textContent.trim()),
      errorTitle: document.querySelector('.cm-error__title')?.textContent?.trim() ?? null,
      errorDesc: document.querySelector('.cm-error__desc')?.textContent?.trim() ?? null,
      errorButtons: [...document.querySelectorAll('.cm-error__actions .el-button')].map(b => b.textContent.trim()),
    })`)

  /** 编辑器可观测状态 */
  const viewEditor = () =>
    cdp.evaluate(`({
      url: location.pathname + location.search,
      headTitle: document.querySelector('.cm-note-editor__title')?.textContent?.trim() ?? null,
      titleValue: document.querySelector('.cm-note-editor__title-input input')?.value ?? null,
      contentValue: document.querySelector('.cm-note-editor__textarea textarea')?.value ?? null,
      categoryText: (() => {
        // 单选的已选项在**第二个** .el-select__selected-item（第一个是搜索框壳，恒为空），
        // 所以读 .el-select__placeholder；带 is-transparent 表示当前只是 placeholder 文案
        const ph = document.querySelector('.cm-note-editor__category-select .el-select__placeholder')
        if (!ph) return null
        return ph.classList.contains('is-transparent') ? '' : ph.textContent.trim()
      })(),
      tagChips: [...document.querySelectorAll('.cm-note-editor__tag-select .el-tag')].map(e => e.textContent.trim()),
      blocker: document.querySelector('.cm-note-editor__blocker')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
      blockerButtons: [...document.querySelectorAll('.cm-note-editor__blocker .el-button')].map(b => b.textContent.trim()),
      warnings: [...document.querySelectorAll('.el-message--warning')].map(e => e.textContent.trim()),
      errors: [...document.querySelectorAll('.el-message--error')].map(e => e.textContent.trim()),
      errorTitle: document.querySelector('.cm-error__title')?.textContent?.trim() ?? null,
      errorDesc: document.querySelector('.cm-error__desc')?.textContent?.trim() ?? null,
    })`)

  const reqIds = (part, method) =>
    cdp.events
      .filter(
        (e) =>
          e.method === 'Network.requestWillBeSent' &&
          e.params.request.url.includes(part) &&
          (!method || e.params.request.method === method),
      )
      .map((e) => e.params.requestId)

  const reqUrl = (requestId) =>
    cdp.events.find((e) => e.method === 'Network.requestWillBeSent' && e.params.requestId === requestId)
      ?.params.request.url ?? ''

  const reqHeaders = (requestId) =>
    cdp.events.find((e) => e.method === 'Network.requestWillBeSent' && e.params.requestId === requestId)
      ?.params.request.headers ?? {}

  const postDataOf = async (requestId) => {
    const ev = cdp.events.find(
      (e) => e.method === 'Network.requestWillBeSent' && e.params.requestId === requestId,
    )
    if (ev?.params.request.postData) return ev.params.request.postData
    try {
      const r = await cdp.send('Network.getRequestPostData', { requestId })
      return r?.postData ?? ''
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

  /** 统计 multipart 原文里某个字段出现的次数 */
  const countField = (raw, name) => {
    const re = new RegExp(`name="${name}"`, 'g')
    return (raw.match(re) ?? []).length
  }

  /** 点开 el-select 并选中一个可见选项 */
  const selectOption = async (selectSelector, label) => {
    const opened = await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selectSelector)})
      if (!el) return false
      const trigger = el.querySelector('.el-select__wrapper') ?? el
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      trigger.click()
      return true
    })()`)
    await sleep(600)
    const picked = await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('.el-select-dropdown__item')]
        .filter(i => i.getBoundingClientRect().height > 0)
      const t = items.find(i => i.textContent.trim() === ${JSON.stringify(label)})
        ?? items.find(i => i.textContent.trim().includes(${JSON.stringify(label)}))
      if (!t) return false
      t.click()
      return true
    })()`)
    await sleep(400)
    return opened && picked
  }

  const clickButtonIn = (scopeSelector, text) =>
    cdp.evaluate(`(() => {
      const btns = [...document.querySelectorAll(${JSON.stringify(scopeSelector)} + ' .el-button')]
      const b = btns.find(x => x.textContent.trim() === ${JSON.stringify(text)})
      if (!b) return false
      b.click()
      return true
    })()`)

  /* ==================== 验收 5：游客「登录后查看」 ==================== */
  console.log('\n[5] 未登录打开笔记详情 → 显示「登录后查看」（不是报错页、不跳登录）')
  await goto(`http://localhost:${PORT}/login`, 1200)
  await clearToken()
  reset()
  await goto(`http://localhost:${PORT}/notes/${PUBLIC_ID}`, 3000)
  const guest = await viewDetail()
  const guestStatus = cdp.events
    .filter(
      (e) =>
        e.method === 'Network.responseReceived' &&
        e.params.response.url.includes(`/api/note/${PUBLIC_ID}`),
    )
    .map((e) => e.params.response.status)
  const guestErrBody = await respJson(reqIds(`/api/note/${PUBLIC_ID}`).pop())
  console.log(`    2.4 对游客的 HTTP 状态：${JSON.stringify(guestStatus)}，响应体：${JSON.stringify(guestErrBody)}`)
  console.log(`    页面：url=${guest.url}｜空状态标题=${JSON.stringify(guest.emptyTitle)}｜按钮=${JSON.stringify(guest.emptyButtons)}`)
  check('2.4 对游客返回 401', guestStatus.includes(401), JSON.stringify(guestStatus))
  check('页面停留在笔记详情路由（没被弹到 /login）', guest.url === `/notes/${PUBLIC_ID}`, guest.url)
  check('显示「登录后查看」空状态', guest.emptyTitle === '登录后查看', String(guest.emptyTitle))
  check('不是错误页（没有渲染 ErrorState）', guest.errorTitle === null, String(guest.errorTitle))
  check('提供「立即登录」入口', guest.emptyButtons.includes('立即登录'), JSON.stringify(guest.emptyButtons))
  check('文案说明登录后会回到这篇笔记', /回到这篇笔记/.test(guest.emptyDesc ?? ''), String(guest.emptyDesc))
  await shoot('t7-5-guest-need-login.png')

  // 点「立即登录」应带 redirect 跳登录页
  await clickButtonIn('.cm-empty__action', '立即登录')
  await sleep(1400)
  const afterLoginClick = await cdp.evaluate(`location.pathname + location.search`)
  console.log(`    点「立即登录」后：${afterLoginClick}`)
  check(
    '「立即登录」带 redirect 跳到登录页',
    afterLoginClick.startsWith('/login') && decodeURIComponent(afterLoginClick).includes(`/notes/${PUBLIC_ID}`),
    afterLoginClick,
  )

  /* ==================== 登录（小明） ==================== */
  await goto(`http://localhost:${PORT}/login`, 1200)
  await setToken(MING_TOKEN)

  /* ==================== 验收 1：草稿 / 私密横幅 ==================== */
  console.log('\n[1a] 草稿笔记详情 → 草稿横幅（2.4 返回 status）')
  reset()
  await goto(`http://localhost:${PORT}/notes/${DRAFT_ID}`, 3000)
  const draftView = await viewDetail()
  const draftBody = await respJson(reqIds(`/api/note/${DRAFT_ID}`).pop())
  console.log(`    2.4 响应 status=${draftBody?.data?.status} visibility=${draftBody?.data?.visibility}`)
  console.log(`    横幅：${JSON.stringify(draftView.banners)}`)
  check('草稿笔记详情渲染出草稿横幅', draftView.draftBanner === true)
  check('草稿横幅文案含「草稿」', /草稿/.test(draftView.banners.join(' ')), JSON.stringify(draftView.banners))
  check('未误报私密横幅', draftView.privateBanner === false)
  await shoot('t7-1-draft-banner.png')

  console.log('\n[1b] 私密笔记详情 → 私密横幅（2.4 返回 visibility）')
  reset()
  await goto(`http://localhost:${PORT}/notes/${PRIVATE_ID}`, 3000)
  const privateView = await viewDetail()
  const privateBody = await respJson(reqIds(`/api/note/${PRIVATE_ID}`).pop())
  console.log(`    2.4 响应 status=${privateBody?.data?.status} visibility=${privateBody?.data?.visibility}`)
  console.log(`    横幅：${JSON.stringify(privateView.banners)}`)
  check('私密笔记详情渲染出私密横幅', privateView.privateBanner === true)
  check('私密横幅文案含「私密」', /私密/.test(privateView.banners.join(' ')), JSON.stringify(privateView.banners))
  check('未误报草稿横幅', privateView.draftBanner === false)
  await shoot('t7-2-private-banner.png')

  /* ==================== 提醒①：404 分诊 ==================== */
  console.log('\n[提醒①] 登录态打开不存在的笔记 → 404 文案（不是通用失败）')
  await goto(`http://localhost:${PORT}/notes/99999999`, 3000)
  const notFound = await viewDetail()
  console.log(`    标题=${JSON.stringify(notFound.errorTitle)}｜描述=${JSON.stringify(notFound.errorDesc)}`)
  check('显示「笔记不存在或已删除」', notFound.errorTitle === '笔记不存在或已删除', String(notFound.errorTitle))
  check('没有误报成「无权查看」', !/无权/.test(notFound.errorTitle ?? ''), String(notFound.errorTitle))
  await shoot('t7-6-not-found.png')

  /* ==================== 验收 3a + 做什么 4：创建跑通 ==================== */
  console.log('\n[3a] 创建笔记：选分类 + 选标签 → 创建（贴 Network 响应 code）')
  reset()
  await goto(`http://localhost:${PORT}/notes/create`, 3000)
  const createInit = await viewEditor()
  console.log(`    分类下拉回填=${JSON.stringify(createInit.categoryText)}｜标签已选=${JSON.stringify(createInit.tagChips)}`)
  check('创建模式标题是「写笔记」', createInit.headTitle === '写笔记', String(createInit.headTitle))
  check('新建时分类为空（categoryId 必填，需用户选）', !createInit.categoryText, String(createInit.categoryText))
  check('有分类可选（说明 2.10 加载成功）', !createInit.blocker, String(createInit.blocker))

  await setInput(cdp, '.cm-note-editor__title-input input', `${PREFIX} 页面创建`)
  await setInput(
    cdp,
    '.cm-note-editor__textarea textarea',
    `# ${PREFIX} 页面创建\n\n这条是 T7 验收脚本通过真实页面创建的。`,
  )
  const catPicked = await selectOption('.cm-note-editor__category-select', CATEGORY_NAME)
  const tag1 = await selectOption('.cm-note-editor__tag-select', TAG_NAMES[0])
  const tag2 = await selectOption('.cm-note-editor__tag-select', TAG_NAMES[1])
  await sleep(400)
  const beforeSubmit = await viewEditor()
  console.log(`    选中分类=${JSON.stringify(beforeSubmit.categoryText)}｜标签=${JSON.stringify(beforeSubmit.tagChips)}`)
  check('分类已选中', catPicked === true && !!beforeSubmit.categoryText, String(beforeSubmit.categoryText))
  check('两个标签已选中', tag1 && tag2 && beforeSubmit.tagChips.length === 2, JSON.stringify(beforeSubmit.tagChips))

  reset()
  const createClicked = await clickButtonIn('.cm-note-editor__head-actions', '创建笔记')
  await sleep(3000)
  const createReqId = reqIds('/api/note/createNote', 'POST').pop()
  const createResp = await respJson(createReqId)
  const createRaw = await postDataOf(createReqId)
  const createHeaders = reqHeaders(createReqId)
  const createdId = createResp?.data
  const afterCreate = await cdp.evaluate(`location.pathname`)
  console.log(`    请求头 Content-Type=${JSON.stringify(createHeaders['Content-Type'] ?? createHeaders['content-type'])}`)
  console.log(`    POST /api/note/createNote 响应：${JSON.stringify(createResp)}`)
  console.log(`    跳转到：${afterCreate}`)
  check('点到了「创建笔记」', createClicked === true)
  check('2.1 返回 code=200', createResp?.code === 200, JSON.stringify(createResp))
  check('2.1 的 data 是新建笔记 id 的裸数字', typeof createdId === 'number', typeof createdId)
  check(
    '创建成功后跳到新笔记详情（本次修复的回归点）',
    afterCreate === `/notes/${createdId}`,
    `${afterCreate} vs /notes/${createdId}`,
  )
  if (typeof createdId === 'number') createdIds.push(createdId)
  check(
    'multipart：Content-Type 带 boundary（没被手动设成 application/json）',
    /multipart\/form-data;\s*boundary=/i.test(String(createHeaders['Content-Type'] ?? createHeaders['content-type'] ?? '')),
    String(createHeaders['Content-Type'] ?? createHeaders['content-type']),
  )
  check('multipart：tagIds 重复 append 了 2 次', countField(createRaw, 'tagIds') === 2, `实际 ${countField(createRaw, 'tagIds')} 次`)
  check('multipart：categoryId / visibility / status 都在', ['categoryId', 'visibility', 'status'].every((f) => countField(createRaw, f) === 1), createRaw.slice(0, 200))
  await shoot('t7-4-create-ok.png')

  /* ==================== 验收 3b + 4：编辑跑通 + 标签/封面保留 ==================== */
  console.log('\n[3b/4] 编辑笔记：改标题、不动封面与标签 → 保存（贴 Network 响应 code + 详情响应）')
  reset()
  await goto(`http://localhost:${PORT}/notes/${PUBLIC_ID}/edit`, 3000)
  const editInit = await viewEditor()
  console.log(`    回显：标题=${JSON.stringify(editInit.titleValue)}｜分类=${JSON.stringify(editInit.categoryText)}｜标签=${JSON.stringify(editInit.tagChips)}`)
  check('编辑模式标题是「编辑笔记」', editInit.headTitle === '编辑笔记', String(editInit.headTitle))
  check('标题已回显', editInit.titleValue === `${PREFIX} 公开笔记`, String(editInit.titleValue))
  check('分类已回显', editInit.categoryText === CATEGORY_NAME, String(editInit.categoryText))
  check('已有标签已回显（2.12 候选 + 详情回显合并）', editInit.tagChips.length === 2, JSON.stringify(editInit.tagChips))
  await shoot('t7-7-edit-echo.png')

  const NEW_TITLE = `${PREFIX} 公开笔记（已改）`
  await setInput(cdp, '.cm-note-editor__title-input input', NEW_TITLE)
  await sleep(500)
  reset()
  const updateClicked = await clickButtonIn('.cm-note-editor__head-actions', '更新笔记')
  await sleep(3000)
  const updateReqId = reqIds(`/api/note/${PUBLIC_ID}`, 'PUT').pop()
  const updateResp = await respJson(updateReqId)
  const updateRaw = await postDataOf(updateReqId)
  const updateHeaders = reqHeaders(updateReqId)
  const afterEdit = await cdp.evaluate(`location.pathname`)
  console.log(`    PUT /api/note/${PUBLIC_ID} 响应：${JSON.stringify(updateResp)}`)
  console.log(`    跳转到：${afterEdit}`)
  check('点到了「更新笔记」', updateClicked === true)
  check('2.2 返回 code=200', updateResp?.code === 200, JSON.stringify(updateResp))
  check('保存后回到该笔记详情', afterEdit === `/notes/${PUBLIC_ID}`, afterEdit)
  check(
    'multipart：Content-Type 带 boundary',
    /multipart\/form-data;\s*boundary=/i.test(String(updateHeaders['Content-Type'] ?? updateHeaders['content-type'] ?? '')),
    String(updateHeaders['Content-Type'] ?? updateHeaders['content-type']),
  )
  check('multipart：tagIds 回传了当前集合（2 次）', countField(updateRaw, 'tagIds') === 2, `实际 ${countField(updateRaw, 'tagIds')} 次`)
  check('multipart：没选新封面 → 请求体里没有 file 字段', countField(updateRaw, 'file') === 0, `实际 ${countField(updateRaw, 'file')} 次`)

  const afterEditDetail = await api('GET', `/api/note/${PUBLIC_ID}`)
  const detailTags = (afterEditDetail?.data?.tags ?? []).map((t) => t.name)
  console.log(`    2.4 详情响应：title=${JSON.stringify(afterEditDetail?.data?.title)}`)
  console.log(`      tags=${JSON.stringify(detailTags)}｜cover=${JSON.stringify(afterEditDetail?.data?.cover)}`)
  check('标题已更新', afterEditDetail?.data?.title === NEW_TITLE, String(afterEditDetail?.data?.title))
  check('编辑后标签保留（Java + Spring Boot）', JSON.stringify(detailTags) === JSON.stringify(TAG_NAMES), JSON.stringify(detailTags))
  check('编辑后原封面保留（不传 file ≠ 删除封面）', afterEditDetail?.data?.cover === SEED_COVER, `${SEED_COVER} → ${afterEditDetail?.data?.cover}`)
  const editViewAfter = await viewDetail()
  check('详情页标签渲染 2 个', editViewAfter.tags.length === 2, JSON.stringify(editViewAfter.tags))
  await shoot('t7-8-edit-saved.png')

  /* ==================== 做什么 5：2.11 是 JSON，不是 multipart ==================== */
  console.log('\n[做什么 5] 2.11 为笔记添加标签：JSON 请求体（不是 multipart）')
  const tagProbe = await api('POST', `/api/note/${PUBLIC_ID}/tag`, { tagIds: TAG_IDS })
  const pageCalledTagApi = cdp.events.some(
    (e) =>
      e.method === 'Network.requestWillBeSent' && /\/api\/note\/\d+\/tag/.test(e.params.request.url),
  )
  console.log(`    POST /api/note/${PUBLIC_ID}/tag（JSON）响应：${JSON.stringify(tagProbe)}`)
  check('2.11 用 JSON 请求体调用返回 code=200（证明它不是 multipart）', tagProbe?.code === 200, JSON.stringify(tagProbe))
  check('页面没有误用 2.11（标签走 2.1/2.2 的 multipart tagIds）', pageCalledTagApi === false)

  /* ==================== 验收 2：无分类阻断提交 ==================== */
  console.log('\n[2] 无分类时点提交 → 被阻断 + 出现「去创建分类」入口')
  console.log('    说明：真实账号都有分类，这里用 CDP 把 2.10 的响应替换成空树（只动响应，不动后端数据）')
  await goto(`http://localhost:${PORT}/notes/create`, 2200)
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/category/tree*', requestStage: 'Request' }],
  })
  /**
   * 一个 poller 处理所有被扣住的 2.10 请求，用 treeMode 切换伪造的响应：
   *   'empty' → 空树（确定「一个分类都没有」）
   *   'fail'  → code=500（「不知道」，与空树是两回事）
   * 两个 poller 并存会互相抢请求，所以只留一个。
   */
  let treeMode = 'empty'
  let stopPoller = false
  const handledPaused = new Set()
  const fakeTreeBody = () =>
    treeMode === 'empty'
      ? { code: 200, message: '操作成功', data: [] }
      : { code: 500, message: '服务器开小差了，请稍后重试', data: null }
  ;(async () => {
    while (!stopPoller) {
      const paused = cdp.events.filter(
        (e) => e.method === 'Fetch.requestPaused' && !handledPaused.has(e.params.requestId),
      )
      for (const p of paused) {
        handledPaused.add(p.params.requestId)
        await cdp
          .send('Fetch.fulfillRequest', {
            requestId: p.params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json;charset=utf-8' }],
            body: Buffer.from(JSON.stringify(fakeTreeBody())).toString('base64'),
          })
          .catch(() => {})
      }
      await sleep(60)
    }
  })()

  reset()
  await goto(`http://localhost:${PORT}/notes/create`, 3000)
  const noCat = await viewEditor()
  console.log(`    阻断条：${JSON.stringify(noCat.blocker)}`)
  check('出现阻断提示', !!noCat.blocker && /还没有任何分类/.test(noCat.blocker ?? ''), String(noCat.blocker))
  check('提供「去创建分类」入口', noCat.blockerButtons.includes('去创建分类'), JSON.stringify(noCat.blockerButtons))
  await shoot('t7-3-no-category-block.png')

  // 真点一次提交：按钮可点（不禁用，否则点了没反馈），但必须被 submit() 拦下
  reset()
  const blockedClick = await clickButtonIn('.cm-note-editor__head-actions', '创建笔记')
  await sleep(1500)
  const blockedState = await viewEditor()
  const blockedPosts = reqIds('/api/note/createNote', 'POST').length
  console.log(`    点提交后：警告=${JSON.stringify(blockedState.warnings)}｜发出的创建请求数=${blockedPosts}`)
  check('点到了「创建笔记」', blockedClick === true)
  check('点提交被阻断（0 个创建请求发出去）', blockedPosts === 0, `实际 ${blockedPosts} 个`)
  check('给出「先创建分类」的警告提示', blockedState.warnings.some((w) => /分类/.test(w)), JSON.stringify(blockedState.warnings))
  await shoot('t7-3b-no-category-blocked-click.png')

  /* ==================== 分类加载失败 ≠ 没有分类 ==================== */
  console.log('\n[附加] 2.10 加载失败 → 提示「重新加载分类」，不谎称「你没有分类」')
  treeMode = 'fail'
  await goto(`http://localhost:${PORT}/notes/create`, 3000)
  const catFail = await viewEditor()
  console.log(`    阻断条：${JSON.stringify(catFail.blocker)}`)
  check('提示「分类加载失败」', /分类加载失败/.test(catFail.blocker ?? ''), String(catFail.blocker))
  check('不谎称「还没有任何分类」', !/还没有任何分类/.test(catFail.blocker ?? ''), String(catFail.blocker))
  check('提供「重新加载分类」', catFail.blockerButtons.includes('重新加载分类'), JSON.stringify(catFail.blockerButtons))
  await shoot('t7-9-category-load-failed.png')

  stopPoller = true
  await cdp.send('Fetch.disable')

  /* ==================== 提醒①：403 分诊（小红看小明的私密笔记） ==================== */
  console.log(`\n[提醒①] 403：${HONG.label} 打开 ${MING.label} 的私密笔记`)
  await goto(`http://localhost:${PORT}/login`, 1200)
  await setToken(HONG_TOKEN)
  reset()
  await goto(`http://localhost:${PORT}/notes/${PRIVATE_ID}`, 3000)
  const forbidden = await viewDetail()
  const forbiddenBody = await respJson(reqIds(`/api/note/${PRIVATE_ID}`).pop())
  console.log(`    2.4 响应体：${JSON.stringify(forbiddenBody)}`)
  console.log(`    标题=${JSON.stringify(forbidden.errorTitle)}｜描述=${JSON.stringify(forbidden.errorDesc)}`)
  check('2.4 返回 code=403', forbiddenBody?.code === 403, JSON.stringify(forbiddenBody))
  check('显示「无权查看这篇笔记」', forbidden.errorTitle === '无权查看这篇笔记', String(forbidden.errorTitle))
  /*
   * 403 有两个来源，**共用同一个 code**：私密笔记（visibility≠1）与草稿（status≠1）。
   * §3.0 约定 D 禁止按 message 文本判断类型，所以页面文案必须**中性** ——
   * 说死成「这是一篇私密笔记」对草稿就是假话（这正是 2026-09-23 后端加草稿校验后暴露的问题）。
   */
  check(
    '403 描述中性（不把 403 说死成「私密」）',
    /只有作者本人/.test(forbidden.errorDesc ?? '') && !/私密/.test(forbidden.errorDesc ?? ''),
    String(forbidden.errorDesc),
  )
  check('没有误报成 404 文案', !/不存在/.test(forbidden.errorTitle ?? ''), String(forbidden.errorTitle))
  await shoot('t7-10-forbidden.png')

  /*
   * 新增分支：非作者打开**公开的草稿**（visibility=1 & status=0）。
   * 后端 2026-09-23 在读取侧补了 status 校验 → 这条路径返回的也是 403，
   * 但 message 是「草稿笔记只能作者自己看」。页面必须给出同一套中性文案。
   */
  console.log(`\n[提醒①] 403：${HONG.label} 打开 ${MING.label} 的**公开草稿**（visibility=1 & status=0）`)
  reset()
  await goto(`http://localhost:${PORT}/notes/${DRAFT_ID}`, 3000)
  const draftForbidden = await viewDetail()
  const draftForbiddenBody = await respJson(reqIds(`/api/note/${DRAFT_ID}`).pop())
  console.log(`    2.4 响应体：${JSON.stringify(draftForbiddenBody)}`)
  console.log(`    标题=${JSON.stringify(draftForbidden.errorTitle)}｜描述=${JSON.stringify(draftForbidden.errorDesc)}`)
  check('公开草稿对非作者返回 code=403', draftForbiddenBody?.code === 403, JSON.stringify(draftForbiddenBody))
  check(
    '后端 message 是「草稿」而非「私密」（证明 403 确实有两个来源）',
    /草稿/.test(draftForbiddenBody?.message ?? '') && !/私密/.test(draftForbiddenBody?.message ?? ''),
    String(draftForbiddenBody?.message),
  )
  check(
    '公开草稿的 403 描述与私密笔记**一致**（中性文案，不按 message 分叉）',
    draftForbidden.errorDesc === forbidden.errorDesc,
    `草稿=${JSON.stringify(draftForbidden.errorDesc)} vs 私密=${JSON.stringify(forbidden.errorDesc)}`,
  )
  check('没有把草稿误说成「私密笔记」', !/私密/.test(draftForbidden.errorDesc ?? ''), String(draftForbidden.errorDesc))
  await shoot('t7-12-draft-forbidden.png')

  console.log('\n[提醒①] 编辑器归属校验：小红打开小明的公开笔记编辑页 → 直接拒绝，不让白改一场')
  reset()
  await goto(`http://localhost:${PORT}/notes/${PUBLIC_ID}/edit`, 3000)
  const editForbidden = await viewEditor()
  console.log(`    标题=${JSON.stringify(editForbidden.errorTitle)}｜描述=${JSON.stringify(editForbidden.errorDesc)}`)
  check('编辑器显示「无权编辑这篇笔记」', editForbidden.errorTitle === '无权编辑这篇笔记', String(editForbidden.errorTitle))
  check('描述说明「只有笔记作者本人可以编辑」', /只有笔记作者本人/.test(editForbidden.errorDesc ?? ''), String(editForbidden.errorDesc))
  check('没有渲染出编辑表单（不泄露正文）', editForbidden.titleValue === null, String(editForbidden.titleValue))
  await shoot('t7-11-edit-forbidden.png')

  /* ==================== 运行时健康度 ==================== */
  console.log('\n[健康度] 控制台（全程归档，不是只看最后一段）')
  reset()
  const consoleErrs = health.consoleErrors.filter(
    (t) => !/Failed to load resource|ERR_|net::/i.test(t),
  )
  console.log(`    未捕获异常 ${health.exceptions.length} 条｜console.error ${consoleErrs.length} 条`)
  check('无未捕获异常', health.exceptions.length === 0, health.exceptions.slice(0, 2).join(' | '))
  check('无 console.error（网络失败日志除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  let removed = 0
  for (const id of createdIds) {
    const r = await api('DELETE', `/api/note/${id}`)
    if (r?.code === 200) removed += 1
  }
  console.log(`\n[清理] 测试笔记删除 ${removed}/${createdIds.length} 篇`)
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
