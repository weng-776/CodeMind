/**
 * 社区文章模块 API（API 文档 v1.2 第三章，共 19 个接口）
 *
 * 重要差异（3.1 / 3.2 与其它接口不同）：
 *   - 发布 / 编辑文章使用 multipart/form-data，不是 JSON
 *   - 封面是**文件字段 `file`**，不是 URL 字符串
 *   - 多个 tagIds 需要在 FormData 中重复 append 同名字段
 *   - 不要手动设置 Content-Type，浏览器会自动生成 multipart boundary
 *   - 编辑时 file 不传 = 保留原封面；tagIds 不传 = 清空全部标签
 */
import { http } from './request'
import type { PageResult } from '@/types/common'
import type {
  ArticleDetailVO,
  ArticleListItemVO,
  ArticleListQuery,
  CreateArticleParams,
  MyArticleQuery,
  UpdateArticleParams,
} from '@/types/article'
import type { CommentVO, CreateCommentParams } from '@/types/comment'
import type { TagVO } from '@/types/category'

/** 把文章表单参数组装成 FormData（与 api/note.ts 的 buildNoteFormData 同一套规则） */
function buildArticleFormData(
  params: CreateArticleParams | UpdateArticleParams,
): FormData {
  const fd = new FormData()

  if (params.title !== undefined) fd.append('title', params.title)
  if (params.content !== undefined) fd.append('content', params.content)
  if (params.summary !== undefined) fd.append('summary', params.summary)
  if (params.status !== undefined) fd.append('status', String(params.status))

  // 多个标签必须重复 append 同名字段，不能传数组
  if (params.tagIds && params.tagIds.length > 0) {
    params.tagIds.forEach((id) => fd.append('tagIds', String(id)))
  }

  // 封面：仅在选择了新文件时才追加；不追加即保留原封面
  if (params.file) {
    fd.append('file', params.file)
  }

  return fd
}

/* ==================== 文章 CRUD ==================== */

/**
 * 3.1 发布文章（multipart/form-data，需认证）
 *
 * ⚠️ 返回值是**新建文章 id 的裸数字**（实测 `{"code":200,"message":"操作成功","data":32}`），
 * **不是对象**。早期这里写成 `{ id: number }`，调用方 `res.id` 恒为 `undefined`，
 * 结果「创建文章后跳到新文章详情」这条路径**从来没走通过** ——
 * 只会静默退回「我的文章」列表（T20 修复）。
 *
 * 与 2.1 `createNote` 是同一类问题，写法刻意保持一致（`http.post<number>`）。
 */
export function createArticle(data: CreateArticleParams) {
  return http.post<number>('/article', buildArticleFormData(data))
}

/** 3.2 编辑文章（multipart/form-data，需认证） */
export function updateArticle(articleId: number, data: UpdateArticleParams) {
  return http.put<null>(`/article/${articleId}`, buildArticleFormData(data))
}

/** 3.3 删除文章（需认证，逻辑删除） */
export function deleteArticle(articleId: number) {
  return http.delete<null>(`/article/${articleId}`)
}

/** 3.4 查看文章详情（认证可选，访问时浏览量 +1） */
export function getArticleDetail(articleId: number) {
  return http.get<ArticleDetailVO>(`/article/${articleId}`)
}

/** 3.5 文章列表（按时间倒序，无需认证） */
export function getArticleList(params?: ArticleListQuery) {
  return http.get<PageResult<ArticleListItemVO>>('/article/list', params as Record<string, unknown>)
}

/** 3.6 我的文章（需认证，含草稿） */
export function getMyArticles(params?: MyArticleQuery) {
  return http.get<PageResult<ArticleListItemVO>>('/article/my', params as Record<string, unknown>)
}

/* ==================== 点赞 ==================== */

/** 3.7 点赞文章（需认证，幂等） */
export function likeArticle(articleId: number) {
  return http.post<null>(`/article/${articleId}/like`)
}

