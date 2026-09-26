/**
 * 首页截图 + 登录态 Header 验证
 * ------------------------------------------------------------------
 * 两件事：
 *   1. 截取首页渲染结果，直观确认视觉效果
 *   2. 注入 token + 桩接口，验证登录态下的 Header（头像、未读红点、下拉菜单）
 *
 * 用法：node scripts/capture-home.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'vite'

const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-shot-'))

/* 桩服务：提供登录态所需的最小接口 */
const { createServer: createHttp } = await import('node:http')
const stubPort = 8123
const stub = createHttp((req, res) => {
  const url = req.url ?? ''
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  // 用户信息
  if (url.startsWith('/api/user/info')) {
    return res.end(
      JSON.stringify({
        code: 200,
        message: 'ok',
        data: {
          id: 1,
          userName: '阿燃',
          avatar: '',
          intro: '正在构建 CodeMind',
          phone: '138****8888',
          createTime: '2024-01-01 10:00:00',
        },
      }),
    )
  }
  // 未读数
  if (url.startsWith('/api/notify/unread')) {
    return res.end(JSON.stringify({ code: 200, message: 'ok', data: 5 }))
  }
  // 文章列表类：返回两条可读数据，便于确认卡片布局
  if (url.includes('/article/latest') || url.includes('/article/hot')) {
    const isHot = url.includes('/article/hot')
    return res.end(
      JSON.stringify({
        code: 200,
        message: 'ok',
        data: {
          total: 2,
          size: 10,
          current: 1,
          records: [
            {
              id: isHot ? 21 : 1,
              title: isHot
                ? '前端性能优化清单：从 LCP 到 INP'
                : '深入理解 Vue 3 响应式：Proxy 与依赖收集',
              cover: '',
              summary:
                '从响应式系统的设计目标出发，梳理依赖收集、派发更新与会话调度的完整链路，并对比 Vue 2 的实现差异。',
              tags: [
                { id: 1, name: 'Vue' },
                { id: 2, name: '源码' },
              ],
              user: { id: 9, userName: '阿燃', avatar: '' },
              viewCount: isHot ? 12800 : 3421,
              likeCount: isHot ? 486 : 128,
              favoriteCount: isHot ? 231 : 64,
              commentCount: isHot ? 57 : 23,
              createTime: isHot ? '2025-01-03 09:30:00' : '2025-01-05 14:20:00',
            },
            {
              id: isHot ? 22 : 2,
              title: isHot
                ? '浏览器渲染原理：从解析到合成'
                : 'Vite 构建优化：从 8 分钟到 40 秒',
              cover: '',
              summary:
                '拆解关键渲染路径的每个阶段，理解重排与重绘的触发条件，并给出可落地的优化手段。',
              tags: [
                { id: 3, name: '工程化' },
                { id: 4, name: '性能' },
              ],
              user: { id: 10, userName: '小林', avatar: '' },
              viewCount: isHot ? 9600 : 2108,
              likeCount: isHot ? 372 : 89,
              favoriteCount: isHot ? 180 : 41,
              commentCount: isHot ? 44 : 12,
              createTime: isHot ? '2025-01-02 16:45:00' : '2025-01-04 11:05:00',
            },
          ],
        },
      }),
    )
  }
  res.statusCode = 404
  res.end(JSON.stringify({ code: 404, message: 'not found', data: null }))
})
await new Promise((r) => stub.listen(stubPort, r))

/* Vite：代理到桩服务 */
const vite = await createServer({
  server: {
    port: 5200,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${stubPort}`, changeOrigin: true } },
  },
  logLevel: 'error',
})
await vite.listen()

const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--remote-debugging-port=9337',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1440,1000',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try {
    const r = await fetch('http://127.0.0.1:9337/json/version')
    if (r.ok) break
  } catch {
    /* 等待 */
  }
}

const targets = await (await fetch('http://127.0.0.1:9337/json/list')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const call = async (method, params) => {
  const m = await send(method, params)
  if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`)
  return m.result
}

await call('Page.enable')
await call('Runtime.enable')
await fs.mkdir(OUT_DIR, { recursive: true })

async function shoot(name, opts = {}) {
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: opts.fullPage ?? true,
    ...(opts.clip ? { clip: opts.clip } : {}),
  })
  const file = path.join(OUT_DIR, name)
  await fs.writeFile(file, Buffer.from(shot.data, 'base64'))
  const { size } = await fs.stat(file)
  console.log(`  ✓ 已保存 ${name} (${(size / 1024).toFixed(1)} KB)`)
  return file
}

