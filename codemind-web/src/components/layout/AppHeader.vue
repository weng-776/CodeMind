<script setup lang="ts">
/**
 * 全局顶栏
 * ------------------------------------------------------------------
 * 结构：Logo | 主导航（首页 / 社区 / 我的知识库 / AI 助手 / 消息）| 右侧（头像菜单 或 登录入口）
 *
 * 几个刻意的取舍：
 *   1. 导航高亮读 route.meta.navKey，而不是自己解析 path —— 路由表是唯一事实来源，
 *      新增页面只要在 meta 里写好 navKey 就会自动高亮。
 *   2. 未读数只在登录后请求一次（路由守卫已做），后续靠 store 本地增减，
 *      切页时不重复打接口。角标挂在导航项「消息」上（>99 显示 99+）。
 *   3. 未登录时「消息」等需登录项**照常显示**，点击由 handleNavClick 送去
 *      `/login?redirect=...`，而不是让游客先撞 401。
 *   3. 退出登录只清本地状态，不调后端 —— 后端无 logout 接口（仅 JWT 无状态）。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import { useUserStore } from '@/stores/user'
import { useAppStore } from '@/stores/app'
import { RouteName } from '@/router/routes-names'

interface NavItem {
  key: string
  label: string
  to: { name: string }
  /** 是否需要登录；未登录时点击直接去登录页 */
  requiresAuth: boolean
}

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const appStore = useAppStore()

/**
 * key 必须与各路由 meta.navKey 完全一致，否则高亮失效。
 * 以 router/modules/*.ts 为准：home / community / notes / ai。
 */
const navItems: NavItem[] = [
  { key: 'home', label: '首页', to: { name: RouteName.HOME }, requiresAuth: false },
  { key: 'community', label: '社区', to: { name: RouteName.ARTICLE_LIST }, requiresAuth: false },
  { key: 'notes', label: '我的知识库', to: { name: RouteName.NOTE_LIST }, requiresAuth: true },
  { key: 'ai', label: 'AI 助手', to: { name: RouteName.AI_CHAT }, requiresAuth: true },
  /*
   * 消息不再做成右上角的独立铃铛：那样会出现「导航项 + 铃铛」两个入口指向同一页。
   * 现在它在导航里，未读角标挂在它身上；未登录时点击由 handleNavClick 送去登录页。
   */
  { key: 'notify', label: '消息', to: { name: RouteName.NOTIFICATIONS }, requiresAuth: true },
]

/**
 * 导航高亮 key。
 * 优先读 meta.navKey；`/notifications` 的路由表里暂时没写 navKey，
 * 而 router/modules/notify.ts 不在本单范围内，这里按 route.name 兜一次，
 * 免得「消息」永远不高亮（有单子能动 router 时再补 meta 更干净）。
 */
const activeNav = computed(() => {
  const fromMeta = route.meta.navKey
  if (fromMeta) return fromMeta
  return route.name === RouteName.NOTIFICATIONS ? 'notify' : ''
})

/** 未读数：99+ 收敛显示 */
const unreadText = computed(() => {
  const n = userStore.unreadCount
  return n > 99 ? '99+' : String(n)
})

/** 头像加载失败时的兜底字符 */
const avatarFallback = computed(() => userStore.userName?.charAt(0) ?? 'U')

/** 移动端导航抽屉 */
const mobileOpen = ref(false)

function handleNavClick(item: NavItem, event: Event) {
  if (item.requiresAuth && !userStore.isLoggedIn) {
    event.preventDefault()
    void router.push({
      name: RouteName.LOGIN,
      query: { redirect: router.resolve(item.to).fullPath },
    })
    return
  }
  mobileOpen.value = false
}

function goLogin() {
  void router.push({
    name: RouteName.LOGIN,
    query: { redirect: route.fullPath },
  })
}

async function handleUserCommand(command: string) {
  switch (command) {
    case 'profile':
      await router.push({ name: RouteName.MY_PROFILE })
      break
    case 'articles':
      await router.push({ name: RouteName.MY_ARTICLES })
      break
    case 'notes':
      await router.push({ name: RouteName.NOTE_LIST })
      break
    case 'categories':
      await router.push({ name: RouteName.CATEGORY_MANAGE })
      break
    case 'notifications':
      await router.push({ name: RouteName.NOTIFICATIONS })
      break
    case 'logout':
      await handleLogout()
      break
  }
}

