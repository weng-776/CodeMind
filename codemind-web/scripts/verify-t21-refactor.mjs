/**
 * T21 验收：管理端瘦身（抽 AdminPageHead + 拆三个表格子组件）
 * ------------------------------------------------------------------
 * 本单是**纯重构，行为必须零变化**，所以这个脚本的重点不是「功能对不对」，
 * 而是**「重构前后长得一模一样」**。两种模式：
 *
 *   1) 重构**前**跑（把重构前的基准存下来）：
 *        node scripts/verify-t21-refactor.mjs --before
 *      → 存 4 个管理页的截图 `t21-before-<page>.png` + 样式指纹 `t21-before-snapshot.json`
 *
 *   2) 重构**后**跑（默认）：
 *        node scripts/verify-t21-refactor.mjs
 *      → 重新截图 `t21-after-<page>.png`，与基准逐项比对：
 *        · 页头 3 个元素（eyebrow / 标题 / 描述）的**计算样式 + 几何 + 文本**完全一致
 *        · 页头区域**逐像素**对比，差异像素必须为 0
 *        · 表格 / 标签的计算样式（字号、颜色、边框、圆角…）完全一致
 *        · 行数硬指标、数据终态
 *
 * 为什么要存「指纹」而不只比图片：截图里的数据是动态的（计数、时间戳会变），
 * 整页像素差必然非 0，说明不了问题。真正要钉死的是**页头的样式与几何** ——
 * 那正是本单改的东西（§0.6 T21 验收项点名要看 eyebrow 字号/字距、标题字重、
 * 描述行宽 max-width: 60ch）。
 *
 * 前置：后端 8080 在跑。
 * 用法（package.json 在禁止清单里，用绝对路径跑）：
 *   "/c/Users/翁甲燃/.workbuddy/binaries/node/versions/22.22.2-3/node" scripts/verify-t21-refactor.mjs --before
 *   "/c/Users/翁甲燃/.workbuddy/binaries/node/versions/22.22.2-3/node" scripts/verify-t21-refactor.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

import { createReporter, launchBrowser, sleep } from './lib/cdp-harness.mjs'

const BACKEND = process.env.API_TARGET || 'http://localhost:8080'
/** 端口与既有脚本错开（… T20=5231/9365） */
const PORT = 5232
const DEBUG_PORT = 9366
const OUT_DIR = path.resolve(process.cwd(), 'docs/screenshots')
const SNAPSHOT_PATH = path.join(OUT_DIR, 't21-before-snapshot.json')

/**
 * 本单的**回归编排**清单（`--all` 模式依次跑）。
 *
 * 为什么用 `spawnSync` 而不是 shell 里串起来：MEMORY 里记过一条实测 ——
 * 「一条命令里串跑多套浏览器测试会被 SIGTERM 掐掉」，所以每个脚本都单独起进程、
 * 顺序等待，跑完一个再起下一个。
 *
 * 期望值只做**下限提示**：T17/T18/T19 因为本单补了清理断言，通过数会比原来多
 * （核验方 §12.4 建议的修复），所以这里不硬编码「必须等于某个数」，
 * 只要求**失败数为 0**。
 */
const REGRESSION_SCRIPTS = [
  { file: 'verify-t16-admin.mjs', note: '管理端 看板（基线 45）' },
  { file: 'verify-t17-admin.mjs', note: '管理端 用户治理（基线 80 + 清理断言）' },
  { file: 'verify-t18-admin.mjs', note: '管理端 内容治理（基线 110 + 清理断言）' },
  { file: 'verify-t19-admin.mjs', note: '管理端 死信队列（基线 60 + 清理断言）' },
  { file: 'verify-layout.mjs', note: '桩回归 布局（基线 36）' },
  { file: 'verify-render.mjs', note: '桩回归 渲染（基线 33）' },
  { file: 'verify-login.mjs', note: '桩回归 登录（基线 43）' },
]

