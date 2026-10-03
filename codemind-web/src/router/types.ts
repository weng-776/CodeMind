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
    /**
     * 是否要求管理员身份。
     *
     * ⚠️ 只做**界面门控**，不是权限依据 —— 真判定在后端 `AdminInterceptor`
     *    （每次请求都查库取 role）。详见 `管理端前端设计说明.md` §0.1。
     * ⚠️ 守卫**刻意不在这里跳转**：`userInfo` 是登录时拉一次的缓存，
     *    管理员被降权后前端可能仍是 admin；若守卫直接把非管理员跳走，
     *    页面就永远没有机会渲染「无管理员权限」态。
     *    所以门控交给页面（`isAdmin` 预检 + 接口 403 兜底，两条路都渲染 403 态）。
     */
    requiresAdmin?: boolean
  }
}
