<script setup lang="ts">
/**
 * 主布局
 * ------------------------------------------------------------------
 * 结构：Header（吸顶）+ Main（路由出口）+ Footer
 *
 * 关于 <router-view>：
 *   这里不写 KeepAlive —— 社区列表的筛选状态应该通过 URL query 表达，
 *   而不是靠缓存组件。这样刷新/分享链接都能复现同一个视图，也是文档
 *   「Tab 用独立路径而非 query」思路的延伸。
 *
 * 关于 Footer：
 *   不放版权声明以外的营销内容。技术社区的页脚应当克制。
 *   唯一例外是 AI 对话页（isFullWidth）—— 那是一个占满视口的应用式界面，
 *   内部自己管滚动，再挂一条页脚会挤出「嵌套滚动」的怪结构，所以整条隐藏。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import AppHeader from '@/components/layout/AppHeader.vue'

const route = useRoute()

/** 宽屏页面（AI 对话、编辑器）不要容器限宽，自行处理布局 */
const isFullWidth = computed(() => route.meta.navKey === 'ai')

const year = new Date().getFullYear()
</script>

<template>
  <div class="cm-layout" :class="{ 'is-app-shell': isFullWidth }">
    <AppHeader />

    <main class="cm-layout__main" :class="{ 'is-full-width': isFullWidth }">
      <router-view v-slot="{ Component }">
        <transition name="cm-fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <footer v-if="!isFullWidth" class="cm-layout__footer">
      <div class="cm-container cm-layout__footer-inner">
        <span>CodeMind · 面向开发者的智能知识管理与技术社区</span>
        <span class="cm-layout__footer-year">© {{ year }}</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.cm-layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background-color: var(--cm-bg-body);
}

/*
 * 应用式页面（AI 对话）：整页**不滚动**，高度锁死一屏，由内部各区域自己滚。
 *
 * 为什么必须锁死：这里原来只有 `min-height: 100vh`，而那是**下限**不是确定高度 ——
 * 对话一长，`.cm-layout` 就跟着内容一起长高，`.cm-layout__main` / `.cm-ai`
 * 也就永远拿不到「确定的高度」，内部那些 `overflow-y: auto`
 * （会话列表 / 消息区）**永远不会溢出、滚动条永远不激活**，
 * 最终退化成整页滚动：侧栏被一起卷走、输入框被顶到文档末尾
 * （要一直拉到最底才能继续聊）、滚轮也只在滚整页。
 *
 * 给到确定高度后，三个区域各滚各的：
 *   会话列表 `.cm-ai__side-body` / 消息区 `.cm-ai__scroll` / 输入框固定不滚。
 */
.cm-layout.is-app-shell {
  height: 100vh;
  overflow: hidden;
}

.cm-layout__main {
  flex: 1;
  width: 100%;
}

/* AI 页面需要占满视口高度且自行管理内部滚动 */
.cm-layout__main.is-full-width {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.cm-layout__footer {
  border-top: 1px solid var(--cm-border-subtle);
  background-color: var(--cm-bg-surface);
}

.cm-layout__footer-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-4);
  padding-top: var(--cm-space-5);
  padding-bottom: var(--cm-space-5);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-layout__footer-year {
  font-family: var(--cm-font-mono);
}

/* 页面切换：极轻的淡入，避免每跳一次都「弹」一下 */
.cm-fade-enter-active,
.cm-fade-leave-active {
  transition: opacity 0.16s ease;
}

.cm-fade-enter-from,
.cm-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .cm-fade-enter-active,
  .cm-fade-leave-active {
    transition: none;
  }
}

@media (max-width: 640px) {
  .cm-layout__footer-inner {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--cm-space-1);
  }
}
</style>
