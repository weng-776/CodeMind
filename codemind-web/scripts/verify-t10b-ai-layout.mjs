#!/usr/bin/env node
/**
 * T10 返工验收：AI 对话页的三区独立滚动
 * ------------------------------------------------------------------
 * 端口：vite 5225（proxy → 真实后端 8080）、CDP 9359
 *
 * 用户报的 4 个症状：
 *   1. 对话区鼠标滚轮不生效
 *   2. 只能拖右侧滚动条
 *   3. 输入框不固定，聊几轮后跟着内容一起沉下去，要拉到底才能继续
 *   4. 会话列表也跟着滚，拉到下面看不到会话
 *
 * 根因：`.cm-layout` 只有 `min-height: 100vh`（下限而非确定高度），
 * 对话一长整页就跟着长高 → 内部两个 `overflow-y: auto` 永不溢出 → 退化成整页滚动。
 *
 * 所以这里要验的正是「**整页不滚、三个区域各滚各的**」：
 *   - documentElement 不能有可滚动余量
 *   - 消息区能滚，且**真实滚轮**能滚动它
 *   - 输入框 / 侧栏在消息区滚动前后位置不变（不被卷走）
 *   - 侧栏自己能滚
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep, startVite, launchBrowser, shutdown, createReporter, waitFor } from './lib/cdp-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'docs', 'screenshots')
const PORT = 5225
const DEBUG_PORT = 9359
const BACKEND = 'http://localhost:8080'
const BASE = `http://localhost:${PORT}`

const { check, summary } = createReporter()

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

/** 找一条消息最多的会话，确保内容一定会溢出视口 */
async function longestConversation(token) {
  const list = await fetch(`${BACKEND}/api/ai/conversations?page=1&size=50`, {
    headers: { token },
  }).then((r) => r.json())
  const convs = list.data || []
  let best = null
  for (const c of convs) {
    const m = await fetch(`${BACKEND}/api/ai/conversations/${c.id}/messages?page=1&size=100`, {
      headers: { token },
    }).then((r) => r.json())
    const msgs = (m.data && (m.data.records || m.data)) || []
    const chars = msgs.reduce((a, x) => a + String(x.content || '').length, 0)
    if (!best || chars > best.chars) best = { id: c.id, chars, n: msgs.length }
  }
  return best
}

/** 一次求值把布局指标全拿到 */
function metrics(cdp) {
  return cdp.evaluate(`(() => {
    const de = document.documentElement
    const sc = document.querySelector('.cm-ai__scroll')
    const side = document.querySelector('.cm-ai__side-body')
    const composer = document.querySelector('.cm-ai__composer')
    const sideEl = document.querySelector('.cm-ai__side')
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), height: Math.round(b.height) } }
    return {
      vh: window.innerHeight,
      pageOverflow: de.scrollHeight - de.clientHeight,
      pageScrollTop: de.scrollTop,
      msg: sc ? { clientH: sc.clientHeight, scrollH: sc.scrollHeight, top: sc.scrollTop, canScroll: sc.scrollHeight > sc.clientHeight + 1 } : null,
      side: side ? { clientH: side.clientHeight, scrollH: side.scrollHeight, top: side.scrollTop, canScroll: side.scrollHeight > side.clientHeight + 1 } : null,
      composer: r(composer),
      sideBox: r(sideEl),
      msgRect: sc ? r(sc) : null,
      overflowY: sc ? getComputedStyle(sc).overflowY : null,
    }
  })()`)
}

async function shoot(cdp, name) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(res.data, 'base64'))
  console.log(`    📸 ${name}`)
}

/** 在指定坐标发一次**真实**滚轮事件（CDP 合成，与用户操作同一条链路） */
async function wheelAt(cdp, x, y, deltaY) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x),
    y: Math.round(y),
    deltaX: 0,
    deltaY,
  })
  await sleep(350)
}

let viteServer
let browser
let cdp
/** 脚本自身抛异常也要让退出码非 0 —— 否则「崩了」会被 finally 里的 summary 覆盖成 0 */
let crashed = false

