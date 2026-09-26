/**
 * 组件真实挂载测试
 * ------------------------------------------------------------------
 * 上一个脚本只验证「能编译」，这个脚本验证「能运行」：
 * 用 jsdom + 真实 Vue runtime 把组件渲出来，捕获渲染期异常。
 *
 * 实现要点：
 *   - Vue 运行时 / vue-router / Element Plus 直接从 node_modules 静态 import
 *     （走 Node 原生解析，避免 Vite SSR 通道碰到 CJS 入口报 module is not defined）
 *   - 只有 .vue 单文件组件走 Vite 的 ssrLoadModule，让 Vite 负责 SFC 编译与 @ 别名
 *
 * 用法：node scripts/verify-render.mjs
 */
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createRouter, createMemoryHistory } from 'vue-router'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

/* ---------- 1. 先建立 DOM（组件里可能访问 window/document） ---------- */
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
})

globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 22 的 navigator 是只读 getter，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
})
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.SVGElement = dom.window.SVGElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.getComputedStyle = dom.window.getComputedStyle
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.CustomEvent = dom.window.CustomEvent
globalThis.ResizeObserver =
  dom.window.ResizeObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
globalThis.IntersectionObserver =
  dom.window.IntersectionObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 构造一个最小 router，供组件内部的 useRouter/useRoute 使用 */
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div/>' } },
      { path: '/articles', name: 'article-list', component: { template: '<div/>' } },
      { path: '/articles/:id(\\d+)', name: 'article-detail', component: { template: '<div/>' } },
      { path: '/user/:userId(\\d+)', name: 'user-profile', component: { template: '<div/>' } },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: { template: '<div/>' } },
    ],
  })
}

/** 挂载并渲染，返回 { html, error } */
async function renderComponent(comp, props = {}) {
  const app = createSSRApp(comp, props)
  app.use(makeRouter())
  // 复刻 main.ts 的全局注册：Element Plus + 全部图标，
  // 否则 el-button / el-icon 解析不到，测出来的不是真实运行结果
  app.use(ElementPlus)
  for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(name, component)
  }
  try {
    const html = await renderToString(app)
    return { html, error: null }
  } catch (error) {
    return { html: '', error }
  }
}