/* ==================== 1. 未登录首页 ==================== */
console.log('\n--- 截图 ---')
await call('Page.navigate', { url: 'http://localhost:5200/' })
await new Promise((r) => setTimeout(r, 3000))
await shoot('home-guest.png')

/* ==================== 2. 登录态首页 ==================== */
console.log('\n[登录态 Header]')

// 先注入 token，再重新加载
await call('Page.navigate', { url: 'http://localhost:5200/' })
await new Promise((r) => setTimeout(r, 800))
await call('Runtime.evaluate', {
  expression: `localStorage.setItem('codemind_token', 'fake-jwt-for-screenshot')`,
})
await call('Page.navigate', { url: 'http://localhost:5200/' })
await new Promise((r) => setTimeout(r, 3000))

const state = await call('Runtime.evaluate', {
  expression: `(() => {
    const q = (s) => document.querySelector(s)
    return JSON.stringify({
      hasUserMenu: !!q('.cm-header__user'),
      userName: q('.cm-header__username')?.textContent?.trim() ?? null,
      badge: q('.cm-header__badge')?.textContent?.trim() ?? null,
      hasBell: !!q('.cm-header__icon-btn'),
      loginBtnGone: ![...document.querySelectorAll('.cm-header__actions .el-button')].some(b => b.textContent.includes('登录')),
      cardCount: document.querySelectorAll('.cm-article-card').length,
      firstTitle: q('.cm-article-card__title')?.textContent?.trim() ?? null,
      viewText: q('.cm-article-card__stat span')?.textContent?.trim() ?? null,
    })
  })()`,
  returnByValue: true,
})
console.log('  ', state.result.value)

await shoot('home-logged-in.png')

// 只截 Header 区域，便于看清细节
await shoot('header-detail.png', {
  fullPage: false,
  clip: { x: 0, y: 0, width: 1440, height: 56, scale: 2 },
})

/* ==================== 3. 打开用户下拉菜单 ==================== */
console.log('\n[用户下拉菜单]')
await call('Runtime.evaluate', { expression: `document.querySelector('.cm-header__user').click()` })
await new Promise((r) => setTimeout(r, 700))

const menu = await call('Runtime.evaluate', {
  expression: `JSON.stringify([...document.querySelectorAll('.el-dropdown-menu__item')].map(i => i.textContent.trim()))`,
  returnByValue: true,
})
console.log('  菜单项：', menu.result.value)
await shoot('header-dropdown.png')

/* ==================== 4. 移动端视图 ==================== */
console.log('\n[窄屏适配]')
await call('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await call('Page.navigate', { url: 'http://localhost:5200/' })
await new Promise((r) => setTimeout(r, 2500))

const mobile = await call('Runtime.evaluate', {
  expression: `(() => {
    const q = (s) => document.querySelector(s)
    const burger = q('.cm-header__hamburger')
    return JSON.stringify({
      navHidden: q('.cm-header__nav') ? getComputedStyle(q('.cm-header__nav')).display : null,
      burgerVisible: burger ? getComputedStyle(burger).display !== 'none' : false,
      logoTextHidden: q('.cm-header__logo-text') ? getComputedStyle(q('.cm-header__logo-text')).display === 'none' : null,
    })
  })()`,
  returnByValue: true,
})
console.log('  ', mobile.result.value)
await shoot('home-mobile.png', { fullPage: false })

chrome.kill()
await vite.close()
stub.close()
try {
  await fs.rm(profileDir, { recursive: true, force: true })
} catch {
  /* 忽略 */
}
console.log('\n完成。')
process.exit(0)
