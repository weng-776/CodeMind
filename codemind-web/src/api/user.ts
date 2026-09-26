/**
 * 用户模块 API（API 文档 v1.2 第一章，共 12 个接口）
 */
import { http } from './request'
import type { PageResult } from '@/types/common'
import type {
  FollowUserVO,
  LoginByCodeParams,
  LoginByPasswordParams,
  LoginResultVO,
  SendCodeParams,
  UpdatePasswordParams,
  UpdateUserDataParams,
  UserInfoVO,
  UserProfileVO,
} from '@/types/user'

/** 1.1 发送验证码 */
export function sendCode(data: SendCodeParams) {
  return http.post<boolean>('/user/sendCode', data)
}

/** 1.2 验证码登录 / 注册（新用户自动注册） */
export function loginByCode(data: LoginByCodeParams) {
  return http.post<LoginResultVO>('/user/login/code', data)
}

/** 1.3 密码登录 */
export function loginByPassword(data: LoginByPasswordParams) {
  return http.post<LoginResultVO>('/user/login/password', data)
}

/** 1.4 获取当前登录用户信息（需认证） */
export function getUserInfo() {
  return http.get<UserInfoVO>('/user/info')
}

/**
 * 1.5 修改个人资料（需认证）
 *
 * ⚠️ 真实后端收的是 `multipart/form-data`（`@RequestParam MultipartFile file`
 * + 表单字段），不是文档里写的 JSON —— 发 JSON 会返回 500「系统繁忙」。
 * 与笔记 / 文章的封面一致：不手动设 Content-Type，交给浏览器生成 boundary。
 *
 * ⚠️ 后端校验（`UpdateUserDataDTO`，2026-09-23 读源码 + curl 复核）：
 *   `@Size(min = 3, max = 12)`  昵称  → 但 message 只写了「不能超过12个字符」
 *   `@Size(min = 6, max = 200)` 简介  → message 只写了「不能超过200字符」
 *   即**下限也生效**，只是提示语会自相矛盾（「昵称不能超过12个字符」出现在昵称只有 2 个字时）。
 *   所以调用方（ProfileHomeTab）必须自己做 3~12 / 6~200 的前置校验。
 *
 * ⚠️ 响应体：文档写 `data: true`，**实测是 `data: null` + `message: "更新成功"`**。
 *   调用方只关心「没抛错」，不要依赖这个返回值。
 *
 * 语义提醒：**没传的字段会被保留**（不是清空）。所以只改头像时不要顺手把
 * 昵称也带上 —— 库里存在 2 个字的昵称，带上必然被 `min = 3` 打回。
 */
export function updateUserData(data: UpdateUserDataParams) {
  const fd = new FormData()
  if (data.userName !== undefined) fd.append('userName', data.userName)
  if (data.intro !== undefined) fd.append('intro', data.intro)
  // 不传 file = 后端保留原头像（后端没有「删除头像」的能力）
  if (data.file) fd.append('file', data.file)
  return http.put<null>('/user/data', fd)
}

/**
 * 1.6 修改密码（需认证）
 * 路径以文档正文为准：`PUT /api/user/updatePassword`
 * 请求体为 JSON（`@RequestBody UpdatePasswordDTO`），密码规则 `^\w{4,32}$`
 */
export function updatePassword(data: UpdatePasswordParams) {
  return http.put<boolean>('/user/updatePassword', data)
}

/** 1.7 查看用户主页（认证可选，用于判断关注状态） */
export function getUserProfile(userId: number) {
  return http.get<UserProfileVO>(`/user/profile/${userId}`)
}

/** 1.8 关注用户（需认证，幂等） */
export function followUser(followUserId: number) {
  return http.post<null>(`/user/follow/${followUserId}`)
}

/**
 * 1.9 取消关注（需认证，硬删除）
 * 路径以文档正文为准：`DELETE /api/user/cancelFollow/{followUserId}`
 */
export function cancelFollow(followUserId: number) {
  return http.delete<null>(`/user/cancelFollow/${followUserId}`)
}

/** 1.10 我的关注列表（需认证，分页） */
export function getMyFollows(params?: { page?: number; size?: number }) {
  return http.get<PageResult<FollowUserVO>>('/user/follows', params as Record<string, unknown>)
}

/** 1.11 我的粉丝列表（需认证，分页） */
export function getMyFans(params?: { page?: number; size?: number }) {
  return http.get<PageResult<FollowUserVO>>('/user/fans', params as Record<string, unknown>)
}

/** 1.12 判断关注状态（需认证） */
export function getFollowStatus(userId: number) {
  return http.get<boolean>(`/user/follow/status/${userId}`)
}

/** 3.12 我的收藏列表（文档归类在社区模块，路径属于 user，此处一并导出方便使用） */
export function getMyFavorites(params?: { page?: number; size?: number }) {
  return http.get<PageResult<import('@/types/article').ArticleListItemVO>>(
    '/user/favorites',
    params as Record<string, unknown>,
  )
}
