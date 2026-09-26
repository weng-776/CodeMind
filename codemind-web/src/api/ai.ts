/**
 * AI 智能助手模块 API（API 文档 v1.2 第五章）
 *
 * 两类接口：
 *   1. 会话管理（JSON）：创建会话、会话列表、历史消息
 *   2. 流式生成（Flux<String>）：统一聊天 + 文章/笔记的 AI 上下文操作
 *
 * 流式接口的响应 Content-Type 是 `text/html;charset=UTF-8`，
 * 返回的是「裸文本流」而不是 SSE，因此不能走 axios，必须用
 * fetch + ReadableStream 手动读取，详见 api/aiStream.ts。
 */
import { http } from './request'
import type { AiChatParams, AiConversationVO, MessageVO } from '@/types/ai'

/* ==================== 会话管理 ==================== */

/** 5.1 创建 AI 会话（需认证，无需传 userId） */
export function createConversation() {
  return http.post<AiConversationVO>('/ai/conversations')
}

/** 5.2 查询当前用户 AI 会话列表（需认证，不分页） */
export function getConversations() {
  return http.get<AiConversationVO[]>('/ai/conversations')
}

/** 5.3 查询指定会话历史消息（需认证） */
export function getConversationMessages(conversationId: string) {
  return http.get<MessageVO[]>(`/ai/conversations/${conversationId}/messages`)
}

/**
 * 删除会话（需认证，后端 2026-09-24 新增）
 *
 * ⚠️ 路径是 `DeleteConversation`（**大写 D**），与同资源的 `conversations` 小写风格不一致，
 * 别按 REST 习惯改成小写。后端会一并清掉该会话的记忆
 * （`chatMemoryRepository.deleteByConversationId`）。
 * 重复删除 → `code=404`「会话不存在」，调用方按「已删除」处理即可（幂等）。
 *
 * ⚠️ 删的如果是**当前正在看的会话**，调用方必须把 `?c=` 一并去掉并切走 ——
 * 否则之后拿着已删的 conversationId 发消息会直接 404。
 */
export function deleteConversation(conversationId: string) {
  return http.delete<null>(`/ai/DeleteConversation/${conversationId}`)
}

/* ==================== 请求体构造 ==================== */

export function buildChatBody(params: AiChatParams): AiChatParams {
  return {
    conversationId: params.conversationId,
    prompt: params.prompt,
  }
}
