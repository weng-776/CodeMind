/**
 * 用户相关路由
 * /profile 采用 Tab 结构，子 Tab 用独立路径而非 query，
 * 便于直接分享链接到具体 Tab。
 */
import type { RouteRecordRaw } from 'vue-router'
import { RouteName } from '../routes-names'

export const userRoutes: RouteRecordRaw[] = [
  {
    // 他人主页：未登录也可查看
    path: '/user/:userId(\\d+)',
    name: RouteName.USER_PROFILE,
    component: () => import('@/views/user/UserProfileView.vue'),
    meta: {
      title: '用户主页',
      layout: true,
      requiresAuth: false,
    },
  },
  {
    // 当前用户个人中心：默认重定向到「我的主页」Tab
    path: '/profile',
    component: () => import('@/views/user/ProfileLayout.vue'),
    meta: {
      layout: true,
      requiresAuth: true,
    },
    children: [
      {
        path: '',
        redirect: { name: RouteName.MY_PROFILE },
      },
      {
        path: 'home',
        name: RouteName.MY_PROFILE,
        component: () => import('@/views/user/tabs/ProfileHomeTab.vue'),
        meta: { title: '我的主页', layout: true, requiresAuth: true, navKey: 'profile' },
      },
      {
        path: 'articles',
        name: RouteName.MY_ARTICLES,
        component: () => import('@/views/user/tabs/ProfileArticlesTab.vue'),
        meta: { title: '我的文章', layout: true, requiresAuth: true, navKey: 'profile' },
      },
      {
        path: 'notes',
        name: RouteName.MY_NOTES,
        component: () => import('@/views/user/tabs/ProfileNotesTab.vue'),
        meta: { title: '我的笔记', layout: true, requiresAuth: true, navKey: 'profile' },
      },
      {
        path: 'favorites',
        name: RouteName.MY_FAVORITES,
        component: () => import('@/views/user/tabs/ProfileFavoritesTab.vue'),
        meta: { title: '我的收藏', layout: true, requiresAuth: true, navKey: 'profile' },
      },
      {
        path: 'follows',
        name: RouteName.MY_FOLLOWS,
        component: () => import('@/views/user/tabs/ProfileFollowsTab.vue'),
        meta: { title: '我的关注', layout: true, requiresAuth: true, navKey: 'profile' },
      },
      {
        path: 'fans',
        name: RouteName.MY_FANS,
        component: () => import('@/views/user/tabs/ProfileFansTab.vue'),
        meta: { title: '我的粉丝', layout: true, requiresAuth: true, navKey: 'profile' },
      },
    ],
  },
]
