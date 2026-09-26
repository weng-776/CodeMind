/**
 * T6 验收：笔记列表与分类管理（真实后端）
 * ------------------------------------------------------------------
 * 覆盖工单 T6 的验收项：
 *   1. 带筛选条件的 URL 刷新后状态完整还原（URL + 截图）
 *   2. 删除本页最后一条 → 页码自动 -1（贴删除前/后 URL）
 *   3. 分类树来自 2.10 真实数据（贴 Network 响应）
 *   4. 删除分类的二次确认弹窗（文案含后果说明）
 *   5. 控制台 0 未捕获异常
 * 另覆盖「做什么」：关键词 300ms 防抖、切筛选丢弃过期响应、可见性乐观更新 + 失败回滚。
 *
 * ⚠️ 测试数据：为了造出「第 2 页只有 1 条」的分页场景，会新建 11 篇笔记
 *   （标题都带 `[T6验收]` 前缀，status=1），验收结束（含失败）全部删除。
 *
 * 前置：后端 8080；账号 13800000002 / 123456。
 * 用法：node scripts/verify-t6-note-list.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, setInput, confirmMessageBox } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5217
const DEBUG_PORT = 9351
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const PHONE = '13800000002'
const PASSWORD = '123456'

const PREFIX = '[T6验收]'
const MARK_A = '甲样本'
const MARK_B = '乙样本'
const COUNT_A = 6
const COUNT_B = 5

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

/* ==================== 造数据：11 篇笔记 ==================== */
console.log(`\n[准备] 新建 ${COUNT_A + COUNT_B} 篇笔记（${COUNT_A} 篇含「${MARK_A}」、${COUNT_B} 篇含「${MARK_B}」）`)
const createdIds = []
/*
 * ⚠️ 2.1 的 categoryId 是**必填**（后端 @NotBlank 校验，漏了会返回 400
 * 「标题笔记分类内容不能为空」这种残句）。这里挂到已有的 React(7) 分类下，
 * 清理时连同笔记一起删掉，不影响分类本身。
 */
