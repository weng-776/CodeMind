/**
 * 用户模块类型
 * 对应 API 文档 v1.2 第一章「用户模块」。
 */
import type { ID } from './common'

/** 用户简要信息 —— 出现于文章列表、评论、通知、关注列表等处 */
export interface UserSimpleVO {
  id: ID
  userName: string
  avatar: string
  intro?: string
}

/** 关注/粉丝列表项（1.10 / 1.11 的 records 元素） */
export interface FollowUserVO {
  id: ID
  userName: string
  avatar: string
  intro: string
  fansCount: number
  followCount: number
  articleCount: number
  createTime: string
}

/** 当前登录用户信息（1.4 GET /api/user/info） */
export interface UserInfoVO {
  /**
   * 用户ID。
   * ⚠️ 文档里有，但真实后端的 `UserDataVO` **不返回该字段**（联调实测 2026-09-16），
   * 因此声明为可选；当前用户 id 由 `stores/user.ts` 从 JWT 的 userId 声明兜底。
   */
  id?: ID
  userName: string
  /** 文档示例是脱敏手机号 `138****5678`，真实后端返回完整手机号 */
  phone: string
  avatar: string
  intro: string
  /** 粉丝数 */
  fansCount: number
  /** 关注数 */
  followCount: number
  /** 笔记总数 */
  noteCount: number
  /** 文章总数 */
  articleCount: number
  /**
   * 是否**已经设置过**登录密码（2026-09-27 后端新增字段）。
   *
   * - `false` = 手机验证码注册的新用户（库里 password 是空串）→ 必须先去 `/set-password` 设一个
   * - `true`  = 已设过密码
   *
   * ⚠️ 判断「没设过密码」**必须写 `hasPassword === false`**，不能写 `!hasPassword`：
   * 字段缺失时是 `undefined`，取反会把所有老用户都判成「没设过密码」并弹进设置页。
   */
  hasPassword: boolean
  /**
   * 用户角色：`0` = 普通用户，`1` = 管理员（2026-10-02 后端新增，对应
   * `UserConstants.USER_ROLE_*`；由 `BeanUtils.copyProperties` 自动带出）。
   *
   * ⚠️ 声明为可选是**防御性**的：老版本后端不返回该字段，取到 `undefined`
   *    时按「非管理员」处理（`role === UserRole.ADMIN` 自然为 false），
   *    不会把所有人误判成管理员。
   * ⚠️ **它只是界面门控，不是权限依据**：真正的判定在后端 `AdminInterceptor`
   *    （每次请求查库取 role）。前端守卫只做体验优化，
   *    所以每个管理端页面都必须能渲染接口 403 的兜底态。
   */
  role?: number
}

/** 他人主页信息（1.7 GET /api/user/profile/{userId}） */
export interface UserProfileVO {
  id: ID
  userName: string
  avatar: string
  intro: string
  fansCount: number
  followCount: number
  articleCount: number
  noteCount: number
  /** 当前用户是否已关注（未登录恒为 false） */
  isFollow: boolean
}

/* ==================== 请求参数 ==================== */

/** 1.1 发送验证码 */
export interface SendCodeParams {
  phone: string
}

/** 1.2 验证码登录 */
export interface LoginByCodeParams {
  phone: string
  code: string
}

/** 1.3 密码登录 */
export interface LoginByPasswordParams {
  phone: string
  password: string
}

/** 1.2 / 1.3 登录响应 */
export interface LoginResultVO {
  token: string
}

/**
 * 1.5 修改个人资料
 *
 * ⚠️ 文档写的是 JSON body（含 `avatar` 字符串），但真实后端是
 * `@RequestParam MultipartFile file` + 表单字段绑定（`UserController.updateUserData`），
 * 发 JSON 会直接 500。联调实测：`multipart/form-data` 才成功（2026-09-16）。
 * 因此这里没有 `avatar` 字段 —— 头像只能通过 `file` 上传，
 * 后端的语义是「不传 file 就保留原头像」，不存在「用 URL 设置头像」的能力。
 */
export interface UpdateUserDataParams {
  userName?: string
  intro?: string
  /** 头像图片文件（可选），不传则保留原头像 */
  file?: File | null
}

/** 1.6 修改密码 */
export interface UpdatePasswordParams {
  oldPassword: string
  newPassword: string
}

/**
 * 1.13 注册后首次设置密码（2026-09-27 后端新增 POST /api/user/setPassword）
 *
 * ⚠️ 只能用于「从没设过密码」的账号：
 *   - 已设过密码的账号再调 → 400「密码已设置，请使用修改密码」
 *   - 改密码走 1.6 `PUT /api/user/updatePassword`（要旧密码）
 *   - `phone` 必须与当前登录用户一致，否则 400「手机号不匹配」
 *   - 密码规则 `^\w{4,32}$`
 */
export interface SetPasswordParams {
  password: string
  phone: string
}
