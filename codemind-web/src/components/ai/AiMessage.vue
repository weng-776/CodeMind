<script setup lang="ts">
/**
 * AI 消息气泡
 * ------------------------------------------------------------------
 * 用户消息：右对齐、实底色、纯文本
 * AI 消息：左对齐、无底色块、Markdown 渲染
 *
 * 流式生成中显示光标动画；生成失败给出重试入口。
 */
import { computed } from 'vue'

import MarkdownViewer from '@/components/common/MarkdownViewer.vue'
import type { ChatMessage } from '@/types/ai'

interface Props {
  message: ChatMessage
}

const props = defineProps<Props>()

defineEmits<{
  retry: []
}>()

const isUser = computed(() => props.message.role === 'user')

const isAssistant = computed(() => props.message.role === 'assistant')

/** 生成中且已有内容 → 在末尾显示光标 */
const showCursor = computed(() => props.message.streaming === true)

/** 生成中但还没有任何内容 → 显示「思考中」 */
const isWaiting = computed(() => props.message.streaming === true && !props.message.content)
</script>

<template>
  <div class="cm-msg" :class="isUser ? 'cm-msg--user' : 'cm-msg--ai'">
    <!-- AI 头像 -->
    <div v-if="isAssistant" class="cm-msg__avatar cm-msg__avatar--ai" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5 6.4 9.1 2 7.5l4.4-1.6L8 1.5z"
          fill="currentColor"
        />
      </svg>
    </div>

    <div class="cm-msg__body">
      <!-- 等待首字节 -->
      <div v-if="isWaiting" class="cm-msg__thinking">
        <span class="cm-msg__dot" />
        <span class="cm-msg__dot" />
        <span class="cm-msg__dot" />
        <span class="cm-msg__thinking-text">正在思考</span>
      </div>

      <!-- 用户消息：纯文本 -->
      <p v-else-if="isUser" class="cm-msg__text">{{ message.content }}</p>

      <!-- AI 消息：Markdown 渲染 -->
      <template v-else>
        <MarkdownViewer
          v-if="message.content"
          :content="message.content"
          variant="compact"
        />
        <span v-if="showCursor" class="cm-msg__cursor" aria-hidden="true" />
      </template>

      <!--
        失败提示。
        具体的失败原因在气泡正文里（composable 在没收到任何内容时会把 message 写进 content），
        这里只负责给「重试」入口，所以文案保持极简，别和正文重复。
      -->
      <div v-if="message.error" class="cm-msg__error">
        <span>生成失败</span>
        <button type="button" class="cm-msg__retry" @click="$emit('retry')">重试</button>
      </div>
    </div>

    <!-- 用户头像 -->
    <div v-if="isUser" class="cm-msg__avatar cm-msg__avatar--user" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="5.5" r="2.8" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M2.8 14c0-2.6 2.3-4.4 5.2-4.4s5.2 1.8 5.2 4.4"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.cm-msg {
  display: flex;
  gap: var(--cm-space-3);
  padding: var(--cm-space-4) 0;
}

.cm-msg--user {
  justify-content: flex-end;
}

.cm-msg--ai {
  justify-content: flex-start;
}

/* ---------- 头像 ---------- */
.cm-msg__avatar {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--cm-radius-md);
}

.cm-msg__avatar--ai {
  color: var(--cm-accent-600);
  background-color: var(--cm-accent-50);
  border: 1px solid var(--cm-accent-100);
}

.cm-msg__avatar--user {
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-subtle);
  border: 1px solid var(--cm-border-subtle);
}

/* ---------- 内容 ---------- */
.cm-msg__body {
  min-width: 0;
  max-width: 100%;
}

.cm-msg--user .cm-msg__body {
  max-width: 72%;
}

/* 用户消息用实底气泡区分角色 */
.cm-msg__text {
  padding: var(--cm-space-3) var(--cm-space-4);
  font-size: var(--cm-font-size-base);
  line-height: var(--cm-line-height-normal);
  color: var(--cm-text-primary);
  background-color: var(--cm-bg-subtle);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---------- 流式光标 ---------- */
.cm-msg__cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background-color: var(--cm-accent-500);
  animation: cm-blink 1s steps(2, start) infinite;
}

@keyframes cm-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

/* ---------- 思考中 ---------- */
.cm-msg__thinking {
  display: flex;
  align-items: center;
  gap: var(--cm-space-1);
  height: 28px;
}

.cm-msg__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background-color: var(--cm-accent-400);
  animation: cm-bounce 1.2s ease-in-out infinite;
}

.cm-msg__dot:nth-child(2) {
  animation-delay: 0.15s;
}

.cm-msg__dot:nth-child(3) {
  animation-delay: 0.3s;
}

.cm-msg__thinking-text {
  margin-left: var(--cm-space-2);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-quaternary);
}

@keyframes cm-bounce {
  0%,
  60%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

/* ---------- 错误 ---------- */
.cm-msg__error {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-2);
  padding: var(--cm-space-2) var(--cm-space-3);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-danger);
  background-color: var(--cm-danger-bg);
  border: 1px solid var(--cm-danger-border);
  border-radius: var(--cm-radius-md);
}

.cm-msg__retry {
  padding: 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-danger);
  background: none;
  border: none;
  text-decoration: underline;
  cursor: pointer;
}

/* ---------- 无障碍：尊重动效偏好 ---------- */
@media (prefers-reduced-motion: reduce) {
  .cm-msg__dot {
    animation: none;
    opacity: 0.6;
  }

  .cm-msg__cursor {
    animation: none;
  }
}

@media (max-width: 768px) {
  .cm-msg--user .cm-msg__body {
    max-width: 88%;
  }
}
</style>
