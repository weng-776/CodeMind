/**
 * T3 验收：社区列表（真实后端）
 * ------------------------------------------------------------------
 * 覆盖工单 T3 的验收项：
 *   1. URL 与页面状态一致：?tab=hot、?tagId=3（无 tab）、?tab=latest&page=2
 *   2. 点标签 → URL 带 tab=tag&tagId=x，且请求打到 /api/article/tag/{id}
 *   3. 分页读响应的 current / total / pages（响应里没有 page）
 *   4. 四个 tab 与接口一一对应：latest→3.18 / hot→3.17 / all→3.5 / tag→3.19
 *   5. 快速切 tab 丢弃过期响应（用 CDP Fetch 把 hot 请求扣住 1.5s 再放行）
 *   6. 标签占位元素（id/name 为 null）不渲染
 *   7. 后端不可达 → 错误态 + 重试，不白屏
 *
 * 前置：后端 8080。用法：node scripts/verify-t3-article-list.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launchBrowser, createReporter, sleep, waitFor } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
const PORT = 5212
const DEAD_PORT = 5213
const DEBUG_PORT = 9348
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

const { check, summary } = createReporter()

try {
  const status = await fetch(`${BACKEND}/api/article/latest`).then((r) => r.status)
  if (status !== 200) throw new Error(`latest=${status}`)
} catch (e) {
  console.log(`\n后端 ${BACKEND} 不可达：${e.message}\n请先启动后端。`)
  process.exit(1)
}

const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()
const viteDead = await createServer({
  server: {
    port: DEAD_PORT,
    strictPort: true,
    proxy: { '/api': { target: 'http://localhost:8100', changeOrigin: true } },
  },
  logLevel: 'error',
})
await viteDead.listen()

let browser
try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1280,1000' })
  const cdp = browser.cdp
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
  const reqUrls = (part) =>
    cdp.events
      .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes(part))
      .map((e) => e.params.request.url)
  const respBody = async (part) => {
    const hit = cdp.events
      .filter((e) => e.method === 'Network.responseReceived' && e.params.response.url.includes(part))
      .map((e) => e.params.requestId)[0]
    if (!hit) return null
    try {
      const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId: hit })
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  const view = () =>
    cdp.evaluate(`({
      path: location.pathname + location.search,
      activeTab: document.querySelector('.cm-tabs__item.is-active')?.textContent?.trim() ?? null,
      tagPill: document.querySelector('.cm-tabs__item.is-tag')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      cards: document.querySelectorAll('.cm-article-card').length,
      firstTitle: document.querySelector('.cm-article-card__title')?.textContent?.trim() ?? null,
      tagChips: document.querySelectorAll('.cm-article-card__tag').length,
      emptyText: document.querySelector('.cm-empty, [class*="empty"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      pagerActive: document.querySelector('.el-pager .is-active')?.textContent?.trim() ?? null,
      hasRetry: [...document.querySelectorAll('button')].some(b => /重新加载|重试/.test(b.textContent)),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`)

  /* ==================== 1. ?tab=hot ==================== */
  console.log('\n[1] ?tab=hot')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/articles?tab=hot`)
  const hot = await view()
  const hotBody = await respBody('/api/article/hot')
  console.log(`    请求：${reqUrls('/api/article/hot')[0]}`)
  console.log(`    响应 data 字段：${Object.keys(hotBody?.data ?? {}).join(',')}`)
  console.log(`    current=${hotBody?.data?.current} total=${hotBody?.data?.total} pages=${hotBody?.data?.pages}`)
  check('打到 /api/article/hot', reqUrls('/api/article/hot').length >= 1)
  check('tab 高亮=热门', hot.activeTab === '热门', `实际 ${hot.activeTab}`)
  check('URL 保留 ?tab=hot', hot.path.includes('tab=hot'), `实际 ${hot.path}`)
  check('渲染出文章卡片', hot.cards > 0, `实际 ${hot.cards}`)
  await shoot('t3-1-tab-hot.png')

  /* ==================== 2. 只有 tagId、没有 tab ==================== */
  console.log('\n[2] ?tagId=3（无 tab，旧链接兼容）')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/articles?tagId=3`)
  const tagOnly = await view()
  const tagBody = await respBody('/api/article/tag/3')
  console.log(`    请求：${reqUrls('/api/article/tag/3')[0]}`)
  console.log(`    响应 current=${tagBody?.data?.current} total=${tagBody?.data?.total} records=${tagBody?.data?.records?.length}`)
  check('自动按 tag 处理，打到 /api/article/tag/3', reqUrls('/api/article/tag/3').length >= 1)
  check('出现标签筛选态 pill', !!tagOnly.tagPill, `实际 ${tagOnly.tagPill}`)
  check('没有被静默回落到「最新」', '最新' !== tagOnly.activeTab, `实际高亮=${tagOnly.activeTab}`)
  await shoot('t3-2-tagid-only.png')

  /* ==================== 3. ?tab=latest&page=2 ==================== */
  console.log('\n[3] ?tab=latest&page=999（远超总页数，必然越界）')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/articles?tab=latest&page=999`)
  const p2 = await view()
  const latestBody = await respBody('/api/article/latest')
  console.log(`    请求：${reqUrls('/api/article/latest')[0]}`)
  console.log(`    响应：${JSON.stringify({ ...latestBody?.data, records: `[${latestBody?.data?.records?.length} 条]` })}`)
  check('请求带 page=999', (reqUrls('/api/article/latest')[0] ?? '').includes('page=999'))
  check('响应里没有 page 字段', latestBody && !('page' in latestBody.data), `字段：${Object.keys(latestBody?.data ?? {}).join(',')}`)
  check('响应有 current/total/pages', ['current', 'total', 'pages'].every((k) => k in (latestBody?.data ?? {})))
  check('URL 未被偷偷改写（仍是 page=999）', p2.path.includes('page=999'), `实际 ${p2.path}`)
  check('给出越界态而不是「社区没文章」', /这一页没有内容/.test(p2.emptyText ?? ''), `实际 ${p2.emptyText}`)
  await shoot('t3-3-latest-page2.png')

  /* ==================== 4. 四个 tab 与接口对应 ==================== */
  console.log('\n[4] ?tab=all → 3.5 /api/article/list')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/articles?tab=all`)
  const all = await view()
  const allBody = await respBody('/api/article/list')
  console.log(`    请求：${reqUrls('/api/article/list')[0]}`)
  console.log(`    响应 current=${allBody?.data?.current} total=${allBody?.data?.total}`)
  check('打到 /api/article/list（3.5）', reqUrls('/api/article/list').length >= 1)
  check('tab 高亮=全部', all.activeTab === '全部', `实际 ${all.activeTab}`)
  check('渲染出文章卡片', all.cards > 0, `实际 ${all.cards}`)

  /* ==================== 5. 点标签跳转 ==================== */
  console.log('\n[5] 点卡片上的标签 → 按标签筛选')
  cdp.clearEvents()
  await goto(`http://localhost:${PORT}/articles`)
  const beforeTag = await view()
  check('卡片上渲染出了标签（占位元素已过滤）', beforeTag.tagChips > 0, `实际 ${beforeTag.tagChips} 个`)
  const emptyChips = await cdp.evaluate(
    `[...document.querySelectorAll('.cm-article-card__tag')].filter(b => !b.textContent.trim()).length`,
  )
  check('没有空白标签胶囊（id/name 为 null 的不渲染）', emptyChips === 0, `实际 ${emptyChips} 个空白`)

  // 后端返回的封面地址可能 404（MinIO 里没有对应对象）→ 不应露出破损图/alt 文字
  await sleep(1200)
  const brokenCovers = await cdp.evaluate(
    `[...document.querySelectorAll('.cm-article-card__cover img')].filter(i => i.complete && i.naturalWidth === 0).length`,
  )
  check('封面取不到时不露破损图', brokenCovers === 0, `实际 ${brokenCovers} 张破损图`)

  const tagName = await cdp.evaluate(`(() => {
    const b = document.querySelector('.cm-article-card__tag')
    if (!b) return null
    b.click()
    return b.textContent.trim()
  })()`)
  await sleep(2200)
  const afterTag = await view()
  const tagReq = reqUrls('/api/article/tag/')
  console.log(`    点了标签「${tagName}」→ URL：${afterTag.path}`)
  console.log(`    请求：${tagReq[0]}`)
  check('URL 带 tab=tag & tagId', /tab=tag/.test(afterTag.path) && /tagId=\d+/.test(afterTag.path), `实际 ${afterTag.path}`)
  check('URL 带 tagName', /tagName=/.test(afterTag.path), `实际 ${afterTag.path}`)
  check('请求打到 /api/article/tag/{id}', tagReq.length >= 1, `实际 ${tagReq.length} 次`)
  check('列表按标签过滤后有结果', afterTag.cards > 0, `实际 ${afterTag.cards} 张卡`)
  await shoot('t3-4-tag-click.png')
  await fs.writeFile(
    path.join(OUT_DIR, 't3-list-api-evidence.json'),
    JSON.stringify(
      {
        tabHot: { url: reqUrls('/api/article/hot')[0] ?? null, current: hotBody?.data?.current, total: hotBody?.data?.total, pages: hotBody?.data?.pages },
        tagOnly: { url: reqUrls('/api/article/tag/3')[0] ?? null, current: tagBody?.data?.current, total: tagBody?.data?.total },
        latestPage2: { url: reqUrls('/api/article/latest')[0] ?? null, body: latestBody?.data ? { ...latestBody.data, records: `[${latestBody.data.records?.length} 条]` } : null },
        tabAll: { url: reqUrls('/api/article/list')[0] ?? null, current: allBody?.data?.current, total: allBody?.data?.total },
        tagClick: { url: tagReq[0] ?? null, path: afterTag.path, tagName },
      },
      null,
      2,
    ),
  )

  /* ==================== 6. 丢弃过期响应 ==================== */
  console.log('\n[6] 快速切 tab：把 hot 请求扣住 1.5s 再放行，看它会不会覆盖最新')
  await goto(`http://localhost:${PORT}/articles`)
  const baseline = await view()
  const latestFirstTitle = baseline.firstTitle
  console.log(`    最新页首条：${latestFirstTitle}`)

  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/article/hot*', requestStage: 'Request' }] })
  const handled = new Set()
  let stopPoller = false
  ;(async () => {
    while (!stopPoller) {
      const paused = cdp.events.filter(
        (e) => e.method === 'Fetch.requestPaused' && !handled.has(e.params.requestId),
      )
      for (const p of paused) {
        handled.add(p.params.requestId)
        setTimeout(() => {
          cdp.send('Fetch.continueRequest', { requestId: p.params.requestId }).catch(() => {})
        }, 1500)
      }
      await sleep(80)
    }
  })()

  // 点「热门」（请求被扣住）→ 立刻切回「最新」（正常返回）
  await cdp.evaluate(`[...document.querySelectorAll('.cm-tabs__item')].find(b => b.textContent.trim() === '热门').click()`)
  await sleep(300)
  await cdp.evaluate(`[...document.querySelectorAll('.cm-tabs__item')].find(b => b.textContent.trim() === '最新').click()`)
  await sleep(1200)
  const midState = await view()
  check('切回最新后展示的是最新数据', midState.firstTitle === latestFirstTitle, `实际 ${midState.firstTitle}`)
  // 等被扣住的 hot 请求放行并返回
  await sleep(2500)
  const afterStale = await view()
  console.log(`    迟到的 hot 响应到达后，首条仍是：${afterStale.firstTitle}`)
  check('迟到的 hot 响应被丢弃（没覆盖最新）', afterStale.firstTitle === latestFirstTitle, `实际 ${afterStale.firstTitle}`)
  check('tab 高亮仍是「最新」', afterStale.activeTab === '最新', `实际 ${afterStale.activeTab}`)
  await shoot('t3-5-stale-response.png')
  stopPoller = true
  await cdp.send('Fetch.disable')

  /* ==================== 7. 后端不可达 ==================== */
  console.log('\n[7] 后端不可达 → 错误态 + 重试')
  await goto(`http://localhost:${DEAD_PORT}/articles`, 3500)
  await sleep(1200)
  const down = await view()
  const downText = await cdp.evaluate(`document.body.innerText.slice(0, 300)`)
  check('出现错误态', /加载失败/.test(downText), downText.replace(/\s+/g, ' ').slice(0, 120))
  check('有重试按钮', down.hasRetry === true)
  check('没有横向溢出（未白屏/未错位）', down.overflowX <= 0, `overflowX=${down.overflowX}`)
  await shoot('t3-6-backend-down.png')

  /* ==================== 8. 运行时健康度 ==================== */
  console.log('\n[8] 运行时健康度')
  const exceptions = cdp.exceptions()
  const consoleErrs = cdp.consoleErrors().filter((t) => !/Failed to load resource|ERR_|net::/i.test(t))
  check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
  check('无 console.error（资源加载失败除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
} finally {
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
    await viteDead?.close()
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
console.log(`截图与接口证据已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
