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
]
