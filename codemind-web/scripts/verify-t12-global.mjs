#!/usr/bin/env node
/**
 * T12 全局收尾验收
 * ------------------------------------------------------------------
 * 端口：vite 5223（proxy → 真实后端 8080）、CDP 9357
 *
 * 覆盖工单 4 条验收：
 *   1. 全项目搜索证据（无 mock、无 src 内 localhost:8080、无 any、无魔法色值）
 *   2. 后端不可用时主要页面进错误态（≥3 张）
 *   3. 6 个主要页面的 404 / 空态 / 加载态截图
 *   4. vue-tsc --build 0 错误（本脚本外单独跑，这里只做类型文件静态复核）
 * 另外自查两项工单要求：
 *   5. document.title 随路由变化
 *   6. 桌面优先、兼顾平板：768 / 834 / 1024 下无横向溢出
 *
 * 「制造状态」统一用 CDP `Fetch` 域，不改源码、不改接口路径、不动配置：
 *   hold  扣住请求不放 → 页面停在加载态
 *   empty 直接返回空列表 → 页面进空态
 *   fail  让请求失败 → 页面进错误态
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
} from './lib/cdp-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'docs', 'screenshots')

const PORT = 5223
const DEBUG_PORT = 9357
const BACKEND = 'http://localhost:8080'
const BASE = `http://localhost:${PORT}`
/** 拦截规则只锚定在这个前缀，避免误伤 `/src/api/*.ts` 这类模块请求 */
const API_PREFIX = `${BASE}/api/`

const { check, summary } = createReporter()

/* ==================== 通用小工具 ==================== */

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

/**
 * 请求拦截路由器。
 *
 * 直接给 cdp.ws 挂一个自己的 message 监听（骨架的 CDP 类只把事件塞进数组，
 * 不提供回调），这样能对 `Fetch.requestPaused` 立即响应 ——
 * 轮询 cdp.events 会有竞态：同一时刻有多个请求被扣住时会漏掉后面的。
 */
function createFetchRouter(cdp) {
  /** @type {{re: RegExp, mode: 'hold'|'empty'|'fail'}[]} */
  let rules = []
  /** 被扣住（不响应）的请求，释放时要逐个收尾，否则页面永远转圈 */
  let held = []

  cdp.ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.method !== 'Fetch.requestPaused') return

    const { requestId, request } = msg.params
    const url = request.url
    // 只看真正的接口请求；页面/模块资源一律放行
    if (!url.startsWith(API_PREFIX)) {
      void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
      return
    }

    const rule = rules.find((r) => r.re.test(url))
    if (!rule) {
      void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
      return
    }

    if (rule.mode === 'hold') {
      held.push(requestId)
      return
    }
    if (rule.mode === 'fail') {
      void cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {})
      return
    }
    // empty：返回一个「成功但零条记录」的分页体，页面据此进空态
    const payload = {
      code: 200,
      message: 'success',
      data: { records: [], total: 0, size: 20, current: 1, pages: 0 },
    }
    void cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      })
      .catch(() => {})
  })

  return {
    async set(list) {
      rules = list
      await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: `${API_PREFIX}*`, requestStage: 'Request' }],
      })
    },
    /** 把扣住的请求全部放行（让页面能继续，避免后续导航被卡） */
    release() {
      const ids = held
      held = []
      ids.forEach((id) => {
        void cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'Aborted' }).catch(() => {})
      })
    },
    async off() {
      this.release()
      rules = []
      await cdp.send('Fetch.disable').catch(() => {})
    },
  }
}

/** 导航到某页并等到「骨架已挂载」（有 #app 且非空白） */
async function goto(cdp, url, waitMs = 1500) {
  await cdp.send('Page.navigate', { url })
  await sleep(waitMs)
}

/* ==================== 一、静态审计 ==================== */

function walk(dir, exts) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, exts))
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full)
  }
  return out
}

/** 去掉注释行，避免把「注释里提到的色值」当成魔法色值 */
function codeLines(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('/*') || t.startsWith('//') || t.startsWith('<!--'))
    })
}

