/**
 * T19 验收：管理端 · 死信队列（真实后端 + 真实 RabbitMQ + 真实 Chrome）
 * ------------------------------------------------------------------
 * 覆盖工单 T19 的验收项（`管理端前端设计说明.md` §6）：
 *   0. 后端契约核验：6 个队列、白名单 400、空队列 replay 200·data=0、鉴权 401/403
 *   1. **未登录**访问 /admin/mq → 跳 `/login?redirect=…`
 *   2. 管理员登录 → **6 张队列卡片**（积压数 / 消费者数 / 完整队列名）
 *   3. 展开看消息：**合法 JSON 被格式化**、**非 JSON 原样显示且有「非 JSON」标记**、页面不崩
 *   4. 清空：**二次确认**，文案如实说明后果；点取消 → 不发请求；点确认 → 积压归零
 *   5. 重投：**二次确认**，文案如实说明后果；点取消 → 不发请求；
 *      点确认 → **重新拉一次队列列表**（不按 message 文本分支）→ 积压归零
 *   6. **非管理员** → 明确「无管理员权限」
 *   7. 所有 `/api/admin/*` 请求头都是 `token`
 *   8. 控制台 0 未捕获异常、0 console.error
 *
 * ⚠️ 死信消息怎么造（**后端设计说明 §7.5 指定的自测手法**）：
 *    用 RabbitMQ 管理端 HTTP API 往**死信交换机** `codemind.dlx` 发一条消息（rk=cache），
 *    它会直接落进 `codemind.cache.queue.dead`。管理端接口 `AdminMqServiceImpl` 的注释里
 *    也明确写了「手工往死信队列里灌的消息（比如自测时）是没有 x-death 的，靠静态表兜底」——
 *    所以这条路径是后端作者留的正规自测入口。
 *
 *    为什么不用「发垃圾消息到 codemind.exchange 让消费者失败」来造？
 *    那条路 3 次重试 + 死信要等好几秒，且重投后**又会失败回到死信**，
 *    没法验「重投后积压归零」。灌**合法**载荷进死信再重投，才能跑出归零闭环。
 *
 * ⚠️ 本脚本会**先清空 cache 死信队列再灌**，`finally` 里再清空一次。
 *    跑完 6 个死信队列必须全 0（与后端交接时的终态一致）。
 *
 * 前置：后端 8080 在跑；RabbitMQ 192.168.238.186 的 15672 管理端可达（guest/123456）。
 * 用法（package.json 在禁止清单里，用绝对路径跑）：
 *   "/c/Users/翁甲燃/.workbuddy/binaries/node/versions/22.22.2-3/node" scripts/verify-t19-admin.mjs
 */
import fs from 'node:fs/promises'
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
const MQ_MGMT = process.env.MQ_MGMT || 'http://192.168.238.186:15672'
const MQ_AUTH = process.env.MQ_AUTH || 'guest:123456'
/** 端口与既有脚本错开（… T18=5229/9363） */
const PORT = 5230
const DEBUG_PORT = 9364
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const ADMIN = { phone: '13800000002', password: '123456', name: '小明' }
const NORMAL = { phone: '13800000003', password: '123456', name: '小红' }

/** 死信交换机 + 目标队列（cache 链路：codemind.dlx --rk=cache--> codemind.cache.queue.dead） */
const DLX = 'codemind.dlx'
const DLX_ROUTING_KEY = 'cache'
const DEAD_QUEUE = 'codemind.cache.queue.dead'

/** 合法载荷：消费端 `CountConsumer.cacheMessages` 只删一个 Redis key，能正常消费 → 重投后积压归零 */
const VALID_PAYLOAD = JSON.stringify({ articleId: 8, messageId: `T19-valid-${Date.now()}` })
/** 非 JSON 载荷：专门验「parse 失败要原样显示、不能抛异常」 */
const BROKEN_PAYLOAD = '这不是 JSON，只是一段裸文本 { broken'

const { check, summary } = createReporter()

