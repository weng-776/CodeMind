<script setup lang="ts">
/**
 * 错误状态占位组件
 * 请求失败时使用，提供重试入口，避免页面白屏。
 */
interface Props {
  title?: string
  description?: string
  /** 是否显示重试按钮 */
  retryable?: boolean
  retryText?: string
}

withDefaults(defineProps<Props>(), {
  title: '加载失败',
  description: '请检查网络连接后重试',
  retryable: true,
  retryText: '重新加载',
})

defineEmits<{
  retry: []
}>()
</script>

<template>
  <div class="cm-error">
    <svg
      class="cm-error__icon"
      width="52"
      height="52"
      viewBox="0 0 52 52"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="26" cy="26" r="20" stroke="currentColor" stroke-width="1.5" opacity="0.4" />
      <path
        d="M26 17v12"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        opacity="0.7"
      />
      <circle cx="26" cy="35" r="1.6" fill="currentColor" opacity="0.7" />
    </svg>

    <p class="cm-error__title">{{ title }}</p>
    <p v-if="description" class="cm-error__desc">{{ description }}</p>

    <div class="cm-error__actions">
      <!--
        默认插槽是「整段替换」动作区（历史用法，保留）。
        只想**追加**一个次要动作（比如「返回列表」）时用 `#extra`：
        这样「重新加载」永远来自组件本身，页面不必各自手写一遍 ——
        收尾前有 4 个页面各自写了一个文案与样式都靠自觉的重试按钮。
      -->
      <slot>
        <el-button v-if="retryable" type="primary" plain size="small" @click="$emit('retry')">
          {{ retryText }}
        </el-button>
      </slot>
      <slot name="extra" />
    </div>
  </div>
</template>

<style scoped>
.cm-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--cm-space-16) var(--cm-space-6);
  text-align: center;
  color: var(--cm-danger);
}

.cm-error__title {
  margin-top: var(--cm-space-4);
  font-size: var(--cm-font-size-md);
  color: var(--cm-text-primary);
}

.cm-error__desc {
  margin-top: var(--cm-space-2);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
  max-width: 34ch;
}

.cm-error__actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-5);
}

/*
 * Element Plus 会给相邻按钮加 `margin-left`，在 flex 里会和 gap 叠加成 24px。
 * 统一交给 gap 控制，间距才和项目其它按钮组一致。
 */
.cm-error__actions .el-button + .el-button {
  margin-left: 0;
}
</style>
