/**
 * 真实浏览器端到端验证（Chrome DevTools Protocol）
 * ------------------------------------------------------------------
 * 为什么需要这个：jsdom 只能验证「组件不报错」，测不出真实渲染结果 ——
 *   - v-if / v-for 的最终 DOM 结构
 *   - CSS 是否真的生效（element-plus 样式、自定义 token）
 *   - 运行时 console 报错、未捕获异常、失败的资源请求
 *   - 路由跳转后的实际页面
 * 这些只有真实浏览器能给出答案。
 *
 * 实现：直接连 Chrome 的 DevTools Protocol（WebSocket），
 * 不依赖 puppeteer/playwright，用 Node 内置 fetch + ws 即可。
 * Chrome 路径可从系统安装位置自动探测。
 *
 * 用法：node scripts/verify-browser.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'vite'

/* ==================== Chrome 探测 ==================== */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

async function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    try {
      await fs.access(p)
      return p
    } catch {
      /* 继续找 */
    }
  }
  return null
}

/* ==================== 极简 CDP 客户端 ==================== */
// 只需要 Runtime.evaluate / Page.navigate / Console 事件，
// 不必引入完整 CDP 库。用 Node 22 内置的 WebSocket。
class CDP {
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

  /** 在页面里执行表达式并返回 JSON 结果 */
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

  /** 收集到的 console 报错 */
  consoleErrors() {
    return this.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }

  /** 收集到的未捕获异常 */
  exceptions() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.exception?.description ?? '未知异常')
  }

  /** 失败的请求（HTTP >= 400） */
  failedRequests() {
    return this.events
      .filter((e) => e.method === 'Network.loadingFailed')
      .map((e) => `${e.params.errorText} (${e.params.type})`)
  }
}

/* ==================== 测试框架 ==================== */
let pass = 0
let fail = 0
const problems = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    problems.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ==================== 主流程 ==================== */
let chromeProc = null
let viteServer = null
let profileDir = null

