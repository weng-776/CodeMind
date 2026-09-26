/**
 * AI 流式接口（API 文档 v1.2 第 5.4 - 5.10 节）
 * ------------------------------------------------------------------
 * 这些接口返回 Flux<String>（裸文本流），不走 axios。
 * 底层读取逻辑统一由 composables/useAiStream.ts 提供。
 *
 * 覆盖接口：
 *   POST /api/ai/chat                                   统一聊天
 *   POST /api/ai/articles/{articleId}/summary           文章总结
 *   POST /api/ai/articles/{articleId}/knowledge-points  文章知识点
 *   POST /api/ai/articles/{articleId}/interview-questions 文章面试题
 *   POST /api/ai/notes/{noteId}/summary                 笔记总结
 *   POST /api/ai/notes/{noteId}/knowledge-points        笔记知识点
 *   POST /api/ai/notes/{noteId}/interview-questions     笔记面试题
 */
import { streamFetch, type StreamHandlers } from '@/composables/useAiStream'
import { buildAuthHeaders } from '@/utils/auth'
import type { AiChatParams, AiContextAction, AiContextTarget } from '@/types/ai'

/**
 * 5.4 AI 统一聊天（流式）
 *
 * @param params   conversationId + prompt
 * @param handlers onChunk / onDone / onError
 * @param signal   AbortSignal，用于「停止生成」
 */
export function streamChat(
  params: AiChatParams,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamFetch(
    '/ai/chat',
    {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        conversationId: params.conversationId,
        prompt: params.prompt,
      }),
    },
    handlers,
    signal,
  )
}

/**
 * 5.5 - 5.10 文章 / 笔记的上下文 AI 操作（流式）
 *
 * 路径由 target 与 action 组合而成：
 *   target: articles | notes
 *   action: summary | knowledge-points | interview-questions
 * 共覆盖 6 个接口。这三个动作均无请求体，但仍以 POST 提交。
 */
export function streamContextAi(
  target: AiContextTarget,
  id: number,
  action: AiContextAction,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamFetch(
    `/ai/${target}/${id}/${action}`,
    {
      method: 'POST',
      headers: buildAuthHeaders(),
    },
    handlers,
    signal,
  )
}
