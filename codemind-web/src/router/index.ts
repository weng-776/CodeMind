/**
 * 路由主入口
 * ------------------------------------------------------------------
 * 职责：
 *   1. 组装各业务模块的路由
 *   2. 登录守卫（requiresAuth / redirectIfAuthed）
 *   3. 动态 document.title
 *   4. 把「401 跳登录」的回调注入请求层
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

import { setUnauthorizedHandler } from '@/api/request'
import { useUserStore } from '@/stores/user'

import { authRoutes } from './modules/auth'
import { homeRoutes } from './modules/home'
import { articleRoutes } from './modules/article'
import { noteRoutes } from './modules/note'
import { userRoutes } from './modules/user'
import { notifyRoutes } from './modules/notify'
import { aiRoutes } from './modules/ai'
import { RouteName } from './routes-names'

export { RouteName }

const routes: RouteRecordRaw[] = [
  ...homeRoutes,
  ...authRoutes,
  ...articleRoutes,
  ...noteRoutes,
  ...userRoutes,
  ...notifyRoutes,
  ...aiRoutes,
  {
    path: '/:pathMatch(.*)*',
    name: RouteName.NOT_FOUND,
    component: () => import('@/views/error/NotFoundView.vue'),
    meta: {
      title: '页面不存在',
      layout: true,
      requiresAuth: false,
    },
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(_to, _from, savedPosition) {
    // 浏览器前进/后退时恢复原滚动位置，其余情况回到顶部
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
})

/* ==================== 登录守卫 ==================== */
router.beforeEach(async (to) => {
  const userStore = useUserStore()

  // 1) 已登录用户访问登录页 → 回首页
  if (to.meta.redirectIfAuthed && userStore.isLoggedIn) {
    return { name: RouteName.HOME }
  }

  // 2) 需要登录的页面且未登录 → 去登录页并记住来源
  if (to.meta.requiresAuth && !userStore.isLoggedIn) {
    return {
      name: RouteName.LOGIN,
      query: { redirect: to.fullPath },
    }
  }

  // 3) 已登录但用户信息尚未加载 → 按需拉取
  //    （刷新页面后 Pinia 状态丢失，但 token 还在 localStorage 中）
  if (userStore.isLoggedIn && !userStore.infoLoaded) {
    await userStore.ensureUserInfo()
    await userStore.fetchUnreadCount()
  }

  return true
})

/* ==================== 页面标题 ==================== */
router.afterEach((to) => {
  const title = to.meta.title
  document.title = title ? `${title} · CodeMind` : 'CodeMind'
})

/* ==================== 注入 401 处理 ==================== */
// 请求层不直接依赖 router，由这里反向注册，避免循环依赖。
setUnauthorizedHandler(() => {
  const userStore = useUserStore()
  userStore.logout()

  const current = router.currentRoute.value
  if (current.name !== RouteName.LOGIN) {
    void router.replace({
      name: RouteName.LOGIN,
      query: { redirect: current.fullPath },
    })
  }
})

export default router