function staticAudit() {
  console.log('\n[验收 1] 全项目静态审计')
  const files = walk(path.join(ROOT, 'src'), ['.ts', '.vue', '.css'])
  console.log(`    扫描 src/ 下 ${files.length} 个文件`)

  const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')

  // ① mock / 假数据
  const mockHits = files.filter((f) =>
    /\b(mock|faker|fakeData|fake_data)\b|假数据|静态json/i.test(fs.readFileSync(f, 'utf8')),
  )
  check('src/ 内没有 mock / 假数据', mockHits.length === 0, mockHits.map(rel).join(', '))

  // ② 硬编码后端地址
  const localhostHits = files.filter((f) => /localhost:\d+|127\.0\.0\.1:\d+/.test(fs.readFileSync(f, 'utf8')))
  check('src/ 内没有硬编码的后端地址', localhostHits.length === 0, localhostHits.map(rel).join(', '))
  const viteConfig = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8')
  check(
    '后端地址只出现在 vite.config.ts 的代理默认值里（可被 VITE_PROXY_TARGET 覆盖）',
    /VITE_PROXY_TARGET/.test(viteConfig),
  )

  // ③ any
  const anyHits = []
  for (const f of files) {
    codeLines(fs.readFileSync(f, 'utf8')).forEach((line, i) => {
      if (/:\s*any\b|<any>|\bas\s+any\b/.test(line)) anyHits.push(`${rel(f)}:${i + 1}`)
    })
  }
  check('没有 `any`（含 as any / <any>）', anyHits.length === 0, anyHits.slice(0, 5).join(', '))

  // ④ 魔法色值（tokens.css 是唯一允许定义色值的地方）
  const tokensPath = path.join(ROOT, 'src', 'styles', 'tokens.css')
  const colorHits = []
  for (const f of files) {
    if (f === tokensPath) continue
    codeLines(fs.readFileSync(f, 'utf8')).forEach((line, i) => {
      if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) colorHits.push(`${rel(f)}:${i + 1}`)
    })
  }
  check(
    '色值只定义在 tokens.css，其它文件全走 var(--cm-*)',
    colorHits.length === 0,
    colorHits.slice(0, 6).join(', '),
  )

  // ⑤ 三态组件复用：数据页都要有 Loading / Empty / Error，且 Error 必须能重试
  const views = walk(path.join(ROOT, 'src', 'views'), ['.vue'])
  const missing = []
  for (const f of views) {
    const s = fs.readFileSync(f, 'utf8')
    if (!/<ErrorState\b/.test(s)) continue // 纯表单页/静态页不强制
    if (!/LoadingState/.test(s)) missing.push(`${rel(f)} 缺 LoadingState`)
    /*
     * 「编辑页」是表单，没有「列表为空」这个概念，
     * 强行塞一个 EmptyState 反而是为了过检查而加无用分支。
     */
    const isFormPage = /EditView\.vue$/.test(f)
    if (!isFormPage && !/EmptyState/.test(s)) missing.push(`${rel(f)} 缺 EmptyState`)
  }
  check('用到 ErrorState 的数据页都配了 Loading / Empty', missing.length === 0, missing.join(', '))

  const noRetry = []
  for (const f of views) {
    const s = fs.readFileSync(f, 'utf8')
    const re = /<ErrorState\b[\s\S]*?(\/>|<\/ErrorState>)/g
    let m
    while ((m = re.exec(s))) {
      if (!/@retry=/.test(m[0])) noRetry.push(rel(f))
    }
  }
  check('所有 ErrorState 都接了 @retry（重试入口来自组件本身）', noRetry.length === 0, noRetry.join(', '))

  // ⑥ 代码高亮：hljs 产出的类名必须有对应样式，否则高亮等于没生效
  const css = walk(path.join(ROOT, 'src', 'styles'), ['.css'])
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
  const hljsRoles = ['hljs-keyword', 'hljs-string', 'hljs-comment', 'hljs-number', 'hljs-title']
  const missingRoles = hljsRoles.filter((r) => !css.includes(`.${r}`))
  check(
    'hljs 语法着色有样式定义（此前完全没有，代码块是单色）',
    missingRoles.length === 0,
    `缺 ${missingRoles.join(', ')}`,
  )
  check('语法色走 token 而不是写死色值', /--cm-code-keyword/.test(css) && /--cm-code-keyword/.test(fs.readFileSync(tokensPath, 'utf8')))
}

/* ==================== 二、浏览器验收 ==================== */

let viteServer
let browser
let cdp
let router
let tmpArticleId = null
let TOKEN = ''

