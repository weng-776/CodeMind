/**
 * 端到端验证公共骨架
 * ------------------------------------------------------------------
 * 前 7 步的验证脚本（verify-login / verify-article-list / verify-article-detail /
 * verify-note）各自把 CDP 客户端、桩后端样板、断言器抄了一遍 —— 每个文件开头
 * 四百多行是同一份代码。第 8/9/10 步不再复制，抽到这里。
 *
 * 提供：
 *   - 浏览器探测与无头启动（CDP over WebSocket，不依赖 puppeteer/playwright）
 *   - 极简 CDP 客户端（send / evaluate / 收集 console.error 与未捕获异常）
 *   - 断言器（check / summary，失败不中断，最后统一汇总）
 *   - 桩后端样板（json / fail / readBody / 按字节切分的流式响应）
 *   - 页面交互小工具（原生 setter 驱动 v-model、按文本点击、确认弹窗）
 *
 * 用法见 verify-profile.mjs / verify-notify.mjs / verify-ai-chat.mjs。
 *
 * 注意：旧脚本暂时没迁移过来。它们有 554 项断言在跑，为了不改动已验证的基线，
 * 保留原样；后续有需要再逐个替换。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

/* ==================== 基础工具 ==================== */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

export async function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    try {
      await fs.access(p)
      return p
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

/* ==================== 极简 CDP 客户端 ==================== */

export class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
        }
      } else {
        this.events.push(msg)
      }
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return new CDP(ws)
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 20000)
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? '页面求值异常')
    }
    return res.result.value
  }

  consoleErrors() {
    return this.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }

  exceptions() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.exception?.description ?? '未知异常')
  }

  clearEvents() {
    this.events.length = 0
  }
}

/* ==================== 断言器 ==================== */

export function createReporter() {
  const state = { pass: 0, fail: 0, problems: [] }

  function check(name, ok, detail = '') {
    if (ok) {
      state.pass += 1
      console.log(`  ✓ ${name}`)
    } else {
      state.fail += 1
      state.problems.push(name)
      console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }

  function summary() {
    console.log(`\n========== 通过 ${state.pass}，失败 ${state.fail} ==========`)
    if (state.problems.length) {
      console.log('失败项：')
      state.problems.forEach((p) => console.log(`  - ${p}`))
    }
    return state.fail
  }

  return { check, summary, state }
}

export async function waitFor(cdp, expression, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return true
    await sleep(120)
  }
  return false
}

/* ==================== 页面交互小工具 ==================== */

/** 用原生 setter + input 事件写值，否则 Vue 的 v-model 收不到 */
export function setInput(cdp, selector, value) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

/** 在页面里派发一次键盘事件（用于测 Enter / Shift+Enter 行为差异） */
export function pressKey(cdp, selector, key, modifiers = {}) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const ev = new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)},
      bubbles: true,
      cancelable: true,
      shiftKey: ${!!modifiers.shift},
      ctrlKey: ${!!modifiers.ctrl},
      metaKey: ${!!modifiers.meta},
    })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  })()`)
}

export function clickByText(cdp, selector, text) {
  return cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = els.find(e => e.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)
}

export function textOf(cdp, selector) {
  return cdp.evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.textContent?.replace(/\\s+/g,' ').trim() ?? null`,
  )
}

/** 确认 Element Plus 的 MessageBox（点主按钮） */
export function confirmMessageBox(cdp) {
  return cdp.evaluate(`(() => {
    const btn = document.querySelector('.el-message-box__btns .el-button--primary')
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

/** 取消 Element Plus 的 MessageBox（点次按钮） */
export function cancelMessageBox(cdp) {
  return cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.el-message-box__btns .el-button')]
    const btn = btns.find(b => !b.classList.contains('el-button--primary'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

/**
 * el-dialog / el-message-box 关闭后仍留在 DOM（display:none），
 * 所以判断「是否可见」必须看尺寸，不能用 querySelector 是否存在。
 */
export function visibleExpr(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })()`
}

/* ==================== 桩后端 ==================== */

export function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
  })
}

/**
 * 建一个桩后端。
 * @param port    监听端口
 * @param handler (ctx) => boolean  返回 true 表示已处理；false 则落到 404
 *   ctx = { req, res, url, entry, json, fail, notFound }
 * @param requestLog 外部传入的数组，记录每次请求（含 method/path/query/body/raw）
 */
