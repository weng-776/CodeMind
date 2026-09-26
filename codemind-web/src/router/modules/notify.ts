/**
 * 消息通知路由
 */
import type { RouteRecordRaw } from 'vue-router'
import { RouteName } from '../routes-names'

export const notifyRoutes: RouteRecordRaw[] = [
  {
    path: '/notifications',
    name: RouteName.NOTIFICATIONS,
    component: () => import('@/views/notify/NotificationView.vue'),
    meta: {
      title: '消息',
      layout: true,
      navKey: 'notify',
      requiresAuth: true,
    },
  },
]
