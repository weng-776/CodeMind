#!/usr/bin/env node
/**
 * T14 验收：对接后端新增能力（通知筛选 / 删除 + 会话标题与删除）
 * ------------------------------------------------------------------
 * 端口：vite 5226（proxy → 真实后端 8080）、CDP 9360
 *
 * 覆盖工单 5 条验收：
 *   1. 通知筛选四态各贴请求 URL + total（应分别 ≈ 83 / 9 / 24 / 50）
 *   2. 删一条**未读**通知 → 条目消失 + 未读数 -1
 *   3. 新建会话发一条消息 → **不刷新页面**侧栏标题自动变
 *   4. 删非当前会话 → 列表少一项；删**当前**会话 → 自动切走且 URL 不留已删 id
 *   5. vue-tsc 0 错误（脚本外单独跑）+ 0 未捕获异常
 *
 * 三个刻意的设计：
 *   - 用 **CDP 真实鼠标事件**（mouseMoved → pressed → released）点删除按钮，
 *     顺便验证「悬停才浮现」确实成立（侧栏删除键默认 opacity:0）。
 *   - 未读通知**现造现删**（小红先取关再点赞 → 等 MQ → 删掉），跑完不留垃圾。
 *   - 「删掉最后一个会话 → URL 去掉 ?c=」这一条**不能拿真实数据去试**
 *     （会把历史会话全删光）。用 `Fetch` 拦截 5.2 只返回一个临时会话，
 *     走完整分支后再把临时会话删掉 —— 真实数据一条不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  sleep,
  startVite,
  launchBrowser,
  shutdown,
  createReporter,
  waitFor,
  confirmMessageBox,
} from './lib/cdp-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'docs', 'screenshots')
const PORT = 5226
const DEBUG_PORT = 9360
const BACKEND = 'http://localhost:8080'
const BASE = `http://localhost:${PORT}`
const API_PREFIX = `${BASE}/api/`

const { check, summary } = createReporter()

const PLACEHOLDER_TITLE_RE = /^新会话\d+$/

/* ==================== 小工具 ==================== */

async function login(phone) {
  const res = await fetch(`${BACKEND}/api/user/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password: '123456' }),
  })
  const json = await res.json()
  if (json.code !== 200) throw new Error(`登录失败(${phone})：${json.message}`)
  return json.data.token
}

/** 带 token 的后端调用（用于造数据 / 读地面真值） */
function api(pathname, { token, method = 'GET', body } = {}) {
  const headers = { token }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return fetch(`${BACKEND}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json())
}

async function shoot(cdp, name) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(res.data, 'base64'))
  console.log(`    📸 ${name}`)
}

/**
 * 按文案点按钮：**两侧都归一化 + 全等**。
 * （骨架的 clickByText 只归一化元素文本，「AI 总结」这类带空格的文案匹配不上。）
 */
function clickByLabel(cdp, selector, label) {
  const norm = label.replace(/\s+/g, '')
  return cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = els.find(e => (e.textContent || '').replace(/\\s+/g, '') === ${JSON.stringify(norm)})
    if (!el) return false
    el.click()
    return true
  })()`)
}

/** 真实鼠标：移动到元素中心（触发 hover）→ 按下 → 抬起 */
async function hoverAndClick(cdp, selector) {
  const box = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      opacityBefore: getComputedStyle(el).opacity,
    }
  })()`)
  if (!box) return null

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y,
    button: 'none',
  })
  await sleep(250)
  const opacityAfter = await cdp.evaluate(
    `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity`,
  )
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  })
  await sleep(400)
  return { opacityBefore: box.opacityBefore, opacityAfter }
}

/** 从 Network 事件里取最后一次匹配的请求 URL */
function lastRequestUrl(cdp, re) {
  const hits = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => e.params.request.url)
    .filter((u) => u.startsWith(API_PREFIX) && re.test(u))
  return hits.length ? hits[hits.length - 1] : null
}

/** 页面里读通知页状态 */
function notifyState(cdp) {
  return cdp.evaluate(`(() => {
    const sub = document.querySelector('.cm-notify__subtitle')?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''
    const m = sub.match(/有\\s*(\\d+)\\s*条未读/)
    return {
      url: location.pathname + location.search,
      subtitle: sub,
      unread: m ? Number(m[1]) : 0,
      items: document.querySelectorAll('.cm-notify__item').length,
      activeTab: document.querySelector('.cm-tabs__item.is-active')?.textContent?.trim() ?? null,
    }
  })()`)
}

