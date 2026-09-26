#!/usr/bin/env node
/**
 * T11 验收：文章 / 笔记详情页 AI 面板（5.5 ~ 5.10）
 * ------------------------------------------------------------------
 * 端口：vite 5222（proxy → 真实后端 8080）、CDP 9356
 *
 * 与 T10 脚本的区别：这里**全部用条件等待**，不用固定 sleep。
 * 因为三个动作耗时差异极大（总结 ~6s、知识点 ~8s、面试题 13~17s），
 * 固定 sleep 要么白等、要么等不到（第一次跑就栽在这：知识点等 14s 仍是
 * 「正在提取…」，于是误判成 bug，实际是还没生成完）。
 *
 * 验收点：
 *   1. 6 个入口逐个触发一次（6 张截图）
 *   2. 面试题生成中能点「停止」且真的停下
 *   3. 面板失败时正文仍正常
 *   4. 未登录时这 6 个接口返回 401 → 给「登录后查看」而不是报错
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
} from './lib/cdp-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'docs', 'screenshots')

const PORT = 5222
const DEBUG_PORT = 9356
const BACKEND = 'http://localhost:8080'
const BASE = `http://localhost:${PORT}`

/** 测试用内容：文章 30 / 笔记 33（都是小明自己的） */
const ARTICLE_ID = 30
const NOTE_ID = 33

const { check, summary } = createReporter()

/* ==================== 小工具 ==================== */

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

async function shoot(cdp, name) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(res.data, 'base64'))
  console.log(`    📸 ${name}`)
}

/** 面板状态快照（一次求值拿全，避免多次往返时状态已变） */
function snapPanel(cdp) {
  return cdp.evaluate(`(() => {
    const panel = document.querySelector('.cm-ai-panel')
    const body = document.querySelector('.cm-ai-panel__body')
    const bodyText = body?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''
    const actionBtns = [...document.querySelectorAll('.cm-ai-panel__actions button')]
    const r = panel?.getBoundingClientRect()
    return {
      open: !!panel && !!r && r.width > 0 && r.height > 0,
      title: document.querySelector('.cm-ai-panel__title')?.textContent?.trim() ?? '',
      bodyText,
      len: bodyText.length,
      live: !!document.querySelector('.cm-ai-panel__live'),
      needLogin: (document.querySelector('.cm-ai-panel__state')?.innerText ?? '').includes('登录后查看'),
      hasError: bodyText.includes('生成失败') || bodyText.includes('重试'),
      hasStop: actionBtns.some(b => b.textContent.trim() === '停止'),
      hasCopy: actionBtns.some(b => b.textContent.trim() === '复制'),
    }
  })()`)
}

/**
 * 按文案点按钮。
 *
 * ⚠️ 不能用骨架里的 `clickByText`：它只把**元素文本**的空白去掉，
 * 不处理传入的搜索词。按钮文案是「AI 总结」（中间有空格），
 * 归一化后元素是「AI总结」，而搜索词仍是「AI 总结」→ 永远匹配不上。
 * 这里两边都归一化，并且用**全等**而不是 includes，避免误点到别的按钮。
 */
