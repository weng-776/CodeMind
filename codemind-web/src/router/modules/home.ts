/**
 * 首页路由
 */
import type { RouteRecordRaw } from 'vue-router'
import { RouteName } from '../routes-names'

export const homeRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    name: RouteName.HOME,
    component: () => import('@/views/home/HomeView.vue'),
    meta: {
      title: '首页',
      layout: true,
      navKey: 'home',
      // 未登录也可浏览首页的公开内容
      requiresAuth: false,
    },
  },
]
