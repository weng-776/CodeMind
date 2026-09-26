/**
 * 评论模块类型
 * 对应 API 文档 **v1.9** 第 3.13 / 3.14 / 3.16 / 3.20 节（按真实后端实测校准）。
 *
 * 重要：后端只支持「两层」——一级评论（parentId = 0）下挂回复，不做无限级评论树。
 * 但回复**不是以 `children` 嵌套返回的**：
 *   - **3.16** 每个一级评论只内联**前 2 条** `replies`，并给出该根的回复总数 `replyCount`；
 *   - 完整回复列表走 **3.20 按需分页**（`GET /api/comment/{rootId}/replies`）。
 *
 * 所以结构上是「同一结构的递归」：`replies` 的元素仍是 `CommentVO`，
 * 但元素里的 `replyCount` / `replies` 恒为 `null`（层级到此为止）。
 *
 * ⚠️ 历史坑：本文件原按文档 **v1.2 的设计稿**写成 `children: CommentReplyVO[]`，
 * 与后端真实出参不符 —— 后端 `community/vo/CommentVO.java` 的字段是
 * `replies` / `replyCount` / `replyUser`，**根本没有 `children`**。
 * 2026-09-23（T4.5）已更正：**文档 v1.9 一直是对的，是这里没跟上。**
 * `total` = **一级评论数（不含回复）**，回复数要看每条根的 `replyCount`，两者不要相加。
 */
import type { ID } from './common'
import type { UserSimpleVO } from './user'

/**
 * 评论项。既用于一级评论（`parentId = 0`），也用于 `replies` 里的回复
 * （此时 `parentId` = 所属根的 id）。
 */
export interface CommentVO {
  id: ID
  articleId: ID
  user: UserSimpleVO
  /** 一级评论恒为 `0`；`replies` 里的元素恒为所属根的 id */
  parentId: ID
  content: string
  createTime: string
  /** 被回复人。**仅 `replies` 里的元素可能有值**；`null` = 直接回复文章作者，前端不渲染 @ */
  replyUser?: UserSimpleVO | null
  /** 该根下的**回复总数**，仅一级评论有值 → 按钮上的「查看全部 N 条回复」 */
  replyCount?: number | null
  /** 该根下的**前 2 条**回复，仅一级评论有值；元素结构同上 */
  replies?: CommentVO[] | null
}

/* ==================== 请求参数 ==================== */

/**
 * 3.13 发布评论 / 回复评论（同一接口）
 * parentId = 0 表示一级评论，否则为要回复的评论 ID。
 */
export interface CreateCommentParams {
  articleId: ID
  content: string
  parentId?: ID
}
