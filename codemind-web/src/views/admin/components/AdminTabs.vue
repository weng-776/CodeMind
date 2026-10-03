<script setup lang="ts">
/**
 * 管理端分段导航
 * ------------------------------------------------------------------
 * 4 个管理页面之间用**分段控件**切换，而不是「左侧菜单树」——
 * `05_前端开发SOP` §6 明令禁止把 CodeMind 做成传统 Admin。
 *
 * 为什么是 RouterLink 而不是按钮 + router.push：
 *   4 个页面各有独立 URL，用链接才能保留「新标签页打开 / 中键点击 / 右键复制地址」
 *   这些浏览器原生能力，也对键盘与读屏更友好（`nav` + `aria-current`）。
 *
 * 高亮按 `route.name` 判定，而不是解析 path —— 路由表是唯一事实来源。
 */
import { useRoute } from 'vue-router'
import { Connection, DataLine, Document, User } from '@element-plus/icons-vue'

import { RouteName } from '@/router/routes-names'

interface AdminTabItem {
  name: string
  label: string
  icon: typeof DataLine
}

const TABS: AdminTabItem[] = [
  { name: RouteName.ADMIN_DASHBOARD, label: '数据看板', icon: DataLine },
  { name: RouteName.ADMIN_USERS, label: '用户治理', icon: User },
  { name: RouteName.ADMIN_CONTENT, label: '内容治理', icon: Document },
  { name: RouteName.ADMIN_MQ, label: '死信队列', icon: Connection },
]

const route = useRoute()
</script>

<template>
  <nav class="cm-admin-tabs" aria-label="管理后台导航">
    <RouterLink
      v-for="item in TABS"
      :key="item.name"
      :to="{ name: item.name }"
      class="cm-admin-tabs__item"
      :class="{ 'is-active': route.name === item.name }"
      :aria-current="route.name === item.name ? 'page' : undefined"
    >
      <el-icon :size="14"><component :is="item.icon" /></el-icon>
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.cm-admin-tabs {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-1);
  padding: 3px;
  background-color: var(--cm-bg-subtle);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
  max-width: 100%;
  overflow-x: auto;
}

.cm-admin-tabs__item {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
  padding: var(--cm-space-2) var(--cm-space-4);
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-text-tertiary);
  text-decoration: none;
  white-space: nowrap;
  border-radius: var(--cm-radius-md);
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.cm-admin-tabs__item:hover {
  color: var(--cm-text-primary);
}

.cm-admin-tabs__item.is-active {
  color: var(--cm-accent-700);
  background-color: var(--cm-bg-surface);
  box-shadow: var(--cm-shadow-xs);
}

.cm-admin-tabs__item:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--cm-accent-300);
}

@media (max-width: 480px) {
  .cm-admin-tabs {
    display: flex;
    width: 100%;
  }

  .cm-admin-tabs__item {
    flex: 1;
    justify-content: center;
    padding: var(--cm-space-2) var(--cm-space-2);
  }
}
</style>
