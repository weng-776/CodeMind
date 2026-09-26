/**
 * T10 验收：AI 会话与流式聊天（真实后端）
 * ------------------------------------------------------------------
 * 覆盖工单 T10 的 6 条验收：
 *   1. 连续 3 轮中文对话 → 无乱码；贴 5.4 的 Content-Type
 *   2. 新建会话后立刻发消息 → 不出现 404（conversationId 精度没丢）
 *   3. 生成中发送按钮 disabled；结束后恢复可继续发
 *   4. 后端不可用时发消息 → 面板内错误提示，不白屏、不整页崩
 *   5. 已知限制不当 bug 报（列表排序 / prompt 无长度限制）——
 *      ⚠️ 原来还有「会话标题永不更新」「没有删除会话接口」两条，**2026-09-24 已失效**：
 *      后端补上了「流结束后异步生成标题」与 `DELETE /api/ai/DeleteConversation/{id}`。
 *      本脚本只断言「标题非空」；标题会不会自动更新、删除能不能用，
 *      由 `scripts/verify-t14-backend-new.mjs` 验证。
 *   6. Console 0 未捕获异常
 * 另覆盖「做什么」与提醒：
 *   - 5.4 响应体是裸文本（无 data: / 无 [DONE]）
 *   - 错误分支是 HTTP 200 + application/json → 必须按错误对象处理，不能渲染进正文
 *   - conversationId 全程 string（19 位雪花 ID，Number() 会丢精度）
 *   - 「停止生成」真的能中断，且不会把下一轮的状态一起清掉
 *   - prompt 前端限长 2000
 *
 * ⚠️ 数据副作用：本脚本**自己不清理**会话，每跑一次会在测试账号下留下 2~3 个会话。
 *   （后端**现在有**删除能力了 —— `DELETE /api/ai/DeleteConversation/{id}`，
 *   只是本脚本没接；`scripts/verify-t14-backend-new.mjs` 会清理自己造的会话。）
 *
 * 前置：后端 8080；账号 小明 13800000002 / 123456。AI 服务需可用（要真实模型响应）。
 * 用法：node scripts/verify-t10-ai-chat.mjs > t10.log 2>&1   ← 不要接 head/tail
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, setInput } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
/** 端口避开 T6~T9 用的 5217 / 5218 / 5220 / 5221 */
const PORT = 5222
const DEBUG_PORT = 9356
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const MING = { phone: '13800000002', password: '123456', label: '小明(用户2)' }

/** 与 AiChatView 里的 PROMPT_MAX 保持一致 */
const PROMPT_MAX = 2000

/** 连续对话用的问题（全中文，用来验证跨分片多字节字符不被破坏） */
const PROMPTS = [
  '请用一句话说明什么是闭包。',
  '刚才我问了你什么？请复述一遍。',
  '再用一句话说明它和普通函数的区别。',
]

const { check, summary } = createReporter()

/* ==================== 前置 ==================== */
try {
  const status = await fetch(`${BACKEND}/api/article/latest`).then((r) => r.status)
  if (status !== 200) throw new Error(`latest=${status}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端。`)
  process.exit(1)
}