const CATEGORY_ID = 7
for (let i = 1; i <= COUNT_A + COUNT_B; i += 1) {
  const mark = i <= COUNT_A ? MARK_A : MARK_B
  const fd = new FormData()
  fd.append('title', `${PREFIX} ${mark} #${i}`)
  fd.append('content', `# ${PREFIX} ${mark} #${i}\n\n用于 T6 验收的分页与筛选样本。`)
  fd.append('categoryId', String(CATEGORY_ID))
  fd.append('visibility', '1')
  fd.append('status', '1')
  const r = await fetch(`${BACKEND}/api/note/createNote`, { method: 'POST', headers: { token: TOKEN }, body: fd }).then((res) => res.json())
  if (r?.data) createdIds.push(r.data)
  else console.log(`    第 ${i} 篇创建失败：${JSON.stringify(r)}`)
}
check('测试笔记创建成功', createdIds.length === COUNT_A + COUNT_B, JSON.stringify(createdIds))
const listProbe = await api('GET', `/api/note/list?page=1&size=10&keyword=${encodeURIComponent(PREFIX)}`)
console.log(`    2.5 keyword=${PREFIX} → total=${listProbe?.data?.total} pages=${listProbe?.data?.pages}`)
check('筛选出 11 篇 → 共 2 页（第 2 页恰好 1 条）', listProbe?.data?.total === 11 && listProbe?.data?.pages === 2)

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1360,1100' })
  const cdp = browser.cdp
  await fs.mkdir(OUT_DIR, { recursive: true })

  const shoot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
  }
  const goto = async (url, wait = 2800) => {
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(150)
    await cdp.send('Page.navigate', { url })
    await sleep(wait)
  }
  const view = () =>
    cdp.evaluate(`({
      url: location.pathname + location.search,
      titles: [...document.querySelectorAll('.cm-note-card__title')].map(e => e.textContent.trim()),
      totalText: document.querySelector('.cm-note-list__subtitle')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      keywordValue: document.querySelector('.cm-note-list__search input')?.value ?? null,
      statusText: document.querySelectorAll('.cm-note-list__filter-select .el-select__selected-item')[0]?.textContent?.trim()
        ?? document.querySelectorAll('.cm-note-list__filter-select input')[0]?.value ?? null,
      pagerActive: document.querySelector('.el-pager .is-active')?.textContent?.trim() ?? null,
      catItems: document.querySelectorAll('.cm-note-list__cats li').length,
      flags: [...document.querySelectorAll('.cm-note-card__flag:not(.cm-note-card__flag--draft)')].map(e => e.textContent.trim()),
      errorToasts: [...document.querySelectorAll('.el-message--error')].map(e => e.textContent.trim()),
    })`)
  const noteRequests = () =>
    cdp.events
      .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/note/list'))
      .map((e) => e.params.request.url)
  const respBodyOf = async (part) => {
    const hit = cdp.events
      .filter((e) => e.method === 'Network.responseReceived' && e.params.response.url.includes(part))
      .map((e) => e.params.requestId)[0]
    if (!hit) return null
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId: hit })
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  const clickOp = async (titleText, opText) => {
    const ok = await cdp.evaluate(`(() => {
      const item = [...document.querySelectorAll('.cm-note-list__item')]
        .find(li => li.querySelector('.cm-note-card__title')?.textContent.trim() === ${JSON.stringify(titleText)})
      const btn = [...(item?.querySelectorAll('.cm-note-list__op') ?? [])].find(b => b.textContent.trim() === ${JSON.stringify(opText)})
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(500)
    return ok
  }

  /* ==================== 登录 ==================== */
  await goto(`http://localhost:${PORT}/login`, 1400)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(TOKEN)})`)

  /* ==================== 3. 分类树来自 2.10 ==================== */
  console.log('\n[3] 分类侧栏来自 2.10 真实数据')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/notes`, 3200)
  const treeBody = await respBodyOf('/api/category/tree')
  const treeReq = cdp.events.some(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/category/tree'),
  )
  const flattenCount = (() => {
    let n = 0
    const walk = (nodes) => (nodes ?? []).forEach((x) => { n += 1; walk(x.children) })
    walk(treeBody?.data)
    return n
  })()
  const base = await view()
  console.log(`    请求 /api/category/tree；响应 ${flattenCount} 个分类（顶层 ${treeBody?.data?.length} 个）`)
  console.log(`    响应片段：${JSON.stringify(treeBody?.data?.slice(0, 3))}`)
  check('已请求 2.10 /api/category/tree', treeReq === true)
  check('分类树响应 code=200 且有节点', treeBody?.code === 200 && flattenCount > 0)
  check('侧栏渲染的分类数 = 接口返回的节点数', base.catItems === flattenCount, `页面 ${base.catItems}，接口 ${flattenCount}`)
  await shoot('t6-4-category-tree.png')

  /* ==================== 2. 关键词 300ms 防抖 ==================== */
  console.log('\n[2] 关键词防抖')
  cdp.clearEvents()
  await cdp.evaluate(`(() => {
    const el = document.querySelector('.cm-note-list__search input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const type = (v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    type('甲')
    setTimeout(() => type('甲样'), 60)
    setTimeout(() => type('甲样本'), 120)
  })()`)
  await sleep(1400)
  const debounceCalls = noteRequests().length
  console.log(`    连续输入 3 次 → /api/note/list 请求 ${debounceCalls} 次`)
  check('防抖生效：3 次输入只打 1 次接口', debounceCalls === 1, `实际 ${debounceCalls} 次`)
  await sleep(600)

  /* ==================== 1. 带筛选 URL 刷新后完整还原 ==================== */
  console.log('\n[1] 带筛选的 URL 刷新还原')
  const FILTER_URL = `/notes?status=1&keyword=${encodeURIComponent(PREFIX)}&page=2`
  await goto(`http://localhost:${PORT}${FILTER_URL}`, 3200)
  const first = await view()
  console.log(`    刷新前 URL：${first.url}`)
  console.log(`    第 2 页条目：${JSON.stringify(first.titles)}｜分页高亮=${first.pagerActive}｜关键词框=${first.keywordValue}`)
  check('URL 保留全部筛选条件', first.url.includes('status=1') && first.url.includes('page=2') && first.url.includes('keyword='), first.url)
  check('第 2 页只有 1 条（11 篇 / 每页 10）', first.titles.length === 1, `实际 ${first.titles.length}`)
  check('关键词输入框回填为 URL 里的值', first.keywordValue === PREFIX, `实际 ${first.keywordValue}`)
  // 硬刷新（先跳 about:blank 再回同一 URL）验证状态还原
  await goto(`http://localhost:${PORT}${FILTER_URL}`, 3200)
  const reloaded = await view()
  check('刷新后 URL 不变', reloaded.url === first.url, `${first.url} → ${reloaded.url}`)
  check('刷新后列表仍是第 2 页那条', JSON.stringify(reloaded.titles) === JSON.stringify(first.titles), JSON.stringify(reloaded.titles))
  check('刷新后关键词框仍回填', reloaded.keywordValue === PREFIX, `实际 ${reloaded.keywordValue}`)
  await shoot('t6-1-filter-url.png')

  /* ==================== 2. 删除本页最后一条 → 页码 -1 ==================== */
  console.log('\n[2b] 删除本页最后一条 → 自动退回上一页')
  const beforeDeleteUrl = reloaded.url
  const lastTitle = reloaded.titles[0]
  const deleted = await clickOp(lastTitle, '删除')
  check('点到了删除按钮', deleted === true)
  await confirmMessageBox(cdp)
  await sleep(2800)
  const afterDelete = await view()
  console.log(`    删除前 URL：${beforeDeleteUrl}`)
  console.log(`    删除后 URL：${afterDelete.url}`)
  check('删除后 URL 的页码退回第 1 页', !afterDelete.url.includes('page=2'), `实际 ${afterDelete.url}`)
  check('删除后列表变成第 1 页的 10 条', afterDelete.titles.length === 10, `实际 ${afterDelete.titles.length}`)
  check('被删的那条已不在列表里', !afterDelete.titles.includes(lastTitle))
  await shoot('t6-2-after-delete.png')

  /* ==================== 4. 分类管理：树 + 删除确认文案 ==================== */
  console.log('\n[4] 分类管理：树形展示 + 删除二次确认（含后果说明）')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/categories`, 3000)
  const catPage = await cdp.evaluate(`({
    url: location.pathname,
    rows: document.querySelectorAll('.cm-categories__row').length,
    hasChildRow: [...document.querySelectorAll('.cm-categories__row')].some(r => /\\d+ 个子分类/.test(r.textContent)),
    stats: [...document.querySelectorAll('.cm-categories__stat')].map(s => s.textContent.replace(/\\s+/g, ' ').trim()),
  })`)
  const catTreeBody = await respBodyOf('/api/category/tree')
  const catNodeCount = (() => {
    let n = 0
    const walk = (nodes) => (nodes ?? []).forEach((x) => { n += 1; walk(x.children) })
    walk(catTreeBody?.data)
    return n
  })()
  console.log(`    页面行数 ${catPage.rows}，接口节点数 ${catNodeCount}，概览：${JSON.stringify(catPage.stats)}`)
  check('分类管理页在 /categories', catPage.url === '/categories', catPage.url)
  check('树形行数与 2.10 节点数一致', catPage.rows === catNodeCount, `页面 ${catPage.rows}，接口 ${catNodeCount}`)
  check('存在带子分类的行（说明是树不是平铺）', catPage.hasChildRow === true)
  await shoot('t6-5-category-manage.png')

  // 删除「带子分类」的那一行，看确认文案
  const opened = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.cm-categories__row')].find(r => /\\d+ 个子分类/.test(r.textContent))
    const btn = [...row.querySelectorAll('.cm-categories__op')].find(b => b.textContent.trim() === '删除')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await sleep(900)
  const confirmText = await cdp.evaluate(`document.querySelector('.el-message-box__message')?.innerText ?? null`)
  console.log(`    确认弹窗文案：${JSON.stringify(confirmText)}`)
  check('弹出了二次确认', opened === true && !!confirmText)
  check('文案说明「笔记不会被删除，但分类会被置空」', /笔记不会被删除/.test(confirmText ?? '') && /置空/.test(confirmText ?? ''), String(confirmText))
  check('文案提示子分类未说明', /子分类/.test(confirmText ?? ''), String(confirmText))
  await shoot('t6-6-delete-category-confirm.png')
  // 取消，不真的删分类
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.el-message-box__btns .el-button')]
    btns.find(b => !b.classList.contains('el-button--primary'))?.click()
  })()`)
  await sleep(600)

  // 重命名弹窗：父分类只读
  await cdp.evaluate(`(() => {
    const row = document.querySelector('.cm-categories__row')
    const btn = [...row.querySelectorAll('.cm-categories__op')].find(b => b.textContent.trim() === '重命名')
    btn.click()
  })()`)
  await sleep(800)
  const editDialog = await cdp.evaluate(`({
    open: !!document.querySelector('.el-dialog:not([style*="display: none"])'),
    readonlyLabel: document.querySelector('.cm-categories__readonly')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
    hasParentSelect: !!document.querySelector('.el-dialog .el-select'),
    fields: [...document.querySelectorAll('.el-dialog .el-form-item__label')].map(e => e.textContent.trim()),
  })`)
  console.log(`    重命名弹窗：父分类只读文案=${JSON.stringify(editDialog.readonlyLabel)}，有无下拉=${editDialog.hasParentSelect}`)
  check('重命名弹窗里父分类是只读展示（没有下拉）', editDialog.hasParentSelect === false && !!editDialog.readonlyLabel)
  check('只读提示写明接口不支持改父分类', /不支持/.test(editDialog.readonlyLabel ?? ''), String(editDialog.readonlyLabel))
  await shoot('t6-7-category-rename-dialog.png')
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.el-dialog__footer .el-button')]
    btns.find(b => b.textContent.trim() === '取消')?.click()
  })()`)
  await sleep(600)

  /* ==================== 做什么 2：切筛选丢弃过期响应 ==================== */
  console.log('\n[2c] 快速切筛选：扣住「甲样本」的请求，切到「乙样本」再放行')
  await goto(`http://localhost:${PORT}/notes`, 3000)
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/note/list*', requestStage: 'Request' }] })
  const handled = new Set()
  let stopPoller = false
  ;(async () => {
    while (!stopPoller) {
      const paused = cdp.events.filter(
        (e) => e.method === 'Fetch.requestPaused' && !handled.has(e.params.requestId),
      )
      for (const p of paused) {
        handled.add(p.params.requestId)
        // 只扣住「甲样本」那条，其余（含关键词为空的首屏）立即放行
        const isMarkA = decodeURIComponent(p.params.request.url).includes(MARK_A)
        setTimeout(() => {
          cdp.send('Fetch.continueRequest', { requestId: p.params.requestId }).catch(() => {})
        }, isMarkA ? 2000 : 0)
      }
      await sleep(60)
    }
  })()

  await setInput(cdp, '.cm-note-list__search input', MARK_A)
  await sleep(900) // 让甲样本的请求发出并被扣住
  await setInput(cdp, '.cm-note-list__search input', MARK_B)
  await sleep(1200) // 乙样本的请求正常返回并渲染
  const midStale = await view()
  await sleep(2200) // 等被扣住的甲样本响应放行并返回
  const afterStale = await view()
  console.log(`    当前 URL：${afterStale.url}`)
  console.log(`    迟到的甲样本响应到达后，列表标题：${JSON.stringify(afterStale.titles)}`)
  check('切到乙样本后展示的是乙样本数据', midStale.titles.length > 0 && midStale.titles.every((t) => t.includes(MARK_B)), JSON.stringify(midStale.titles))
  check('迟到的甲样本响应被丢弃（没覆盖乙样本）', afterStale.titles.length > 0 && afterStale.titles.every((t) => t.includes(MARK_B)), JSON.stringify(afterStale.titles))
  stopPoller = true
  await cdp.send('Fetch.disable')
  await shoot('t6-3-stale-filter.png')

  /* ==================== 做什么 3：可见性乐观更新 + 失败回滚 ==================== */
  console.log('\n[2d] 可见性切换：扣住请求看乐观更新，再让它失败看回滚')
  await goto(`http://localhost:${PORT}/notes?keyword=${encodeURIComponent(MARK_B)}`, 3000)
  const beforeVis = await view()
  const targetTitle = beforeVis.titles[0]
  const flagBefore = beforeVis.flags[0]
  console.log(`    目标笔记：${targetTitle}｜切换前标记：${flagBefore}`)

  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/note/*/visibility*', requestStage: 'Request' }] })
  await clickOp(targetTitle, '设为私密')
  await sleep(500)
  const optimisticFlag = await cdp.evaluate(`(() => {
    const item = [...document.querySelectorAll('.cm-note-list__item')].find(li => li.querySelector('.cm-note-card__title')?.textContent.trim() === ${JSON.stringify(targetTitle)})
    return item?.querySelector('.cm-note-card__flag:not(.cm-note-card__flag--draft)')?.textContent.trim() ?? null
  })()`)
  console.log(`    扣住请求时（乐观更新后）标记：${optimisticFlag}`)
  check('请求未回来界面已翻转（乐观更新）', optimisticFlag !== flagBefore, `${flagBefore} → ${optimisticFlag}`)
  await shoot('t6-8-visibility-optimistic.png')

  const heldIds = cdp.events.filter((e) => e.method === 'Fetch.requestPaused').map((e) => e.params.requestId)
  for (const rid of heldIds) {
    await cdp.send('Fetch.failRequest', { requestId: rid, errorReason: 'Failed' }).catch(() => {})
  }
  await sleep(1600)
  const rolled = await cdp.evaluate(`(() => {
    const item = [...document.querySelectorAll('.cm-note-list__item')].find(li => li.querySelector('.cm-note-card__title')?.textContent.trim() === ${JSON.stringify(targetTitle)})
    return {
      flag: item?.querySelector('.cm-note-card__flag:not(.cm-note-card__flag--draft)')?.textContent.trim() ?? null,
      toasts: [...document.querySelectorAll('.el-message--error')].map(e => e.textContent.trim()),
    }
  })()`)
  console.log(`    失败后标记：${rolled.flag}｜提示：${JSON.stringify(rolled.toasts)}`)
  check('失败后标记回滚', rolled.flag === flagBefore, `${flagBefore} → ${rolled.flag}`)
  check('失败提示只弹一次（请求层负责）', rolled.toasts.length === 1, `实际 ${rolled.toasts.length} 条`)
  await cdp.send('Fetch.disable')
  await shoot('t6-9-visibility-rollback.png')

  /* ==================== 5. 运行时健康度 ==================== */
  console.log('\n[5] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp.consoleErrors().filter((t) => !/Failed to load resource|ERR_|net::/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
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
