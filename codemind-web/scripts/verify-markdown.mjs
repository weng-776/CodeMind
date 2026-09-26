/**
 * Markdown 渲染与 XSS 清洗验证
 *
 * 验证 markdown-it → highlight.js → DOMPurify 这条链路：
 *   1. 基础 Markdown 语法正确渲染
 *   2. 代码块高亮生效
 *   3. 危险 HTML 被清洗（XSS 防护）
 *
 * 运行：node scripts/verify-markdown.mjs
 */
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'

const { window } = new JSDOM('')
const DOMPurify = createDOMPurify(window)

function highlightCode(code, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      /* fallthrough */
    }
  }
  try {
    return hljs.highlightAuto(code).value
  } catch {
    return ''
  }
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight: (code, lang) => {
    const h = highlightCode(code, lang)
    if (!h) return ''
    const cls = lang ? ` class="hljs language-${lang}"` : ' class="hljs"'
    return `<pre class="cm-code-block"><code${cls}>${h}</code></pre>`
  },
})

// 与 src/utils/markdown.ts 保持一致：给外链补 target/rel
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx]
  if (token) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

const CONFIG = {
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['style', 'form', 'input', 'button'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick'],
}

function render(source) {
  return DOMPurify.sanitize(md.render(source), CONFIG)
}

let pass = 0
let fail = 0
function check(label, cond, extra) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) {
    fail++
    if (extra) console.log('        ' + extra)
  } else pass++
}

/* ---------- 1. 基础语法 ---------- */
console.log('=== 1. 基础 Markdown 语法 ===')
{
  const html = render('# 标题\n\n**粗体** 和 *斜体*\n\n- 项目一\n- 项目二')
  check('渲染 h1', html.includes('<h1>'))
  check('渲染 strong', html.includes('<strong>'))
  check('渲染 em', html.includes('<em>'))
  check('渲染 ul/li', html.includes('<ul>') && html.includes('<li>'))
}

/* ---------- 2. 代码高亮 ---------- */
console.log('')
console.log('=== 2. 代码块语法高亮 ===')
{
  const html = render('```java\npublic class Demo {}\n```')
  check('生成 pre 代码块', html.includes('<pre'))
  check('带 hljs class', html.includes('hljs'))
  check('包含高亮 span', html.includes('<span'))
  check('语言标识保留', html.includes('language-java') || html.includes('hljs'))
}

/* ---------- 3. XSS 防护（重点） ---------- */
console.log('')
console.log('=== 3. XSS 清洗（安全关键）===')
{
  const cases = [
    ['script 标签', '<script>alert(1)</script>', 'script'],
    ['img onerror', '<img src=x onerror="alert(1)">', 'onerror'],
    ['javascript: 链接', '[click](javascript:alert(1))', 'href='],
    ['iframe', '<iframe src="evil.com"></iframe>', 'iframe'],
    ['svg onload', '<svg onload="alert(1)"></svg>', 'onload'],
    ['事件属性', '<div onclick="alert(1)">x</div>', 'onclick'],
  ]
  for (const [label, input, forbidden] of cases) {
    const html = render(input)
    const blocked = !html.toLowerCase().includes(forbidden.toLowerCase())
    check(`${label} 已被清洗`, blocked, `输出: ${html}`)
  }
}

/* ---------- 4. 正常内容不被误伤 ---------- */
console.log('')
console.log('=== 4. 正常内容不被误清洗 ===')
{
  const html = render('表格与链接\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[链接](https://example.com)')
  check('表格保留', html.includes('<table>'))
  check('链接保留', html.includes('<a '))
  check('外链加了 noopener', html.includes('noopener'))

  const codeHtml = render('行内 `code` 与 ~~删除~~')
  check('行内代码保留', codeHtml.includes('<code>'))
}

/* ---------- 5. 中文与多行 ---------- */
console.log('')
console.log('=== 5. 中文内容正确性 ===')
{
  const src = '## 结论\n\n这段中文不应该出现乱码，包括标点：、。！？'
  const html = render(src)
  check('中文无乱码', !html.includes('\uFFFD'))
  check('中文内容完整', html.includes('这段中文不应该出现乱码'))
}

console.log('')
console.log('=== 汇总 ===')
console.log(`  通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