/**
 * 跑一个子脚本，收集输出与退出码。
 *
 * ⚠️ 必须用**异步 `spawn`**，不能用 `spawnSync`：
 *    本机（Windows + 沙箱）实测 `spawnSync(node, ...)` 直接抛 `EBUSY`（子进程起不来，
 *    退出码 `null`、输出为空），而异步 `spawn` 正常。
 */
function runScript(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('scripts', file)], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', (e) => resolve({ status: null, out, error: `${e.code ?? ''} ${e.message}` }))
    child.on('close', (code) => resolve({ status: code, out, error: '' }))
  })
}

/** `--all`：依次跑上面 7 个脚本，汇总退出码与通过数 */
async function runAllRegressions() {
  console.log('\n===== T21 回归编排（--all）：依次跑 7 个既有脚本 =====')
  const results = []
  for (const item of REGRESSION_SCRIPTS) {
    const started = Date.now()
    console.log(`\n---------- ${item.file}（${item.note}）----------`)
    const res = await runScript(item.file)
    const out = res.out ?? ''
    const spawnError = res.error ?? ''
    const summary = out.match(/通过\s*(\d+)，失败\s*(\d+)/)
    const failedLines = out
      .split('\n')
      .filter((l) => l.trim().startsWith('✗'))
      .slice(0, 5)
    const pass = summary ? Number(summary[1]) : null
    const failCount = summary ? Number(summary[2]) : null
    const ok = res.status === 0 && failCount === 0
    results.push({ ...item, status: res.status, pass, fail: failCount, ok })
    console.log(
      `  → 退出码 ${res.status}｜通过 ${pass ?? '?'}，失败 ${failCount ?? '?'}｜${ok ? '✅ 绿' : '❌ 红'}｜耗时 ${Math.round((Date.now() - started) / 1000)}s`,
    )
    if (spawnError) console.log(`     ⚠ 子进程启动失败：${spawnError}`)
    failedLines.forEach((l) => console.log(`     ${l.trim()}`))
    if (!summary) {
      // 脚本没跑到汇总（崩了/前置失败），把尾部输出打出来
      console.log(`     尾部输出：${out.trim().split('\n').slice(-6).join(' / ')}`)
    }
  }

  console.log('\n===== 回归编排汇总 =====')
  results.forEach((r) => {
    console.log(
      `  ${r.ok ? '✅' : '❌'} ${r.file.padEnd(26)} 退出码=${String(r.status).padStart(3)} 通过=${String(r.pass ?? '?').padStart(4)} 失败=${String(r.fail ?? '?').padStart(3)}`,
    )
  })
  const red = results.filter((r) => !r.ok)
  console.log(`\n共 ${results.length} 个脚本，绿 ${results.length - red.length}，红 ${red.length}`)
  return red.length
}

if (process.argv.includes('--all')) {
  const red = await runAllRegressions()
  process.exit(red > 0 ? 1 : 0)
}

const MODE = process.argv.includes('--before') ? 'before' : 'after'

const ADMIN = { phone: '13800000002', password: '123456' }

/** 4 个管理页（key 用于文件名） */
const PAGES = [
  { key: 'dashboard', route: '/admin', title: '数据看板' },
  { key: 'users', route: '/admin/users', title: '用户治理' },
  { key: 'content', route: '/admin/content', title: '内容治理' },
  { key: 'mq', route: '/admin/mq', title: '死信队列' },
]

/** 重构后的行数硬指标 */
const LINE_LIMIT = 1000
/** 重构前各页行数（§0.6 T21 目标栏给的基线；脚本会自己再量一次做对比） */
const BEFORE_LINE_COUNTS = {
  'src/views/admin/AdminDashboardView.vue': 300,
  'src/views/admin/AdminUserView.vue': 625,
  'src/views/admin/AdminMqView.vue': 643,
}

const { check, summary } = createReporter()

