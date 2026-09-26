/**
 * 消息通知模块 API（API 文档 v1.2 第四章 + 后端 2026-09-24 新增能力）
 */
import { http } from './request'
import type { PageResult } from '@/types/common'
import type { NotifyType, NotifyVO } from '@/types/notify'

/**
 * 4.1 我的消息列表（需认证，分页，size 最大 50）
 *
 * `type` 可选：1=点赞 / 2=评论 / 3=关注；**不传 = 全部**。
 * 实测（2026-09-24）筛选是**在库上做**的，不是只过滤当前页：
 * 不传 total=83，type=1/2/3 分别 9/24/50，三者相加正好 83。
 * 非法值（如 9、0）→ `code=400`「消息类型不合法」。
 */
export function getNotifyList(params?: { page?: number; size?: number; type?: NotifyType }) {
  return http.get<PageResult<NotifyVO>>('/notify/list', params as Record<string, unknown>)
}

/** 4.2 未读消息数量（需认证） */
export function getUnreadCount() {
  return http.get<number>('/notify/unread')
}

/** 4.3 标记某条消息已读（需认证） */
export function markNotifyRead(notifyId: number) {
  return http.put<null>(`/notify/read/${notifyId}`)
}

/** 4.4 全部消息已读（需认证） */
export function markAllNotifyRead() {
  return http.put<null>('/notify/readAll')
}

/**
 * 删除单条消息（需认证，后端 2026-09-24 新增）
 *
 * ⚠️ 路径是 `deleteMessage`（**小写 d**），别按 REST 习惯写成 `/notify/delete/{id}`。
 * ⚠️ **删掉未读通知会让未读数 -1**（后端会一并处理）—— 调用方必须同步本地未读数，
 *    否则 Header 红点会多算一条，直到下次刷新。
 * 重复删除 → `code=404`「消息不存在」，调用方按「已删除」处理即可（幂等）。
 */
export function deleteNotify(notifyId: number) {
  return http.delete<null>(`/notify/deleteMessage/${notifyId}`)
}