async function clickByLabel(cdp, selector, label) {
  const norm = label.replace(/\s+/g, '')
  return cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = els.find(e => (e.textContent || '').replace(/\\s+/g, '') === ${JSON.stringify(norm)})
    if (!el) return false
    el.click()
    return true
  })()`)
}

/** 等面板「生成中」标记出现 */
const waitStreamStart = (cdp, timeout = 20000) =>
  waitFor(cdp, `document.querySelector('.cm-ai-panel__live')`, timeout)

/** 等「生成中」标记消失 —— 这才是「生成结束」的可靠信号 */
const waitStreamEnd = (cdp, timeout = 120000) =>
  waitFor(cdp, `!document.querySelector('.cm-ai-panel__live')`, timeout)

/** 在 cdp.events 里等某个 CDP 事件（从 fromIndex 起找，避免误抓旧事件） */
async function waitEvent(cdp, method, fromIndex, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const ev = cdp.events.slice(fromIndex).find((e) => e.method === method)
    if (ev) return ev
    await sleep(80)
  }
  return null
}

/**
 * 「正在流式输出、且已经吐出真实内容」。
 *
 * ⚠️ 不能用「复制按钮出现」当信号 —— 模板里「停止」和「复制」是 v-if / v-else-if
 * 互斥的（streaming 时显示停止、结束后才显示复制），所以「复制出现」其实等于
 * 「流已经结束了」，那时候早就没得停了（第一版就是这么错的）。
 * 这里用：停止按钮还在（= 仍在流式）+ 正文长度远超等待文案（= 已有真实内容）。
 */
const STREAMING_CONTENT_EXPR = `(() => {
  const t = document.querySelector('.cm-ai-panel__body')?.innerText ?? ''
  const stop = [...document.querySelectorAll('.cm-ai-panel__actions button')].some(b => b.textContent.trim() === '停止')
  return stop && t.length > 120
})()`

/**
 * 触发一个 AI 动作并等到生成结束。
 *
 * ⚠️ 后端会**偶发**返回业务错误「系统繁忙，请稍后尝试」（LLM 限流，
 * HTTP 200 + application/json）。这是真实存在的后端行为，不是前端 bug ——
 * 面板会正确地把它渲染成「生成失败 / 重新生成」。
 * 所以这里带重试：失败就点面板里的「重新生成」，最多 attempts 次。
 *
 * @returns 结束后的面板快照
 */
async function runAction(cdp, btnSelector, label, { attempts = 4, timeout = 120000 } = {}) {
  let last = null

  for (let i = 1; i <= attempts; i += 1) {
    const clicked =
      i === 1
        ? await clickByLabel(cdp, btnSelector, label)
        : await clickByLabel(cdp, '.cm-error__actions button', '重新生成')
    if (!clicked) throw new Error(`点不到按钮：${i === 1 ? label : '重新生成'}`)

    if (!(await waitStreamStart(cdp))) {
      throw new Error(`点了「${label}」但面板没有进入生成中`)
    }
    if (!(await waitStreamEnd(cdp, timeout))) {
      throw new Error(`「${label}」超过 ${timeout}ms 仍未结束`)
    }
    await sleep(400)

    last = await snapPanel(cdp)
    if (!last.hasError) return last
    console.log(`    ⚠️ 第 ${i} 次返回业务错误（后端限流），点「重新生成」重试`)
  }

  return last
}

/**
 * 端口预检：上一次跑被中断时可能残留 vite 进程占着端口，
 * 不预检的话 vite 只抛一句 `Port 5222 is already in use`，看不出是谁占的。
 */
async function assertPortFree(port) {
  try {
    const res = await fetch(`http://localhost:${port}/`)
    if (res.status < 500) {
      throw new Error(
        `端口 ${port} 已被占用（多半是上一次跑残留的 vite）。` +
          `先结束占用该端口的进程再重跑：netstat -ano | findstr :${port}`,
      )
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('已被占用')) throw err
    /* 连不上 = 空闲 */
  }
}

/* ==================== 主流程 ==================== */

let viteServer
let browser
let cdp