async function main() {
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })

  try {
    // 只有 .vue 走 Vite，别名与 SFC 编译交给它
    const EmptyState = (await vite.ssrLoadModule('/src/components/common/EmptyState.vue')).default
    const ErrorState = (await vite.ssrLoadModule('/src/components/common/ErrorState.vue')).default
    const LoadingState = (await vite.ssrLoadModule('/src/components/common/LoadingState.vue')).default
    const ArticleCard = (await vite.ssrLoadModule('/src/components/article/ArticleCard.vue')).default

    console.log('\n--- 组件真实挂载（jsdom + Vue SSR 渲染） ---')

    /* ==================== EmptyState ==================== */
    console.log('\n[EmptyState]')
    {
      const { html, error } = await renderComponent(EmptyState, {
        title: '还没有内容',
        description: '快去写下第一篇',
      })
      check('渲染无异常', !error, error?.message ?? '')
      check('渲染出标题', html.includes('还没有内容'))
      check('渲染出描述', html.includes('快去写下第一篇'))
    }

    /* ==================== ErrorState ==================== */
    console.log('\n[ErrorState]')
    {
      const { html, error } = await renderComponent(ErrorState, { title: '加载失败' })
      check('渲染无异常', !error, error?.message ?? '')
      check('渲染出标题', html.includes('加载失败'))
      check('渲染出重试按钮', html.includes('重新加载'))
    }

    /* ==================== LoadingState ==================== */
    console.log('\n[LoadingState]')
    {
      const skeleton = await renderComponent(LoadingState, { variant: 'skeleton', rows: 3 })
      check('骨架屏渲染无异常', !skeleton.error, skeleton.error?.message ?? '')
      const rowCount = (skeleton.html.match(/cm-skeleton__row/g) ?? []).length
      check('骨架屏渲染 3 行', rowCount === 3, `实际 ${rowCount} 行`)
      check('骨架屏带微光动画类', skeleton.html.includes('cm-shimmer'))

      const spinner = await renderComponent(LoadingState, { variant: 'spinner', text: '努力加载中' })
      check('转圈态渲染无异常', !spinner.error, spinner.error?.message ?? '')
      check('转圈态显示文案', spinner.html.includes('努力加载中'))
    }

    /* ==================== ArticleCard 正常数据 ==================== */
    console.log('\n[ArticleCard · 正常数据]')
    {
      const { html, error } = await renderComponent(ArticleCard, {
        article: {
          id: 101,
          title: '深入理解 Vue 3 响应式原理',
          cover: '',
          summary: '从 Proxy 与 effect 出发，梳理依赖收集与派发的完整链路。',
          tags: [
            { id: 1, name: 'Vue' },
            { id: 2, name: '源码' },
          ],
          user: { id: 9, userName: '阿燃', avatar: '' },
          viewCount: 12500,
          likeCount: 340,
          favoriteCount: 88,
          commentCount: 21,
          createTime: '2025-01-01 12:00:00',
        },
      })
      check('渲染无异常', !error, error?.message ?? '')
      check('渲染标题', html.includes('深入理解 Vue 3 响应式原理'))
      check('渲染摘要', html.includes('从 Proxy 与 effect 出发'))
      check('渲染作者名', html.includes('阿燃'))
      check('渲染标签 Vue / 源码', html.includes('Vue') && html.includes('源码'))
      check('浏览量 12500 缩写为 1.3万', html.includes('1.3万'))
      check('渲染评论数 21', html.includes('21'))
      check('有键盘可达语义 tabindex=0', html.includes('tabindex="0"'))
      check('时间已相对化（不再显示原始串）', !html.includes('2025-01-01 12:00:00'))
    }

    /* ==================== ArticleCard 边界：字段缺失 ==================== */
    console.log('\n[ArticleCard · 字段缺失]')
    {
      const { html, error } = await renderComponent(ArticleCard, {
        article: {
          id: 2,
          title: '只有标题的最简文章',
          cover: '',
          summary: '',
          tags: [],
          viewCount: 0,
          likeCount: 0,
          favoriteCount: 0,
          commentCount: 0,
          createTime: '2025-01-01 00:00:00',
        },
      })
      check('不抛异常', !error, error?.message ?? '')
      check('仍渲染标题', html.includes('只有标题的最简文章'))
      check('统计显示 0', html.includes('0'))
      check('无作者时不渲染作者节点', !html.includes('cm-article-card__author"'))
    }

    /* ==================== ArticleCard 边界：草稿 / 排名 / 封面 / 标签溢出 ==================== */
    console.log('\n[ArticleCard · 草稿 + 排名 + 封面 + 标签溢出]')
    {
      const { html, error } = await renderComponent(ArticleCard, {
        article: {
          id: 3,
          title: '草稿文章',
          cover: 'https://example.com/cover.png',
          summary: '摘要',
          status: 0,
          tags: [
            { id: 1, name: 'T1' },
            { id: 2, name: 'T2' },
            { id: 3, name: 'T3' },
            { id: 4, name: 'T4' },
            { id: 5, name: 'T5' },
          ],
          user: { id: 1, userName: '作者', avatar: '' },
          viewCount: 1,
          likeCount: 1,
          favoriteCount: 1,
          commentCount: 1,
          createTime: '2025-06-01 10:00:00',
        },
        showStatus: true,
        variant: 'compact',
        rank: 1,
        showCover: true,
      })
      check('渲染无异常', !error, error?.message ?? '')
      check('草稿角标渲染', html.includes('草稿'))
      check('排名序号渲染', html.includes('cm-article-card__rank'))
      check('5 个标签折为 4 + "+1"', html.includes('+1'))
      check('封面图渲染', html.includes('example.com/cover.png'))
      check('compact 密度类名生效', html.includes('cm-article-card--compact'))
      check('草稿态类名生效', html.includes('is-draft'))
    }

    /* ==================== ArticleCard 边界：未来时间 ==================== */
    console.log('\n[ArticleCard · 服务端时间超前]')
    {
      const future = new Date(Date.now() + 60 * 60 * 1000)
      const pad = (n) => String(n).padStart(2, '0')
      const stamp = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())} ${pad(future.getHours())}:${pad(future.getMinutes())}:00`

      const { html, error } = await renderComponent(ArticleCard, {
        article: {
          id: 4,
          title: '时间超前的文章',
          cover: '',
          summary: '',
          tags: [],
          viewCount: 0,
          likeCount: 0,
          favoriteCount: 0,
          commentCount: 0,
          createTime: stamp,
        },
      })
      check('渲染无异常', !error, error?.message ?? '')
      check('未来时间显示为「刚刚」而非负数', html.includes('刚刚'), `原始时间 ${stamp}`)
    }
  } finally {
    await vite.close()
  }

  console.log(`\n========== 通过 ${pass}，失败 ${fail} ==========\n`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('测试脚本自身异常：', err)
  process.exit(1)
})