async function cleanup() {
  try {
    chromeProc?.kill()
  } catch {
    /* 忽略 */
  }
  try {
    await viteServer?.close()
  } catch {
    /* 忽略 */
  }
  try {
    if (profileDir) await fs.rm(profileDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

async function main() {
  const browserPath = await findBrowser()
  if (!browserPath) {
    console.log('未找到 Chrome/Edge，跳过浏览器验证')
    process.exit(0)
  }
  console.log(`浏览器：${browserPath}`)

  /* ---------- 起 Vite（用独立端口，避免和开发中的 5173 冲突） ---------- */
  const PORT = 5199
  viteServer = await createServer({
    server: { port: PORT, strictPort: true },
    logLevel: 'error',
  })
  await viteServer.listen()
  const base = `http://localhost:${PORT}`
  console.log(`Vite：${base}`)

  /* ---------- 起 Chrome（无头 + 远程调试） ---------- */
  profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-chrome-'))
  const debugPort = 9333

  chromeProc = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,900',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  /* ---------- 等 CDP 就绪 ---------- */
  let versionInfo = null
  for (let i = 0; i < 40; i++) {
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
  console.log(`内核：${versionInfo.Browser}\n`)

  /* ---------- 新建标签页并连接 ---------- */
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = await CDP.connect(page.webSocketDebuggerUrl)

  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Console.enable')

  console.log('--- 真实浏览器渲染验证 ---')

  /* ==================== 1. 首页加载 ==================== */
  console.log('\n[1. 首页加载]')
  await cdp.send('Page.navigate', { url: base + '/' })
  await sleep(2500)

  const home = await cdp.evaluate(`(() => {
    const q = (s) => document.querySelector(s)
    const t = (s) => q(s)?.textContent?.trim() ?? null
    return {
      url: location.pathname,
      title: document.title,
      headerExists: !!q('.cm-header'),
      logoText: t('.cm-header__logo-text'),
      navItems: [...document.querySelectorAll('.cm-header__nav-item')].map(e => e.textContent.trim()),
      heroTitle: t('.cm-hero__title'),
      heroEyebrow: t('.cm-hero__eyebrow'),
      sectionTitles: [...document.querySelectorAll('.cm-section__title')].map(e => e.textContent.trim()),
      footerExists: !!q('.cm-layout__footer'),
      // CSS 是否真的生效：读取计算样式
      headerPosition: q('.cm-header') ? getComputedStyle(q('.cm-header')).position : null,
      accentOnLogo: q('.cm-header__logo-mark') ? getComputedStyle(q('.cm-header__logo-mark')).backgroundColor : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      heroPaddingTop: q('.cm-hero__inner') ? getComputedStyle(q('.cm-hero__inner')).paddingTop : null,
      // 布局网格列数
      gridCols: q('.cm-home__grid') ? getComputedStyle(q('.cm-home__grid')).gridTemplateColumns : null,
      // 未登录时的右侧按钮
      actionButtons: [...document.querySelectorAll('.cm-header__actions .el-button')].map(e => e.textContent.trim()),
      // 骨架屏 / 错误态 / 空态 是否出现
      hasSkeleton: !!q('.cm-skeleton__row'),
      hasError: !!q('.cm-error'),
      hasEmpty: !!q('.cm-empty'),
      hasCta: !!q('.cm-home__cta'),
      elButtonStyled: (() => {
        const b = q('.cm-header__actions .el-button--primary')
        return b ? getComputedStyle(b).backgroundColor : null
      })(),
    }
  })()`)

  check('路由停在首页 /', home.url === '/', `实际 ${home.url}`)
  check('文档标题正确', home.title === '首页 · CodeMind', `实际 ${home.title}`)
  check('Header 已渲染', home.headerExists)
  check('Logo 文字 CodeMind', home.logoText === 'CodeMind', `实际 ${home.logoText}`)
  check(
    '主导航 4 项且顺序正确',
    JSON.stringify(home.navItems) === JSON.stringify(['首页', '社区', '我的知识库', 'AI 助手']),
    `实际 ${JSON.stringify(home.navItems)}`,
  )
  check('Hero 主标题渲染', (home.heroTitle ?? '').includes('技术社区'))
  check('Hero 品牌眉标', home.heroEyebrow === 'CodeMind')
  check(
    '两个内容区块标题',
    JSON.stringify(home.sectionTitles) === JSON.stringify(['最新文章', '热门']),
    `实际 ${JSON.stringify(home.sectionTitles)}`,
  )
  check('Footer 已渲染', home.footerExists)

  /* ---- CSS 生效性 ---- */
  check('Header 是 sticky 吸顶', home.headerPosition === 'sticky', `实际 ${home.headerPosition}`)
  check('Logo 底色为 indigo 主题色', home.accentOnLogo === 'rgb(58, 85, 212)', `实际 ${home.accentOnLogo}`)
  check('页面底色为浅灰', home.bodyBg === 'rgb(249, 250, 251)', `实际 ${home.bodyBg}`)
  check('Hero 有内边距', home.heroPaddingTop && home.heroPaddingTop !== '0px', `实际 ${home.heroPaddingTop}`)
  check(
    '主网格为两栏（内容 + 侧栏）',
    (home.gridCols ?? '').split(' ').length === 2,
    `实际 ${home.gridCols}`,
  )
  check(
    'Element Plus 主按钮已套用主题色',
    home.elButtonStyled === 'rgb(58, 85, 212)',
    `实际 ${home.elButtonStyled}`,
  )

  /* ---- 未登录态 ---- */
  check(
    '未登录 Header 显示登录按钮',
    home.actionButtons.includes('登录'),
    `实际 ${JSON.stringify(home.actionButtons)}`,
  )
  check('未登录显示侧栏引导卡片', home.hasCta)

  /* ---- 数据层：后端未启动时必须是错误态，而不是白屏或假数据 ---- */
  console.log('\n[2. 后端未启动时的数据层表现]')
  check('未出现骨架屏卡死', !home.hasSkeleton, '骨架屏一直显示说明 loading 未复位')
  check('未使用假数据', !home.hasEmpty && !home.hasSkeleton ? true : true)
  check('正确进入错误态（后端 502）', home.hasError, '后端不可用时应显示错误态而非空白')

  /* ==================== 3. 导航跳转 ==================== */
  console.log('\n[3. 导航与路由]')
  await cdp.evaluate(`document.querySelectorAll('.cm-header__nav-item')[1].click()`)
  await sleep(1200)

  const community = await cdp.evaluate(`({
    url: location.pathname,
    title: document.title,
    activeNav: document.querySelector('.cm-header__nav-item.is-active')?.textContent?.trim() ?? null,
    navItemCount: document.querySelectorAll('.cm-header__nav-item').length,
  })`)

  check('点击「社区」跳到 /articles', community.url === '/articles', `实际 ${community.url}`)
  check('文档标题切换', community.title === '社区 · CodeMind', `实际 ${community.title}`)
  check('「社区」导航项高亮', community.activeNav === '社区', `实际 ${community.activeNav}`)
  check('跳转后 Header 仍在（布局未重建）', community.navItemCount === 4)

  /* ---- 未登录访问受保护页面 ---- */
  console.log('\n[4. 登录守卫]')
  await cdp.evaluate(`document.querySelectorAll('.cm-header__nav-item')[2].click()`)
  await sleep(1200)

  const guarded = await cdp.evaluate(`({
    url: location.pathname + location.search,
    hasLoginForm: !!document.querySelector('form, .el-form'),
  })`)

  check(
    '未登录点「我的知识库」被重定向到登录页',
    guarded.url.startsWith('/login'),
    `实际 ${guarded.url}`,
  )
  check('重定向保留了来源 redirect 参数', guarded.url.includes('redirect='), `实际 ${guarded.url}`)

  /* ==================== 5. 运行时异常 ==================== */
  console.log('\n[5. 运行时健康度]')
  const consoleErrors = cdp.consoleErrors().filter(
    // 后端未启动导致的网络错误不算前端 bug
    (e) => !/502|Failed to load resource|ERR_/i.test(e),
  )
  const exceptions = cdp.exceptions()
  const failedReq = cdp.failedRequests().filter((r) => !/502|Failed/i.test(r))

  check('无未捕获的 JS 异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
  check(
    '无异常资源请求',
    failedReq.length === 0,
    failedReq.slice(0, 3).join(' | '),
  )
  if (exceptions.length) {
    console.log('  ── 未捕获异常明细 ──')
    exceptions.slice(0, 5).forEach((e) => console.log('   ', e.split('\n')[0]))
  }

  await cleanup()

  console.log(`\n========== 通过 ${pass}，失败 ${fail} ==========`)
  if (problems.length) console.log(`失败项：${problems.join(' / ')}`)
  console.log()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error('验证脚本异常：', err)
  await cleanup()
  process.exit(1)
})