/* ==================== 极简 PNG 解码（只为逐像素对比，不引第三方依赖） ==================== */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`不支持的 PNG 格式：depth=${bitDepth} colorType=${colorType}`)
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = cur[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        v = (v + pred) & 0xff
      } else if (filter !== 0) {
        throw new Error(`未知的 PNG filter：${filter}`)
      }
      cur[x] = v
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, channels, data: out }
}

/** 数出两张图在指定区域里**颜色不同**的像素数 */
function diffRegion(a, b, region) {
  if (a.width !== b.width || a.height !== b.height) {
    return { diff: -1, reason: `尺寸不同 ${a.width}x${a.height} vs ${b.width}x${b.height}` }
  }
  const x0 = Math.max(0, region.x)
  const y0 = Math.max(0, region.y)
  const x1 = Math.min(a.width, region.x + region.w)
  const y1 = Math.min(a.height, region.y + region.h)
  let diff = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const ia = (y * a.width + x) * a.channels
      const ib = (y * b.width + x) * b.channels
      if (
        a.data[ia] !== b.data[ib] ||
        a.data[ia + 1] !== b.data[ib + 1] ||
        a.data[ia + 2] !== b.data[ib + 2]
      ) {
        diff += 1
      }
    }
  }
  return { diff, reason: '' }
}

/* ==================== 前置：后端可达 ==================== */
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
  body: JSON.stringify({ phone: ADMIN.phone, password: ADMIN.password }),
}).then((r) => r.json())
const adminToken = loginRes?.data?.token
if (typeof adminToken !== 'string') {
  console.log(`\n管理员登录失败：${JSON.stringify(loginRes)}`)
  process.exit(1)
}

if (MODE === 'before') {
  console.log('\n===== T21 基准快照模式（--before）：重构前跑，存样式指纹 + 截图 =====')
} else {
  console.log('\n===== T21 对比模式：与 --before 存的基准逐项比对 =====')
}

/* ==================== 页面侧：样式指纹 ==================== */
/**
 * 页头元素要**全量**比（计算样式 + 几何 + 文本）—— 它就是本单改的东西。
 * 表格/标签只比**计算样式**：内容是动态数据，几何和文本本来就会变。
 */
const HEAD_PROPS = [
  'fontSize',
  'fontFamily',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'color',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'maxWidth',
  'textAlign',
]
const TABLE_PROPS = [
  'fontSize',
  'fontFamily',
  'fontWeight',
  'color',
  'backgroundColor',
  'borderBottomColor',
  'borderBottomWidth',
  'borderTopColor',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'textAlign',
  'whiteSpace',
  'verticalAlign',
  'borderRadius',
  'lineHeight',
  'display',
]

/** 取某个选择器的计算样式 + 几何（+ 可选文本） */
const readFingerprint = () => {
  const expr = `(() => {
    const pick = (sel, props, withGeometry, withText) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const cs = getComputedStyle(el)
      const style = {}
      for (let i = 0; i < props.length; i += 1) {
        style[props[i]] = cs[props[i]]
      }
      const out = { style: style }
      if (withGeometry) {
        const r = el.getBoundingClientRect()
        out.geom = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }
      if (withText) {
        out.text = el.textContent.replace(/\\s+/g, ' ').trim()
      }
      return out
    }
    const styleOnly = (sel, props) => pick(sel, props, false, false)
    const HEAD = ${JSON.stringify(HEAD_PROPS)}
    const TABLE = ${JSON.stringify(TABLE_PROPS)}
    return {
      eyebrow: pick('.cm-admin__eyebrow', HEAD, true, true),
      title: pick('.cm-admin__title', HEAD, true, true),
      desc: pick('.cm-admin__desc', HEAD, true, true),
      headBox: (() => {
        const el = document.querySelector('.cm-admin__head')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      })(),
      table: styleOnly('.cm-table', TABLE),
      tableTh: styleOnly('.cm-table thead th', TABLE),
      tableTd: styleOnly('.cm-table tbody td', TABLE),
      tableTitle: styleOnly('.cm-table__title', TABLE),
      badge: styleOnly('.cm-badge', TABLE),
      authorName: styleOnly('.cm-author__name', TABLE),
    }
  })()`
  if (process.env.T21_DEBUG) {
    console.log('--- DEBUG 表达式前 14 行 ---')
    console.log(expr.split('\n').slice(0, 14).join('\n'))
    console.log('--- END ---')
  }
  return cdp.evaluate(expr)
}