/**
 * 6 个主要页面。
 *
 * ⚠️ `apiRe` 必须对准页面**真正会发**的接口：社区列表默认 tab 走的是
 * `/article/latest`（不是 `/article/list`，那是「全部」tab），
 * 第一版写错成 list，结果拦截没命中、页面照常渲染出真实数据，
 * 于是「加载态/空态/错误态」三条断言全红 —— 看起来像三个功能都坏了，
 * 实际是测试的 URL 猜错了。
 */
const PAGES = [
  { key: 'home', name: '首页', path: '/', apiRe: /\/api\/article\/(latest|hot)/ },
  {
    key: 'articles',
    name: '社区列表',
    path: '/articles',
    apiRe: /\/api\/article\/(latest|hot|list|tag)/,
  },
  { key: 'article-detail', name: '文章详情', path: '/articles/__ID__', apiRe: /\/api\/article\/\d+/ },
  { key: 'notes', name: '知识库列表', path: '/notes', apiRe: /\/api\/note\/list/ },
  { key: 'ai', name: 'AI 对话', path: '/ai', apiRe: /\/api\/ai\/conversations/ },
  { key: 'notifications', name: '消息通知', path: '/notifications', apiRe: /\/api\/notify\/list/ },
]

/** 空态有意义的列表页 */
const EMPTY_PAGES = ['articles', 'notes', 'notifications']

