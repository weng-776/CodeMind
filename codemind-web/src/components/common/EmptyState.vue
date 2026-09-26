<script setup lang="ts">
/**
 * 空状态占位组件
 * 列表无数据、搜索无结果时使用。
 */
interface Props {
  title?: string
  description?: string
  /** 图标尺寸 */
  size?: number
}

withDefaults(defineProps<Props>(), {
  title: '暂无数据',
  description: '',
  size: 96,
})
</script>

<template>
  <div class="cm-empty">
    <svg
      class="cm-empty__icon"
      :width="size"
      :height="size"
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="14"
        y="22"
        width="68"
        height="52"
        rx="6"
        stroke="currentColor"
        stroke-width="1.5"
        opacity="0.35"
      />
      <path d="M14 34h68" stroke="currentColor" stroke-width="1.5" opacity="0.35" />
      <circle cx="22" cy="28" r="1.8" fill="currentColor" opacity="0.35" />
      <circle cx="28" cy="28" r="1.8" fill="currentColor" opacity="0.35" />
      <path
        d="M32 50h32M32 60h20"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        opacity="0.25"
      />
    </svg>

    <p class="cm-empty__title">{{ title }}</p>
    <p v-if="description" class="cm-empty__desc">{{ description }}</p>

    <div v-if="$slots.default" class="cm-empty__action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.cm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--cm-space-16) var(--cm-space-6);
  text-align: center;
  color: var(--cm-text-quaternary);
}

.cm-empty__icon {
  color: var(--cm-text-quaternary);
}

.cm-empty__title {
  margin-top: var(--cm-space-4);
  font-size: var(--cm-font-size-md);
  color: var(--cm-text-secondary);
}

.cm-empty__desc {
  margin-top: var(--cm-space-2);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-quaternary);
  max-width: 32ch;
}

.cm-empty__action {
  margin-top: var(--cm-space-5);
}
</style>