async function handleLogout() {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出登录', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }

  userStore.logout()
  ElMessage.success('已退出登录')

  // 退出后如果当前页需要登录，回到首页；否则原地停留
  if (route.meta.requiresAuth) {
    void router.push({ name: RouteName.HOME })
  }
}

</script>

<template>
  <header class="cm-header">
    <div class="cm-header__inner cm-container">
      <!-- Logo -->
      <RouterLink :to="{ name: RouteName.HOME }" class="cm-header__logo" aria-label="CodeMind 首页">
        <span class="cm-header__logo-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="8 6 3 12 8 18" />
            <polyline points="16 6 21 12 16 18" />
            <line x1="13.5" y1="4" x2="10.5" y2="20" />
          </svg>
        </span>
        <span class="cm-header__logo-text">CodeMind</span>
      </RouterLink>

      <!-- 主导航 -->
      <nav class="cm-header__nav" aria-label="主导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.key"
          :to="item.to"
          class="cm-header__nav-item"
          :class="{ 'is-active': activeNav === item.key }"
          @click="handleNavClick(item, $event)"
        >
          {{ item.label }}

          <!-- 未读角标：只挂在「消息」上，登录后才可能非 0 -->
          <span
            v-if="item.key === 'notify' && userStore.unreadCount > 0"
            class="cm-header__badge cm-header__badge--nav"
          >
            {{ unreadText }}
          </span>
        </RouterLink>
      </nav>

      <!-- 右侧操作区 -->
      <div class="cm-header__actions">
        <template v-if="userStore.isLoggedIn">
          <!-- 用户菜单 -->
          <el-dropdown trigger="click" @command="handleUserCommand">
            <button type="button" class="cm-header__user" aria-label="用户菜单">
              <el-avatar :size="28" :src="userStore.avatar || undefined" class="cm-header__avatar">
                {{ avatarFallback }}
              </el-avatar>
              <span class="cm-header__username cm-truncate">{{ userStore.userName || '未命名' }}</span>
              <el-icon class="cm-header__caret" :size="12"><ArrowDown /></el-icon>
            </button>

            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">
                  <el-icon><User /></el-icon>个人中心
                </el-dropdown-item>
                <el-dropdown-item command="articles">
                  <el-icon><Document /></el-icon>我的文章
                </el-dropdown-item>
                <el-dropdown-item command="notes">
                  <el-icon><Notebook /></el-icon>我的笔记
                </el-dropdown-item>
                <el-dropdown-item command="categories">
                  <el-icon><FolderOpened /></el-icon>分类管理
                </el-dropdown-item>
                <el-dropdown-item command="notifications" divided>
                  <el-icon><Bell /></el-icon>消息通知
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>
                  <el-icon><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>

        <template v-else>
          <el-button size="small" @click="goLogin">登录</el-button>
          <el-button size="small" type="primary" @click="goLogin">开始使用</el-button>
        </template>

        <!-- 移动端汉堡 -->
        <button
          type="button"
          class="cm-header__hamburger"
          :aria-expanded="appStore.mobileNavOpen"
          aria-label="打开导航"
          @click="appStore.toggleMobileNav()"
        >
          <el-icon :size="19"><Menu /></el-icon>
        </button>
      </div>
    </div>

    <!-- 移动端导航面板 -->
    <transition name="cm-nav-slide">
      <nav v-if="appStore.mobileNavOpen" class="cm-header__mobile-nav" aria-label="主导航（移动端）">
        <RouterLink
          v-for="item in navItems"
          :key="item.key"
          :to="item.to"
          class="cm-header__mobile-item"
          :class="{ 'is-active': activeNav === item.key }"
          @click="handleNavClick(item, $event)"
        >
          {{ item.label }}
          <span
            v-if="item.key === 'notify' && userStore.unreadCount > 0"
            class="cm-header__badge cm-header__badge--nav"
          >
            {{ unreadText }}
          </span>
        </RouterLink>
      </nav>
    </transition>
  </header>
</template>

<style scoped>
.cm-header {
  position: sticky;
  top: 0;
  z-index: var(--cm-z-header);
  background-color: var(--cm-bg-glass);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-header__inner {
  display: flex;
  align-items: center;
  gap: var(--cm-space-8);
  height: var(--cm-header-height);
}

/* ---------- Logo ---------- */
.cm-header__logo {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
  text-decoration: none;
  color: var(--cm-text-primary);
}

.cm-header__logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: var(--cm-text-inverse);
  background-color: var(--cm-accent-600);
  border-radius: var(--cm-radius-md);
}

