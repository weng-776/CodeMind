/**
 * 个人知识库（笔记）与分类路由
 *
 * 这些页面均要求登录：笔记是个人数据，未登录访问没有意义
 * （且 /notes 列表接口本身就需要认证）。
 */
import type { RouteRecordRaw } from 'vue-router'
import { RouteName } from '../routes-names'

export const noteRoutes: RouteRecordRaw[] = [
  {
    path: '/notes',
    name: RouteName.NOTE_LIST,
    component: () => import('@/views/note/NoteListView.vue'),
    meta: {
      title: '我的知识库',
      layout: true,
      navKey: 'notes',
      requiresAuth: true,
    },
  },
  {
    path: '/notes/create',
    name: RouteName.NOTE_CREATE,
    component: () => import('@/views/note/NoteEditView.vue'),
    meta: {
      title: '创建笔记',
      layout: true,
      navKey: 'notes',
      requiresAuth: true,
    },
  },
  {
    // 笔记详情允许未登录访问（公开笔记），私密笔记由后端拦截
    path: '/notes/:id(\\d+)',
    name: RouteName.NOTE_DETAIL,
    component: () => import('@/views/note/NoteDetailView.vue'),
    meta: {
      title: '笔记详情',
      layout: true,
      navKey: 'notes',
      requiresAuth: false,
    },
  },
  {
    path: '/notes/:id(\\d+)/edit',
    name: RouteName.NOTE_EDIT,
    component: () => import('@/views/note/NoteEditView.vue'),
    meta: {
      title: '编辑笔记',
      layout: true,
      requiresAuth: true,
    },
  },
  {
    path: '/categories',
    name: RouteName.CATEGORY_MANAGE,
    component: () => import('@/views/note/CategoryManageView.vue'),
    meta: {
      title: '分类管理',
      layout: true,
      navKey: 'notes',
      requiresAuth: true,
    },
  },
]
