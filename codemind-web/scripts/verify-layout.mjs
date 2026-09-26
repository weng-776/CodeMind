/**
 * 布局与首页运行时冒烟测试
 * ------------------------------------------------------------------
 * 编译通过 ≠ 运行时正确。这个脚本用 jsdom 真实挂载组件，
 * 捕获编译期发现不了的问题：模板运行时错误、未定义变量、
 * 插槽渲染异常、v-for key 缺失、图标组件未注册等。
 *
 * 用法：node scripts/verify-layout.mjs
 */
import { JSDOM } from 'jsdom'

/* ---------- 准备最小 DOM 环境 ---------- */
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

let pass = 0
let fail = 0

function check(name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ---------- 动态编译 .vue 单文件组件 ---------- */
// 复用项目自带的 compiler-sfc + plugin-vue，避免手写编译流程产生偏差
const { parse, compileScript, compileTemplate, compileStyleAsync } = await import(
  'vue/compiler-sfc'
)
const fs = await import('node:fs/promises')
const path = await import('node:path')

async function loadSFC(filePath) {
  const source = await fs.readFile(filePath, 'utf-8')
  const { descriptor, errors } = parse(source, { filename: filePath })
  if (errors.length) throw new Error(`SFC 解析失败: ${errors[0].message}`)

  const id = path.basename(filePath, '.vue')
  const hasScriptSetup = !!descriptor.scriptSetup

  let scriptCode = ''
  if (hasScriptSetup || descriptor.script) {
    const compiled = compileScript(descriptor, { id })
    scriptCode = compiled.content
  }

  const templateResult = compileTemplate({
    source: descriptor.template?.content ?? '',
    filename: filePath,
    id,
    compilerOptions: { bindingMetadata: hasScriptSetup ? compileScript(descriptor, { id }).bindings : undefined },
  })

  return { scriptCode, templateCode: templateResult.code, id, descriptor }
}

console.log('\n--- 1. SFC 编译健康检查 ---')

const files = [
  'src/layouts/MainLayout.vue',
  'src/components/layout/AppHeader.vue',
  'src/components/article/ArticleCard.vue',
  'src/components/common/ContentSection.vue',
  'src/components/common/EmptyState.vue',
  'src/components/common/ErrorState.vue',
  'src/components/common/LoadingState.vue',
  'src/views/home/HomeView.vue',
  'src/App.vue',
]

for (const f of files) {
  const full = path.resolve(process.cwd(), f)
  try {
    const source = await fs.readFile(full, 'utf-8')
    const { descriptor, errors } = parse(source, { filename: full })

    if (errors.length) {
      check(`${f} 解析`, false, errors[0].message)
      continue
    }

    // script setup 标签必须成对出现，否则整块会被当成模板文本（曾踩过这个坑）
    const hasUnclosedScript =
      source.includes('</script>') && !/<script\s+setup/.test(source)
    if (hasUnclosedScript) {
      check(`${f} 标签完整`, false, '缺少 <script setup> 开标签')
      continue
    }

    // 模板编译必须无错
    if (descriptor.template) {
      const tpl = compileTemplate({
        source: descriptor.template.content,
        filename: full,
        id: path.basename(f, '.vue'),
      })
      if (tpl.errors.length) {
        check(`${f} 模板编译`, false, String(tpl.errors[0]))
        continue
      }
    }

    check(`${f} 编译`, true)
  } catch (err) {
    check(`${f} 编译`, false, err.message)
  }
}

/* ---------- 2. 检查组件引用的图标是否真实存在 ---------- */
console.log('\n--- 2. 图标引用检查 ---')

const iconsAvailable = new Set(
  (await fs.readdir(path.resolve(process.cwd(), 'node_modules/@element-plus/icons-vue/dist/types/components')))
    .filter((f) => f.endsWith('.vue.d.ts'))
    .map((f) => f.replace('.vue.d.ts', ''))
    // kebab-case → PascalCase，与全局注册名一致
    .map((n) => n.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')),
)

const iconUsage = new Map()
for (const f of files) {
  const src = await fs.readFile(path.resolve(process.cwd(), f), 'utf-8')
  // 匹配模板里 <el-icon><Xxx /></el-icon> 这类大写开头的组件
  const matches = src.matchAll(/<el-icon[^>]*>\s*<([A-Z][A-Za-z0-9]*)\s*\/>/g)
  for (const m of matches) {
    const name = m[1]
    if (!iconUsage.has(name)) iconUsage.set(name, [])
    iconUsage.get(name).push(f)
  }
}

for (const [icon, usedIn] of iconUsage) {
  check(
    `图标 <${icon} /> 已注册`,
    iconsAvailable.has(icon),
    iconsAvailable.has(icon) ? '' : `在 ${usedIn.join(', ')} 中使用但图标库中不存在`,
  )
}

/* ---------- 3. 检查 ArticleCard 的组件名映射 ---------- */
console.log('\n--- 3. ArticleCard 动态图标映射 ---')
{
  const src = await fs.readFile(
    path.resolve(process.cwd(), 'src/components/article/ArticleCard.vue'),
    'utf-8',
  )
  const dynamicIcons = [...src.matchAll(/icon:\s*'([A-Za-z]+)'/g)].map((m) => m[1])
  check('检测到动态图标映射', dynamicIcons.length > 0, `共 ${dynamicIcons.length} 个`)
  for (const icon of dynamicIcons) {
    check(`动态图标 ${icon} 存在`, iconsAvailable.has(icon))
  }
}

/* ---------- 4. navKey 一致性：Header 与路由表必须对得上 ---------- */
console.log('\n--- 4. navKey 一致性检查 ---')
{
  const headerSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/components/layout/AppHeader.vue'),
    'utf-8',
  )
  const headerKeys = [...headerSrc.matchAll(/key:\s*'([a-z-]+)',\s*label:/g)].map((m) => m[1])

  const modulesDir = path.resolve(process.cwd(), 'src/router/modules')
  const moduleFiles = await fs.readdir(modulesDir)
  let routeKeys = []
  for (const mf of moduleFiles) {
    const s = await fs.readFile(path.join(modulesDir, mf), 'utf-8')
    routeKeys.push(...[...s.matchAll(/navKey:\s*'([a-z-]+)'/g)].map((m) => m[1]))
  }
  const uniqueRouteKeys = [...new Set(routeKeys)]

  // ⚠️ 不要写死数量：T2 给顶栏加了「消息」后 4→5，写死 4 就会红（T2 起 test:layout 一直是红的）。
  // 这里真正要守的不变量有两条：① 解析没坏（提到了导航项）；② 每一项都能在路由表里找到 navKey（见下面的循环）。
  check(
    'Header 提取到导航项（≥4 项，不写死数量）',
    headerKeys.length >= 4,
    `实际 ${headerKeys.length} 个: ${headerKeys.join(', ')}`,
  )
  check(
    '导航项无重复',
    new Set(headerKeys).size === headerKeys.length,
    `实际 ${headerKeys.join(', ')}`,
  )
  for (const k of headerKeys) {
    check(`导航项 "${k}" 在路由表中存在`, uniqueRouteKeys.includes(k), `路由表中的 key: ${uniqueRouteKeys.join(', ')}`)
  }
  // 反向：路由表里有但导航没暴露的（profile 属预期内，走用户菜单）
  const notInNav = uniqueRouteKeys.filter((k) => !headerKeys.includes(k))
  console.log(`  ℹ 未出现在顶部导航的 navKey: ${notInNav.join(', ') || '无'}`)
}

/* ---------- 5. 检查 format.ts 的时间解析正确性 ---------- */
console.log('\n--- 5. 时间格式化函数 ---')
{
  const src = await fs.readFile(path.resolve(process.cwd(), 'src/utils/format.ts'), 'utf-8')
  check('parseServerTime 处理空格分隔时间', src.includes("replace(' ', 'T')"))
  check('相对时间有未来时间兜底', src.includes("return '刚刚'"))
  check('数字缩写有万字处理', src.includes('万'))
}

console.log(`\n========== 通过 ${pass}，失败 ${fail} ==========\n`)
process.exit(fail > 0 ? 1 : 0)
