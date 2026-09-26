/**
 * 消息通知模块类型
 * 对应 API 文档 v1.2 第四章。
 */
import type { ID } from './common'
import type { UserSimpleVO } from './user'

/** 通知类型：1=被点赞，2=被评论，3=被关注 */
export enum NotifyType {
  LIKE = 1,
  COMMENT = 2,
  FOLLOW = 3,
}

/** 阅读状态：0=未读，1=已读 */
export enum NotifyReadStatus {
  UNREAD = 0,
  READ = 1,
}

/** 通知项（4.1 GET /api/notify/list 的 records 元素） */
export interface NotifyVO {
  id: ID
  type: NotifyType
  /** 触发人：谁点的赞 / 评论 / 关注 */
  fromUser: UserSimpleVO
  /** 关联文章 ID，未涉及为 null */
  articleId: ID | null
  /** 关联评论 ID，未涉及为 null */
  commentId: ID | null
  /**
   * 关联文章是否已被删除（后端在列表侧打标，4.1）。
   * true 时不要跳转，提示「相关文章已被删除」。
   * 可选：后端旧版本不返回该字段，此时为 undefined（falsy），按原逻辑跳转。
   */
  articleDeleted?: boolean
  /**
   * 关联评论是否已被删除（后端在列表侧打标，4.1）。
   * true 时不要跳转，提示「相关评论已被删除」。
   * 可选：同上。
   */
  commentDeleted?: boolean
  /** 通知文案，后端已拼接完成，前端直接展示 */
  content: string
  isRead: NotifyReadStatus
  createTime: string
}
