<script setup lang="ts">
/**
 * 内容区块容器
 * ------------------------------------------------------------------
 * 首页的「最新文章 / 热门文章 / 推荐」共用同一套骨架：
 *   标题 + 副标题 + 右上角「更多」入口 + 内容槽位
 *
 * 关键点：加载态与错误态由本组件统一渲染，页面只需要传进来三个标志位。
 * 这样每个区块的三态处理方式必然一致，不会出现某个区块忘了写 error 分支。
 */
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'

interface Props {
  title: string
  subtitle?: string
  /** 区块加载中 */
  loading?: boolean
  /** 区块加载失败 */
  error?: boolean
  /** 数据为空 */
  empty?: boolean
  /** 空状态文案 */
  emptyText?: string
  /** 有内容时是否显示右上角「更多」 */
  moreTo?: Record<string, unknown> | null
  moreText?: string
  /** 骨架屏行数 */
  skeletonRows?: number
}

withDefaults(defineProps<Props>(), {
  subtitle: '',
  loading: false,
  error: false,
  empty: false,
  emptyText: '暂无内容',
  moreTo: null,
  moreText: '更多',
  skeletonRows: 4,
})

defineEmits<{
  retry: []
}>()
</script>

<template>
  <section class="cm-section">
    <header class="cm-section__head">
      <div class="cm-section__titles">
        <h2 class="cm-section__title">{{ title }}</h2>
        <p v-if="subtitle" class="cm-section__subtitle">{{ subtitle }}</p>
      </div>

      <RouterLink
        v-if="moreTo && !loading && !error && !empty"
        :to="moreTo"
        class="cm-section__more"
      >
        {{ moreText }}
        <el-icon :size="12"><ArrowRight /></el-icon>
      </RouterLink>
    </header>

    <div class="cm-section__body">
      <LoadingState v-if="loading" variant="skeleton" :rows="skeletonRows" />

      <ErrorState
        v-else-if="error"
        title="内容加载失败"
        description="该区块的数据暂时取不到，可单独重试"
        @retry="$emit('retry')"
      />

      <EmptyState v-else-if="empty" :title="emptyText" />

      <slot v-else />
    </div>
  </section>
</template>

<style scoped>
.cm-section + .cm-section {
  margin-top: var(--cm-space-10);
}

.cm-section__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--cm-space-4);
  padding-bottom: var(--cm-space-3);
  margin-bottom: var(--cm-space-2);
  border-bottom: 1px solid var(--cm-border-default);
}

.cm-section__titles {
  display: flex;
  align-items: baseline;
  gap: var(--cm-space-3);
  min-width: 0;
}

.cm-section__title {
  margin: 0;
  font-size: var(--cm-font-size-xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--cm-text-primary);
  white-space: nowrap;
}

.cm-section__subtitle {
  margin: 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-quaternary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cm-section__more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
  text-decoration: none;
  transition: color 0.15s ease;
}

.cm-section__more:hover {
  color: var(--cm-accent-600);
}
</style>