/* ==================== 前置：后端 + RabbitMQ 管理端 ==================== */
try {
  const status = await fetch(`${BACKEND}/api/article/latest`).then((r) => r.status)
  if (status !== 200) throw new Error(`latest=${status}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端。`)
  process.exit(1)
}

const MQ_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Basic ${Buffer.from(MQ_AUTH).toString('base64')}`,
}

async function mqWhoami() {
  const res = await fetch(`${MQ_MGMT}/api/whoami`, { headers: MQ_HEADERS })
  if (!res.ok) throw new Error(`whoami=${res.status}`)
  return res.json()
}

try {
  const who = await mqWhoami()
  console.log(`\nRabbitMQ 管理端可达：${who.name}（${(who.tags ?? []).join(',')}）`)
} catch (e) {
  console.log(`\nRabbitMQ 管理端 ${MQ_MGMT} 不可达：${e.message}`)
  console.log('死信消息需要靠它灌入，请确认管理插件可用。')
  process.exit(1)
}

/** 往死信交换机发一条消息 → 直接落进 DEAD_QUEUE */
async function publishToDeadQueue(payload) {
  const res = await fetch(`${MQ_MGMT}/api/exchanges/%2F/${DLX}/publish`, {
    method: 'POST',
    headers: MQ_HEADERS,
    body: JSON.stringify({
      properties: { content_type: 'application/json' },
      routing_key: DLX_ROUTING_KEY,
      payload,
      payload_encoding: 'string',
    }),
  })
  return res.json()
}

async function apiLogin(phone, password) {
  const res = await fetch(`${BACKEND}/api/user/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  }).then((r) => r.json())
  return res?.data?.token ?? null
}

const adminToken = await apiLogin(ADMIN.phone, ADMIN.password)
const normalToken = await apiLogin(NORMAL.phone, NORMAL.password)
const adminHeaders = { token: adminToken }

const adminGet = (p) => fetch(`${BACKEND}${p}`, { headers: adminHeaders }).then((r) => r.json())
const getQueues = () => adminGet('/api/admin/mq/queues')
const getMessages = (q) => adminGet(`/api/admin/mq/queues/${q}/messages`)
const clearQueue = (q) =>
  fetch(`${BACKEND}/api/admin/mq/queues/${q}/messages`, {
    method: 'DELETE',
    headers: adminHeaders,
  }).then((r) => r.json())

/**
 * 清空全部死信队列（兜底还原）。
 *
 * ⚠️ 返回值是**每个队列的清理结果**，由调用方（`finally`）纳入 `check()` ——
 * 核验方 §12.4：T17/T18/T19 连续三单的清理段都只有 `console.log`。
 * 本单尤其要紧：往**死信队列**里灌了消息，清理失败会留下真实积压
 * （直接影响线上排查口径），却照样报全绿。
 */
async function clearAllDeadQueues() {
  const results = []
  const list = (await getQueues())?.data ?? []
  for (const q of list) {
    if ((q.messageCount ?? 0) === 0) continue
    const r = await clearQueue(q.queueName)
    console.log(`    ↩ 清理 ${q.queueName}（${q.messageCount} 条）→ code=${r?.code}`)
    results.push({ queue: q.queueName, code: r?.code ?? null })
  }
  return results
}

/** 6 个死信队列的总积压（终态核对用） */
async function totalBacklog() {
  const list = (await getQueues())?.data ?? []
  return list.reduce((sum, q) => sum + (q.messageCount ?? 0), 0)
}

/* ==================== [0] 后端契约核验 ==================== */
console.log('\n[0] 后端契约核验（直接打后端，不经过页面）')
check('管理员可密码登录', typeof adminToken === 'string' && adminToken.length > 20)
check('普通用户可密码登录', typeof normalToken === 'string' && normalToken.length > 20)