/** 逐项比较两个指纹，返回不一致的字段列表 */
function compareFingerprint(before, after, prefix, label) {
  const problems = []
  const walk = (b, a, p) => {
    if (b === null && a === null) return
    if (b === null || a === null) {
      problems.push(`${p}：一侧为 null（before=${b === null ? 'null' : '有值'} / after=${a === null ? 'null' : '有值'}）`)
      return
    }
    if (typeof b !== 'object') {
      if (b !== a) problems.push(`${p}：${JSON.stringify(b)} → ${JSON.stringify(a)}`)
      return
    }
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    keys.forEach((k) => walk(b[k], a[k], `${p}.${k}`))
  }
  walk(before, after, label)
  return problems
}

/* ==================== Vite + Chrome ==================== */
const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await vite.listen()

let browser
let cdp

const captured = {}

try {
  browser = await launchBrowser({ debugPort: DEBUG_PORT, windowSize: '1440,1000' })
  cdp = browser.cdp
  await fs.mkdir(OUT_DIR, { recursive: true })

  const goto = async (url, wait = 2400) => {
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(150)
    await cdp.send('Page.navigate', { url })
    await sleep(wait)
  }

  // 用真实后端换来的 token 直接进（登录链路本身由 T1 覆盖，这里不重复测）
  await goto(`http://localhost:${PORT}/login`, 1500)
  await cdp.evaluate(`localStorage.setItem('codemind_token', ${JSON.stringify(adminToken)})`)

  for (const page of PAGES) {
    await goto(`http://localhost:${PORT}${page.route}`, 2800)
    const url = await cdp.evaluate(`location.pathname + location.search`)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const name = `t21-${MODE}-${page.key}.png`
    await fs.writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
    const fingerprint = await readFingerprint()
    captured[page.key] = { url, name, fingerprint }
    console.log(
      `  [${MODE}] ${page.route} → ${url}｜截图 ${name}｜headBox=${JSON.stringify(fingerprint?.headBox)}`,
    )
  }

  /* ==================== 基准模式：写快照就结束 ==================== */
  if (MODE === 'before') {
    await fs.writeFile(SNAPSHOT_PATH, JSON.stringify(captured, null, 2), 'utf8')
    console.log(`\n基准已写入 ${SNAPSHOT_PATH}`)
    console.log('接下来做重构，然后不带 --before 再跑一次本脚本。')
  } else {
    /* ==================== 对比模式 ==================== */
    console.log('\n[1] 视觉回归：页头样式 / 几何 / 文本 + 页头区域逐像素')
    let snapshot
    try {
      snapshot = JSON.parse(await fs.readFile(SNAPSHOT_PATH, 'utf8'))
    } catch {
      console.log(`\n读不到基准快照 ${SNAPSHOT_PATH}，请先用 --before 跑一次。`)
      process.exit(1)
    }

    for (const page of PAGES) {
      const before = snapshot[page.key]
      const after = captured[page.key]
      check(`${page.route} 基准存在`, Boolean(before), '快照里没有这一页')
      if (!before || !after) continue

      check(`${page.route} 仍停在 ${page.route}`, after.url.startsWith(page.route), after.url)

      // 页头样式 + 几何 + 文本
      const problems = compareFingerprint(before.fingerprint, after.fingerprint, page.key, page.title)
      check(`${page.title}：页头/表格样式与几何完全一致`, problems.length === 0, problems.slice(0, 6).join(' ｜ '))
      if (problems.length) problems.slice(0, 10).forEach((p) => console.log(`      · ${p}`))

      // 页头区域逐像素
      const box = before.fingerprint?.headBox
      if (box) {
        const region = { x: box.x, y: box.y, w: box.w, h: box.h }
        const a = decodePng(await fs.readFile(path.join(OUT_DIR, before.name)))
        const b = decodePng(await fs.readFile(path.join(OUT_DIR, after.name)))
        const { diff, reason } = diffRegion(a, b, region)
        console.log(`      ${page.title} 页头区域 ${JSON.stringify(region)} → 差异像素 ${diff}`)
        check(
          `${page.title}：页头区域逐像素无差异`,
          diff === 0,
          reason || `${diff} 个像素不同`,
        )
      }
    }

    /* ==================== 行数硬指标 ==================== */
    console.log('\n[2] 行数硬指标')
    const contentLines = (await fs.readFile('src/views/admin/AdminContentView.vue', 'utf8')).split('\n').length
    console.log(`    AdminContentView.vue = ${contentLines} 行（重构前 1070）`)
    check(`AdminContentView.vue < ${LINE_LIMIT}`, contentLines < LINE_LIMIT, `${contentLines} 行`)

    for (const [file, before] of Object.entries(BEFORE_LINE_COUNTS)) {
      const now = (await fs.readFile(file, 'utf8')).split('\n').length
      console.log(`    ${file.split('/').pop()} = ${now} 行（重构前 ${before}）`)
      check(`${file.split('/').pop()} 行数未增加`, now <= before, `${before} → ${now}`)
    }

    // 全项目：不再新增超 1000 行的 .vue
    const walk = async (dir) => {
      const out = []
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...(await walk(full)))
        else if (entry.name.endsWith('.vue')) out.push(full)
      }
      return out
    }
    const vues = await walk('src')
    const over = []
    for (const f of vues) {
      const n = (await fs.readFile(f, 'utf8')).split('\n').length
      if (n > LINE_LIMIT) over.push([f.replace(/\\/g, '/'), n])
    }
    console.log(`    超 ${LINE_LIMIT} 行的 .vue：${JSON.stringify(over)}`)
    const NEW_OVER = over.filter(([f]) => f.includes('/admin/'))
    check('管理端没有超 1000 行的 .vue', NEW_OVER.length === 0, JSON.stringify(NEW_OVER))
    check(
      '既有超标文件未增加（ArticleDetailView / NoteEditView 本单不许碰）',
      over.filter(([f]) => f.includes('ArticleDetailView') || f.includes('NoteEditView')).length === 2,
      JSON.stringify(over),
    )

    /* ==================== 结构硬指标 ==================== */
    console.log('\n[3] 结构：AdminPageHead 被 4 页共用，且不再重复页头样式')
    const headSrc = await fs.readFile('src/views/admin/components/AdminPageHead.vue', 'utf8')
    check('AdminPageHead.vue 存在且有 eyebrow/title/description', /eyebrow/.test(headSrc) && /title/.test(headSrc) && /description/.test(headSrc))
    check(
      'AdminPageHead 自带页头样式（eyebrow 字距 / 标题字重 / 描述 max-width）',
      /letter-spacing:\s*0\.14em/.test(headSrc) && /font-weight:\s*650/.test(headSrc) && /max-width:\s*60ch/.test(headSrc),
      '样式没跟过来',
    )

    for (const f of [
      'src/views/admin/AdminDashboardView.vue',
      'src/views/admin/AdminUserView.vue',
      'src/views/admin/AdminContentView.vue',
      'src/views/admin/AdminMqView.vue',
    ]) {
      const src = await fs.readFile(f, 'utf8')
      const name = f.split('/').pop()
      check(`${name} 使用了 AdminPageHead`, /<AdminPageHead/.test(src), '没找到 <AdminPageHead')
      check(
        `${name} 已删掉重复的页头样式`,
        !/\.cm-admin__eyebrow\s*\{/.test(src) && !/\.cm-admin__title\s*\{/.test(src) && !/\.cm-admin__desc\s*\{/.test(src),
        '仍残留 .cm-admin__eyebrow/__title/__desc 样式块',
      )
    }

    for (const f of [
      'src/views/admin/components/AdminArticleTable.vue',
      'src/views/admin/components/AdminNoteTable.vue',
      'src/views/admin/components/AdminCommentTable.vue',
    ]) {
      const exists = await fs
        .readFile(f, 'utf8')
        .then(() => true)
        .catch(() => false)
      check(`${f.split('/').pop()} 存在`, exists)
    }

    /* ==================== 数据终态 ==================== */
    console.log('\n[4] 数据终态')
    const headers = { token: adminToken }
    const queues = await fetch(`${BACKEND}/api/admin/mq/queues`, { headers }).then((r) => r.json())
    const backlog = (queues?.data ?? []).reduce((s, q) => s + (q.messageCount ?? 0), 0)
    console.log(`    6 个死信队列总积压 = ${backlog}`)
    check('6 个死信队列全 0', backlog === 0, String(backlog))
    check('队列数仍为 6', (queues?.data ?? []).length === 6, String((queues?.data ?? []).length))

    const dash = await fetch(`${BACKEND}/api/admin/dashboard/overview`, { headers }).then((r) => r.json())
    const d = dash?.data ?? {}
    const expect = { articleCount: 30, noteCount: 23, commentCount: 36, likeCount: 30, favoriteCount: 12 }
    console.log(`    看板 = ${JSON.stringify(d)}`)
    const bad = Object.entries(expect).filter(([k, v]) => d[k] !== v)
    check('看板内容计数 30 / 23 / 36 / 30 / 12', bad.length === 0, JSON.stringify(bad))

    /*
     * ⚠️ `userCount` 不能硬编码成 7。
     * T17 的脚本为了「分页」这一验收项（翻页器要 `total > 每页 10` 才渲染），
     * 会注册 `13500008801~13500008804` 四个账号把用户数顶到 11；
     * 而**后端没有删除用户的接口**，它们删不掉、会一直留在库里（已写进 T17 交接块）。
     * 所以这里按「7 + 实际存在的测试账号数」核对 —— 既不放过异常，
     * 也不把「预期内的测试账号」误判成失败。
     */
    const seedPhones = ['13500008801', '13500008802', '13500008803', '13500008804']
    let seedPresent = 0
    for (const phone of seedPhones) {
      const r = await fetch(`${BACKEND}/api/admin/users?keyword=${phone}`, { headers }).then((r) => r.json())
      if ((r?.data?.total ?? 0) > 0) seedPresent += 1
    }
    const expectUsers = 7 + seedPresent
    console.log(`    用户数：${d.userCount}（期望 7 + ${seedPresent} 个 T17 测试账号 = ${expectUsers}）`)
    check(
      `看板 userCount = 7 + ${seedPresent} 个测试账号（基线 7，T17 造数会留下账号）`,
      d.userCount === expectUsers,
      `${d.userCount} vs ${expectUsers}`,
    )
    check('今日新增全为 0（内容类）', ['todayArticleCount', 'todayNoteCount', 'todayCommentCount', 'todayLikeCount', 'todayFavoriteCount'].every((k) => d[k] === 0), JSON.stringify(d))

    /* ==================== 运行时健康度 ==================== */
    console.log('\n[5] 运行时健康度')
    const exceptions = cdp.exceptions()
    const consoleErrs = cdp
      .consoleErrors()
      .filter((t) => !/Failed to load resource|ERR_|net::|MinIO|404 \(Not Found\)/i.test(t))
    check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))
    check('无 console.error（网络/图片失败除外）', consoleErrs.length === 0, consoleErrs.slice(0, 2).join(' | '))
  }
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
    if (browser?.profileDir) await fs.rm(browser.profileDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

if (MODE === 'before') {
  console.log('\n基准快照完成（本模式不做断言）。')
  process.exit(0)
}

const fail = summary()
console.log(`截图已写入 ${OUT_DIR}`)
process.exit(fail > 0 ? 1 : 0)