export async function startStub(port, handler, requestLog = []) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    const entry = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      contentType: req.headers['content-type'] ?? '',
      body: null,
      raw: null,
    }

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const raw = await readBody(req)
      entry.raw = raw
      if (/application\/json/.test(entry.contentType)) {
        try {
          entry.body = raw ? JSON.parse(raw) : null
        } catch {
          entry.body = raw
        }
      } else {
        // multipart 原文，用例里用正则数同名字段
        entry.body = raw
      }
    }
    requestLog.push(entry)

    const json = (data, delay = 0) => {
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ code: 200, message: 'success', data }))
      }
      if (delay > 0) setTimeout(send, delay)
      else send()
    }

    const fail = (msg = '服务器内部错误', status = 500) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: status, message: msg, data: null }))
    }

    const notFound = () => {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 404, message: 'not found', data: null }))
    }

    const handled = await handler({ req, res, url, entry, json, fail, notFound })
    if (!handled) notFound()
  })

  await new Promise((r) => server.listen(port, r))
  return server
}

/**
 * 按字节切分写出「裸文本流」，模拟后端 Flux<String>。
 * ------------------------------------------------------------------
 * 刻意按**固定字节数**切分而不是按字符：UTF-8 下一个汉字占 3 字节，
 * 固定切分必然把汉字劈成两半。如果前端对每个分片独立 decode（不传
 * stream:true），这些半截字节就会变成 U+FFFD 乱码。
 * 这是本脚本最有价值的一条断言：在真实浏览器 + 真实网络链路里验证
 * 跨分片多字节字符不会被破坏。
 */
export function writeTextStream(res, text, { chunkSize = 4, delayMs = 18 } = {}) {
  const buf = Buffer.from(text, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'text/html;charset=UTF-8',
    'Cache-Control': 'no-cache',
  })

  let offset = 0
  const timer = setInterval(() => {
    if (offset >= buf.length) {
      clearInterval(timer)
      res.end()
      return
    }
    res.write(buf.subarray(offset, offset + chunkSize))
    offset += chunkSize
  }, delayMs)

  // 用户点「停止生成」会断开连接，这里必须清掉定时器，否则会一直往已关闭的
  // response 上写，Node 抛 ERR_STREAM_WRITE_AFTER_END
  res.on('close', () => clearInterval(timer))
}

/* ==================== 启动与清理 ==================== */

export async function startVite({ port, stubPort }) {
  const server = await createServer({
    server: {
      port,
      strictPort: true,
      proxy: { '/api': { target: `http://localhost:${stubPort}`, changeOrigin: true } },
    },
    logLevel: 'error',
  })
  await server.listen()
  return server
}

export async function launchBrowser({ debugPort, windowSize = '1440,1000' }) {
  const browserPath = await findBrowser()
  if (!browserPath) return null

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-cdp-'))
  const proc = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      `--window-size=${windowSize}`,
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let versionInfo = null
  for (let i = 0; i < 40; i += 1) {
    await sleep(250)
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (res.ok) {
        versionInfo = await res.json()
        break
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!versionInfo) throw new Error('Chrome 调试端口未就绪')

  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const pageTarget = targets.find((t) => t.type === 'page')
  const cdp = await CDP.connect(pageTarget.webSocketDebuggerUrl)

  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('DOM.enable')

  return { cdp, proc, profileDir, browserPath, version: versionInfo.Browser }
}

/**
 * 统一收尾。任何一步失败都不能留下僵尸 Chrome / 占着端口的 Vite，
 * 否则下一次跑脚本会 strictPort 报错。
 */
export async function shutdown({ cdp, proc, profileDir, viteServer, stubServer }) {
  try {
    cdp?.ws?.close()
  } catch {
    /* 忽略 */
  }
  try {
    proc?.kill()
  } catch {
    /* 忽略 */
  }
  try {
    await viteServer?.close()
  } catch {
    /* 忽略 */
  }
  /*
   * ⚠️ 必须**判空再 await**。
   *
   * 原写法 `await new Promise((r) => stubServer?.close(r))` 在 `stubServer` 为空时，
   * 可选链直接短路成 `undefined` —— **`r` 永远不会被调用**，这个 Promise 永不 settle，
   * 顶层 `await` 悬空 → Node 报「Detected unsettled top-level await」并**以退出码 13 结束**。
   * 后果：直连真实后端（没有桩）的脚本，哪怕断言全过，在 CI 里仍被判失败。
   *
   * 这条 T0.5 的遗留观察项 #3 就记过（「所有打真实后端的脚本都会踩，值得统一修」），
   * T11 又踩了一次并自己传空 server 绕开 —— 2026-09-24 由核验方统一修掉。
   */
  try {
    if (stubServer) await new Promise((r) => stubServer.close(r))
  } catch {
    /* 忽略 */
  }
  try {
    if (profileDir) await fs.rm(profileDir, { recursive: true, force: true })
  } catch {
    /* Windows 上目录可能仍被占用 */
  }
}