const queuesRes = await getQueues()
const queueList = queuesRes?.data ?? []
console.log(`    队列数：${queueList.length}`)
queueList.forEach((q) => console.log(`      ${q.queueName}  积压=${q.messageCount} 消费者=${q.consumerCount}`))
check('死信队列固定 6 条', queueList.length === 6, String(queueList.length))
check(
  '每条都有 queueName / messageCount / consumerCount',
  queueList.every((q) => 'queueName' in q && 'messageCount' in q && 'consumerCount' in q),
)
check('队列名带点号（原样返回，不截断）', queueList.every((q) => q.queueName.includes('.')))
check('包含 cache 死信队列', queueList.some((q) => q.queueName === DEAD_QUEUE))

// 白名单：三个接口都要 400
const badGet = await getMessages('foo.bar')
const badDel = await fetch(`${BACKEND}/api/admin/mq/queues/foo.bar/messages`, {
  method: 'DELETE',
  headers: adminHeaders,
}).then((r) => r.json())
const badReplay = await fetch(`${BACKEND}/api/admin/mq/queues/foo.bar/replay`, {
  method: 'POST',
  headers: adminHeaders,
}).then((r) => r.json())
console.log(`    非白名单队列：GET code=${badGet?.code} / DELETE code=${badDel?.code} / replay code=${badReplay?.code}`)
check('GET 非白名单队列 → 业务 code 400', badGet?.code === 400, JSON.stringify(badGet))
check('DELETE 非白名单队列 → 业务 code 400', badDel?.code === 400, JSON.stringify(badDel))
check('replay 非白名单队列 → 业务 code 400', badReplay?.code === 400, JSON.stringify(badReplay))

// 鉴权
const noToken = await fetch(`${BACKEND}/api/admin/mq/queues`)
check('无 token → HTTP 401', noToken.status === 401, String(noToken.status))
const normalRes = await fetch(`${BACKEND}/api/admin/mq/queues`, { headers: { token: normalToken } })
const normalBody = await normalRes.json()
console.log(`    非管理员 → HTTP ${normalRes.status}，code=${normalBody?.code}`)
check('非管理员 → HTTP 403 + 业务 code 403', normalRes.status === 403 && normalBody?.code === 403, `${normalRes.status}/${normalBody?.code}`)

/*
 * 空队列重投的语义确认。
 * ⚠️ 必须**先清空**再验：死信队列里可能有历史残留（别的自测灌进去的），
 *    不清就直接 replay，拿到的是「已重投 N 条」而不是「队列已空，无需重投」。
 */
await clearQueue(DEAD_QUEUE)
await sleep(500)
const emptyReplay = await fetch(`${BACKEND}/api/admin/mq/queues/${DEAD_QUEUE}/replay`, {
  method: 'POST',
  headers: adminHeaders,
}).then((r) => r.json())
console.log(`    空队列 replay → code=${emptyReplay?.code} data=${emptyReplay?.data}「${emptyReplay?.message}」`)
check('空队列 replay → 200 且 data=0', emptyReplay?.code === 200 && emptyReplay?.data === 0, JSON.stringify(emptyReplay))

/* ==================== [0.5] 造死信消息 ==================== */
console.log('\n[0.5] 造死信消息（灌进 DLX → 落进 cache 死信队列）')

const pub1 = await publishToDeadQueue(VALID_PAYLOAD)
const pub2 = await publishToDeadQueue(BROKEN_PAYLOAD)
console.log(`    灌入结果：${JSON.stringify(pub1)} / ${JSON.stringify(pub2)}`)
check('两条消息都路由成功（routed=true）', pub1?.routed === true && pub2?.routed === true, `${JSON.stringify(pub1)}/${JSON.stringify(pub2)}`)
await sleep(600)

const seededQueues = await getQueues()
const seededCache = (seededQueues?.data ?? []).find((q) => q.queueName === DEAD_QUEUE)
console.log(`    死信积压：${seededCache?.messageCount}`)
check('死信队列积压 2 条', seededCache?.messageCount === 2, String(seededCache?.messageCount))

