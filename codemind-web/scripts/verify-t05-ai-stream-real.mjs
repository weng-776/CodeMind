/**
 * T0.5 验收：AI 流式认证头与错误分流（真实后端，不桩任何接口）
 * ------------------------------------------------------------------
 * 验收点（对应工单 T0.5）：
 *   1. 登录态调 AI 文章总结 → 200 + 正文渲染，且请求头带 `token`（CDP 抓包为证）
 *   2. 清掉 token 再调同一接口 → 面板给「登录后查看」引导（T11 起是引导态，
 *      不是把 onError 文案当红字摊出来），不是「登录状态已失效」，URL 不跳 /login
 *   3. 调 /api/ai/articles/99999/summary → onError('文章不存在')，
 *      onChunk 一次都不触发（不把 {"code":404} 渲染进对话）
 *   4. 连续 3 轮中文对话 → 无 U+FFFD 乱码（回归流式解码）
 *   5. 全程无未捕获异常 / 无 console.error（401/404 的资源加载日志除外）
 *
 * 前置：后端在 8080；测试账号 13800000002 / 123456（密码登录取 token）。
 * 用法：node scripts/verify-t05-ai-stream-real.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import {
  CDP,
  launchBrowser,
  createReporter,
  sleep,
  waitFor,
  setInput,
  clickByText,
} from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5207
const DEBUG_PORT = 9343
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const { check, summary } = createReporter()

/* ==================== 前置：后端可达 + 密码登录拿 token ==================== */
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
  body: JSON.stringify({ phone: '13800000002', password: '123456' }),
}).then((r) => r.json())
const TOKEN = loginRes?.data?.token
if (!TOKEN) {
  console.log('密码登录失败：', JSON.stringify(loginRes))
  process.exit(1)
}
console.log(`\n后端正常，已用测试账号登录拿到 token（userId=2）`)

/* ==================== Vite（走项目自身 vite.config.ts 的代理 → 8080） ==================== */
const vite = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'error',
})
await vite.listen()