let viteServer
let browser
let cdp
let crashed = false
let T2 = ''
let T3 = ''
/** 造的临时数据，收尾时要清掉 */
const cleanup = { likedArticleId: null, tempConversationId: null }

try {
  console.log('[准备] 启动 vite(5226 → 后端 8080) 与无头浏览器')
  viteServer = await startVite({ port: PORT, stubPort: 8080 })
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1440,1000' })
  cdp = browser.cdp

  T2 = await login('13800000002')
  T3 = await login('13800000003')

  await cdp.send('Page.navigate', { url: `${BASE}/login` })
  await sleep(800)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(T2)})`)

  /* ==================== 验收 1：通知筛选 ==================== */
  console.log('\n[验收 1] 通知类型筛选（URL 驱动，切换回到第 1 页）')
  await cdp.send('Page.navigate', { url: `${BASE}/notifications` })
  await sleep(2000)

  const filterCases = [
    { label: '全部', expectType: null, expectTotal: null },
    { label: '点赞', expectType: '1', expectTotal: 9 },
    { label: '评论', expectType: '2', expectTotal: 24 },
    { label: '关注', expectType: '3', expectTotal: 50 },
  ]

  for (const c of filterCases) {
    cdp.clearEvents()
    const clicked = await clickByLabel(cdp, '.cm-tabs__item', c.label)
    await sleep(1400)
    const st = await notifyState(cdp)
    const reqUrl = lastRequestUrl(cdp, /\/api\/notify\/list/)

    // 页面里显示的「共 N 条」= 该筛选下的 total
    const totalOnPage = Number((st.subtitle.match(/共\s*(\d+)\s*条/) ?? [])[1] ?? -1)
    const reqQuery = reqUrl ? new URL(reqUrl).searchParams.get('type') : null

    console.log(
      `    ${c.label}：tab=${st.activeTab}｜url=${st.url}｜请求 type=${reqQuery}｜total=${totalOnPage}`,
    )
    console.log(`      → ${reqUrl ?? '（没发请求）'}`)

    check(`「${c.label}」按钮点到了`, clicked === true)
    check(`「${c.label}」tab 高亮正确`, st.activeTab === c.label, String(st.activeTab))
    check(
      `「${c.label}」URL query 正确`,
      c.expectType === null ? !/type=/.test(st.url) : st.url.includes(`type=${c.expectType}`),
      st.url,
    )
    check(
      `「${c.label}」请求参数正确（不传 = 全部）`,
      reqQuery === c.expectType,
      `实际 type=${reqQuery}`,
    )
    if (c.expectTotal !== null) {
      // 后端数据会随测试增减，允许 ±3 的漂移
      check(
        `「${c.label}」total ≈ ${c.expectTotal}`,
        Math.abs(totalOnPage - c.expectTotal) <= 3,
        `实际 ${totalOnPage}`,
      )
    }
    if (c.label === '关注') await shoot(cdp, 't14-1-filter-follow.png')
  }

  // 切换筛选要回到第 1 页
  console.log('    校验「切筛选回到第 1 页」')
  await cdp.send('Page.navigate', { url: `${BASE}/notifications?page=3` })
  await sleep(1800)
  const onPage3 = await notifyState(cdp)
  await clickByLabel(cdp, '.cm-tabs__item', '点赞')
  await sleep(1400)
  const afterSwitch = await notifyState(cdp)
  console.log(`      page=3 起点=${onPage3.url} → 切「点赞」后=${afterSwitch.url}`)
  check('从第 3 页切筛选会回到第 1 页', !/page=/.test(afterSwitch.url), afterSwitch.url)
  check('切筛选后 URL 带上了 type', afterSwitch.url.includes('type=1'), afterSwitch.url)

  /* ==================== 验收 2：删除未读通知 ==================== */
  console.log('\n[验收 2] 删一条未读通知 → 条目消失 + 未读数 -1')

  // 造数据：小红先取消再点赞（点赞幂等，直接点不会产生通知）
  const mine = await api('/api/article/my?page=1&size=1', { token: T2 })
  const targetArticle = (mine.data?.records ?? [])[0]
  if (!targetArticle) throw new Error('小明没有文章，无法造点赞通知')
  cleanup.likedArticleId = targetArticle.id
  await api(`/api/article/${targetArticle.id}/like`, { token: T3, method: 'DELETE' })
  await api(`/api/article/${targetArticle.id}/like`, { token: T3, method: 'POST' })
  console.log(`    小红点赞了文章 ${targetArticle.id}，等 MQ 落库…`)

  // 后端写通知是异步的（MQ）→ 必须轮询
  let unreadBefore = 0
  for (let i = 0; i < 20; i += 1) {
    await sleep(700)
    const r = await api('/api/notify/unread', { token: T2 })
    unreadBefore = r.data ?? 0
    if (unreadBefore > 0) break
  }
  check('造出了未读通知（4.2 > 0）', unreadBefore > 0, String(unreadBefore))

  await cdp.send('Page.navigate', { url: `${BASE}/notifications?type=1` })
  await sleep(2000)
  const before2 = await notifyState(cdp)
  const firstItemText = await cdp.evaluate(
    `document.querySelector('.cm-notify__item .cm-notify__content')?.innerText ?? ''`,
  )
  console.log(`    删除前：${JSON.stringify(firstItemText)}｜条目 ${before2.items}｜未读 ${before2.unread}`)
  await shoot(cdp, 't14-2a-before-delete.png')

  const hoverInfo = await hoverAndClick(cdp, '.cm-notify__item .cm-notify__del')
  check('点到了通知的删除按钮', hoverInfo !== null)
  console.log(`    删除按钮 opacity：未悬停 ${hoverInfo?.opacityBefore} → 悬停 ${hoverInfo?.opacityAfter}`)

  await sleep(400)
  const boxShown = await waitFor(cdp, `!!document.querySelector('.el-message-box')`, 5000)
  check('弹出了二次确认框', boxShown === true)
  const boxText = await cdp.evaluate(
    `document.querySelector('.el-message-box__message')?.innerText?.replace(/\\s+/g,' ').trim() ?? ''`,
  )
  console.log(`    确认框文案：${JSON.stringify(boxText)}`)
  check('确认框说明了不可恢复', /不可恢复/.test(boxText), boxText)
  await shoot(cdp, 't14-2b-confirm-dialog.png')

  cdp.clearEvents()
  const confirmed = await confirmMessageBox(cdp)
  check('点到了确认按钮', confirmed === true)
  await sleep(1600)

  // 从 Network 里拿到被删的通知 id（比按文案前缀比对精确得多：
  // 同一个人对同一篇文章的点赞通知文案是完全一样的）
  const delUrl = lastRequestUrl(cdp, /\/api\/notify\/deleteMessage\//)
  const deletedId = delUrl ? Number(delUrl.split('/').pop()) : null
  console.log(`    删除请求：${delUrl ?? '（没发请求）'}`)

  const after2 = await notifyState(cdp)
  const unreadApiAfter = (await api('/api/notify/unread', { token: T2 })).data ?? 0
  console.log(
    `    删除后：条目 ${after2.items}｜页面未读 ${after2.unread}｜接口未读 ${unreadApiAfter}`,
  )
  check('该条通知从列表消失（条目 -1）', after2.items === before2.items - 1, `${before2.items} → ${after2.items}`)
  check(
    '未读数 -1（页面）',
    after2.unread === before2.unread - 1,
    `${before2.unread} → ${after2.unread}`,
  )
  check(
    '未读数 -1（接口地面真值）',
    unreadApiAfter === unreadBefore - 1,
    `${unreadBefore} → ${unreadApiAfter}`,
  )
  if (deletedId) {
    const relisted = await api('/api/notify/list?page=1&size=50&type=1', { token: T2 })
    const stillThere = (relisted.data?.records ?? []).some((n) => Number(n.id) === deletedId)
    console.log(`    被删的 id=${deletedId} 是否还在列表里：${stillThere}`)
    check('被删的那条在接口里也不存在了', stillThere === false, `id=${deletedId}`)
  } else {
    check('拿到了删除请求里的通知 id', false, delUrl ?? '没发请求')
  }
  await shoot(cdp, 't14-2c-after-delete.png')

  /* ==================== 验收 3：会话标题自动更新 ==================== */
  console.log('\n[验收 3] 新建会话发消息 → 不刷新页面，标题自动变')
  await cdp.send('Page.navigate', { url: `${BASE}/ai` })
  await sleep(2200)

  const convCountBefore = await cdp.evaluate(`document.querySelectorAll('.cm-ai__conv-row').length`)
  const newClicked = await clickByLabel(cdp, 'button', '新建会话')
  check('点到了「新建会话」', newClicked === true)
  await sleep(1800)

  const created = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cm-ai__conv-row')]
    const first = rows[0]
    return {
      rows: rows.length,
      url: location.pathname + location.search,
      firstTitle: first?.querySelector('.cm-ai__conv-title')?.innerText?.trim() ?? '',
    }
  })()`)
  console.log(`    会话数 ${convCountBefore} → ${created.rows}｜url=${created.url}`)
  console.log(`    新会话标题 = ${JSON.stringify(created.firstTitle)}`)
  check('新建后会话数 +1', created.rows === convCountBefore + 1, `${convCountBefore} → ${created.rows}`)
  check('新建会话标题是占位标题', PLACEHOLDER_TITLE_RE.test(created.firstTitle), created.firstTitle)
  check('URL 带上了新会话的 ?c=', /[?&]c=\d{15,}/.test(created.url), created.url)

  const newConvId = (created.url.match(/[?&]c=(\d+)/) ?? [])[1] ?? null
  await shoot(cdp, 't14-3a-before-send.png')

  // 发一条消息（后端 LLM 偶发限流 → 带重试）
  let titleUpdated = false
  let finalTitle = ''
  for (let attempt = 1; attempt <= 3 && !titleUpdated; attempt += 1) {
    console.log(`    第 ${attempt} 次发送消息…`)
    await cdp.evaluate(`document.querySelector('.cm-ai__input textarea')?.focus()`)
    await cdp.send('Input.insertText', { text: '一句话说明什么是闭包' })
    await sleep(300)
    const sent = await clickByLabel(cdp, '.cm-ai__composer-actions button', '发送')
    check(`第 ${attempt} 次点到了「发送」`, sent === true)

    // 等流结束：发送按钮文案从「生成中…」变回「发送」
    const ended = await waitFor(
      cdp,
      `[...document.querySelectorAll('.cm-ai__composer-actions button')].some(b => b.textContent.replace(/\\s+/g,'') === '发送')`,
      60000,
    )
    console.log(`      流结束=${ended}`)

    // 不刷新页面，等侧栏标题自己变
    for (let i = 0; i < 16; i += 1) {
      await sleep(500)
      const t = await cdp.evaluate(
        `document.querySelector('.cm-ai__conv-row .cm-ai__conv-title')?.innerText?.trim() ?? ''`,
      )
      if (t && !PLACEHOLDER_TITLE_RE.test(t)) {
        titleUpdated = true
        finalTitle = t
        console.log(`      → 第 ${(i * 0.5).toFixed(1)} 秒 标题自动变为 ${JSON.stringify(t)}`)
        break
      }
    }
    if (!titleUpdated) console.log('      8 秒内标题未变（多半是后端限流导致标题没生成），重试')
  }

  check(
    '**不刷新页面**侧栏标题自动变成真实标题',
    titleUpdated === true,
    titleUpdated ? finalTitle : '8 秒内仍是占位标题',
  )
  if (titleUpdated) {
    const titleOnPage = await cdp.evaluate(
      `document.querySelector('.cm-ai__conv-row .cm-ai__conv-title')?.innerText?.trim() ?? ''`,
    )
    check('标题不是占位格式', !PLACEHOLDER_TITLE_RE.test(titleOnPage), titleOnPage)
    // 与后端地面真值比对
    const list = await api('/api/ai/conversations', { token: T2 })
    const hit = (list.data ?? []).find((c) => String(c.id) === String(newConvId))
    check('页面标题与后端一致', hit && hit.title === titleOnPage, `后端=${hit?.title} 页面=${titleOnPage}`)
  }
  await shoot(cdp, 't14-3b-title-updated.png')

  /* ==================== 验收 4：删除会话 ==================== */
  console.log('\n[验收 4] 删除会话')

  // 4a：删「非当前」会话 —— 先新建一个，让刚才那个变成非当前
  const beforeA = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cm-ai__conv-row')]
    return {
      rows: rows.length,
      titles: rows.map(r => r.querySelector('.cm-ai__conv-title')?.innerText?.trim() ?? ''),
      activeIndex: rows.findIndex(r => r.querySelector('.cm-ai__conv')?.classList.contains('is-active')),
      url: location.pathname + location.search,
    }
  })()`)
  await clickByLabel(cdp, 'button', '新建会话')
  await sleep(1600)
  const withNew = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cm-ai__conv-row')]
    return {
      rows: rows.length,
      activeIndex: rows.findIndex(r => r.querySelector('.cm-ai__conv')?.classList.contains('is-active')),
      url: location.pathname + location.search,
    }
  })()`)
  console.log(`    新建后：会话 ${beforeA.rows} → ${withNew.rows}｜当前在第 ${withNew.activeIndex + 1} 行`)

  // 删第 2 行（非当前）
  const targetRowIndex = withNew.activeIndex === 0 ? 1 : 0
  const hoverA = await hoverAndClick(
    cdp,
    `.cm-ai__conv-row:nth-child(${targetRowIndex + 1}) .cm-ai__conv-del`,
  )
  check('点到了侧栏会话的删除按钮', hoverA !== null)
  console.log(`    侧栏删除键 opacity：未悬停 ${hoverA?.opacityBefore} → 悬停 ${hoverA?.opacityAfter}`)
  check('删除键「悬停才浮现」生效', hoverA?.opacityBefore === '0' && hoverA?.opacityAfter === '1', JSON.stringify(hoverA))

  await sleep(400)
  check('弹出了二次确认框', (await waitFor(cdp, `!!document.querySelector('.el-message-box')`, 5000)) === true)
  const convBoxText = await cdp.evaluate(
    `document.querySelector('.el-message-box__message')?.innerText?.replace(/\\s+/g,' ').trim() ?? ''`,
  )
  console.log(`    确认框文案：${JSON.stringify(convBoxText)}`)
  check('确认框提示不可恢复', /不可恢复/.test(convBoxText), convBoxText)
  await confirmMessageBox(cdp)
  await sleep(1600)

  const afterA = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cm-ai__conv-row')]
    return {
      rows: rows.length,
      activeIndex: rows.findIndex(r => r.querySelector('.cm-ai__conv')?.classList.contains('is-active')),
      url: location.pathname + location.search,
    }
  })()`)
  console.log(`    删非当前后：会话 ${withNew.rows} → ${afterA.rows}｜url=${afterA.url}`)
  check('删非当前会话 → 列表少一项', afterA.rows === withNew.rows - 1, `${withNew.rows} → ${afterA.rows}`)
  check('删非当前会话 → 当前会话不变', afterA.url === withNew.url, `${withNew.url} → ${afterA.url}`)
  await shoot(cdp, 't14-4a-delete-other.png')

  // 4b：删「当前」会话 → 自动切走，URL 不再指向已删的 id
  const currentUrl = afterA.url
  const currentId = (currentUrl.match(/[?&]c=(\d+)/) ?? [])[1] ?? null
  console.log(`    准备删当前会话 id=${currentId}`)
  const hoverB = await hoverAndClick(
    cdp,
    `.cm-ai__conv-row:nth-child(${afterA.activeIndex + 1}) .cm-ai__conv-del`,
  )
  check('点到了当前会话的删除按钮', hoverB !== null)
  await sleep(400)
  await waitFor(cdp, `!!document.querySelector('.el-message-box')`, 5000)
  await confirmMessageBox(cdp)
  await sleep(1800)

  const afterB = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cm-ai__conv-row')]
    return {
      rows: rows.length,
      activeIndex: rows.findIndex(r => r.querySelector('.cm-ai__conv')?.classList.contains('is-active')),
      url: location.pathname + location.search,
      title: document.querySelector('.cm-ai__head-text h1, .cm-ai__head-text')?.innerText?.replace(/\\s+/g,' ').trim().slice(0, 30) ?? '',
    }
  })()`)
  console.log(`    删当前后：会话 ${afterA.rows} → ${afterB.rows}｜url=${afterB.url}｜当前在第 ${afterB.activeIndex + 1} 行`)
  check('删当前会话 → 列表少一项', afterB.rows === afterA.rows - 1, `${afterA.rows} → ${afterB.rows}`)
  check(
    '删当前会话 → URL 不再指向已删的 id',
    currentId === null || !afterB.url.includes(`c=${currentId}`),
    `${currentUrl} → ${afterB.url}`,
  )
  check('删当前会话 → 自动切到了别的会话', afterB.activeIndex >= 0, `activeIndex=${afterB.activeIndex}`)
  check('删当前会话 → URL 指向切过去的那条', /[?&]c=\d{15,}/.test(afterB.url), afterB.url)
  await shoot(cdp, 't14-4b-delete-current.png')

  // 4c：只剩一个会话时删掉 → URL 必须把 ?c= 摘干净
  //     ⚠️ 不拿真实数据试：拦截 5.2 只返回一个临时会话，走完分支再删掉它
  console.log('    4c：只剩一个会话时删掉（拦截 5.2 只返回临时会话，不动真实数据）')
  const tempConv = await api('/api/ai/conversations', { token: T2, method: 'POST' })
  cleanup.tempConversationId = tempConv.data?.id ?? null
  console.log(`    临时会话 id=${cleanup.tempConversationId}`)

  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: `${API_PREFIX}ai/conversations`, requestStage: 'Request' }],
  })
  cdp.ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.method !== 'Fetch.requestPaused') return
    const { requestId, request } = msg.params
    // 只劫持「会话列表」这一个 GET；创建/删除一律放行
    if (request.method === 'GET' && /\/api\/ai\/conversations$/.test(request.url)) {
      const payload = { code: 200, message: '操作成功', data: [tempConv.data] }
      void cdp
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
          body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
        })
        .catch(() => {})
      return
    }
    void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
  })

  await cdp.send('Page.navigate', { url: `${BASE}/ai?c=${cleanup.tempConversationId}` })
  await sleep(2200)
  const onlyOne = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cm-ai__conv-row')]
    return { rows: rows.length, url: location.pathname + location.search }
  })()`)
  console.log(`    拦截后侧栏会话数=${onlyOne.rows}｜url=${onlyOne.url}`)
  check('拦截生效：侧栏只剩 1 个会话', onlyOne.rows === 1, String(onlyOne.rows))
  check('URL 指向这个临时会话', onlyOne.url.includes(`c=${cleanup.tempConversationId}`), onlyOne.url)

  await hoverAndClick(cdp, '.cm-ai__conv-row:nth-child(1) .cm-ai__conv-del')
  await sleep(400)
  await waitFor(cdp, `!!document.querySelector('.el-message-box')`, 5000)
  await confirmMessageBox(cdp)
  await sleep(1800)

  const afterC = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cm-ai__conv-row')]
    return {
      rows: rows.length,
      url: location.pathname + location.search,
      empty: !!document.querySelector('.cm-ai__side-body .cm-empty'),
      welcome: !!document.querySelector('.cm-ai__welcome'),
    }
  })()`)
  console.log(`    删光后：会话 ${afterC.rows}｜url=${afterC.url}｜空态=${afterC.empty}｜欢迎页=${afterC.welcome}`)
  check('删掉最后一个会话 → 列表为空', afterC.rows === 0, String(afterC.rows))
  check('删掉最后一个会话 → URL 里没有 ?c=', !/[?&]c=/.test(afterC.url), afterC.url)
  check('删掉最后一个会话 → 对话区回到欢迎页', afterC.welcome === true)
  await shoot(cdp, 't14-4c-delete-last.png')

  await cdp.send('Fetch.disable').catch(() => {})

  /* ==================== 健康度 ==================== */
  console.log('\n[健康度] 控制台')
  const exs = cdp.exceptions()
  const errs = cdp.consoleErrors().filter((t) => !/Failed to load resource|net::ERR/i.test(t))
  console.log(`    未捕获异常 ${exs.length} 条｜console.error（已滤网络类）${errs.length} 条`)
  check('0 未捕获异常', exs.length === 0, JSON.stringify(exs.slice(0, 2)))
  check('0 console.error', errs.length === 0, JSON.stringify(errs.slice(0, 2)))
} catch (err) {
  console.error('\n[脚本异常]', err)
  crashed = true
} finally {
  /* ==================== 清理造出来的数据 ==================== */
  try {
    if (cleanup.tempConversationId) {
      const r = await api(`/api/ai/DeleteConversation/${cleanup.tempConversationId}`, {
        token: T2,
        method: 'DELETE',
      })
      console.log(`\n[收尾] 删除临时会话 ${cleanup.tempConversationId} → ${JSON.stringify(r)}`)
    }
    if (cleanup.likedArticleId) {
      const r = await api(`/api/article/${cleanup.likedArticleId}/like`, { token: T3, method: 'DELETE' })
      console.log(`[收尾] 小红取消点赞文章 ${cleanup.likedArticleId} → ${JSON.stringify(r)}`)
    }
  } catch (err) {
    console.error('[收尾] 清理失败：', err)
  }

  await shutdown({ cdp, proc: browser?.proc, profileDir: browser?.profileDir, viteServer })
  process.exitCode = summary() > 0 || crashed ? 1 : 0
}
