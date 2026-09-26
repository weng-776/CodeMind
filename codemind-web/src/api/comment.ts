/**
 * 评论模块 API
 * 评论相关接口在文档中归属「社区模块」（3.13 / 3.14 / 3.16 / 3.20），
 * 为便于按业务域引入，这里做一层语义化再导出。
 */
export {
  createComment,
  deleteComment,
  getCommentList,
  getCommentReplies,
} from './article'

export type { CommentVO, CreateCommentParams } from '@/types/comment'
