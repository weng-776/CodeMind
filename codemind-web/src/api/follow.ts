/**
 * 关注模块 API
 * 关注相关接口在文档中归属「用户模块」（1.8 / 1.9 / 1.10 / 1.11 / 1.12），
 * 为便于按业务域引入，这里做一层语义化再导出。
 */
export {
  followUser,
  cancelFollow,
  getMyFollows,
  getMyFans,
  getFollowStatus,
} from './user'

export type { FollowUserVO } from '@/types/user'
