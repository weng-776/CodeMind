/**
 * 社区文章模块类型
 * 对应 API 文档 v1.2 第三章「社区模块」。
 */
import type { ID, ContentStatus } from './common'
import type { UserSimpleVO } from './user'
import type { TagVO } from './category'

/**
 * 文章作者信息。
 * 文章详情中的 user 比列表多一个 intro 字段，这里统一声明为可选。
 */
export interface ArticleUserVO {
  id: ID
  userName: string
  avatar: string
  intro?: string
}

/** 文章列表项 —— 用于 3.5 列表、3.6 我的文章、3.12 收藏列表、3.17 热门、3.18 最新、3.19 标签 */
export interface ArticleListItemVO {
  id: ID
  title: string
  cover: string
  summary: string
  /** 3.6 我的文章中返回 */
  status?: ContentStatus
  /** 列表接口均返回；我的文章/收藏列表不返回时说明当前用户即作者/收藏者 */
  user?: ArticleUserVO
  tags: TagVO[]
  viewCount: number
  likeCount: number
  favoriteCount: number
  commentCount: number
  createTime: string
  updateTime?: string
}

/** 文章详情（3.4 GET /api/article/{articleId}） */
export interface ArticleDetailVO {
  id: ID
  title: string
  summary: string
  /** Markdown 原文 */
  content: string
  cover: string
  user: ArticleUserVO
  viewCount: number
  likeCount: number
  favoriteCount: number
  tags: TagVO[]
  /** 当前用户是否点赞（未登录为 false） */
  isLiked: boolean
  /** 当前用户是否收藏（未登录为 false） */
  isFavorited: boolean
  createTime: string
  updateTime: string
}

/* ==================== 请求参数 ==================== */

/**
 * 3.1 发布文章
 * 该接口使用 multipart/form-data，因此这里描述的是「FormData 的语义字段」，
 * 真正的组装逻辑在 api/article.ts 中完成。
 */
export interface CreateArticleParams {
  title: string
  /** Markdown 内容 */
  content: string
  /** 封面图片文件（仅图片类型），不传则无封面 */
  file?: File | null
  summary?: string
  status?: ContentStatus
  tagIds?: ID[]
}

/** 3.2 编辑文章（multipart/form-data，全字段可选） */
export interface UpdateArticleParams {
  title?: string
  summary?: string
  content?: string
  /** 封面图片文件，不传则保留原封面 */
  file?: File | null
  status?: ContentStatus
  /** 传空数组表示清空标签 */
  tagIds?: ID[]
}

/** 3.6 我的文章查询参数 */
export interface MyArticleQuery {
  page?: number
  size?: number
  /** 不传则查全部（含草稿） */
  status?: ContentStatus
}

/** 文章列表查询参数（3.5 / 3.17 / 3.18 / 3.19 通用） */
export interface ArticleListQuery {
  page?: number
  size?: number
}
