<script setup lang="ts">
/**
 * AI 上下文操作面板
 * ------------------------------------------------------------------
 * 用于文章详情页与笔记详情页，承载「AI总结 / 知识点提取 / 生成面试题」。
 * 本身不含业务请求逻辑，全部通过 props 与事件与父页面通信，
 * 便于在文章与笔记两处复用。
 */
import MarkdownViewer from '@/components/common/MarkdownViewer.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import type { AiContextAction } from '@/types/ai'

interface Props {
  visible: boolean
  title: string
  content: string
  streaming: boolean
  error: string | null
  /** 当前动作的等待文案（三个接口耗时差很大，由父级按动作给） */
  loadingText: string
  /** 未登录：这 6 个接口对游客一律 401，展示「登录后查看」而不是报错 */
  needLogin: boolean
  activeAction: AiContextAction | null
}

defineProps<Props>()

defineEmits<{
  close: []
  stop: []
  retry: []
  copy: [text: string]
  login: []
}>()
</script>

<template>
  <el-drawer
    :model-value="visible"
    :with-header="false"
    direction="rtl"
    size="560px"
    :close-on-click-modal="true"
    class="cm-ai-panel"
    @close="$emit('close')"
  >
    <div class="cm-ai-panel__inner">
      <!-- 头部 -->
      <header class="cm-ai-panel__head">
        <div class="cm-ai-panel__title-wrap">
          <span class="cm-ai-panel__badge" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5 6.4 9.1 2 7.5l4.4-1.6L8 1.5z"
                fill="currentColor"
              />
            </svg>
          </span>
          <h2 class="cm-ai-panel__title">{{ title }}</h2>

          <!-- 生成中指示 -->
          <span v-if="streaming" class="cm-ai-panel__live">
            <span class="cm-ai-panel__pulse" />
            生成中
          </span>
        </div>

        <div class="cm-ai-panel__actions">
          <button
            v-if="streaming"
            type="button"
            class="cm-ai-panel__btn"
            @click="$emit('stop')"
          >
            停止
          </button>

          <button
            v-else-if="content"
            type="button"
            class="cm-ai-panel__btn"
            @click="$emit('copy', content)"
          >
            复制
          </button>

          <button
            type="button"
            class="cm-ai-panel__btn cm-ai-panel__btn--icon"
            aria-label="关闭"
            @click="$emit('close')"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <!-- 内容区 -->
      <div class="cm-ai-panel__body cm-scroll-thin">
        <!--
          未登录优先于错误：5.5~5.10 对游客一律 401，那是「要登录」不是「坏了」。
          放在最前面，避免先闪一下红字再变成登录提示。
        -->
        <div v-if="needLogin" class="cm-ai-panel__state">
          <EmptyState
            title="登录后查看"
            description="AI 助手需要登录后才能使用，登录后会回到这篇内容"
            :size="72"
          >
            <el-button type="primary" size="small" @click="$emit('login')">立即登录</el-button>
          </EmptyState>
        </div>

        <!-- 失败：只在面板内降级，详情页正文不受影响 -->
        <ErrorState
          v-else-if="error"
          title="生成失败"
          :description="error"
          retry-text="重新生成"
          @retry="$emit('retry')"
        />

        <!-- 等待首字节：文案按动作区分（面试题要 13~17s，得让用户知道该等） -->
        <LoadingState v-else-if="streaming && !content" :text="loadingText" />

        <!-- 结果 -->
        <template v-else-if="content">
          <MarkdownViewer :content="content" variant="article" />
          <span v-if="streaming" class="cm-ai-panel__cursor" aria-hidden="true" />
        </template>

        <!-- 空（理论上不会出现） -->
        <LoadingState v-else text="准备中" />
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.cm-ai-panel__inner {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ---------- 头部 ---------- */
.cm-ai-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-3);
  padding: var(--cm-space-4) var(--cm-space-5);
  border-bottom: 1px solid var(--cm-border-subtle);
  flex-shrink: 0;
}

.cm-ai-panel__title-wrap {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  min-width: 0;
}

.cm-ai-panel__badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  color: var(--cm-accent-600);
  background-color: var(--cm-accent-50);
  border: 1px solid var(--cm-accent-100);
  border-radius: var(--cm-radius-md);
}

.cm-ai-panel__title {
  font-size: var(--cm-font-size-md);
  font-weight: 500;
}

.cm-ai-panel__live {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  padding: 2px 8px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-accent-600);
  background-color: var(--cm-accent-50);
  border-radius: var(--cm-radius-sm);
  white-space: nowrap;
}

.cm-ai-panel__pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--cm-accent-500);
  animation: cm-pulse 1.4s ease-in-out infinite;
}

@keyframes cm-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.8);
  }
}

/* ---------- 按钮 ---------- */
.cm-ai-panel__actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
}

.cm-ai-panel__btn {
  padding: var(--cm-space-1) var(--cm-space-3);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
  background-color: var(--cm-bg-surface);
  border: 1px solid var(--cm-border-default);
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  transition:
    background-color var(--cm-duration-fast) var(--cm-ease-out),
    color var(--cm-duration-fast) var(--cm-ease-out),
    border-color var(--cm-duration-fast) var(--cm-ease-out);
}

.cm-ai-panel__btn:hover {
  color: var(--cm-text-primary);
  background-color: var(--cm-bg-hover);
  border-color: var(--cm-border-strong);
}

.cm-ai-panel__btn:active {
  transform: scale(0.97);
}

.cm-ai-panel__btn--icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
}

/* ---------- 内容 ---------- */
.cm-ai-panel__body {
  flex: 1;
  overflow-y: auto;
  padding: var(--cm-space-6);
}

/* 整块状态（登录 / 空）：垂直居中，别贴着抽屉顶部 */
.cm-ai-panel__state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60%;
}

.cm-ai-panel__cursor {
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

@media (prefers-reduced-motion: reduce) {
  .cm-ai-panel__pulse,
  .cm-ai-panel__cursor {
    animation: none;
  }
}
</style>

<style>
/* 抽屉本体样式（非 scoped：需要影响 el-drawer 根元素） */
.cm-ai-panel .el-drawer__body {
  padding: 0;
  overflow: hidden;
}

.cm-ai-panel .el-drawer__header {
  margin-bottom: 0;
  padding: 0;
}

@media (max-width: 640px) {
  .cm-ai-panel {
    width: 100% !important;
    max-width: 100%;
  }
}
</style>
