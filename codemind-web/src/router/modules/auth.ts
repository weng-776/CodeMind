/**
 * 认证相关路由
 */
import type { RouteRecordRaw } from 'vue-router'
import { RouteName } from '../routes-names'

export const authRoutes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: RouteName.LOGIN,
    component: () => import('@/views/auth/LoginView.vue'),
    meta: {
      title: '登录',
      layout: false,
      // 已登录用户访问登录页时，直接回首页
      redirectIfAuthed: true,
    },
  },
  {
    /*
     * 注册后强制设置密码（1.13）。
     * `skipPasswordGuard` 必须有：否则守卫看到 hasPassword === false 后
     * 会把用户从本页再跳回本页，形成自跳自的死循环。
     */
    path: '/set-password',
    name: RouteName.SET_PASSWORD,
    component: () => import('@/views/auth/SetPasswordView.vue'),
    meta: {
      title: '设置密码',
      layout: false,
      requiresAuth: true,
      skipPasswordGuard: true,
    },
  },
]
