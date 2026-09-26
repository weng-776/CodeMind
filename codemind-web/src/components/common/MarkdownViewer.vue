<script setup lang="ts">
/**
 * Markdown 渲染组件
 * ------------------------------------------------------------------
 * 统一承载文章正文、笔记正文、AI 回复的 Markdown 展示。
 *
 * 渲染链路：markdown-it → highlight.js → DOMPurify → v-html
 * 清洗步骤不可省略，否则内容中的脚本会被执行（XSS）。
 */
import { computed } from 'vue'

import { renderMarkdown } from '@/utils/markdown'

interface Props {
  /** Markdown 原文 */
  content: string | null | undefined
  /**
   * 展示密度：
   *   article —— 文章/笔记详情，宽松排版
   *   compact —— AI 气泡，紧凑排版
   */
  variant?: 'article' | 'compact'
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'article',
})

const html = computed(() => renderMarkdown(props.content))

const className = computed(() =>
  props.variant === 'compact' ? 'cm-markdown cm-markdown--compact' : 'cm-markdown',
)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- 内容已由 DOMPurify 清洗 -->
  <div :class="className" v-html="html" />
</template>