const token = await fetch(`${BACKEND}/api/user/login/password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: MING.phone, password: MING.password }),
})
  .then((r) => r.json())
  .then((r) => r?.data?.token)
if (!token) {
  console.log('密码登录失败')
  process.exit(1)
}
console.log(`登录成功：${MING.label}`)

/* ==================== 前置：AI 服务可用性 ==================== */
const before = await fetch(`${BACKEND}/api/ai/conversations`, { headers: { token } }).then((r) => r.json())
console.log(`\n[准备] 已有会话 ${before?.data?.length ?? 0} 个`)
check('5.2 会话列表可用', before?.code === 200 && Array.isArray(before.data))
if (before?.data?.length) {
  const s = before.data[0]
  console.log(`    样例：id=${s.id}（typeof ${typeof s.id}，${String(s.id).length} 位）｜title=${JSON.stringify(s.title)}`)
  check('会话 id 是 string（雪花 ID，不能当 number）', typeof s.id === 'string')
  /*
   * ⚠️ 断言已更新（2026-09-24）：后端补上了「流结束后异步生成真实标题」，
   * 所以「标题永远是 `新会话NNN`」这个**已知限制不再成立**（用户当日改的后端）。
   *
   * 标题生成是**异步**的（实测流结束后约 1.5~2s 才写库），所以这里既**不能**断言
   * 「一定是占位」、也**不能**断言「一定不是占位」—— 两种都可能出现。
   * 本脚本只负责「字段可用」；「标题会不会自动更新」由
   * `scripts/verify-t14-backend-new.mjs` 专门验证（它做了有上限的轮询）。
   */
  check('会话标题是非空字符串', typeof s.title === 'string' && s.title.length > 0, String(s.title))
}

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
let cdp
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1440,1100' })
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

  const health = { exceptions: [], consoleErrors: [] }
  const reset = () => {
    for (const e of cdp.exceptions()) if (!health.exceptions.includes(e)) health.exceptions.push(e)
    for (const e of cdp.consoleErrors())
      if (!health.consoleErrors.includes(e)) health.consoleErrors.push(e)
    cdp.clearEvents()
  }

  /* ---------- 页面可观测状态 ---------- */
  const snap = () =>
    cdp.evaluate(`(() => {
      const msgs = [...document.querySelectorAll('.cm-msg')]
      const ai = msgs.filter(m => m.classList.contains('cm-msg--ai'))
      const user = msgs.filter(m => m.classList.contains('cm-msg--user'))
      const composerBtns = [...document.querySelectorAll('.cm-ai__composer-actions .el-button')]
      return {
        url: location.pathname + location.search,
        subtitle: document.querySelector('.cm-ai__subtitle')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
        headTitle: document.querySelector('.cm-ai__title')?.textContent?.trim() ?? null,
        convCount: document.querySelectorAll('.cm-ai__conv').length,
        convActive: document.querySelector('.cm-ai__conv.is-active')?.textContent?.trim() ?? null,
        msgCount: msgs.length,
        userCount: user.length,
        aiCount: ai.length,
        aiTexts: ai.map(m => m.querySelector('.cm-msg__body')?.textContent?.trim() ?? ''),
        userTexts: user.map(m => m.querySelector('.cm-msg__text')?.textContent?.trim() ?? ''),
        streaming: ai.some(m => !!m.querySelector('.cm-msg__cursor')) || ai.some(m => !!m.querySelector('.cm-msg__thinking')),
        errors: [...document.querySelectorAll('.cm-msg__error')].map(e => e.textContent.replace(/\\s+/g,' ').trim()),
        hasErrorRow: document.querySelectorAll('.cm-msg__error').length > 0,
        sendBtn: (() => {
          const b = composerBtns.find(x => /发送|生成中/.test(x.textContent))
          return b ? { text: b.textContent.replace(/\\s+/g,'').trim(), disabled: b.disabled } : null
        })(),
        stopBtn: composerBtns.some(x => /停止生成/.test(x.textContent)),
        draft: document.querySelector('.cm-ai__input textarea')?.value ?? null,
        draftMax: document.querySelector('.cm-ai__input textarea')?.getAttribute('maxlength') ?? null,
        counter: document.querySelector('.cm-ai__composer-count')?.textContent?.trim() ?? null,
        alive: !!document.querySelector('.cm-ai') && document.body.textContent.length > 40,
        welcome: !!document.querySelector('.cm-ai__welcome'),
      }
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

  const reqInfo = (requestId) => {
    const ev = cdp.events.find(
      (e) => e.method === 'Network.requestWillBeSent' && e.params.requestId === requestId,
    )
    const res = cdp.events.find(
      (e) => e.method === 'Network.responseReceived' && e.params.requestId === requestId,
    )
    return { request: ev?.params?.request, response: res?.params?.response }
  }

  /** CDP 给的头名是小写的，别只读 'Content-Type' */
  const headerOf = (headers, name) => {
    if (!headers) return undefined
    const want = name.toLowerCase()
    for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k]
    return undefined
  }

  const respText = async (requestId) => {
    if (!requestId) return null
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId })
      return base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
    } catch {
      return null
    }
  }

  const waitFor = async (expression, timeout = 30000, step = 250) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await cdp.evaluate(`!!(${expression})`)) return true
      await sleep(step)
    }
    return false
  }

  /** 等流式开始（输入框进入「生成中」） */
  const waitStreamStart = () =>
    waitFor(`document.querySelector('.cm-ai__subtitle')?.textContent.includes('正在生成')`, 20000)

  /** 等流式结束（不再有光标/思考中，副标题也不再是「正在生成」） */
  const waitStreamEnd = (timeout = 90000) =>
    waitFor(
      `!document.querySelector('.cm-msg__cursor') && !document.querySelector('.cm-msg__thinking')
       && !document.querySelector('.cm-ai__subtitle')?.textContent.includes('正在生成')`,
      timeout,
    )

  const clickComposer = (text) =>
    cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('.cm-ai__composer-actions .el-button')]
        .find(x => x.textContent.replace(/\\s+/g,'').includes(${JSON.stringify(text)}))
      if (!b) return false
      b.click()
      return true
    })()`)

  const send = async (text) => {
    await setInput(cdp, '.cm-ai__input textarea', text)
    await sleep(250)
    const ok = await clickComposer('发送')
    return ok
  }

  const cjkOnly = (s) => (s ?? '').replace(/[^\u4e00-\u9fa5]/g, '')

  /* ==================== 登录进入 /ai ==================== */
  await goto(`http://localhost:${PORT}/login`, 1200)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(token)})`)
  reset()
  await goto(`http://localhost:${PORT}/ai`, 3200)
  const v0 = await snap()
  console.log(`\n[准备] 进入 /ai：会话 ${v0.convCount} 个｜当前会话 ${JSON.stringify(v0.convActive)}｜url=${v0.url}`)
  check('会话侧栏渲染出列表', v0.convCount > 0, String(v0.convCount))
  check('URL 带上当前会话 ?c=<id>', /\?c=\d+/.test(v0.url), v0.url)
  check('输入框有 maxlength（prompt 前端限长）', v0.draftMax === String(PROMPT_MAX), String(v0.draftMax))

  /* ==================== 验收 2：新建会话后立刻发消息 ==================== */
  console.log('\n[验收 2] 新建会话后立刻发消息 → 不出现 404（conversationId 精度没丢）')
  reset()
  const newClicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('.cm-ai__side-head .el-button')]
      .find(x => x.textContent.includes('新建会话'))
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(1800)
  const createdReqId = reqIds('/api/ai/conversations', 'POST').pop()
  const createdResp = JSON.parse((await respText(createdReqId)) ?? 'null')
  const createdId = createdResp?.data?.id
  console.log(`    5.1 响应：${JSON.stringify(createdResp)}`)
  console.log(`    id 类型=${typeof createdId}｜长度=${String(createdId).length}｜Number(id) 是否丢精度=${String(Number(createdId)) !== String(createdId)}`)
  check('点到了「新建会话」', newClicked === true)
  check('5.1 返回 code=200', createdResp?.code === 200, JSON.stringify(createdResp))
  check('5.1 的 id 是 string', typeof createdId === 'string', typeof createdId)
  check(
    'id 超出 JS 安全整数（所以必须按 string 传，Number() 会丢精度）',
    BigInt(createdId) > BigInt(Number.MAX_SAFE_INTEGER) && String(Number(createdId)) !== String(createdId),
    `${createdId} → ${Number(createdId)}`,
  )

  const vNew = await snap()
  console.log(`    新建后 url=${vNew.url}`)
  check('新会话写进了 ?c=<id>（未截断）', vNew.url.includes(`c=${createdId}`), vNew.url)

  // 立刻发消息
  reset()
  const sent1 = await send(PROMPTS[0])
  check('点到了「发送」', sent1 === true)
  await waitStreamStart()
  await waitStreamEnd()
  const chatReqId = reqIds('/api/ai/chat', 'POST').pop()
  const chatInfo = reqInfo(chatReqId)
  const chatBody = (() => {
    try {
      return JSON.parse(
        cdp.events.find(
          (e) => e.method === 'Network.requestWillBeSent' && e.params.requestId === chatReqId,
        )?.params?.request?.postData ?? 'null',
      )
    } catch {
      return null
    }
  })()
  const chatRespBody = await respText(chatReqId)
  const allResp = cdp.events
    .filter((e) => e.method === 'Network.responseReceived')
    .map((e) => ({ url: e.params.response.url, status: e.params.response.status }))
  const chatCtype = headerOf(chatInfo.response?.headers, 'Content-Type') ?? chatInfo.response?.mimeType
  console.log(`    5.4 请求体 conversationId = ${JSON.stringify(chatBody?.conversationId)}`)
  console.log(`    5.4 响应 Content-Type = ${JSON.stringify(chatCtype)}`)
  console.log(`    5.4 响应体长度 = ${chatRespBody?.length ?? 0}`)
  check('5.4 请求体的 conversationId 与新会话 id **完全一致**', chatBody?.conversationId === createdId, JSON.stringify(chatBody?.conversationId))
  check(
    '5.4 请求体里 conversationId 是字符串且长度 19（没被当数字截断）',
    typeof chatBody?.conversationId === 'string' && chatBody.conversationId.length === 19,
    `${typeof chatBody?.conversationId} / ${chatBody?.conversationId?.length}`,
  )
  check('5.4 响应 Content-Type 是 text/html（裸文本流）', /text\/html/.test(String(chatCtype)), String(chatCtype))
  const aiRelated404 = allResp.filter(
    (r) => r.status === 404 && /\/api\/ai\//.test(r.url),
  )
  console.log(`    AI 相关 404 响应：${JSON.stringify(aiRelated404)}`)
  check('**没有出现 404**（会话 ID 精度没丢）', aiRelated404.length === 0, JSON.stringify(aiRelated404))

  /* ==================== 验收 1：连续 3 轮中文，无乱码 ==================== */
  console.log('\n[验收 1] 连续 3 轮中文对话 → 确认无乱码')
  const roundResults = []
  // 第 1 轮已经在验收 2 里发过了，这里补齐后两轮
  for (let i = 1; i < PROMPTS.length; i += 1) {
    reset()
    const ok = await send(PROMPTS[i])
    check(`第 ${i + 1} 轮点到了「发送」`, ok === true)
    const started = await waitStreamStart()
    const ended = await waitStreamEnd()
    const rid = reqIds('/api/ai/chat', 'POST').pop()
    const raw = await respText(rid)
    const view = await snap()
    const rendered = view.aiTexts[view.aiTexts.length - 1] ?? ''
    roundResults.push({ round: i + 1, started, ended, raw: raw ?? '', rendered })
    console.log(
      `    第 ${i + 1} 轮：开始=${started} 结束=${ended}｜原始 ${raw?.length ?? 0} 字｜渲染 ${rendered.length} 字`,
    )
    console.log(`      原始前 40 字：${JSON.stringify((raw ?? '').slice(0, 40))}`)
  }

  const v3 = await snap()
  console.log(`    共 ${v3.userCount} 条用户消息 / ${v3.aiCount} 条 AI 消息`)
  check('3 轮用户消息都在', v3.userCount === 3, String(v3.userCount))
  check('3 条 AI 回答都在', v3.aiCount === 3, String(v3.aiCount))

  const allRendered = v3.aiTexts.join('')
  console.log(`    U+FFFD 乱码字符数（渲染后）：${(allRendered.match(/\uFFFD/g) ?? []).length}`)
  check('渲染后的回答里没有 U+FFFD 乱码', !allRendered.includes('\uFFFD'))
  const rawJoined = roundResults.map((r) => r.raw).join('')
  console.log(`    U+FFFD 乱码字符数（原始流）：${(rawJoined.match(/\uFFFD/g) ?? []).length}`)
  check('原始流里也没有 U+FFFD 乱码', !rawJoined.includes('\uFFFD'))

  // 逐轮比对「原始流的中文」是否原样出现在渲染结果里 —— 有乱码就比对不上
  for (const r of roundResults) {
    const rawCjk = cjkOnly(r.raw)
    const renderedCjk = cjkOnly(r.rendered)
    const probe = rawCjk.slice(0, 40)
    console.log(`    第 ${r.round} 轮中文比对：原始 ${rawCjk.length} 字 → 取前 ${probe.length} 字`)
    check(
      `第 ${r.round} 轮：原始流的中文原样出现在渲染结果里（证明没乱码）`,
      probe.length >= 8 && renderedCjk.includes(probe),
      `probe=${JSON.stringify(probe.slice(0, 20))}`,
    )
  }
  await shoot('t10-1-three-rounds.png')

  /* ==================== 验收 3：生成中按钮 disabled + 结束后恢复 ==================== */
  console.log('\n[验收 3] 生成中发送按钮 disabled（扣住 5.4 请求截图）；结束后恢复')
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/ai/chat*', requestStage: 'Request' }],
  })
  reset()
  await send('请解释一下 HTTP 和 HTTPS 的区别。')
  await sleep(1200)
  const holding = await snap()
  console.log(`    扣住请求时：副标题=${JSON.stringify(holding.subtitle)}`)
  console.log(`    发送按钮：${JSON.stringify(holding.sendBtn)}｜停止按钮=${holding.stopBtn}`)
  check('副标题显示「正在生成…」', /正在生成/.test(holding.subtitle ?? ''), String(holding.subtitle))
  check('发送按钮文字变成「生成中…」', /生成中/.test(holding.sendBtn?.text ?? ''), JSON.stringify(holding.sendBtn))
  check('**发送按钮 disabled**', holding.sendBtn?.disabled === true, JSON.stringify(holding.sendBtn))
  check('同时提供「停止生成」按钮', holding.stopBtn === true)
  check('AI 气泡显示「正在思考」占位', holding.streaming === true)
  await shoot('t10-3-generating.png')

  // 放行，等它生成完
  const held = cdp.events.filter((e) => e.method === 'Fetch.requestPaused').map((e) => e.params.requestId)
  console.log(`    放行 ${held.length} 个被扣住的 5.4 请求`)
  for (const rid of held) {
    await cdp.send('Fetch.continueRequest', { requestId: rid }).catch(() => {})
  }
  await cdp.send('Fetch.disable')
  await waitStreamEnd()
  // 发送按钮在「草稿为空」时本来就是禁用的，所以要先把字打进去再看它能不能点
  await setInput(cdp, '.cm-ai__input textarea', '随便打点字')
  await sleep(300)
  const afterStream = await snap()
  console.log(`    结束后：副标题=${JSON.stringify(afterStream.subtitle)}｜发送按钮=${JSON.stringify(afterStream.sendBtn)}`)
  check('结束后发送按钮恢复可用（有草稿时可点）', afterStream.sendBtn?.disabled === false && afterStream.sendBtn?.text === '发送', JSON.stringify(afterStream.sendBtn))
  check('「停止生成」按钮消失', afterStream.stopBtn === false)
  check('副标题回到「对话进行中…」', /对话进行中/.test(afterStream.subtitle ?? ''), String(afterStream.subtitle))

  // 结束后确实还能继续发
  reset()
  await send('谢谢，请用一句话总结上面的内容。')
  const restarted = await waitStreamStart()
  const restartedEnd = await waitStreamEnd()
  const afterRestart = await snap()
  console.log(`    再发一条：开始=${restarted} 结束=${restartedEnd}｜AI 消息 ${afterRestart.aiCount} 条`)
  check('结束后可以继续发（第 5 条 AI 回答已生成）', restarted && restartedEnd && afterRestart.aiCount === 5, String(afterRestart.aiCount))
  await shoot('t10-2-after-resume.png')

  /* ==================== 附加：停止生成 ==================== */
  console.log('\n[附加] 点「停止生成」能真的中断，且不会污染下一轮状态')
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/ai/chat*', requestStage: 'Request' }],
  })
  reset()
  await send('请写一篇 800 字的文章介绍数据库索引。')
  await sleep(1200)
  const beforeStop = await snap()
  const stopped = await clickComposer('停止生成')
  await sleep(1200)
  await setInput(cdp, '.cm-ai__input textarea', '停完再打点字')
  await sleep(300)
  const afterStop = await snap()
  console.log(`    停止前：生成中=${beforeStop.streaming}｜停止后：生成中=${afterStop.streaming}｜发送按钮=${JSON.stringify(afterStop.sendBtn)}`)
  check('点到了「停止生成」', stopped === true)
  check('停止后不再处于生成中', afterStop.streaming === false)
  check('停止后发送按钮恢复可用', afterStop.sendBtn?.disabled === false, JSON.stringify(afterStop.sendBtn))
  check('被中断的 AI 气泡有收尾文案', /已停止生成/.test(afterStop.aiTexts.join(' ')), JSON.stringify(afterStop.aiTexts.slice(-1)))
  // 清掉被扣住的请求，避免影响后续
  for (const rid of cdp.events.filter((e) => e.method === 'Fetch.requestPaused').map((e) => e.params.requestId)) {
    await cdp.send('Fetch.failRequest', { requestId: rid, errorReason: 'Aborted' }).catch(() => {})
  }
  await cdp.send('Fetch.disable')
  await sleep(600)
  await shoot('t10-4-stopped.png')

  /* ==================== 验收 4：后端不可用 → 面板内错误 ==================== */
  console.log('\n[验收 4] 后端不可用时发消息 → 面板内错误提示，不白屏、不整页崩')
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/ai/chat*', requestStage: 'Request' }],
  })
  reset()
  await send('后端挂掉时这条会失败。')
  await sleep(1200)
  for (const rid of cdp.events.filter((e) => e.method === 'Fetch.requestPaused').map((e) => e.params.requestId)) {
    await cdp.send('Fetch.failRequest', { requestId: rid, errorReason: 'Failed' }).catch(() => {})
  }
  await cdp.send('Fetch.disable')
  await sleep(2000)
  await setInput(cdp, '.cm-ai__input textarea', '失败后打点字')
  await sleep(300)
  const failed = await snap()
  console.log(`    错误行：${JSON.stringify(failed.errors)}`)
  console.log(`    最后一条 AI 气泡：${JSON.stringify((failed.aiTexts[failed.aiTexts.length - 1] ?? '').slice(0, 60))}`)
  console.log(`    页面仍存活=${failed.alive}｜发送按钮=${JSON.stringify(failed.sendBtn)}`)
  check('气泡内出现错误提示（不是白屏）', failed.hasErrorRow === true, JSON.stringify(failed.errors))
  check('错误行给出「重试」入口', failed.errors.some((t) => /重试/.test(t)), JSON.stringify(failed.errors))
  check(
    '失败原因写在气泡里（网络异常）',
    /网络异常|无法连接/.test(failed.aiTexts[failed.aiTexts.length - 1] ?? ''),
    String(failed.aiTexts[failed.aiTexts.length - 1]),
  )
  check('整页没有崩（对话区与输入框都还在）', failed.alive === true)
  check('失败后发送按钮恢复可用（可以重试）', failed.sendBtn?.disabled === false, JSON.stringify(failed.sendBtn))
  await shoot('t10-5-backend-down.png')

  /* ==================== 附加：错误响应是 JSON → 不能渲染进正文 ==================== */
  console.log('\n[附加] 5.4 返回 application/json 错误 → 按错误处理，不把 JSON 渲染成 AI 正文')
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/ai/chat*', requestStage: 'Request' }],
  })
  reset()
  await send('这条会收到一个 JSON 错误。')
  await sleep(1200)
  for (const rid of cdp.events.filter((e) => e.method === 'Fetch.requestPaused').map((e) => e.params.requestId)) {
    await cdp.send('Fetch.fulfillRequest', {
      requestId: rid,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json;charset=UTF-8' }],
      body: Buffer.from(
        JSON.stringify({ code: 404, message: '会话不存在', data: null }),
      ).toString('base64'),
    }).catch(() => {})
  }
  await cdp.send('Fetch.disable')
  await sleep(2000)
  const jsonErr = await snap()
  const lastAi = jsonErr.aiTexts[jsonErr.aiTexts.length - 1] ?? ''
  console.log(`    最后一条 AI 气泡：${JSON.stringify(lastAi.slice(0, 80))}`)
  console.log(`    错误行：${JSON.stringify(jsonErr.errors)}`)
  check('把后端 message 当成错误提示展示', /会话不存在/.test(lastAi), JSON.stringify(lastAi.slice(0, 60)))
  check('**没有把 JSON 原文渲染进 AI 正文**', !/\{"code"/.test(lastAi) && !/data.*null/.test(lastAi), JSON.stringify(lastAi.slice(0, 60)))
  check('走的是错误态（有重试入口）', jsonErr.hasErrorRow === true)

  /* ==================== 附加：URL 恢复 + 会话切换 ==================== */
  console.log('\n[附加] 刷新后按 ?c=<id> 恢复同一会话')
  const currentUrl = (await snap()).url
  await goto(`http://localhost:${PORT}${currentUrl}`, 3200)
  const restored = await snap()
  console.log(`    刷新前后 url：${currentUrl} → ${restored.url}｜消息 ${restored.msgCount} 条`)
  check('刷新后 URL 不变', restored.url === currentUrl, restored.url)
  check('刷新后历史消息已恢复（>0 条）', restored.msgCount > 0, String(restored.msgCount))
  check('刷新后仍在同一会话（侧栏高亮一致）', !!restored.convActive, String(restored.convActive))
  await shoot('t10-6-reload-restored.png')

  /* ==================== 验收 5：已知限制（不当 bug） ==================== */
  console.log('\n[验收 5] 已知限制：标题 / 排序 / 无删除接口 / prompt 限长')
  const convList = (await fetch(`${BACKEND}/api/ai/conversations`, { headers: { token } }).then((r) => r.json()))
    ?.data ?? []
  const titles = convList.map((c) => c.title)
  const idAsc = convList.every(
    (c, i) => i === 0 || BigInt(convList[i - 1].id) < BigInt(c.id),
  )
  console.log(`    会话 ${convList.length} 个｜标题样例 ${JSON.stringify(titles.slice(0, 4))}`)
  // ⚠️ 同上的过时断言更新：标题现在会被后端异步生成，「所有标题都是占位」不再成立。
  check('每个会话都有非空标题', titles.every((t) => typeof t === 'string' && t.length > 0), JSON.stringify(titles.slice(0, 3)))
  check('5.2 按 id 升序返回（已知限制，前端不擅自改序）', idAsc === true)
  const deleteAttempt = await fetch(`${BACKEND}/api/ai/conversations/${convList[0]?.id}`, {
    method: 'DELETE',
    headers: { token },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  console.log(
    `    DELETE /api/ai/conversations/{id} → HTTP ${deleteAttempt.status}，业务 code=${deleteAttempt.body?.code}（${deleteAttempt.body?.message}）`,
  )
  /*
   * ⚠️ 本条的**标题意图已过时**（2026-09-24）：后端已新增
   * `DELETE /api/ai/DeleteConversation/{id}`（**大写 D**），会话现在**可以删**了，
   * 「没有删除会话的接口」不再成立。
   *
   * 这里保留的是另一个**仍然成立且有用**的事实：**旧路径** `/api/ai/conversations/{id}`
   * 依然不存在（业务 code=404）—— 正好证明这条路径不按 REST 惯例写，前端别猜。
   * 真正的删除能力由 `scripts/verify-t14-backend-new.mjs` 验证。
   */
  check(
    '旧路径 DELETE /api/ai/conversations/{id} 不存在（新路径是 DeleteConversation，大写 D）',
    deleteAttempt.body?.code === 404,
    JSON.stringify(deleteAttempt),
  )
  const stillThere = (await fetch(`${BACKEND}/api/ai/conversations`, { headers: { token } })
    .then((r) => r.json())
    .then((r) => r.data)) ?? []
  check('调用后会话确实没被删掉', stillThere.length === convList.length, `${convList.length} → ${stillThere.length}`)

  /*
   * prompt 限长：用 CDP 的 Input.insertText 模拟**真实键盘输入**。
   * 不能直接用原生 setter 赋值 —— 那是程序化改 value，浏览器不会施加 maxlength，
   * 会得到「限长失效」的假结论（第一次跑就踩了这个坑）。
   */
  await cdp.evaluate(`document.querySelector('.cm-ai__input textarea')?.focus()`)
  await cdp.send('Input.insertText', { text: 'x'.repeat(PROMPT_MAX + 500) })
  await sleep(600)
  const limited = await snap()
  console.log(`    模拟输入 ${PROMPT_MAX + 500} 字后，输入框实际 ${limited.draft?.length} 字｜计数=${JSON.stringify(limited.counter)}`)
  check('prompt 被前端截到 2000 字（接口本身无限制）', limited.draft?.length === PROMPT_MAX, String(limited.draft?.length))
  check('计数器显示 2000 / 2000', limited.counter === `${PROMPT_MAX} / ${PROMPT_MAX}`, String(limited.counter))
  await shoot('t10-7-prompt-limit.png')
  await setInput(cdp, '.cm-ai__input textarea', '')
  await sleep(300)

  /* ==================== 验收 6：控制台健康度 ==================== */
  console.log('\n[验收 6] 控制台（全程归档）')
  reset()
  const consoleErrs = health.consoleErrors.filter(
    (t) => !/Failed to load resource|ERR_|net::|ERR_FAILED|ERR_ABORTED/i.test(t),
  )
  console.log(`    未捕获异常 ${health.exceptions.length} 条｜console.error ${consoleErrs.length} 条`)
  check('0 未捕获异常', health.exceptions.length === 0, health.exceptions.slice(0, 2).join(' | '))
  check('0 console.error（网络失败日志除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  console.log('\n[清理] 会话没有删除接口（已知限制），本次新增的会话会留在测试账号下')
  const after = await fetch(`${BACKEND}/api/ai/conversations`, { headers: { token } })
    .then((r) => r.json())
    .catch(() => null)
  console.log(`[清理] 当前会话数：${after?.data?.length ?? '?'}（会话与消息都无法清理）`)

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
