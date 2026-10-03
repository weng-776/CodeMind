<script setup lang="ts">
/**
 * 管理端页头
 * ------------------------------------------------------------------
 * T16 / T17 / T18 / T19 四单各自把同一段页头（eyebrow + 标题 + 描述）**内联**了一遍：
 * `.vue` 的 `<style scoped>` 不能跨文件复用，而各单的派工范围都不许回头改前面的文件，
 * 所以只能复制。T21 管理端收口后抽成组件，一处维护。
 *
 * 🔴 **样式是逐字节照搬的**（T21 是纯重构，必须视觉零变化）：
 *    字号 / 字距 / 字重 / 上下 margin / `max-width: 60ch` 一个字都不能动 ——
 *    改任何一个都会让 `verify-t21-refactor.mjs` 的页头逐像素对比变红。
 *
 * 类名刻意**沿用**原来的 `cm-admin__head / __eyebrow / __title / __desc`：
 * 改名不会影响渲染，但会让 diff 变大、也让「视觉零变化」更难论证。
 */
interface Props {
  /** 页面标题（h1） */
  title: string
  /** 标题下方的说明文字；不传则不渲染那一行 */
  description?: string
  /** 顶部小字。默认「管理后台」，四个管理页目前都用默认值 */
  eyebrow?: string
}

withDefaults(defineProps<Props>(), {
  description: '',
  eyebrow: '管理后台',
})
</script>

<template>
  <header class="cm-admin__head">
    <p v-if="eyebrow" class="cm-admin__eyebrow">{{ eyebrow }}</p>
    <h1 class="cm-admin__title">{{ title }}</h1>
    <p v-if="description" class="cm-admin__desc">{{ description }}</p>
  </header>
</template>

<style scoped>
/* ⚠️ 以下三条与重构前 4 个页面里的内联样式**逐字节一致**，不要"顺手优化"。 */
.cm-admin__eyebrow {
  margin: 0;
  font-family: var(--cm-font-mono);
  font-size: var(--cm-font-size-xs);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--cm-accent-600);
}

.cm-admin__title {
  margin: var(--cm-space-3) 0 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-admin__desc {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
  max-width: 60ch;
}
</style>
