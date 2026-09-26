/**
 * T5 验收：文章编辑器（真实后端）
 * ------------------------------------------------------------------
 * 覆盖工单 T5 的验收项：
 *   1. 发布文章 → 请求 Content-Type 带 boundary + 响应 code=200
 *   2. 编辑同一篇、只改标题不换图 → 保存成功且**封面不变**（对比两次详情响应）
 *   3. 编辑同一篇、标签原样提交 → 保存后**标签还在**（详情 tags）
 *   4. 存草稿 → 「我的文章」(3.6) 里 status=0
 *   5. 保存成功后能正常离开页面；有未保存改动时会被拦截
 *   6. 标签多选：能多选、能取消待选、保存后再进编辑页原样回显
 * 另覆盖 multipart 细节：多个 tagIds 重复 append、未选封面时 file 字段不出现。
 *
 * ⚠️ 测试数据：会新建一篇文章，验收结束（含失败）都通过 3.3 删除。
 *
 * 前置：后端 8080；账号 13800000002 / 123456。
 * 用法：node scripts/verify-t5-article-editor.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, setInput } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5216
const DEBUG_PORT = 9350
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const PHONE = '13800000002'
const PASSWORD = '123456'

const { check, summary } = createReporter()

/* ==================== 前置：后端 + token + 标签接口实测 ==================== */
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
const TOKEN = loginRes?.data?.token
if (!TOKEN) {
  console.log('密码登录失败：', JSON.stringify(loginRes))
  process.exit(1)
}

