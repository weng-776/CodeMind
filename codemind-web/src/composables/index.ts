/**
 * 组合式函数统一出口
 *
 * - useAiStream.ts  底层流式内核（fetch + getReader + TextDecoder）
 * - useAiChat.ts    AI 聊天窗口状态机
 * - useAiContext.ts 文章/笔记详情页的上下文 AI
 */
export { streamFetch, readTextStream } from './useAiStream'
export type { StreamHandlers } from './useAiStream'

export { useAiChat } from './useAiChat'

export { useAiContext, AI_ACTION_LABELS, AI_ACTIONS } from './useAiContext'
