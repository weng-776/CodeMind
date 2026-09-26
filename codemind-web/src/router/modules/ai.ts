/**
 * AI 助手路由
 */
import type { RouteRecordRaw } from 'vue-router'
import { RouteName } from '../routes-names'

export const aiRoutes: RouteRecordRaw[] = [
  {
    // 会话 ID 作为可选 query（?c=xxx），便于刷新后恢复当前会话
    path: '/ai',
    name: RouteName.AI_CHAT,
    component: () => import('@/views/ai/AiChatView.vue'),
    meta: {
      title: 'AI 助手',
      layout: true,
      navKey: 'ai',
      requiresAuth: true,
    },
  },
]
