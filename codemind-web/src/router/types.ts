/**
 * 路由 meta 类型声明
 * 通过 declare module 扩展 vue-router 的 RouteMeta，
 * 让 route.meta.requiresAuth 等字段有类型提示。
 */
import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    /** 页面标题，用于 document.title 与面包屑 */
    title?: string
    /** 是否需要登录才能访问 */
    requiresAuth?: boolean
    /** 已登录用户访问时是否自动跳转首页（用于登录页） */
    redirectIfAuthed?: boolean
    /** 是否启用主布局（Header + Main）。登录页为 false */
    layout?: boolean
    /** Header 导航中高亮的菜单标识 */
    navKey?: string
  }
}
