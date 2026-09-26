/**
 * 通用类型定义
 * 对应 API 文档 v1.2「通用约定」章节。
 */

/** 后端统一响应包装：{ code, message, data } */
export interface ApiResult<T = unknown> {
  code: number
  message: string
  data: T
}

/**
 * 分页响应体。
 * 注意：真实后端返回的是 MyBatis-Plus 的 `Page` 对象，实测（2026-09-23）
 * 只有 `records / total / size / current / pages`，**没有 `page` 字段** ——
 * 当前页一律读 `current`；`page` 仅作历史兼容的可选字段保留，不要再读它。
 */
export interface PageResult<T> {
  total: number
  /** 历史兼容字段：真实后端不返回，读取请用 `current` */
  page?: number
  size: number
  current?: number
  /** 总页数。MyBatis-Plus `Page` 原样返回时**确实带着它**（2026-09-23 实测确认，T3/T4.5） */
  pages?: number
  records: T[]
}

/** 分页请求参数：page 从 1 开始，size 默认 10 */
export interface PageQuery {
  page?: number
  size?: number
}

/** 通用 ID 类型：后端统一使用 long，JS 中按 number 处理 */
export type ID = number

/** 文章/笔记状态：0 草稿，1 正常/发布 */
export enum ContentStatus {
  DRAFT = 0,
  PUBLISHED = 1,
}

/** 笔记可见性：0 私密，1 公开 */
export enum Visibility {
  PRIVATE = 0,
  PUBLIC = 1,
}