/** 3.8 取消点赞（需认证） */
export function unlikeArticle(articleId: number) {
  return http.delete<null>(`/article/${articleId}/like`)
}

/** 3.9 判断点赞状态（需认证） */
export function getLikeStatus(articleId: number) {
  return http.get<boolean>(`/article/${articleId}/like/status`)
}

/* ==================== 收藏 ==================== */

/** 3.10 收藏文章（需认证，幂等） */
export function favoriteArticle(articleId: number) {
  return http.post<null>(`/article/${articleId}/favorite`)
}

/** 3.11 取消收藏（需认证） */
export function unfavoriteArticle(articleId: number) {
  return http.delete<null>(`/article/${articleId}/favorite`)
}

/* ==================== 评论 ==================== */

/**
 * 3.13 / 3.14 发布评论与回复评论（同一接口，靠 parentId 区分）
 * parentId = 0 或省略 → 一级评论；填评论 ID → 回复该评论
 *
 * ⚠️ 返回值同样是**新建评论 id 的裸数字**（实测 `{"code":200,"data":38}`），不是对象。
 * 现有调用方（`ArticleDetailView` 的发布评论 / 回复）发完是**重新拉评论列表**、
 * 不依赖这个 id，所以标错没有造成可见故障；但仍要改成 `number` ——
 * 否则下一个人按 `{id}` 去用就会拿到 `undefined`（T20 一并修掉）。
 */
export function createComment(data: CreateCommentParams) {
  return http.post<number>('/comment', data)
}

/** 3.15 删除评论（需认证，逻辑删除） */
export function deleteComment(commentId: number) {
  return http.delete<null>(`/comment/${commentId}`)
}

/** 3.16 查看评论列表（无需认证，按时间正序，仅一层嵌套） */
export function getCommentList(
  articleId: number,
  params?: { page?: number; size?: number },
) {
  return http.get<PageResult<CommentVO>>(
    `/article/${articleId}/comment`,
    params as Record<string, unknown>,
  )
}

/**
 * 3.20 查看回复列表（需认证）
 * 指定一条**一级评论**下的全部回复，按时间正序分页返回（扁平列表，不再嵌套）。
 * 对应前端「查看全部 N 条回复」按钮；3.16 只会在每个根下带前 2 条。
 */
export function getCommentReplies(
  rootId: number,
  params?: { page?: number; size?: number },
) {
  return http.get<PageResult<CommentVO>>(
    `/comment/${rootId}/replies`,
    params as Record<string, unknown>,
  )
}

/**
 * 2.12 标签列表查询（需认证，**无分页**）
 *
 * 标签是**全局公共资源**（所有用户共享同一份），由初始化脚本预置，
 * **没有创建标签的接口** —— 前端只能从候选集里选。
 *
 * 实测（2026-09-23，curl）：接口可用，返回 `[{ id, name, createTime }]`（9 条），
 * 传 `keyword` 做名称模糊匹配；**未登录返回 HTTP 401**（不在白名单里）。
 * 注意：旧结论「后端没实现、不要再加回来」已于 2026-09-17 被 TagController 推翻。
 */
export function getTagList(params?: { keyword?: string }) {
  return http.get<TagVO[]>('/tag/list', params as Record<string, unknown>)
}

/* ==================== 列表变体 ==================== */

/** 3.17 热门文章（按浏览量排序） */
export function getHotArticles(params?: ArticleListQuery) {
  return http.get<PageResult<ArticleListItemVO>>('/article/hot', params as Record<string, unknown>)
}

/** 3.18 最新文章（按发布时间倒序） */
export function getLatestArticles(params?: ArticleListQuery) {
  return http.get<PageResult<ArticleListItemVO>>(
    '/article/latest',
    params as Record<string, unknown>,
  )
}

/** 3.19 标签下的文章 */
export function getArticlesByTag(tagId: number, params?: ArticleListQuery) {
  return http.get<PageResult<ArticleListItemVO>>(
    `/article/tag/${tagId}`,
    params as Record<string, unknown>,
  )
}