try {
  console.log('[准备] 启动 vite(5222 → 后端 8080) 与无头浏览器')
  await assertPortFree(PORT)
  viteServer = await startVite({ port: PORT, stubPort: 8080 })
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1440,1100' })
  cdp = browser.cdp
  console.log(`    浏览器：${browser.version}`)

  const token = await login('13800000002')

  // 注入登录态：必须先到同源页面才能碰 localStorage
  await cdp.send('Page.navigate', { url: `${BASE}/login` })
  await sleep(800)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(token)})`)

  /* ==================== 一、文章页 3 个入口 ==================== */
  console.log(`\n[导航] 文章详情 /articles/${ARTICLE_ID}`)
  await cdp.send('Page.navigate', { url: `${BASE}/articles/${ARTICLE_ID}` })
  await waitFor(cdp, `document.querySelector('.cm-detail__body')`, 30000)
  await sleep(600)

  const AI_BTNS = '.cm-detail__ai-btn'
  const btnCount = await cdp.evaluate(`document.querySelectorAll('${AI_BTNS}').length`)
  check('文章页有 3 个 AI 入口', btnCount === 3, String(btnCount))

  console.log('\n[验收 1-a] 文章 · AI 总结')
  const s1 = await runAction(cdp, AI_BTNS, 'AI 总结')
  console.log(`    标题=${JSON.stringify(s1.title)}｜正文 ${s1.len} 字｜生成中=${s1.live}`)
  check('面板打开且标题为「AI 总结」', s1.open && s1.title === 'AI 总结', JSON.stringify(s1.title))
  check('总结有内容（>80 字）', s1.len > 80, String(s1.len))
  check('结束后「生成中」消失', s1.live === false)
  check('结束后出现「复制」按钮', s1.hasCopy === true)
  await shoot(cdp, 't11-1-art-summary.png')

  console.log('\n[验收 1-b] 文章 · 知识点提取')
  const s2 = await runAction(cdp, AI_BTNS, '知识点提取')
  console.log(`    标题=${JSON.stringify(s2.title)}｜正文 ${s2.len} 字`)
  check('标题切到「知识点提取」', s2.title === '知识点提取', JSON.stringify(s2.title))
  check('知识点有内容（>80 字）', s2.len > 80, String(s2.len))
  await shoot(cdp, 't11-2-art-kp.png')

  console.log('\n[验收 2] 文章 · 生成面试题 → 中途点「停止」')
  const clickedIq = await clickByLabel(cdp, AI_BTNS, '生成面试题')
  check('点到了「生成面试题」', clickedIq === true)
  check('面试题进入生成中', await waitStreamStart(cdp))
  const midPanel = await snapPanel(cdp)
  check('生成中面板有「停止」按钮', midPanel.hasStop === true)
  check('生成中面板有「生成中」标记', midPanel.live === true)

  /*
   * 必须等到**真实内容**出现再点停止，否则「停止后内容还在」无从判断。
   * 面试题最慢（13~17s），而且后端偶发限流，所以等的是
   * 「仍在流式 + 正文长度远超等待文案」，不是拍脑袋 sleep 7 秒 ——
   * 第一版就是这么错的：7 秒时面板上还是等待文案「正在出题…」（正好 27 字），
   * 我却把它当成了「已生成的内容」。
   */
  const contentArrived = await waitFor(cdp, STREAMING_CONTENT_EXPR, 90000)
  const beforeStop = await snapPanel(cdp)
  console.log(`    停止前：${beforeStop.len} 字｜生成中=${beforeStop.live}｜有停止按钮=${beforeStop.hasStop}`)
  check('停止前仍在流式且已吐出真实内容', contentArrived === true, `len=${beforeStop.len} live=${beforeStop.live}`)

  const stopClicked = await clickByLabel(cdp, '.cm-ai-panel__actions button', '停止')
  check('点到了面板里的「停止」', stopClicked === true)
  check('停止后「生成中」消失', await waitStreamEnd(cdp, 15000))
  await sleep(500)
  const afterStop = await snapPanel(cdp)
  console.log(`    停止后：${afterStop.len} 字｜生成中=${afterStop.live}｜有停止按钮=${afterStop.hasStop}`)
  check('停止后已生成的内容被保留（没有被清空）', afterStop.len > 20, String(afterStop.len))
  check('停止后「停止」按钮消失', afterStop.hasStop === false)
  await shoot(cdp, 't11-3-art-iq-stopped.png')

  /* ==================== 二、笔记页 3 个入口 ==================== */
  console.log(`\n[导航] 笔记详情 /notes/${NOTE_ID}`)
  await cdp.send('Page.navigate', { url: `${BASE}/notes/${NOTE_ID}` })
  await waitFor(cdp, `document.querySelector('.cm-note-detail__body')`, 30000)
  await sleep(600)

  const NOTE_BTNS = '.cm-note-detail__ai-btn'
  const noteBtnCount = await cdp.evaluate(`document.querySelectorAll('${NOTE_BTNS}').length`)
  check('笔记页有 3 个 AI 入口', noteBtnCount === 3, String(noteBtnCount))

  console.log('\n[验收 1-c] 笔记 · AI 总结')
  const s4 = await runAction(cdp, NOTE_BTNS, 'AI 总结')
  console.log(`    标题=${JSON.stringify(s4.title)}｜正文 ${s4.len} 字`)
  check('笔记总结有内容（>60 字）', s4.len > 60, String(s4.len))
  await shoot(cdp, 't11-4-note-summary.png')

  console.log('\n[验收 1-d] 笔记 · 知识点提取')
  const s5 = await runAction(cdp, NOTE_BTNS, '知识点提取')
  console.log(`    标题=${JSON.stringify(s5.title)}｜正文 ${s5.len} 字`)
  check('笔记知识点有内容（>60 字）', s5.len > 60, String(s5.len))
  await shoot(cdp, 't11-5-note-kp.png')

  console.log('\n[验收 1-e] 笔记 · 生成面试题')
  const s6 = await runAction(cdp, NOTE_BTNS, '生成面试题')
  console.log(`    标题=${JSON.stringify(s6.title)}｜正文 ${s6.len} 字`)
  check('笔记面试题有内容（>60 字）', s6.len > 60, String(s6.len))
  await shoot(cdp, 't11-6-note-iq.png')

  /* ==================== 三、面板失败时正文不受影响 ==================== */
  console.log('\n[验收 3] 面板失败时正文仍正常')
  await cdp.send('Page.navigate', { url: `${BASE}/articles/${ARTICLE_ID}` })
  await waitFor(cdp, `document.querySelector('.cm-detail__body')`, 30000)
  await sleep(600)

  const bodyBefore = await cdp.evaluate(
    `document.querySelector('.cm-detail__body')?.innerText?.replace(/\\s+/g,' ').trim() ?? ''`,
  )
  console.log(`    正文快照 ${bodyBefore.length} 字：${bodyBefore.slice(0, 40)}…`)

  // 用 CDP 让这个请求直接失败（不改源码、不改接口路径）
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api/ai/articles*', requestStage: 'Request' }],
  })
  const fromIdx = cdp.events.length
  await clickByLabel(cdp, AI_BTNS, 'AI 总结')
  const paused = await waitEvent(cdp, 'Fetch.requestPaused', fromIdx, 12000)
  check('拦截到了 5.5 请求', !!paused, paused ? paused.params.request.url : '没等到 Fetch.requestPaused')
  if (paused) {
    await cdp.send('Fetch.failRequest', { requestId: paused.params.requestId, errorReason: 'Failed' })
  }
  await waitFor(cdp, `!document.querySelector('.cm-ai-panel__live')`, 20000)
  await sleep(800)
  await cdp.send('Fetch.disable')

  const s7 = await snapPanel(cdp)
  const bodyAfter = await cdp.evaluate(
    `document.querySelector('.cm-detail__body')?.innerText?.replace(/\\s+/g,' ').trim() ?? ''`,
  )
  console.log(`    面板：错误态=${s7.hasError}｜文案=${JSON.stringify(s7.bodyText.slice(0, 60))}`)
  console.log(`    正文快照 ${bodyAfter.length} 字`)
  check('面板内出现失败提示', s7.hasError === true, JSON.stringify(s7.bodyText.slice(0, 80)))
  check('失败时没有弹登录提示（已登录）', s7.needLogin === false)
  check('失败时正文一字未变', bodyAfter === bodyBefore && bodyAfter.length > 100, `${bodyBefore.length} → ${bodyAfter.length}`)
  await shoot(cdp, 't11-7-panel-error.png')

  /* ==================== 四、未登录 → 登录后查看 ==================== */
  console.log('\n[验收 4] 未登录时这 6 个接口 401 → 给「登录后查看」而不是报错')
  await cdp.send('Page.navigate', { url: `${BASE}/articles/${ARTICLE_ID}` })
  await waitFor(cdp, `document.querySelector('.cm-detail__body')`, 30000)
  await sleep(600)

  // 先确认接口层确实是 401（游客身份直连后端，不带 token）
  const guestProbe = await cdp.evaluate(`(async () => {
    const paths = [
      'articles/${ARTICLE_ID}/summary',
      'articles/${ARTICLE_ID}/knowledge-points',
      'articles/${ARTICLE_ID}/interview-questions',
      'notes/${NOTE_ID}/summary',
      'notes/${NOTE_ID}/knowledge-points',
      'notes/${NOTE_ID}/interview-questions',
    ]
    const out = []
    for (const p of paths) {
      const r = await fetch('/api/ai/' + p, { method: 'POST' })
      out.push(r.status)
    }
    return out
  })()`)
  console.log(`    游客直连 6 个接口的状态码：${JSON.stringify(guestProbe)}`)
  check(
    '游客访问 6 个接口一律 401',
    Array.isArray(guestProbe) && guestProbe.length === 6 && guestProbe.every((c) => c === 401),
    JSON.stringify(guestProbe),
  )

  /*
   * 让「点 AI 入口的那一刻没有登录态」：清掉 token 后再点。
   * 页面已经渲染出来了（文章正文、AI 入口都在），此时请求不带 token
   * → 后端 401 → 面板应给「登录后查看」，而不是红字报错。
   */
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  const guestClick = await clickByLabel(cdp, AI_BTNS, 'AI 总结')
  check('未登录也能点到 AI 入口', guestClick === true)
  const gotState = await waitFor(cdp, `document.querySelector('.cm-ai-panel__state')`, 15000)
  await sleep(500)
  const s8 = await snapPanel(cdp)
  console.log(`    面板：登录引导=${s8.needLogin}｜错误态=${s8.hasError}｜文案=${JSON.stringify(s8.bodyText.slice(0, 40))}`)
  check('面板出现登录引导', gotState === true)
  check('引导文案是「登录后查看」', s8.needLogin === true, JSON.stringify(s8.bodyText.slice(0, 60)))
  check('没有当成错误报出来', s8.hasError === false, JSON.stringify(s8.bodyText.slice(0, 60)))
  await shoot(cdp, 't11-8-guest-need-login.png')

  // 补充：游客直接打开详情页时，页面本身也是「登录后查看」而不是报错
  await cdp.send('Page.navigate', { url: `${BASE}/articles/${ARTICLE_ID}` })
  await sleep(1800)
  const pageGate = await cdp.evaluate(
    `document.body.innerText.includes('登录后查看') && document.body.innerText.includes('登录后')`,
  )
  console.log(`    游客打开文章详情页：页面级登录引导=${pageGate}`)
  check('游客打开详情页也是「登录后查看」（页面级兜底）', pageGate === true)
  await shoot(cdp, 't11-9-guest-page-gate.png')

  /* ==================== 五、流式响应头证据 ==================== */
  console.log('\n[附加] 5.5~5.10 响应头')
  const aiResponses = cdp.events
    .filter(
      (e) =>
        e.method === 'Network.responseReceived' &&
        /\/api\/ai\/(articles|notes)\//.test(e.params.response.url),
    )
    .map((e) => ({
      path: new URL(e.params.response.url).pathname.replace('/api/ai/', ''),
      status: e.params.response.status,
      ct: e.params.response.headers['Content-Type'] ?? e.params.response.mimeType ?? '',
    }))
  const seen = new Set()
  aiResponses.forEach((r) => {
    const key = `${r.path}|${r.status}|${r.ct}`
    if (seen.has(key)) return
    seen.add(key)
    console.log(`    ${r.path} → HTTP ${r.status}｜${r.ct}`)
  })
  /*
   * ⚠️ 不能断言「所有 HTTP 200 的响应都是 text/html」——
   * 后端**业务错误也是 HTTP 200**（code 与 HTTP 语义对齐，传输层恒 200），
   * LLM 限流时就返回 `HTTP 200 + application/json`（「系统繁忙，请稍后尝试」）。
   * 旧写法把限流那次也算进「成功响应」，于是**只要后端限流一次脚本就红** ——
   * 2026-09-24 核验实测正是如此（31/32，红的就这条），而脚本自己明明已经
   * 点了「重新生成」并成功了。**属于断言写错，不是产品问题。**
   *
   * 正确的不变量是两条：
   *   ① 每个接口**至少成功流过一段**（该 path 出现过 text/html）；
   *   ② 流式响应是 text/html，**不是 SSE**（没有 text/event-stream）。
   */
  const okOnes = aiResponses.filter((r) => r.status === 200)
  const streams = okOnes.filter((r) => /text\/html/.test(r.ct))
  const jsonOnes = okOnes.filter((r) => /application\/json/.test(r.ct))
  const sse = aiResponses.filter((r) => /text\/event-stream/.test(r.ct))
  const paths = [...new Set(aiResponses.map((r) => r.path))]
  const streamedPaths = new Set(streams.map((r) => r.path))
  console.log(
    `    统计：HTTP 200 共 ${okOnes.length} 次（text/html ${streams.length} 次｜` +
      `application/json ${jsonOnes.length} 次 = 业务错误/限流）；SSE ${sse.length} 次`,
  )
  check(
    '每个 AI 接口都至少成功流过一段（text/html）',
    paths.length > 0 && paths.every((p) => streamedPaths.has(p)),
    `已流式成功：${[...streamedPaths].join(', ')}｜全部：${paths.join(', ')}`,
  )
  check('流式响应不是 SSE（无 text/event-stream）', sse.length === 0, JSON.stringify(sse.slice(0, 2)))

  /* ==================== 六、控制台健康度 ==================== */
  console.log('\n[健康度] 控制台')
  const errs = cdp.consoleErrors()
  const exs = cdp.exceptions()
  // 游客分支下浏览器会打印 401 请求失败日志，属预期；这里只关心未捕获异常
  console.log(`    console.error ${errs.length} 条｜未捕获异常 ${exs.length} 条`)
  check('0 未捕获异常', exs.length === 0, JSON.stringify(exs.slice(0, 2)))

  const failCount = summary()
  process.exitCode = failCount > 0 ? 1 : 0
} catch (err) {
  console.error('\n[脚本异常]', err)
  process.exitCode = 1
} finally {
  await shutdown({
    cdp,
    proc: browser?.proc,
    profileDir: browser?.profileDir,
    viteServer,
    /*
     * 本单直连真实后端（8080），**没有桩后端**，所以不传 stubServer。
     *
     * 原先这里传了一个「立刻回调的空 server」来绕开 harness 的缺陷 ——
     * `shutdown()` 里原本是 `await new Promise(r => stubServer?.close(r))`，
     * stubServer 为空时 Promise 永不 settle → Node 报 unsettled top-level await、
     * 退出码 13，于是「断言全过」的脚本在 CI 里仍被判失败。
     * **该缺陷已于 2026-09-24 由核验方在 harness 里统一修掉**（改成判空再 await），
     * 所以这里的绕法已不需要 —— 正好顺带验证修复真的生效。
     */
  })
}
