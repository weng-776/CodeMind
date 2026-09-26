/**
 * 社区文章路由
 * 注意顺序：/articles/create 必须排在 /articles/:id 之前，
 * 否则 "create" 会被当作 id 匹配。
 */
import type { RouteRecordRaw } from 'vue-router'
import { RouteName } from '../routes-names'

export const articleRoutes: RouteRecordRaw[] = [
  {
    path: '/articles',
    name: RouteName.ARTICLE_LIST,
    component: () => import('@/views/article/ArticleListView.vue'),
    meta: {
      title: '社区',
      layout: true,
      navKey: 'community',
      requiresAuth: false,
    },
  },
  {
    path: '/articles/create',
    name: RouteName.ARTICLE_CREATE,
    component: () => import('@/views/article/ArticleEditView.vue'),
    meta: {
      title: '发布文章',
      layout: true,
      requiresAuth: true,
    },
  },
  {
    path: '/articles/:id(\\d+)',
    name: RouteName.ARTICLE_DETAIL,
    component: () => import('@/views/article/ArticleDetailView.vue'),
    meta: {
      title: '文章详情',
      layout: true,
      navKey: 'community',
      requiresAuth: false,
    },
  },
  {
    path: '/articles/:id(\\d+)/edit',
    name: RouteName.ARTICLE_EDIT,
    component: () => import('@/views/article/ArticleEditView.vue'),
    meta: {
      title: '编辑文章',
      layout: true,
      requiresAuth: true,
    },
  },
]
