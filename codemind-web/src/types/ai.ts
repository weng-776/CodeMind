/**
 * AI 智能助手模块类型
 * 对应 API 文档 v1.2 第五章。
 *
 * 注意：AI 生成类接口返回 Flux<String>（裸文本流，Content-Type: text/html;charset=UTF-8），
 * 不是普通 JSON，因此这部分没有「响应 VO」，只有请求参数。
 * 流式读取逻辑见 composables/useAiStream.ts。
 */
import type { ID } from './common'

/** AI 会话（5.1 创建 / 5.2 列表） */
export interface AiConversationVO {
  /** 会话 ID。后端用雪花 ID，可能超出 Number 安全范围，因此按 string 处理 */
  id: string
  title: string
}

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system'

/** 会话历史消息（5.3 GET /api/ai/conversations/{conversationId}/messages） */
export interface MessageVO {
  role: MessageRole
  content: string
}

/** 5.4 AI 统一聊天请求体 */
export interface AiChatParams {
  conversationId: string
  prompt: string
}

/* ==================== 前端本地使用的模型 ==================== */

/**
 * 聊天窗口中的一条消息。
 * 这是前端的视图模型（非后端 VO）：历史消息没有 id、时间等字段，
 * 因此本地生成稳定 id 用于 v-for 的 key 与流式追加时的定位。
 */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  /** 是否正在流式接收中（用于显示光标动画 / 禁用发送） */
  streaming?: boolean
  /** 生成本条消息时是否出错 */
  error?: boolean
}

/** 文章/笔记详情页 AI 操作类型 */
export type AiContextAction = 'summary' | 'knowledge-points' | 'interview-questions'

/** AI 上下文操作的结果（面板内展示） */
export interface AiContextResult {
  action: AiContextAction
  title: string
  content: string
  loading: boolean
  error: string | null
}

/** 上下文 AI 目标类型 */
export type AiContextTarget = 'articles' | 'notes'

/** 上下文 AI 请求标识 */
export interface AiContextRequest {
  target: AiContextTarget
  /** 文章 ID 或笔记 ID */
  id: ID
  action: AiContextAction
}
