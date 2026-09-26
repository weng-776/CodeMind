<script setup lang="ts">
/**
 * 个人中心布局
 * ------------------------------------------------------------------
 * 承载「我的主页 / 文章 / 笔记 / 收藏 / 关注 / 粉丝」等 Tab。
 * 用子路由（<router-view />）而非组件切换，便于直接分享到具体 Tab。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useUserStore } from '@/stores/user'
import { RouteName } from '@/router/routes-names'

const route = useRoute()
const userStore = useUserStore()

interface TabItem {
  name: string
  label: string
}

const tabs: TabItem[] = [
  { name: RouteName.MY_PROFILE, label: '我的主页' },
  { name: RouteName.MY_ARTICLES, label: '我的文章' },
  { name: RouteName.MY_NOTES, label: '我的笔记' },
  { name: RouteName.MY_FAVORITES, label: '我的收藏' },
  { name: RouteName.MY_FOLLOWS, label: '我的关注' },
  { name: RouteName.MY_FANS, label: '我的粉丝' },
]

/** 当前激活的 Tab，用路由名驱动 */
const activeTab = computed(() => route.name as string)

const userInfo = computed(() => userStore.userInfo)
</script>

<template>
  <div class="cm-profile cm-container">
    <!-- 顶部用户摘要：跨 Tab 保持不变 -->
    <header class="cm-profile__header">
      <el-avatar :size="72" :src="userInfo?.avatar" class="cm-profile__avatar">
        {{ userInfo?.userName?.charAt(0) ?? '?' }}
      </el-avatar>

      <div class="cm-profile__ident">
        <h1 class="cm-profile__name">{{ userInfo?.userName || '未登录' }}</h1>
        <p class="cm-profile__intro">{{ userInfo?.intro || '这个人还没有填写简介' }}</p>
      </div>

      <dl class="cm-profile__stats">
        <div class="cm-profile__stat">
          <dt>文章</dt>
          <dd>{{ userInfo?.articleCount ?? 0 }}</dd>
        </div>
        <div class="cm-profile__stat">
          <dt>笔记</dt>
          <dd>{{ userInfo?.noteCount ?? 0 }}</dd>
        </div>
        <div class="cm-profile__stat">
          <dt>关注</dt>
          <dd>{{ userInfo?.followCount ?? 0 }}</dd>
        </div>
        <div class="cm-profile__stat">
          <dt>粉丝</dt>
          <dd>{{ userInfo?.fansCount ?? 0 }}</dd>
        </div>
      </dl>
    </header>

    <!-- Tab 导航 -->
    <nav class="cm-profile__tabs" aria-label="个人中心导航">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.name"
        :to="{ name: tab.name }"
        class="cm-profile__tab"
        :class="{ 'is-active': activeTab === tab.name }"
      >
        {{ tab.label }}
      </RouterLink>
    </nav>

    <!-- Tab 内容 -->
    <main class="cm-profile__body">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.cm-profile {
  padding-top: var(--cm-space-8);
  padding-bottom: var(--cm-space-16);
}

.cm-profile__header {
  display: flex;
  align-items: center;
  gap: var(--cm-space-5);
  padding-bottom: var(--cm-space-6);
}

.cm-profile__avatar {
  flex-shrink: 0;
  background-color: var(--cm-gray-300);
  font-size: var(--cm-font-size-2xl);
}

.cm-profile__ident {
  flex: 1;
  min-width: 0;
}

.cm-profile__name {
  font-size: var(--cm-font-size-2xl);
}

.cm-profile__intro {
  margin-top: var(--cm-space-2);
  font-size: var(--cm-font-size-base);
  color: var(--cm-text-tertiary);
}

.cm-profile__stats {
  display: flex;
  gap: var(--cm-space-8);
  margin: 0;
  flex-shrink: 0;
}

.cm-profile__stat {
  text-align: center;
}

.cm-profile__stat dt {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-profile__stat dd {
  margin: var(--cm-space-1) 0 0;
  font-family: var(--cm-font-mono);
  font-size: var(--cm-font-size-lg);
  font-weight: 500;
  color: var(--cm-text-primary);
}

.cm-profile__tabs {
  display: flex;
  gap: var(--cm-space-1);
  border-bottom: 1px solid var(--cm-border-subtle);
  overflow-x: auto;
}

.cm-profile__tab {
  position: relative;
  padding: var(--cm-space-3) var(--cm-space-4);
  font-size: var(--cm-font-size-md);
  font-weight: 500;
  color: var(--cm-text-tertiary);
  white-space: nowrap;
  transition: color var(--cm-duration-fast) var(--cm-ease-out);
}

.cm-profile__tab:hover {
  color: var(--cm-text-primary);
}

.cm-profile__tab.is-active {
  color: var(--cm-accent-600);
}

/* 下划线用伪元素，避免动画 width 触发重排 */
.cm-profile__tab::after {
  content: '';
  position: absolute;
  left: var(--cm-space-4);
  right: var(--cm-space-4);
  bottom: -1px;
  height: 2px;
  background-color: var(--cm-accent-600);
  transform: scaleX(0);
  transform-origin: center;
  transition: transform var(--cm-duration-base) var(--cm-ease-out);
}

.cm-profile__tab.is-active::after {
  transform: scaleX(1);
}

.cm-profile__body {
  padding-top: var(--cm-space-6);
}

@media (max-width: 768px) {
  .cm-profile__header {
    flex-wrap: wrap;
  }

  .cm-profile__stats {
    width: 100%;
    justify-content: space-between;
    gap: var(--cm-space-4);
  }
}
</style>
