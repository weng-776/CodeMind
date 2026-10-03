/**
 * 管理端类型定义
 * ------------------------------------------------------------------
 * 对应 `管理端前端设计说明.md` §4（全部为 2026-10-02 真机实测契约）。
 *
 * 两条容易踩的约定：
 *   1. 列表 VO（Article/Note/Comment）**一律不含正文 `content`** —— 这是刻意的
 *      设计（正文是长文本，列表页不需要），不是后端漏字段，别去"补"。
 *   2. 管理端是「全量视角」：文章列表含草稿、笔记列表含草稿与私密。
 *      这是设计意图而非越权，但页面**必须**把「草稿 / 私密」标出来，
 *      否则管理员会误以为内容已经公开。
 */
import type { ID, PageResult } from './common'

/** 用户角色：0=普通 1=管理员（对应后端 UserConstants.USER_ROLE_*） */
export const UserRole = { NORMAL: 0, ADMIN: 1 } as const
/** 账号状态：0=禁用 1=正常（对应 UserConstants.USER_STATUS_*） */
export const UserStatus = { DISABLED: 0, NORMAL: 1 } as const

/* ==================== 用户治理 ==================== */

/**
 * 管理端用户列表项（GET /api/admin/users 的 records 元素）。
 *
 * ⚠️ 响应里**没有 `password`**：后端刻意手写字段拷贝而非 BeanUtils，
 *    别以为漏了、也别试图显示。
 * ⚠️ `avatar` 可能是 `Default_avatar.jpg`，而那张图在 MinIO 上是 404
 *    （测试数据问题）→ 头像必须有加载失败兜底。
 */
export interface AdminUserVO {
  id: ID
  phone: string
  userName: string
  avatar: string
  intro: string
  /** 0=禁用 1=正常，见 UserStatus */
  status: number
  /** 0=普通 1=管理员，见 UserRole */
  role: number
  createTime: string
}

/* ==================== 内容治理 ==================== */

/** 列表 VO 里的作者（后端 AdminXxxVO 内嵌的 author 对象） */
export interface AdminAuthorVO {
  id: ID
  userName: string
  avatar: string
  intro: string
}

/** 管理端文章列表项（GET /api/admin/articles 的 records 元素） */
export interface AdminArticleVO {
  id: ID
  userId: ID
  author: AdminAuthorVO
  title: string
  summary: string
  cover: string | null
  viewCount: number
  likeCount: number
  favoriteCount: number
  /** 0=草稿/下架 1=公开 */
  status: number
  createTime: string
}

/** 管理端笔记列表项（GET /api/admin/notes 的 records 元素） */
export interface AdminNoteVO {
  id: ID
  userId: ID
  author: AdminAuthorVO
  categoryId: number | null
  title: string
  summary: string
  cover: string | null
  /** 0=私密 1=公开 */
  visibility: number
  /** 0=草稿 1=正常 */
  status: number
  wordCount: number
  viewCount: number
  createTime: string
}

/** 管理端评论列表项（GET /api/admin/comments 的 records 元素） */
export interface AdminCommentVO {
  id: ID
  articleId: ID
  userId: ID
  author: AdminAuthorVO
  /** 0=一级评论，非 0 是回复（后端评论只有两层） */
  parentId: number
  content: string
  createTime: string
}

/* ==================== 死信队列 ==================== */

/** 死信队列概要（GET /api/admin/mq/queues，固定 6 条） */
export interface AdminQueueVO {
  queueName: string
  messageCount: number
  consumerCount: number
}

/* ==================== 数据看板 ==================== */

/**
 * 看板总览（GET /api/admin/dashboard/overview）。
 *
 * ⚠️ 只有这 12 个字段 —— **没有「今日关注数」**（follow 表存在但看板不含它），
 *    也别自己加维度。
 * ⚠️ 「今日」的边界是 **GMT+8**；全是 0 是常态，不是空态。
 */
export interface DashboardOverviewVO {
  userCount: number
  articleCount: number
  noteCount: number
  commentCount: number
  likeCount: number
  favoriteCount: number
  todayUserCount: number
  todayArticleCount: number
  todayNoteCount: number
  todayCommentCount: number
  todayLikeCount: number
  todayFavoriteCount: number
}

/* ==================== 分页别名 ==================== */

export type AdminUserPage = PageResult<AdminUserVO>
export type AdminArticlePage = PageResult<AdminArticleVO>
export type AdminNotePage = PageResult<AdminNoteVO>
export type AdminCommentPage = PageResult<AdminCommentVO>