.cm-header__logo-mark svg {
  width: 15px;
  height: 15px;
}

.cm-header__logo-text {
  font-size: var(--cm-font-size-lg);
  font-weight: 600;
  letter-spacing: -0.02em;
}

/* ---------- 导航 ---------- */
.cm-header__nav {
  display: flex;
  align-items: center;
  gap: var(--cm-space-1);
  height: 100%;
}

.cm-header__nav-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 100%;
  padding: 0 var(--cm-space-3);
  font-size: var(--cm-font-size-base);
  color: var(--cm-text-secondary);
  text-decoration: none;
  transition: color 0.15s ease;
}

.cm-header__nav-item:hover {
  color: var(--cm-text-primary);
}

.cm-header__nav-item.is-active {
  color: var(--cm-text-primary);
  font-weight: 500;
}

/* 下划线用伪元素缩放，避免布局跳动 */
.cm-header__nav-item::after {
  content: '';
  position: absolute;
  left: var(--cm-space-3);
  right: var(--cm-space-3);
  bottom: -1px;
  height: 2px;
  background-color: var(--cm-accent-600);
  border-radius: var(--cm-radius-full);
  transform: scaleX(0);
  transition: transform 0.2s var(--cm-ease-out);
}

.cm-header__nav-item.is-active::after {
  transform: scaleX(1);
}

/* ---------- 右侧 ---------- */
.cm-header__actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  margin-left: auto;
  flex-shrink: 0;
}

/* 未读角标：默认是浮在图标右上角的形态 */
.cm-header__badge {
  position: absolute;
  top: 1px;
  right: 0;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 10px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  color: var(--cm-text-inverse);
  background-color: var(--cm-danger);
  border: 2px solid var(--cm-bg-surface);
  border-radius: var(--cm-radius-full);
  box-sizing: content-box;
}

/* 挂在导航文字右侧的形态：跟随文字流，不浮层 */
.cm-header__badge--nav {
  position: static;
  margin-left: var(--cm-space-2);
  border: none;
  box-sizing: border-box;
  line-height: 16px;
  font-weight: 500;
}

.cm-header__user {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  max-width: 180px;
  padding: 3px var(--cm-space-2) 3px 3px;
  background: none;
  border: none;
  border-radius: var(--cm-radius-full);
  cursor: pointer;
  color: var(--cm-text-primary);
  transition: background-color 0.15s ease;
}

.cm-header__user:hover {
  background-color: var(--cm-bg-hover);
}

.cm-header__avatar {
  flex-shrink: 0;
  font-size: 12px;
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-header__username {
  font-size: var(--cm-font-size-sm);
  max-width: 110px;
}

.cm-header__caret {
  flex-shrink: 0;
  color: var(--cm-text-quaternary);
}

.cm-header__hamburger {
  display: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  color: var(--cm-text-secondary);
  background: none;
  border: none;
  border-radius: var(--cm-radius-md);
  cursor: pointer;
}

.cm-header__hamburger:hover {
  background-color: var(--cm-bg-hover);
}

/* ---------- 移动端面板 ---------- */
.cm-header__mobile-nav {
  display: none;
  flex-direction: column;
  padding: var(--cm-space-2) var(--cm-space-6) var(--cm-space-4);
  border-top: 1px solid var(--cm-border-subtle);
  background-color: var(--cm-bg-surface);
}

.cm-header__mobile-item {
  padding: var(--cm-space-3) 0;
  font-size: var(--cm-font-size-md);
  color: var(--cm-text-secondary);
  text-decoration: none;
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-header__mobile-item:last-child {
  border-bottom: none;
}

.cm-header__mobile-item.is-active {
  color: var(--cm-accent-600);
  font-weight: 500;
}

.cm-nav-slide-enter-active,
.cm-nav-slide-leave-active {
  transition: opacity 0.18s ease;
}

.cm-nav-slide-enter-from,
.cm-nav-slide-leave-to {
  opacity: 0;
}

/* ---------- 响应式 ---------- */
@media (max-width: 860px) {
  .cm-header__inner {
    gap: var(--cm-space-4);
  }

  .cm-header__nav {
    display: none;
  }

  .cm-header__hamburger {
    display: inline-flex;
  }

  .cm-header__mobile-nav {
    display: flex;
  }

  .cm-header__username {
    display: none;
  }
}

@media (max-width: 480px) {
  .cm-header__logo-text {
    display: none;
  }
}
</style>