const seededMessages = (await getMessages(DEAD_QUEUE))?.data ?? []
console.log(`    消息原文：${JSON.stringify(seededMessages)}`)
check('接口能读到 2 条消息原文', seededMessages.length === 2, String(seededMessages.length))
check('消息里含合法 JSON', seededMessages.includes(VALID_PAYLOAD), JSON.stringify(seededMessages))
check('消息里含非 JSON 文本', seededMessages.includes(BROKEN_PAYLOAD), JSON.stringify(seededMessages))

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

  /** 读 6 张队列卡片 */
  const readCards = () =>
    cdp.evaluate(`(() => {
      return [...document.querySelectorAll('.cm-mq-card')].map((card) => ({
        name: card.querySelector('.cm-mq-card__name')?.textContent?.trim() ?? '',
        label: card.querySelector('.cm-mq-card__label')?.textContent?.trim() ?? '',
        backlog: card.querySelector('[data-backlog]')?.textContent?.trim() ?? '',
        consumers: card.querySelector('[data-consumers]')?.textContent?.trim() ?? '',
        expanded: Boolean(card.querySelector('.cm-mq-card__messages')),
        buttons: [...card.querySelectorAll('.cm-mq-card__actions button')].map((b) => ({
          text: b.textContent.replace(/\\s+/g, ''),
          disabled: b.disabled === true,
        })),
      }))
    })()`)

  /** 读展开出来的消息 */
  const readMessages = () =>
    cdp.evaluate(`(() => {
      return [...document.querySelectorAll('.cm-mq-message')].map((li) => ({
        index: li.querySelector('.cm-mq-message__index')?.textContent?.trim() ?? '',
        badge: li.querySelector('.cm-badge')?.textContent?.trim() ?? '',
        body: li.querySelector('.cm-mq-message__body')?.textContent ?? '',
      }))
    })()`)

  /** 点某张卡片的按钮 */
  const clickCardButton = (queueName, btnText) =>
    cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.cm-mq-card')]
      const card = cards.find((c) => (c.querySelector('.cm-mq-card__name')?.textContent?.trim() ?? '') === ${JSON.stringify(queueName)})
      if (!card) return false
      const btn = [...card.querySelectorAll('.cm-mq-card__actions button')].find((b) => b.textContent.replace(/\\s+/g, '') === ${JSON.stringify(btnText)})
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()`)

  /**
   * 读**当前可见**的确认弹窗。
   * ⚠️ 不能直接 querySelector：关掉的弹窗可能仍留在 DOM，会读到**上一个**弹窗的文案。
   */
  const dialogInfo = () =>
    cdp.evaluate(`(() => {
      const boxes = [...document.querySelectorAll('.el-message-box')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      const box = boxes[boxes.length - 1]
      if (!box) return { visible: false, text: '' }
      return {
        visible: true,
        text: (box.querySelector('.el-message-box__message')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      }
    })()`)

  /** 管理端写请求（PUT/DELETE/POST） */
  const writeRequests = () =>
    cdp.events.filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        e.params.request.url.includes('/api/admin/mq/') &&
        ['PUT', 'DELETE', 'POST'].includes(e.params.request.method),
    )
  /** 队列列表请求（用来证明「重投后重新拉了一次队列列表」） */
  const queueListRequests = () =>
    cdp.events.filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        e.params.request.url.endsWith('/api/admin/mq/queues'),
    )

  const backlogOf = async (queueName) => {
    const cards = await readCards()
    return cards.find((c) => c.name === queueName)?.backlog
  }

  /* ==================== [1] 未登录 ==================== */
  console.log('\n[1] 未登录访问 /admin/mq')
  await goto(`http://localhost:${PORT}/`, 1600)
  await clearToken()
  await goto(`http://localhost:${PORT}/admin/mq`, 2800)
  const anonUrl = await urlOf()
  console.log(`    地址：${anonUrl}`)
  check('被送到 /login', anonUrl.startsWith('/login'), anonUrl)
  check('redirect 保留了 /admin/mq', decodeURIComponent(anonUrl).includes('redirect=/admin/mq'), anonUrl)

  /* ==================== [2] 管理员登录 → 6 张卡片 ==================== */
  console.log('\n[2] 管理员登录 → 队列卡片')
  await loginViaUi(ADMIN, '/admin/mq')
  const listUrl = await urlOf()
  console.log(`    地址：${listUrl}`)
  check('登录后落到 /admin/mq', listUrl.startsWith('/admin/mq'), listUrl)

  const cards = await readCards()
  console.log(`    卡片数：${cards.length}`)
  cards.forEach((c) => console.log(`      ${c.label}｜${c.name}｜积压=${c.backlog}｜消费者=${c.consumers}`))
  check('渲染出 6 张队列卡片', cards.length === 6, String(cards.length))
  check('卡片带中文短标签', cards.every((c) => c.label.length > 0))
  check('卡片显示完整队列名（含点号）', cards.every((c) => c.name.includes('.')), JSON.stringify(cards.map((c) => c.name)))
  check('卡片有积压数', cards.every((c) => /^\d+$/.test(c.backlog)), JSON.stringify(cards.map((c) => c.backlog)))
  check('卡片有消费者数', cards.every((c) => /^\d+$/.test(c.consumers)), JSON.stringify(cards.map((c) => c.consumers)))
  check('cache 队列显示积压 2', cards.find((c) => c.name === DEAD_QUEUE)?.backlog === '2', String(cards.find((c) => c.name === DEAD_QUEUE)?.backlog))
  check('每张卡片有 查看消息/重投/清空 三个按钮', cards.every((c) => c.buttons.length === 3 && c.buttons.some((b) => b.text === '清空') && c.buttons.some((b) => b.text === '重投')))
  await shoot('t19-1-queue-cards.png')

  /* ==================== [3] 展开看消息 ==================== */
  console.log('\n[3] 展开看消息（JSON 格式化 + 非 JSON 降级）')
  const expandClicked = await clickCardButton(DEAD_QUEUE, '查看消息')
  await sleep(1400)
  const expandUrl = await urlOf()
  const msgs = await readMessages()
  console.log(`    展开后 URL：${expandUrl}`)
  console.log(`    消息条数：${msgs.length}`)
  msgs.forEach((m) => console.log(`      ${m.index} [${m.badge}] ${JSON.stringify(m.body.slice(0, 70))}`))
  check('点「查看消息」展开成功', expandClicked === true)
  check('展开态写进了 URL（?queue=）', decodeURIComponent(expandUrl).includes(`queue=${DEAD_QUEUE}`), expandUrl)
  check('展开出 2 条消息', msgs.length === 2, String(msgs.length))

  const jsonMsg = msgs.find((m) => m.badge === 'JSON')
  const brokenMsg = msgs.find((m) => m.badge === '非 JSON')
  check('合法 JSON 被标为「JSON」', Boolean(jsonMsg), JSON.stringify(msgs.map((m) => m.badge)))
  check('非 JSON 被标为「非 JSON」', Boolean(brokenMsg), JSON.stringify(msgs.map((m) => m.badge)))
  check(
    '合法 JSON 被格式化（多行缩进，含 articleId）',
    (jsonMsg?.body ?? '').includes('"articleId"') && (jsonMsg?.body ?? '').includes('\n'),
    JSON.stringify(jsonMsg?.body),
  )
  check('非 JSON **原样显示**（内容一字不改）', brokenMsg?.body === BROKEN_PAYLOAD, JSON.stringify(brokenMsg?.body))

  const pageText = await bodyText()
  check('页面没有崩（正文还在，含「死信队列」标题）', pageText.includes('死信队列') && pageText.length > 100, String(pageText.length))
  await shoot('t19-2-messages-expanded.png')

  /* ==================== [4] 清空（二次确认） ==================== */
  console.log('\n[4] 清空队列（二次确认）')
  cdp.clearEvents()
  const clearClicked = await clickCardButton(DEAD_QUEUE, '清空')
  await sleep(800)
  const clearDialog = await dialogInfo()
  console.log(`    清空确认文案：${clearDialog.text}`)
  check('点清空弹出了二次确认', clearClicked === true && clearDialog.visible === true, clearDialog.text)
  check('文案如实说明后果（永久删除 N 条、不可恢复）', clearDialog.text.includes('将永久删除该队列里的 2 条消息，且不可恢复。'), clearDialog.text)
  await shoot('t19-3-clear-confirm.png')

  // 取消 → 不发请求、积压不变
  await cancelMessageBox(cdp)
  await sleep(1200)
  console.log(`    取消后写请求数=${writeRequests().length}，积压=${await backlogOf(DEAD_QUEUE)}`)
  check('取消后没有发出任何写请求', writeRequests().length === 0, String(writeRequests().length))
  check('取消后积压仍是 2', (await backlogOf(DEAD_QUEUE)) === '2', String(await backlogOf(DEAD_QUEUE)))

  // 确认 → 真清空
  cdp.clearEvents()
  await clickCardButton(DEAD_QUEUE, '清空')
  await sleep(700)
  await confirmMessageBox(cdp)
  await sleep(2200)
  const afterClearBacklog = await backlogOf(DEAD_QUEUE)
  const afterClearMsgs = await readMessages()
  const apiAfterClear = (await getMessages(DEAD_QUEUE))?.data ?? []
  console.log(`    清空后：页面积压=${afterClearBacklog}，页面消息=${afterClearMsgs.length}，后端消息=${apiAfterClear.length}`)
  check('清空后页面积压归零', afterClearBacklog === '0', String(afterClearBacklog))
  check('清空后展开区没有消息', afterClearMsgs.length === 0, String(afterClearMsgs.length))
  check('后端消息确实清空了', apiAfterClear.length === 0, String(apiAfterClear.length))
  const delReq = writeRequests().find((e) => e.params.request.method === 'DELETE')
  check('DELETE 请求打到了正确队列', delReq?.params.request.url.includes(`/api/admin/mq/queues/${DEAD_QUEUE}/messages`) === true, delReq?.params.request.url)
  await shoot('t19-4-after-clear.png')

  /* ==================== [5] 重投（二次确认 + 积压归零） ==================== */
  console.log('\n[5] 重投（二次确认 + 重新拉列表确认归零）')
  // 再灌 1 条**合法**载荷：重投后会被正常消费，积压才能真正归零
  const pubAgain = await publishToDeadQueue(VALID_PAYLOAD)
  await sleep(700)
  // 「刷新」在工具条上，不在卡片里
  await clickByText(cdp, '.cm-mq-toolbar button', '刷新')
  await sleep(1600)
  console.log(`    再灌 1 条：${JSON.stringify(pubAgain)}，页面积压=${await backlogOf(DEAD_QUEUE)}`)
  check('再灌 1 条后页面积压为 1', (await backlogOf(DEAD_QUEUE)) === '1', String(await backlogOf(DEAD_QUEUE)))

  cdp.clearEvents()
  const replayClicked = await clickCardButton(DEAD_QUEUE, '重投')
  await sleep(800)
  const replayDialog = await dialogInfo()
  console.log(`    重投确认文案：${replayDialog.text}`)
  check('点重投弹出了二次确认', replayClicked === true && replayDialog.visible === true, replayDialog.text)
  check(
    '文案如实说明后果（重投回原交换机、失败会被打回）',
    replayDialog.text.includes('将把消息重新投递回原交换机，消费失败的会被再次打回死信队列。'),
    replayDialog.text,
  )
  await shoot('t19-5-replay-confirm.png')

  // 取消 → 不发请求
  await cancelMessageBox(cdp)
  await sleep(1200)
  console.log(`    取消后写请求数=${writeRequests().length}，积压=${await backlogOf(DEAD_QUEUE)}`)
  check('取消后没有发出任何写请求', writeRequests().length === 0, String(writeRequests().length))
  check('取消后积压仍是 1', (await backlogOf(DEAD_QUEUE)) === '1', String(await backlogOf(DEAD_QUEUE)))

  // 确认 → 真重投
  cdp.clearEvents()
  await clickCardButton(DEAD_QUEUE, '重投')
  await sleep(700)
  await confirmMessageBox(cdp)
  await sleep(3000)
  const afterReplayBacklog = await backlogOf(DEAD_QUEUE)
  const apiAfterReplay = (await getQueues())?.data?.find((q) => q.queueName === DEAD_QUEUE)
  const replayListReqs = queueListRequests().length
  console.log(`    重投后：页面积压=${afterReplayBacklog}，后端积压=${apiAfterReplay?.messageCount}，队列列表请求数=${replayListReqs}`)
  check('重投后页面积压归零（无需手动刷新）', afterReplayBacklog === '0', String(afterReplayBacklog))
  check('后端积压也确实为 0（消息被正常消费）', apiAfterReplay?.messageCount === 0, String(apiAfterReplay?.messageCount))
  check(
    '重投后**重新拉了一次队列列表**（不按 message 文本分支）',
    replayListReqs >= 1,
    String(replayListReqs),
  )
  const postReq = writeRequests().find((e) => e.params.request.method === 'POST')
  check('POST 请求打到了 replay 端点', postReq?.params.request.url.includes(`/api/admin/mq/queues/${DEAD_QUEUE}/replay`) === true, postReq?.params.request.url)
  await shoot('t19-6-after-replay.png')

  /* ==================== [7] 请求头 ==================== */
  console.log('\n[7] 请求头核验')
  const allReqs = cdp.events.filter(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/admin/mq/'),
  )
  const badHeader = allReqs.filter((e) => !e.params.request.headers.token)
  console.log(`    捕获 ${allReqs.length} 个 /api/admin/mq/* 请求`)
  check('确实发出过管理端请求', allReqs.length > 0, String(allReqs.length))
  check('所有请求都带 token 头', badHeader.length === 0, badHeader.map((e) => e.params.request.url).join(' | '))

  /* ==================== [6] 非管理员 ==================== */
  console.log('\n[6] 非管理员（小红）访问 /admin/mq')
  cdp.clearEvents()
  await loginViaUi(NORMAL, '/admin/mq')
  const normalUrl = await urlOf()
  const normalText = await bodyText()
  console.log(`    地址：${normalUrl}`)
  console.log(`    正文片段：${normalText.slice(0, 130)}`)
  check('停在 /admin/mq', normalUrl.startsWith('/admin/mq'), normalUrl)
  check('页面明确提示「无管理员权限」', normalText.includes('无管理员权限'), normalText.slice(0, 130))
  check('不是「加载失败」', !normalText.includes('加载失败'), normalText.slice(0, 130))
  const normalAdminReqs = cdp.events.filter(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/admin/'),
  )
  check('非管理员本地预检生效：未发出管理端请求', normalAdminReqs.length === 0, String(normalAdminReqs.length))
  await shoot('t19-7-forbidden.png')

  /* ==================== [8] 运行时健康度 ==================== */
  console.log('\n[8] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp
    .consoleErrors()
    .filter((t) => !/Failed to load resource|ERR_|net::|MinIO|404 \(Not Found\)/i.test(t))
  check('无未捕获异常（非 JSON 消息没有把页面搞崩）', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（网络/图片失败除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
  console.log('\n[清理] 把 6 个死信队列清回 0')
  /*
   * 兜底清理 + **断言结果**（核验方 §12.4：T17/T18/T19 三单的清理段都只有
   * console.log，清理失败照样 EXIT=0）。本单往死信队列灌过消息，
   * 残留会直接影响线上排查口径，所以这里既断言「清空请求成功」，
   * 也**独立回查一次总积压**（不依赖清空接口的自述）。
   */
  try {
    const cleared = await clearAllDeadQueues()
    check('兜底清理：清空请求都成功', cleared.every((r) => r.code === 200), JSON.stringify(cleared))
    const backlog = await totalBacklog()
    check('兜底清理：6 个死信队列总积压为 0', backlog === 0, String(backlog))
  } catch (e) {
    console.log(`    ⚠ 清理失败：${e.message}`)
    check('兜底清理：清空请求都成功', false, e.message)
    check('兜底清理：6 个死信队列总积压为 0', false, e.message)
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