try {
  console.log('[准备] 启动 vite(5225 → 后端 8080) 与无头浏览器')
  viteServer = await startVite({ port: PORT, stubPort: 8080 })
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1440,900' })
  cdp = browser.cdp

  const token = await login('13800000002')
  const conv = await longestConversation(token)
  if (!conv) throw new Error('后端没有会话，无法复现长对话场景')
  console.log(`    用会话 ${conv.id}（${conv.n} 条消息 / ${conv.chars} 字）复现长对话`)

  await cdp.send('Page.navigate', { url: `${BASE}/login` })
  await sleep(800)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(token)})`)
  await cdp.send('Page.navigate', { url: `${BASE}/ai?c=${conv.id}` })
  await sleep(2500)

  const rendered = await waitFor(cdp, `document.querySelectorAll('.cm-ai__msg, .cm-msg, .cm-ai-msg').length > 4`, 10000)
  console.log(`    消息渲染完成：${rendered}`)

  /* ==================== 基线 ==================== */
  const base = await metrics(cdp)
  console.log(`\n[基线] 视口高 ${base.vh}｜页面可滚余量 ${base.pageOverflow}px`)
  console.log(`    消息区 clientH=${base.msg?.clientH} scrollH=${base.msg?.scrollH} 可滚=${base.msg?.canScroll} overflow-y=${base.overflowY}`)
  console.log(`    侧栏   clientH=${base.side?.clientH} scrollH=${base.side?.scrollH} 可滚=${base.side?.canScroll}`)
  console.log(`    输入框 ${JSON.stringify(base.composer)}`)

  check('内容确实长到会溢出（用例有效）', base.msg?.canScroll === true, JSON.stringify(base.msg))
  check('整页不再有可滚动余量（页面不滚）', base.pageOverflow <= 0, `${base.pageOverflow}px`)
  check('消息区是独立的滚动容器（overflow-y: auto）', base.overflowY === 'auto', String(base.overflowY))
  check('输入框在视口内（贴底固定）', !!base.composer && base.composer.bottom <= base.vh + 1, JSON.stringify(base.composer))
  await shoot(cdp, 't10b-1-layout-top.png')

  /* ==================== 症状 1/2：真实滚轮能滚消息区 ==================== */
  console.log('\n[症状 1/2] 鼠标悬在对话区滚轮')
  /*
   * ⚠️ 方向别搞反：进页面时消息区**已经自动停在底部**（scrollTop 正好是
   * scrollHeight - clientHeight），所以「向下滚」不会有任何变化 ——
   * 第一版就是这么假失败的。要**先向上滚**（deltaY 为负）再向下滚，两个方向都验。
   */
  const center = {
    x: (base.msgRect.left + base.msgRect.right) / 2,
    y: (base.msgRect.top + base.msgRect.bottom) / 2,
  }
  console.log(`    起点 scrollTop=${base.msg.top}（最大值 ${base.msg.scrollH - base.msg.clientH}）`)

  await wheelAt(cdp, center.x, center.y, -400)
  const afterUp = await metrics(cdp)
  console.log(`    向上滚 → scrollTop ${base.msg.top} → ${afterUp.msg.top}`)
  check('真实滚轮向上能滚动消息区', afterUp.msg.top < base.msg.top, `${base.msg.top} → ${afterUp.msg.top}`)
  check('滚消息区不会把整页带走', afterUp.pageOverflow <= 0 && afterUp.pageScrollTop === 0, `overflow=${afterUp.pageOverflow} scrollTop=${afterUp.pageScrollTop}`)

  await wheelAt(cdp, center.x, center.y, 400)
  const afterDown = await metrics(cdp)
  console.log(`    向下滚 → scrollTop ${afterUp.msg.top} → ${afterDown.msg.top}`)
  check('真实滚轮向下能滚回底部', afterDown.msg.top > afterUp.msg.top, `${afterUp.msg.top} → ${afterDown.msg.top}`)

  /* ==================== 症状 3：输入框固定不沉 ==================== */
  console.log('\n[症状 3] 消息滚到底后，输入框位置不变')
  await cdp.evaluate(`(() => { const sc = document.querySelector('.cm-ai__scroll'); sc.scrollTop = sc.scrollHeight })()`)
  await sleep(400)
  const atBottom = await metrics(cdp)
  console.log(`    输入框 top ${base.composer.top} → ${atBottom.composer.top}｜bottom ${base.composer.bottom} → ${atBottom.composer.bottom}`)
  check('滚到底后输入框 top 不变', atBottom.composer.top === base.composer.top, `${base.composer.top} → ${atBottom.composer.top}`)
  check('滚到底后输入框仍贴视口底部', atBottom.composer.bottom <= atBottom.vh + 1 && atBottom.composer.bottom > atBottom.vh - 40, `${atBottom.composer.bottom} / vh=${atBottom.vh}`)
  await shoot(cdp, 't10b-2-layout-bottom.png')

  /* ==================== 症状 4：侧栏不被卷走 + 自己能滚 ==================== */
  console.log('\n[症状 4] 会话列表不被卷走，且自己能滚')
  check('滚到底后侧栏位置不变', atBottom.sideBox.top === base.sideBox.top, `${base.sideBox.top} → ${atBottom.sideBox.top}`)
  check('侧栏顶部仍在视口内', atBottom.sideBox.top >= 0 && atBottom.sideBox.top < 200, String(atBottom.sideBox.top))

  /*
   * 用户明确要求「会话列表单独一个区域，里面有拖拽条还支持滚轮滑动」。
   * 但后端目前只有几条会话，撑不出溢出 → 滚动容器**不会被激活**，
   * 直接断言会假通过（`canScroll=false` 时测什么都「对」）。
   * 所以这里在 DOM 里克隆列表项把侧栏撑高，只为验证**滚动容器本身**成立
   * （不碰数据，刷新即恢复）。
   */
  if (!base.side.canScroll) {
    const inflated = await cdp.evaluate(`(() => {
      const ul = document.querySelector('.cm-ai__conv-list')
      if (!ul || !ul.children.length) return 0
      const items = [...ul.children]
      for (let i = 0; i < 8; i++) items.forEach((li) => ul.appendChild(li.cloneNode(true)))
      return ul.children.length
    })()`)
    console.log(`    会话数不足以溢出，已克隆列表项撑高（${inflated} 条）以验证滚动容器`)
    await sleep(300)
  }

  const sideNow = await metrics(cdp)
  console.log(`    侧栏 clientH=${sideNow.side.clientH} scrollH=${sideNow.side.scrollH} 可滚=${sideNow.side.canScroll}`)
  check('会话列表是可滚动的独立区域（内容够长时溢出）', sideNow.side.canScroll === true, JSON.stringify(sideNow.side))

  const sideCenterY = Math.min(sideNow.sideBox.top + sideNow.side.clientH / 2, sideNow.vh - 20)
  // 侧栏起点在顶部（scrollTop=0），所以这里要**向下**滚（正值）才有位移
  await wheelAt(cdp, 120, sideCenterY, 300)
  const afterSideWheel = await metrics(cdp)
  console.log(`    侧栏滚轮 scrollTop ${sideNow.side.top} → ${afterSideWheel.side.top}`)
  check('侧栏能被鼠标滚轮滚动', afterSideWheel.side.top > sideNow.side.top, `${sideNow.side.top} → ${afterSideWheel.side.top}`)
  check('滚侧栏不会带动消息区', afterSideWheel.msg.top === sideNow.msg.top, `${sideNow.msg.top} → ${afterSideWheel.msg.top}`)
  check('滚侧栏不会带动整页', afterSideWheel.pageOverflow <= 0 && afterSideWheel.pageScrollTop === 0, `overflow=${afterSideWheel.pageOverflow}`)
  check('滚侧栏时输入框依然固定', afterSideWheel.composer.top === sideNow.composer.top, `${sideNow.composer.top} → ${afterSideWheel.composer.top}`)
  // 留一张「会话列表已滚动 + 自带细滚动条」的视觉证据（用户明确要求它有拖拽条）
  await shoot(cdp, 't10b-3-sidebar-scroll.png')

  /* ==================== 回滚到顶部，输入框仍固定 ==================== */
  console.log('\n[附加] 滚回顶部，输入框依旧固定')
  await cdp.evaluate(`(() => { const sc = document.querySelector('.cm-ai__scroll'); sc.scrollTop = 0 })()`)
  await sleep(400)
  const backTop = await metrics(cdp)
  check('滚回顶部后输入框 top 仍与基线一致', backTop.composer.top === base.composer.top, `${base.composer.top} → ${backTop.composer.top}`)
  check('整页始终没有滚动余量', backTop.pageOverflow <= 0, `${backTop.pageOverflow}px`)

  /* ==================== 窄屏（侧栏变抽屉）不回归 ==================== */
  console.log('\n[附加] 窄屏 900px 下不出现整页滚动')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
  const narrow = await metrics(cdp)
  console.log(`    页面可滚余量 ${narrow.pageOverflow}px｜消息区可滚=${narrow.msg?.canScroll}`)
  check('窄屏下整页仍无滚动余量', narrow.pageOverflow <= 0, `${narrow.pageOverflow}px`)
  check('窄屏下输入框仍在视口内', !!narrow.composer && narrow.composer.bottom <= narrow.vh + 1, JSON.stringify(narrow.composer))
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  /* ==================== 附加：消息区不该出现横向滚动条 ====================
   * AI 回复里常有宽表格 / 长代码块。它们应当**自己横向滚**，
   * 而不是把整个消息区撑出横向滚动条（那会让每一条消息都跟着左右晃）。
   */
  const hOver = await cdp.evaluate(`(() => {
    const sc = document.querySelector('.cm-ai__scroll')
    const wide = [...sc.querySelectorAll('table, pre')].filter(el => el.scrollWidth > el.clientWidth + 1).length
    return { sw: sc.scrollWidth, cw: sc.clientWidth, wideInner: wide }
  })()`)
  console.log(`\n[附加] 消息区横向：scrollWidth=${hOver.sw} clientWidth=${hOver.cw}｜内部可横向滚的表格/代码块 ${hOver.wideInner} 个`)
  check('消息区没有横向溢出', hOver.sw <= hOver.cw + 1, `${hOver.sw} > ${hOver.cw}`)

  /* ==================== 附加：外壳类没漏到普通页面 ====================
   * `.is-app-shell`（height:100vh + overflow:hidden）只该作用在 AI 页。
   * 一旦漏出去，普通页面就再也滚不动了 —— 这条是防回归的关键。
   */
  await cdp.send('Page.navigate', { url: `${BASE}/articles` })
  await sleep(2200)
  const normal = await cdp.evaluate(`(() => {
    const layout = document.querySelector('.cm-layout')
    const de = document.documentElement
    return {
      appShell: layout.classList.contains('is-app-shell'),
      layoutOverflow: getComputedStyle(layout).overflow,
      pageScrollable: de.scrollHeight > de.clientHeight + 1,
      hasFooter: !!document.querySelector('.cm-layout__footer'),
      cards: document.querySelectorAll('.cm-article-card').length,
    }
  })()`)
  console.log(`\n[附加] 普通页面（社区列表）：外壳=${normal.appShell}｜overflow=${normal.layoutOverflow}｜可整页滚动=${normal.pageScrollable}｜有页脚=${normal.hasFooter}｜卡片 ${normal.cards}`)
  check('普通页面没有被套上应用式外壳', normal.appShell === false)
  check('普通页面 overflow 不是 hidden', normal.layoutOverflow !== 'hidden', normal.layoutOverflow)
  check('普通页面仍有页脚', normal.hasFooter === true)
  check('普通页面仍可整页滚动', normal.pageScrollable === true)

  /* ==================== 健康度 ==================== */
  const exs = cdp.exceptions()
  check('0 未捕获异常', exs.length === 0, JSON.stringify(exs.slice(0, 2)))
} catch (err) {
  console.error('\n[脚本异常]', err)
  crashed = true
} finally {
  await shutdown({
    cdp,
    proc: browser?.proc,
    profileDir: browser?.profileDir,
    viteServer,
  })
  process.exitCode = summary() > 0 || crashed ? 1 : 0
}
