/**
 * 路由名称常量
 * ------------------------------------------------------------------
 * 统一用常量而非裸字符串，避免改名时漏改导致跳转失效。
 */
export const RouteName = {
  /* 认证 */
  LOGIN: 'login',
  SET_PASSWORD: 'set-password',

  /* 首页 */
  HOME: 'home',

  /* 社区文章 */
  ARTICLE_LIST: 'article-list',
  ARTICLE_DETAIL: 'article-detail',
  ARTICLE_CREATE: 'article-create',
  ARTICLE_EDIT: 'article-edit',

  /* 个人知识库 */
  NOTE_LIST: 'note-list',
  NOTE_DETAIL: 'note-detail',
  NOTE_CREATE: 'note-create',
  NOTE_EDIT: 'note-edit',
  CATEGORY_MANAGE: 'category-manage',

  /* 用户 */
  USER_PROFILE: 'user-profile',
  MY_PROFILE: 'my-profile',
  MY_ARTICLES: 'my-articles',
  MY_NOTES: 'my-notes',
  MY_FAVORITES: 'my-favorites',
  MY_FOLLOWS: 'my-follows',
  MY_FANS: 'my-fans',

  /* 消息 */
  NOTIFICATIONS: 'notifications',

  /* AI */
  AI_CHAT: 'ai-chat',

  /* 管理后台（仅管理员可见；真权限在后端 AdminInterceptor） */
  ADMIN_DASHBOARD: 'admin-dashboard',
  ADMIN_USERS: 'admin-users',
  ADMIN_CONTENT: 'admin-content',
  ADMIN_MQ: 'admin-mq',

  /* 异常 */
  NOT_FOUND: 'not-found',
} as const

export type RouteNameValue = (typeof RouteName)[keyof typeof RouteName]