async function main() {
  console.log('[准备] 启动 vite(5223 → 后端 8080) 与无头浏览器')
  viteServer = await startVite({ port: PORT, stubPort: 8080 })
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1440,1100' })
  cdp = browser.cdp
  router = createFetchRouter(cdp)
  console.log(`    浏览器：${browser.version}`)

  TOKEN = await login('13800000002')

  // 取一个真实存在的文章 id（列表接口返回的是摘要，不含正文，这里只取 id）
  const artList = await fetch(`${BACKEND}/api/article/list?page=1&size=1`, {
    headers: { token: TOKEN },
  }).then((r) => r.json())
  const articleId = artList?.data?.records?.[0]?.id
  if (!articleId) throw new Error('拿不到文章 id，后端数据可能为空')
  console.log(`    用文章 id=${articleId} 做详情页用例`)

  // 注入登录态（必须先到同源页面才能碰 localStorage）
  await goto(cdp, `${BASE}/login`, 800)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(TOKEN)})`)

  /* ==================== 5. document.title ==================== */
  console.log('\n[附加 1] document.title 随路由变化')
  const titleCases = [
    { path: '/', expect: '首页' },
    { path: '/articles', expect: '社区' },
    { path: '/notes', expect: '知识库' },
    { path: '/notifications', expect: '消息' },
  ]
  for (const c of titleCases) {
    await goto(cdp, `${BASE}${c.path}`, 1200)
    const title = await cdp.evaluate(`document.title`)
    console.log(`    ${c.path} → ${JSON.stringify(title)}`)
    check(`${c.path} 的 title 含「${c.expect}」且带站名`, String(title).includes(c.expect) && String(title).includes('CodeMind'), String(title))
  }

  /* ==================== 3. 404 页 ==================== */
  console.log('\n[验收 3-a] 未匹配路由 → 404 页（不白屏）')
  await goto(cdp, `${BASE}/definitely-not-a-real-page-xyz`, 1500)
  const notFound = await cdp.evaluate(`({
    text: document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,80),
    has404: document.body.innerText.includes('404'),
    appFilled: (document.querySelector('#app')?.innerHTML?.length ?? 0) > 500,
    buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean),
  })`)
  console.log(`    页面文案：${JSON.stringify(notFound.text)}`)
  check('404 页渲染出内容（没有白屏）', notFound.has404 && notFound.appFilled, JSON.stringify(notFound.text))
  check('404 页给了出口按钮', notFound.buttons.length >= 2, JSON.stringify(notFound.buttons))
  await shoot(cdp, 't12-10-404-page.png')

  /* ==================== 3. 加载态（6 页） ==================== */
  console.log('\n[验收 3-b] 6 个主要页面的加载态（扣住主接口不响应）')
  for (let i = 0; i < PAGES.length; i += 1) {
    const page = PAGES[i]
    const url = `${BASE}${page.path.replace('__ID__', String(articleId))}`
    await router.set([{ re: page.apiRe, mode: 'hold' }])
    await goto(cdp, url, 1400)
    const state = await cdp.evaluate(`({
      loading: !!document.querySelector('.cm-loading, .cm-skeleton'),
      bodyLen: document.body.innerText.trim().length,
    })`)
    console.log(`    ${page.name}：加载态=${state.loading}`)
    check(`${page.name} 扣住请求时进加载态`, state.loading === true)
    await shoot(cdp, `t12-${i + 1}-loading-${page.key}.png`)
    await router.off()
  }

  /* ==================== 3. 空态（列表页） ==================== */
  console.log('\n[验收 3-c] 列表页空态（接口返回零条记录）')
  for (let i = 0; i < EMPTY_PAGES.length; i += 1) {
    const page = PAGES.find((p) => p.key === EMPTY_PAGES[i])
    await router.set([{ re: page.apiRe, mode: 'empty' }])
    await goto(cdp, `${BASE}${page.path}`, 1600)
    const state = await cdp.evaluate(`({
      empty: !!document.querySelector('.cm-empty'),
      text: document.querySelector('.cm-empty')?.innerText?.replace(/\\s+/g,' ').trim().slice(0,40) ?? '',
    })`)
    console.log(`    ${page.name}：空态=${state.empty}｜${JSON.stringify(state.text)}`)
    check(`${page.name} 返回空列表时进空态`, state.empty === true, JSON.stringify(state.text))
    await shoot(cdp, `t12-${i + 7}-empty-${page.key}.png`)
    await router.off()
  }

  /* ==================== 2. 错误态（后端不可用） ==================== */
  console.log('\n[验收 2] 后端不可用时主要页面进错误态（请求直接失败）')
  for (let i = 0; i < EMPTY_PAGES.length; i += 1) {
    const page = PAGES.find((p) => p.key === EMPTY_PAGES[i])
    await router.set([{ re: page.apiRe, mode: 'fail' }])
    await goto(cdp, `${BASE}${page.path}`, 1800)
    const state = await cdp.evaluate(`({
      error: !!document.querySelector('.cm-error'),
      retry: [...document.querySelectorAll('.cm-error__actions button')].map(b=>b.textContent.trim()),
      text: document.querySelector('.cm-error')?.innerText?.replace(/\\s+/g,' ').trim().slice(0,60) ?? '',
    })`)
    console.log(`    ${page.name}：错误态=${state.error}｜按钮=${JSON.stringify(state.retry)}`)
    check(`${page.name} 请求失败时进错误态`, state.error === true, JSON.stringify(state.text))
    check(`${page.name} 错误态带重试按钮`, state.retry.some((t) => t.includes('重新')), JSON.stringify(state.retry))
    await shoot(cdp, `t12-${i + 11}-error-${page.key}.png`)
    await router.off()
  }

  /* ==================== 附加：代码高亮真的着色了 ==================== */
  console.log('\n[附加 2] 代码高亮语法着色（此前 .hljs-* 没有任何样式）')
  // 种子里唯一带代码块的文章用的是 `java -Xms2g...`（hljs 认为不是合法 Java，产不出 token），
  // 所以临时造一篇有真语法结构的文章，验收后删除。
  const fd = new FormData()
  fd.append('title', `[T12验收] 代码高亮临时文章 ${Date.now()}`)
  fd.append(
    'content',
    [
      '# 代码高亮验证',
      '',
      '下面是一段 Java：',
      '',
      '```java',
      'public class Demo {',
      '  // 注释',
      '  private static final int MAX = 100;',
      '  public static void main(String[] args) {',
      '    System.out.println("hello");',
      '  }',
      '}',
      '```',
      '',
      '还有一段 JavaScript：',
      '',
      '```js',
      'const n = 42',
      'function add(a, b) { return a + b }',
      '```',
    ].join('\n'),
  )
  fd.append('status', '1')
  const created = await fetch(`${BACKEND}/api/article`, {
    method: 'POST',
    headers: { token: TOKEN },
    body: fd,
  }).then((r) => r.json())
  tmpArticleId = typeof created?.data === 'number' ? created.data : created?.data?.id
  check('造出带代码块的临时文章（发布接口 3.1）', created?.code === 200 && !!tmpArticleId, JSON.stringify(created))

  if (tmpArticleId) {
    await goto(cdp, `${BASE}/articles/${tmpArticleId}`, 1800)
    const hl = await cdp.evaluate(`(() => {
      const pre = document.querySelector('.cm-markdown pre')
      if (!pre) return { hasPre: false }
      const code = pre.querySelector('code')
      const base = getComputedStyle(code).color
      const spans = [...pre.querySelectorAll('[class*="hljs-"]')]
      const byClass = {}
      for (const s of spans) {
        const cls = [...s.classList].find(c => c.startsWith('hljs-')) || 'hljs'
        if (!byClass[cls]) byClass[cls] = getComputedStyle(s).color
      }
      return {
        hasPre: true,
        base,
        spanCount: spans.length,
        byClass,
        preBg: getComputedStyle(pre).backgroundColor,
      }
    })()`)
    console.log(`    代码块底色 ${hl.preBg}｜基础文字色 ${hl.base}`)
    console.log(`    着色 span ${hl.spanCount} 个：${JSON.stringify(hl.byClass)}`)
    check('代码块渲染出来了', hl.hasPre === true)
    check('hljs 产出了着色 span', hl.spanCount > 0, String(hl.spanCount))

    /*
     * 只校验**我们显式配过色**的角色。
     * hljs 还会产出 `.hljs-operator` 之类没有单独配色的类，它们继承基础文字色 ——
     * 那是正常的，第一版要求「所有 span 颜色都不同」就成了假失败。
     */
    const mustDiffer = ['hljs-keyword', 'hljs-string', 'hljs-comment']
    const styled = hl.byClass || {}
    const wrong = mustDiffer.filter((c) => !styled[c] || styled[c] === hl.base)
    check(
      '关键字 / 字符串 / 注释都真的上了色（不是与正文同色）',
      wrong.length === 0,
      `未着色或与正文同色：${JSON.stringify(wrong)}｜base=${hl.base}`,
    )
    check(
      '至少三种语法角色颜色互不相同（不是所有 token 一个色）',
      new Set(mustDiffer.map((c) => styled[c])).size >= 3,
      JSON.stringify(styled),
    )
    await shoot(cdp, 't12-14-code-highlight.png')
  }

  /* ==================== 6. 响应式：平板宽度 ==================== */
  console.log('\n[附加 3] 桌面优先、兼顾平板：横向溢出检测')
  await router.off()
  for (const page of PAGES) {
    await goto(cdp, `${BASE}${page.path.replace('__ID__', String(articleId))}`, 1600)
    for (const w of [1024, 834, 768]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await sleep(450)
      const ov = await cdp.evaluate(`(() => {
        const de = document.documentElement
        const overflow = de.scrollWidth - de.clientWidth
        const offenders = []
        if (overflow > 0) {
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect()
            if (r.width > 0 && r.right > de.clientWidth + 1) {
              offenders.push((el.className || el.tagName) + ' → ' + Math.round(r.right))
              if (offenders.length >= 3) break
            }
          }
        }
        return { overflow, offenders }
      })()`)
      check(
        `${page.name} @${w}px 无横向溢出`,
        ov.overflow <= 0,
        `溢出 ${ov.overflow}px｜越界元素 ${JSON.stringify(ov.offenders)}`,
      )
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(200)
  }

  /* ==================== 健康度 ==================== */
  console.log('\n[健康度] 控制台')
  const errs = cdp.consoleErrors()
  const exs = cdp.exceptions()
  console.log(`    console.error ${errs.length} 条｜未捕获异常 ${exs.length} 条`)
  check('0 未捕获异常', exs.length === 0, JSON.stringify(exs.slice(0, 2)))
}

/* ==================== 入口 ==================== */

staticAudit()

try {
  await main()
} catch (err) {
  console.error('\n[脚本异常]', err)
  process.exitCode = 1
} finally {
  // 清理临时文章（否则会永久留在社区列表里）
  try {
    if (tmpArticleId) {
      const res = await fetch(`${BACKEND}/api/article/${tmpArticleId}`, {
        method: 'DELETE',
        headers: { token: TOKEN },
      }).then((r) => r.json())
      console.log(`\n[收尾] 删除临时文章 ${tmpArticleId} → ${JSON.stringify(res)}`)
    }
  } catch (err) {
    console.error('[收尾] 删除临时文章失败：', err)
  }

  await shutdown({
    cdp,
    proc: browser?.proc,
    profileDir: browser?.profileDir,
    viteServer,
  })

  const failCount = summary()
  process.exitCode = failCount > 0 ? 1 : 0
}