const api = async (method, url, body) => {
  const res = await fetch(`${BACKEND}${url}`, {
    method,
    headers: { token: TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

console.log('\n[0] 实测 2.12 GET /api/tag/list（编辑器标签候选集的前置条件）')
const tagListRes = await fetch(`${BACKEND}/api/tag/list`, { headers: { token: TOKEN } })
const tagListJson = await tagListRes.json()
const tagListNoAuth = await fetch(`${BACKEND}/api/tag/list`)
console.log(`    带 token：HTTP ${tagListRes.status}，${tagListJson.data?.length} 个标签：${tagListJson.data?.map((t) => t.name).join(' / ')}`)
console.log(`    不带 token：HTTP ${tagListNoAuth.status}（${(await tagListNoAuth.json()).message}）`)
check('标签接口可用（HTTP 200 + 数组）', tagListRes.status === 200 && Array.isArray(tagListJson.data) && tagListJson.data.length > 0)
check('未登录返回 401（说明它需要登录）', tagListNoAuth.status === 401)
const keywordProbe = await fetch(`${BACKEND}/api/tag/list?keyword=Java`, { headers: { token: TOKEN } }).then((r) => r.json())
check('keyword 过滤生效', keywordProbe.data?.length === 1 && keywordProbe.data[0].name === 'Java', JSON.stringify(keywordProbe.data))

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
let createdId = null
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1360,1100' })
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
  const reqOf = (method, pathPart) =>
    cdp.events.filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        e.params.request.method === method &&
        e.params.request.url.includes(pathPart),
    )[0]
  const bodyOf = async (requestId) => {
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId })
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  const respOf = (pathPart) =>
    cdp.events.filter((e) => e.method === 'Network.responseReceived' && e.params.response.url.includes(pathPart))[0]
  const countField = (raw, name) => ((raw ?? '').match(new RegExp(`name="${name}"`, 'g')) ?? []).length
  const editorState = () =>
    cdp.evaluate(`({
      path: location.pathname,
      title: document.querySelector('.cm-editor__title-input input')?.value ?? null,
      tags: [...document.querySelectorAll('.cm-editor__tags .el-tag')].map(e => e.textContent.trim()).filter(Boolean),
      hasSelect: !!document.querySelector('.cm-editor__tags .el-select'),
      dirty: !!document.querySelector('.cm-editor__dirty'),
      diffMsgs: [...document.querySelectorAll('.el-message-box__title')].map(e => e.textContent.trim()),
    })`)
  const openTagDropdown = async () => {
    await cdp.evaluate(`(() => {
      const el = document.querySelector('.cm-editor__tag-select .el-select__wrapper') ||
                 document.querySelector('.cm-editor__tags .el-select')
      el.click()
    })()`)
    await sleep(500)
  }
  const clickOption = async (name) => {
    const ok = await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('.el-select-dropdown__item')]
      const hit = items.find(i => i.textContent.trim() === ${JSON.stringify(name)})
      if (!hit) return false
      hit.click()
      return true
    })()`)
    await sleep(400)
    return ok
  }
  const removeChip = async (name) => {
    const ok = await cdp.evaluate(`(() => {
      const tags = [...document.querySelectorAll('.cm-editor__tags .el-tag')]
      const hit = tags.find(t => t.textContent.trim().startsWith(${JSON.stringify(name)}))
      const close = hit?.querySelector('.el-tag__close')
      if (!close) return false
      close.click()
      return true
    })()`)
    await sleep(400)
    return ok
  }
  const clickHeadBtn = async (index) => {
    await cdp.evaluate(`(() => {
      const btns = [...document.querySelectorAll('.cm-editor__head-actions .el-button')]
      btns[${index}].click()
    })()`)
  }

  /* ==================== 登录 + 进入新建页 ==================== */
  await goto(`http://localhost:${PORT}/login`, 1400)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(TOKEN)})`)
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/articles/create`, 3000)

  const createState = await editorState()
  check('停在 /articles/create', createState.path === '/articles/create', `实际 ${createState.path}`)
  check('标签选择控件存在（旧结论「没有标签控件」已推翻）', createState.hasSelect === true)
  check('新建时没有已选标签', createState.tags.length === 0, JSON.stringify(createState.tags))

  const tagReqFired = cdp.events.some(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/tag/list'),
  )
  check('已请求 2.12 /api/tag/list 拉候选集', tagReqFired === true)

  // 打开下拉，确认候选数量来自真实接口
  await openTagDropdown()
  const optionCount = await cdp.evaluate(`document.querySelectorAll('.el-select-dropdown__item').length`)
  console.log(`    下拉候选 ${optionCount} 项（接口返回 ${tagListJson.data.length} 项）`)
  check('候选集来自接口（下拉项数 = 接口返回数）', optionCount === tagListJson.data.length, `实际 ${optionCount}`)
  await shoot('t5-1-editor-create.png')

  /* ==================== 1. 发布一篇新文章（多选 2 个标签、不选封面） ==================== */
  console.log('\n[1] 发布：多选 2 个标签、不选封面')
  const TITLE = `[T5 验收] 编辑器发布 ${Date.now()}`
  await setInput(cdp, '.cm-editor__title-input input', TITLE)
  await setInput(cdp, '.cm-editor__textarea textarea', '# T5 验收\n\n```js\nconsole.log(1)\n```\n')
  await sleep(300)
  await openTagDropdown()
  const pick1 = await clickOption('Java')
  const pick2 = await clickOption('面试')
  const picked = await editorState()
  check('能多选标签（Java + 面试）', pick1 && pick2 && picked.tags.length === 2, JSON.stringify(picked.tags))
  check('标题输入后出现「未保存」标记', picked.dirty === true)

  cdp.clearEvents()
  await clickHeadBtn(1) // 发布文章
  await sleep(2800)
  const createReq = reqOf('POST', '/api/article')
  const createResp = respOf('/api/article')
  const createBody = createResp ? await bodyOf(createResp.params.requestId) : null
  const contentType = createReq?.params?.request.headers['Content-Type'] ?? createReq?.params?.request.headers['content-type']
  console.log(`    POST /api/article Content-Type: ${contentType}`)
  console.log(`    响应：${JSON.stringify(createBody)}`)
  check('请求是 multipart/form-data 且带 boundary', /^multipart\/form-data;\s*boundary=/.test(contentType ?? ''), String(contentType))
  check('未手动设置 Content-Type 的迹象（boundary 由浏览器生成）', /boundary=[\w-]{20,}/.test(contentType ?? ''), String(contentType))
  check('响应 code=200', createBody?.code === 200, JSON.stringify(createBody))
  check('status=1 已提交', /name="status"\r?\n\r?\n1\r?\n/.test(createReq?.params?.request.postData ?? ''))
  check('未选封面 → file 字段不出现', countField(createReq?.params?.request.postData, 'file') === 0)
  createdId = createBody?.data
  check('响应返回新建文章 id', typeof createdId === 'number' && createdId > 0, JSON.stringify(createBody))

  /* ==================== 2/3. 编辑：只改标题不换图，标签原样提交 ==================== */
  console.log('\n[2] 编辑：只改标题、不选新图、标签原样提交')
  const before = (await api('GET', `/api/article/${createdId}`)).data
  console.log(`    改前：title=${before.title} cover=${JSON.stringify(before.cover)} tags=${JSON.stringify(before.tags.map((t) => t.name))}`)

  await goto(`http://localhost:${PORT}/articles/${createdId}/edit`, 3000)
  const editState = await editorState()
  check('编辑页标签原样回显 2 个', editState.tags.length === 2, JSON.stringify(editState.tags))
  check('刚载入不算未保存', editState.dirty === false)

  const NEW_TITLE = `${TITLE}（已修改）`
  await setInput(cdp, '.cm-editor__title-input input', NEW_TITLE)
  await sleep(300)
  cdp.clearEvents()
  await clickHeadBtn(1) // 更新文章
  await sleep(3000)
  const updateReq = reqOf('PUT', `/api/article/${createdId}`)
  const updateRaw = updateReq?.params?.request.postData
  check('更新请求是 PUT multipart', !!updateReq && /^multipart\/form-data;\s*boundary=/.test(updateReq.params.request.headers['Content-Type'] ?? updateReq.params.request.headers['content-type'] ?? ''))
  check('未选新图 → file 字段不出现（= 保留原封面）', countField(updateRaw, 'file') === 0)
  check('tagIds 重复 append 2 次（不是数组）', countField(updateRaw, 'tagIds') === 2, `实际 ${countField(updateRaw, 'tagIds')}`)

  const after = (await api('GET', `/api/article/${createdId}`)).data
  console.log(`    改后：title=${after.title} cover=${JSON.stringify(after.cover)} tags=${JSON.stringify(after.tags.map((t) => t.name))}`)
  check('标题已更新', after.title === NEW_TITLE, `实际 ${after.title}`)
  check('封面保持不变（两次详情响应一致）', after.cover === before.cover, `${JSON.stringify(before.cover)} → ${JSON.stringify(after.cover)}`)
  check('标签仍然存在（原样回传没丢）', JSON.stringify(after.tags.map((t) => t.name)) === JSON.stringify(before.tags.map((t) => t.name)), JSON.stringify(after.tags))

  /* ==================== 6. 标签多选：加一个再取消，保存后回显 ==================== */
  console.log('\n[6] 标签多选：加选一个 → 再取消 → 保存 → 重新进入编辑页回显')
  await goto(`http://localhost:${PORT}/articles/${createdId}/edit`, 3000)
  await openTagDropdown()
  await clickOption('算法')
  const withThree = await editorState()
  check('能加选到 3 个', withThree.tags.length === 3, JSON.stringify(withThree.tags))
  const removed = await removeChip('算法')
  const backToTwo = await editorState()
  check('能取消待选（× 删掉刚加的那个）', removed === true && backToTwo.tags.length === 2, JSON.stringify(backToTwo.tags))
  await shoot('t5-2-tag-multiselect.png')

  cdp.clearEvents()
  await clickHeadBtn(1)
  await sleep(3000)
  await goto(`http://localhost:${PORT}/articles/${createdId}/edit`, 3000)
  const reloadState = await editorState()
  check('重新进入编辑页标签仍为 2 个（原样回显）', reloadState.tags.length === 2, JSON.stringify(reloadState.tags))

  /* ==================== 5. 未保存拦截 + 保存后能离开 ==================== */
  console.log('\n[5] 未保存拦截 / 保存后离开')
  await setInput(cdp, '.cm-editor__title-input input', `${NEW_TITLE} — 临时改动`)
  await sleep(300)
  await cdp.evaluate(`document.querySelector('.cm-header__logo').click()`)
  await sleep(900)
  const guarded = await cdp.evaluate(`({
    stillOnEditor: location.pathname.includes('/edit'),
    boxTitle: document.querySelector('.el-message-box__title')?.textContent?.trim() ?? null,
    boxText: document.querySelector('.el-message-box__message')?.textContent?.trim() ?? null,
  })`)
  console.log(`    拦截弹窗：${guarded.boxTitle} / ${guarded.boxText}`)
  check('有未保存改动时离开被拦截', guarded.stillOnEditor === true && /未保存|离开/.test(`${guarded.boxTitle}${guarded.boxText}`), JSON.stringify(guarded))
  // 选择「继续编辑」留在页面
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.el-message-box__btns .el-button')]
    const cancel = btns.find(b => !b.classList.contains('el-button--primary'))
    cancel?.click()
  })()`)
  await sleep(600)
  await shoot('t5-3-unsaved-guard.png')

  console.log('\n[4] 存草稿：status=0，且保存后能正常离开')
  cdp.clearEvents()
  await clickHeadBtn(0) // 保存草稿
  await sleep(3000)
  const draftReq = reqOf('PUT', `/api/article/${createdId}`)
  check('草稿提交 status=0', /name="status"\r?\n\r?\n0\r?\n/.test(draftReq?.params?.request.postData ?? ''))
  const leftAfterSave = await cdp.evaluate(`({ path: location.pathname, box: !!document.querySelector('.el-message-box__title') })`)
  check('保存成功后正常离开编辑页（未被自己的拦截拦住）', leftAfterSave.path !== `/articles/${createdId}/edit`, `实际 ${leftAfterSave.path}`)
  check('离开时没有残留的拦截弹窗', leftAfterSave.box === false)
  await shoot('t5-4-draft-saved.png')

  // 3.6 我的文章：确认草稿状态
  await sleep(1200)
  const myDrafts = await api('GET', '/api/article/my?page=1&size=20&status=0')
  const mine = myDrafts?.data?.records?.find((r) => r.id === createdId)
  console.log(`    3.6 status=0 列表里找到：${JSON.stringify(mine ? { id: mine.id, title: mine.title, status: mine.status } : null)}`)
  check('3.6 里该文章 status=0（草稿）', mine?.status === 0, JSON.stringify(mine))

  await goto(`http://localhost:${PORT}/profile/articles?status=0`, 2800)
  const profileShot = await cdp.evaluate(`document.body.innerText.includes('草稿')`)
  console.log(`    「我的文章」页含草稿标记：${profileShot}`)
  await shoot('t5-5-my-drafts.png')

  /* ==================== 运行时健康度 ==================== */
  console.log('\n[7] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp.consoleErrors().filter((t) => !/Failed to load resource|ERR_|net::/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  if (createdId) {
    const del = await api('DELETE', `/api/article/${createdId}`)
    console.log(`\n[清理] 删除验收文章 ${createdId}：${JSON.stringify(del)}`)
  }
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
