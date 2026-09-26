<script setup lang="ts">
/**
 * 加载状态组件
 * 支持骨架屏（列表场景）与转圈（区块场景）两种形态。
 */
interface Props {
  /** skeleton 骨架屏 / spinner 转圈 */
  variant?: 'skeleton' | 'spinner'
  /** 骨架屏行数 */
  rows?: number
  /** 骨架屏是否显示封面缩略图块 */
  withCover?: boolean
  /** 转圈模式的文案 */
  text?: string
}

withDefaults(defineProps<Props>(), {
  variant: 'spinner',
  rows: 3,
  withCover: false,
  text: '加载中',
})
</script>

<template>
  <div v-if="variant === 'spinner'" class="cm-loading" role="status" aria-live="polite">
    <span class="cm-loading__spinner" aria-hidden="true" />
    <span class="cm-loading__text">{{ text }}</span>
  </div>

  <div v-else class="cm-skeleton" role="status" aria-live="polite">
    <div v-for="i in rows" :key="i" class="cm-skeleton__row">
      <div v-if="withCover" class="cm-skeleton__cover cm-shimmer" />
      <div class="cm-skeleton__body">
        <div class="cm-skeleton__line cm-shimmer" style="width: 62%" />
        <div class="cm-skeleton__line cm-skeleton__line--sm cm-shimmer" style="width: 92%" />
        <div class="cm-skeleton__line cm-skeleton__line--sm cm-shimmer" style="width: 44%" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 转圈 ---------- */
.cm-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--cm-space-3);
  padding: var(--cm-space-12) var(--cm-space-6);
  color: var(--cm-text-tertiary);
  font-size: var(--cm-font-size-sm);
}

.cm-loading__spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--cm-border-default);
  border-top-color: var(--cm-accent-500);
  border-radius: 50%;
  animation: cm-spin 0.7s linear infinite;
}

@keyframes cm-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------- 骨架屏 ---------- */
.cm-skeleton {
  display: flex;
  flex-direction: column;
}

.cm-skeleton__row {
  display: flex;
  gap: var(--cm-space-4);
  padding: var(--cm-space-5) 0;
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-skeleton__row:last-child {
  border-bottom: none;
}

.cm-skeleton__cover {
  flex-shrink: 0;
  width: 120px;
  height: 76px;
  border-radius: var(--cm-radius-md);
}

.cm-skeleton__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--cm-space-3);
  justify-content: center;
}

.cm-skeleton__line {
  height: 14px;
  border-radius: var(--cm-radius-sm);
}

.cm-skeleton__line--sm {
  height: 12px;
}

/* 微光扫过动画：只动 transform / opacity，走 GPU */
.cm-shimmer {
  background: linear-gradient(
    90deg,
    var(--cm-gray-100) 25%,
    var(--cm-gray-200) 37%,
    var(--cm-gray-100) 63%
  );
  background-size: 400% 100%;
  animation: cm-shimmer 1.4s ease infinite;
}

@keyframes cm-shimmer {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cm-shimmer {
    animation: none;
    background: var(--cm-gray-100);
  }

  .cm-loading__spinner {
    animation-duration: 1.5s;
  }
}
</style>
