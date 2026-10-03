/**
 * 管理端 API
 * ------------------------------------------------------------------
 * 对应 `管理端前端设计说明.md` §2 / §5，15 个接口全部为 2026-10-02 真机实测契约。
 *
 * 🔴 本模块**两种失败形态并存**（最容易写错的地方，§2.1）：
 *
 * | 场景                     | 传输层    | 响应体                          | ApiError.code |
 * |--------------------------|-----------|---------------------------------|---------------|
 * | 无 token                 | HTTP 401  | {code:401,message:"登陆过期…"}  | 401           |
 * | 登录了但不是管理员       | HTTP 403  | {code:403,message:"无管理员权限"}| 403           |
 * | 参数越界(size>50/page<1) | HTTP 200  | {code:400,message:"每页条数…"}  | 400           |
 * | 资源不存在               | HTTP 200  | {code:404,message:"…"}          | 404           |
 *
 * 所以**不能按 HTTP 状态码判断**，一律判 `err.code`（`request.ts` 已把两者
 * 统一塞进 `ApiError.code`）。
 *
 * ⚠️ 403 走的是 **HTTP 403**，axios 会落到 error 分支，`request.ts` 会把 message
 *    覆盖成「没有权限执行该操作」—— **后端那句「无管理员权限」前端根本收不到**，
 *    页面必须显示自己的文案（见 `views/admin/components/AdminForbidden.vue`）。
 */
import { http } from './request'
import type { PageQuery } from '@/types/common'
import type {
  AdminArticlePage,
  AdminCommentPage,
  AdminNotePage,
  AdminQueueVO,
  AdminUserPage,
  DashboardOverviewVO,
} from '@/types/admin'

/** 查询参数统一转成 `Record<string, unknown>` 交给请求层（与既有 api 模块写法一致） */
type Query = Record<string, unknown>

/* ==================== 数据看板 ==================== */

/** 看板总览：6 个总量 + 6 个今日新增（「今日」按 GMT+8） */
export function getDashboardOverview() {
  return http.get<DashboardOverviewVO>('/admin/dashboard/overview')
}

/* ==================== 用户治理 ==================== */

/**
 * 用户列表。
 * `keyword` **同时模糊匹配手机号与昵称**（实测：`keyword=13800000003` 与
 * `keyword=小翁` 各命中 1 条）。
 */
export function getAdminUsers(params: PageQuery & { keyword?: string }) {
  return http.get<AdminUserPage>('/admin/users', params as Query)
}

/**
 * 修改用户账号状态。`status`：0=禁用 1=正常。
 *
 * ⚠️ 参数是 **query 不是 body**（实测 URL 形如 `PUT /api/admin/users/4/status?status=0`）。
 *    `http.put(url, data, config)` 的**第三参**才是 config，写成 body 会静默不生效。
 * ⚠️ 幂等：重复封禁仍返回 `code=200`。
 * ⚠️ 错误分支：`status=2` → 400；用户不存在 → 404；**封自己 → 400**
 *    （后端拦了 `userId.equals(当前登录用户)`，前端应提前禁用该行按钮）。
 */
export function updateAdminUserStatus(userId: number, status: number) {
  return http.put<null>(`/admin/users/${userId}/status`, null, { params: { status } })
}

/* ==================== 内容治理 ==================== */

/** 文章列表（**含草稿**，是全量视角而非越权）。`status`：0=草稿/下架 1=公开 */
export function getAdminArticles(params: PageQuery & { keyword?: string; status?: number }) {
  return http.get<AdminArticlePage>('/admin/articles', params as Query)
}

/** 文章上下架。`status`：0=下架 1=公开（query 参数） */
export function updateAdminArticleStatus(articleId: number, status: number) {
  return http.put<null>(`/admin/articles/${articleId}/status`, null, { params: { status } })
}

/**
 * 删除文章（**不可逆**）。
 * 后端会连带删除其标签、评论、点赞、收藏，并从热门榜与向量库移除 ——
 * 确认文案必须如实说明这些后果。
 */
export function deleteAdminArticle(articleId: number) {
  return http.delete<null>(`/admin/articles/${articleId}`)
}

/**
 * 笔记列表（**含草稿与私密**）。`status`：0=草稿 1=正常；`visibility`：0=私密 1=公开。
 * 实测 `?visibility=0` 能拿到私密笔记 —— 这是设计意图，但页面必须打标签。
 */
export function getAdminNotes(params: PageQuery & {
  keyword?: string
  status?: number
  visibility?: number
}) {
  return http.get<AdminNotePage>('/admin/notes', params as Query)
}

/** 笔记状态。`status`：0=草稿 1=正常（query 参数） */
export function updateAdminNoteStatus(noteId: number, status: number) {
  return http.put<null>(`/admin/notes/${noteId}/status`, null, { params: { status } })
}

/** 删除笔记（不可逆） */
export function deleteAdminNote(noteId: number) {
  return http.delete<null>(`/admin/notes/${noteId}`)
}

/** 评论列表。`articleId` 限定某篇文章；`keyword` 模糊匹配评论内容 */
export function getAdminComments(params: PageQuery & { articleId?: number; keyword?: string }) {
  return http.get<AdminCommentPage>('/admin/comments', params as Query)
}

/** 删除评论（不可逆） */
export function deleteAdminComment(commentId: number) {
  return http.delete<null>(`/admin/comments/${commentId}`)
}

/* ==================== 死信队列 ==================== */

/** 死信队列概要，**固定 6 条** */
export function getAdminQueues() {
  return http.get<AdminQueueVO[]>('/admin/mq/queues')
}

/**
 * 队列里的消息正文。
 *
 * ⚠️ 返回的是 **`string[]`（消息正文原文数组，不分页）**，形如
 *    `["{\"uuid\":\"…\",\"type\":\"article\"…}"]`。
 *    死信里存的是 JSON 文本，但**不能假设一定能 parse**（死信的定义就是
 *    「处理失败的消息」）→ 渲染时必须 `try { JSON.parse } catch { 原样显示 }`。
 * ⚠️ 队列名**带点号**（`codemind.cache.queue.dead`），用模板字符串直接拼 URL 即可，
 *    实测无需特殊处理，但**不要**做后缀截断。
 */
export function getAdminQueueMessages(queueName: string) {
  return http.get<string[]>(`/admin/mq/queues/${queueName}/messages`)
}

/** 清空队列（**不可逆**，危险操作，需二次确认） */
export function clearAdminQueueMessages(queueName: string) {
  return http.delete<null>(`/admin/mq/queues/${queueName}/messages`)
}

/**
 * 重投死信回原交换机，返回**本次重投成功条数**（单次上限 500）。
 *
 * 响应语义（`message` 里可能带「请再次执行」）：
 *   - 正常        → 200，data=N，message="已重投 N 条，队列已清空"
 *   - 没投完      → 200，data=N，message="…队列还剩 M 条，请再次执行"
 *   - 队列已空    → 200，data=0，message="队列已空，无需重投"
 *   - 非白名单队列 → 400
 *
 * ⚠️ 判据用 `data`（条数）与「重投后再拉一次 queues 看 messageCount 是否为 0」，
 *    **不要按 message 文本分支**。
 */
export function replayAdminQueue(queueName: string) {
  return http.post<number>(`/admin/mq/queues/${queueName}/replay`)
}
