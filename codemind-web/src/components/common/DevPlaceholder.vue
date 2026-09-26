<script setup lang="ts">
/**
 * 页面开发中占位
 * ------------------------------------------------------------------
 * 这些页面将在后续阶段实现。此组件用于保证路由可正常跳转、
 * 布局与守卫可被验证，避免开发期出现白屏。
 */
interface Props {
  /** 路由名称或页面名 */
  name: string
  /** 计划实现在第几阶段 */
  stage?: string
  /** 该页面用到的接口，便于后续对齐 */
  endpoints?: string[]
}

withDefaults(defineProps<Props>(), {
  stage: '',
  endpoints: () => [],
})
</script>

<template>
  <div class="cm-placeholder cm-container-narrow">
    <div class="cm-placeholder__card">
      <span class="cm-placeholder__badge">开发中</span>
      <h1 class="cm-placeholder__title">{{ name }}</h1>

      <p class="cm-placeholder__meta">
        <span>路由已就绪，页面待实现</span>
        <template v-if="stage">
          <span class="cm-placeholder__dot">·</span>
          <span>{{ stage }}</span>
        </template>
      </p>

      <div v-if="endpoints.length" class="cm-placeholder__api">
        <p class="cm-placeholder__api-label">计划接入接口</p>
        <ul class="cm-placeholder__list">
          <li v-for="ep in endpoints" :key="ep" class="cm-text-mono">{{ ep }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cm-placeholder {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

.cm-placeholder__card {
  padding: var(--cm-space-8);
  background-color: var(--cm-bg-surface);
  border: 1px dashed var(--cm-border-default);
  border-radius: var(--cm-radius-xl);
}

.cm-placeholder__badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: var(--cm-font-size-xs);
  font-weight: 500;
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border: 1px solid var(--cm-warning-border);
  border-radius: var(--cm-radius-sm);
}

.cm-placeholder__title {
  margin-top: var(--cm-space-4);
  font-size: var(--cm-font-size-2xl);
}

.cm-placeholder__meta {
  margin-top: var(--cm-space-2);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

.cm-placeholder__dot {
  margin: 0 var(--cm-space-2);
  color: var(--cm-text-quaternary);
}

.cm-placeholder__api {
  margin-top: var(--cm-space-6);
  padding-top: var(--cm-space-5);
  border-top: 1px solid var(--cm-border-subtle);
}

.cm-placeholder__api-label {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.cm-placeholder__list {
  margin: var(--cm-space-3) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--cm-space-2);
}

.cm-placeholder__list li {
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
}
</style>
