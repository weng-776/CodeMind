/**
 * 管理端路由
 * ------------------------------------------------------------------
 * 4 个页面共用同一套 meta（见 `管理端前端设计说明.md` §3.1）：
 *   layout: true       → 套主布局（Header + Footer）
 *   navKey: 'admin'    → 4 个页面互相之间高亮（不挂 Header 主导航）
 *   requiresAuth: true → 未登录 → `/login?redirect=…`
 *   requiresAdmin: true→ 仅界面门控，守卫**不跳转**，由页面渲染 403 态
 *
 * 为什么不做成「左菜单 + 右表格」：`05_前端开发SOP` §6 明令禁止把 CodeMind
 * 做成传统 Admin。四个页面之间用 Tab / 分段控件切换（见
 * `views/admin/components/AdminTabs.vue`），与站点其余部分风格一致。
 *
 * ⚠️ 4 个 View 在本单（T16）一次性全部建出，路由表才不会有「指向不存在的
 *    文件」的入口。其中只有看板是本单的实现；用户治理 / 内容治理 / 死信队列
 *    三个页面在 T16 先用 `DevPlaceholder` 占位，由 T17 / T18 / T19 各自替换。
 */
import type { RouteRecordRaw } from 'vue-router'
import { RouteName } from '../routes-names'

/** 4 个页面共用的 meta（每个页面只覆盖 title） */
const adminMeta = {
  layout: true,
  navKey: 'admin',
  requiresAuth: true,
  requiresAdmin: true,
} as const

export const adminRoutes: RouteRecordRaw[] = [
  {
    path: '/admin',
    name: RouteName.ADMIN_DASHBOARD,
    component: () => import('@/views/admin/AdminDashboardView.vue'),
    meta: { ...adminMeta, title: '管理后台' },
  },
  {
    path: '/admin/users',
    name: RouteName.ADMIN_USERS,
    component: () => import('@/views/admin/AdminUserView.vue'),
    meta: { ...adminMeta, title: '用户治理' },
  },
  {
    path: '/admin/content',
    name: RouteName.ADMIN_CONTENT,
    component: () => import('@/views/admin/AdminContentView.vue'),
    meta: { ...adminMeta, title: '内容治理' },
  },
  {
    path: '/admin/mq',
    name: RouteName.ADMIN_MQ,
    component: () => import('@/views/admin/AdminMqView.vue'),
    meta: { ...adminMeta, title: '死信队列' },
  },
]