/* ==================== Chrome ==================== */
let browser
let cdp
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT })
  cdp = browser.cdp
  await fs.mkdir(OUT_DIR, { recursive: true })

  const shoot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
  }
  const goto = async (url, wait = 2500) => {
    await cdp.send('Page.navigate', { url })
    await sleep(wait)
  }

  /** 从 CDP 事件里找某个 /api 请求的请求头与响应状态 */
  const findApiCall = (pathPart) => {
    const req = [...cdp.events]
      .reverse()
      .find(
        (e) =>
          e.method === 'Network.requestWillBeSent' && e.params.request.url.includes(pathPart),
      )
    const res = [...cdp.events]
      .reverse()
      .find(
        (e) =>
          e.method === 'Network.responseReceived' && e.params.response.url.includes(pathPart),
      )
    return {
      headers: req?.params?.request?.headers ?? null,
      status: res?.params?.response?.status ?? null,
    }
  }

  /* ==================== 登录态注入 token ==================== */
  await goto(`http://localhost:${PORT}/login`, 1800)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(TOKEN)})`)

  /* ==================== 验收 1：登录态 AI 总结 + token 头 ==================== */
  console.log('\n[1] 登录态打开文章详情，点「AI 总结」')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/articles/14`, 3000)
  const hasAiBtn = await waitFor(cdp, `document.querySelector('.cm-detail__ai-btn')`, 8000)
  check('文章详情渲染出 AI 按钮（登录态可见正文）', hasAiBtn)

  await clickByText(cdp, '.cm-detail__ai-btn', '总结')
  // 等流式结束：「生成中」消失且正文有内容（总结实测 ~6s，给 40s 上限）
  const finished = await (async () => {
    const start = Date.now()
    while (Date.now() - start < 40000) {
      const state = await cdp.evaluate(`(() => {
        const live = !!document.querySelector('.cm-ai-panel__live')
        const body = document.querySelector('.cm-ai-panel__body')?.innerText ?? ''
        return { live, len: body.length }
      })()`)
      if (!state.live && state.len > 30) return state
      await sleep(400)
    }
    return null
  })()
  check('AI 总结流式结束并渲染出正文', !!finished, finished ? '' : '40s 内未等到正文')

  const call = findApiCall('/api/ai/articles/14/summary')
  check('总结接口响应 HTTP 200', call.status === 200, `实际 ${call.status}`)
  check(
    '请求头带 token（后端只认这个头）',
    typeof call.headers?.token === 'string' && call.headers.token.length > 20,
    `实际 headers=${JSON.stringify(call.headers)}`,
  )
  check(
    '请求头同时带 Authorization: Bearer（兼容）',
    typeof call.headers?.Authorization === 'string' &&
      call.headers.Authorization.startsWith('Bearer '),
  )
  const bodyText =
    (await cdp.evaluate(
      `document.querySelector('.cm-ai-panel__body')?.innerText ?? ''`,
    )) ?? ''
  check('正文里没有混入 {"code":...} 原始 JSON', !bodyText.includes('{"code"'))
  await fs.writeFile(
    path.join(OUT_DIR, 't05-1-summary-request-headers.json'),
    JSON.stringify(call, null, 2),
  )
  await shoot('t05-1-ai-summary-success.png')

  /* ==================== 验收 2：未登录 401 分流 ==================== */
  console.log('\n[2] 清掉 localStorage token，再点「AI 总结」')
  await cdp.evaluate(`localStorage.removeItem('codemind_token')`)
  await sleep(300)
  await clickByText(cdp, '.cm-detail__ai-btn', '总结')
  await sleep(2500)
  const guest = await cdp.evaluate(`({
    path: location.pathname,
    token: localStorage.getItem('codemind_token'),
    panelText: document.querySelector('.cm-ai-panel__body')?.innerText ?? '',
  })`)
  /*
   * ⚠️ 断言已更新（2026-09-24）：T11 把「游客 401」的展示从「把 onError 文案
   * 原样摊出来」改成了专门的**「登录后查看」引导态**（`useAiContext` 的 `needLogin`）。
   * 这比一行红字更准确 —— 游客不是「出错」，只是「要先登录」。
   * 所以这里不再断言那句 onError 文案，改断言引导态的关键文案。
   * （下方三条不受影响，仍然是 T0.5 真正要守的东西。）
   */
  check(
    '游客点击后给「登录后查看」引导（不是把错误当红字摊出来）',
    guest.panelText.includes('登录后查看'),
    `面板内容：${guest.panelText.slice(0, 80)}`,
  )
  check('不是「登录状态已失效」', !guest.panelText.includes('登录状态已失效'))
  check('URL 没有跳到 /login', guest.path === '/articles/14', `实际 ${guest.path}`)
  check('没有乱清 token（本来就是 null）', guest.token === null)
  await shoot('t05-2-guest-401.png')

  /* ==================== 验收 3：业务错误 JSON 走 onError ==================== */
  console.log('\n[3] 带 token 调 /api/ai/articles/99999/summary（文章不存在）')
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(TOKEN)})`)
  const errCase = await cdp.evaluate(`(async () => {
    const m = await import('/src/composables/useAiStream.ts')
    const a = await import('/src/utils/auth.ts')
    let err = null
    let chunks = 0
    await m.streamFetch(
      '/ai/articles/99999/summary',
      { method: 'POST', headers: a.buildAuthHeaders() },
      { onChunk: () => { chunks += 1 }, onError: (e) => { err = e } },
    )
    return { err, chunks }
  })()`)
  check('onError 收到「文章不存在」', errCase.err === '文章不存在', `实际 ${JSON.stringify(errCase)}`)
  check('onChunk 一次都没触发（错误 JSON 没进正文）', errCase.chunks === 0)

  /* ==================== 验收 4：3 轮中文对话无乱码 ==================== */
  console.log('\n[4] /ai 页面连续 3 轮中文对话')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/ai`, 3000)
  const hasInput = await waitFor(cdp, `document.querySelector('.cm-ai__input textarea')`, 8000)
  check('AI 聊天页输入框就绪', hasInput)

  const prompts = [
    '用一句中文介绍 Spring Boot',
    '我刚才问了你什么？请用中文复述',
    '再补充一个 Spring Boot 的核心特性，用中文',
  ]
  for (let i = 0; i < prompts.length; i += 1) {
    await setInput(cdp, '.cm-ai__input textarea', prompts[i])
    await sleep(200)
    await clickByText(cdp, '.cm-ai__composer-actions .el-button', '发送')
    // 等本轮流式结束：「停止生成」消失
    const done = await (async () => {
      const start = Date.now()
      while (Date.now() - start < 40000) {
        const streaming = await cdp.evaluate(
          `[...document.querySelectorAll('.cm-ai__composer-actions .el-button')].some(b => b.textContent.includes('停止'))`,
        )
        if (!streaming) return true
        await sleep(400)
      }
      return false
    })()
    check(`第 ${i + 1} 轮流式结束`, done)
    const msgText = await cdp.evaluate(
      `document.querySelector('.cm-ai__messages')?.innerText ?? ''`,
    )
    check(`第 ${i + 1} 轮无乱码（无 U+FFFD）`, !msgText.includes('�'), msgText.slice(0, 60))
    check(`第 ${i + 1} 轮有实际回复内容`, msgText.length > 50, `长度 ${msgText.length}`)
  }
  await shoot('t05-4-ai-chat-3rounds.png')

  /* ==================== 运行时健康度 ==================== */
  console.log('\n[5] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrors = cdp
    .consoleErrors()
    .filter((t) => !/401|404|Failed to load resource/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（401/404 资源日志除外）', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
} finally {
  // 不用 harness 的 shutdown：它的 stubServer?.close 在无桩时会挂起（EXIT=13），
  // 本脚本打真实后端没有桩，这里就地清理。
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
    /* Windows 上目录可能仍被占用 */
  }
}

const fail = summary()
console.log(`截图与抓包证据已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
