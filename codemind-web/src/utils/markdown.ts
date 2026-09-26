/**
 * Markdown 渲染工具
 * ------------------------------------------------------------------
 * 用于文章正文、笔记正文、AI 回复三处。
 *
 * 安全说明（重要）：
 *   渲染结果是 HTML 字符串，通过 v-html 注入 DOM。
 *   如果直接注入，Markdown 中内嵌的 <script>、onerror、javascript: 等
 *   会造成 XSS。因此必须经过 DOMPurify 清洗。
 *   这是「文章/笔记内容可能来自其他用户」这一场景下的硬性要求。
 */
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import DOMPurify, { type Config as PurifyConfig } from 'dompurify'

/** 对代码块做语法高亮 */
function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      /* 高亮失败则回退为转义后的纯文本 */
    }
  }
  try {
    return hljs.highlightAuto(code).value
  } catch {
    return ''
  }
}

const md = new MarkdownIt({
  html: true, // 允许 Markdown 中写 HTML（随后统一由 DOMPurify 清洗）
  linkify: true, // 自动把裸链接转成 <a>
  breaks: false, // 单个换行不转为 <br>，保持标准 Markdown 语义
  typographer: false, // 不启用智能标点替换，避免中文场景下出现奇怪转换
  highlight: (code, lang) => {
    const highlighted = highlightCode(code, lang)
    // 返回空字符串表示让 markdown-it 使用默认转义逻辑
    if (!highlighted) return ''
    // 手动包一层 <pre><code>，并带上语言 class 便于样式定位
    const langClass = lang ? ` class="hljs language-${lang}"` : ' class="hljs"'
    return `<pre class="cm-code-block"><code${langClass}>${highlighted}</code></pre>`
  },
})

/**
 * 外链安全属性。
 * 只在生成的 <a> 上补 target/rel，避免离开本站后无法返回。
 */
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

/** DOMPurify 允许保留的标签与属性（hljs 需要 span + class） */
const PURIFY_CONFIG: PurifyConfig = {
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['style', 'form', 'input', 'button'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick'],
}

/**
 * 把 Markdown 渲染为已清洗的 HTML 字符串。
 * 可直接用于 v-html。
 */
export function renderMarkdown(source: string | null | undefined): string {
  if (!source) return ''
  const raw = md.render(source)
  // 双保险：即便 markdown-it 或某些插件产出了危险内容，这里也会被过滤。
  // sanitize 默认返回 string（未开启 RETURN_TRUSTED_TYPE）。
  return DOMPurify.sanitize(raw, PURIFY_CONFIG) as string
}

/**
 * 提取 Markdown 纯文本（用于摘要、搜索预览）。
 * 去掉代码块、链接语法、标题标记等。
 */
export function extractPlainText(source: string | null | undefined): string {
  if (!source) return ''
  return source
    .replace(/```[\s\S]*?```/g, '') // 代码块
    .replace(/`([^`]+)`/g, '$1') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/^#{1,6}\s+/gm, '') // 标题标记
    .replace(/^\s*>\s?/gm, '') // 引用
    .replace(/^\s*[-*+]\s+/gm, '') // 无序列表
    .replace(/^\s*\d+\.\s+/gm, '') // 有序列表
    .replace(/[*_~]{1,3}/g, '') // 强调标记
    .replace(/\s+/g, ' ')
    .trim()
}

/** 统计正文字数（中英混排：中文按字、英文按词近似计） */
export function countWords(source: string | null | undefined): number {
  const text = extractPlainText(source)
  if (!text) return 0
  const cjk = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0
  const words = text
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  return cjk + words
}

export default md
