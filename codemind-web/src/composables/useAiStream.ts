/**
 * AI 流式响应内核。
 *
 * 后端返回的是 `Flux<String>`，响应头 `text/html;charset=UTF-8` —— 这是**裸文本流**：
 * 不是 JSON（不能 await response.json()），也不是 SSE（没有 `data:` 前缀），
 * 所以只能用 fetch + response.body.getReader() 手动读字节。
 *
 * ⚠️ 最大的坑：**跨分片的多字节字符截断**。中文在 UTF-8 下占 3 字节，而分片边界是随机的，
 * 一个汉字可能被切成两半 —— 对每片独立 decode 会得到不可恢复的 U+FFFD 乱码。
 * 解法是 `decode(chunk, { stream: true })`（让 TextDecoder 暂存不完整字节），
 * 流结束时再 `decode()` 一次 flush 残留。
 */
import { getToken } from '@/utils/auth'
import { triggerUnauthorized } from '@/api/request'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

/** 流式回调集合 */
export interface StreamHandlers {
  /** 每收到一段文本（已保证是不会乱码的完整字符串） */
  onChunk: (text: string) => void
  /** 正常结束（含用户主动中断） */
  onDone?: () => void
  /** 出错 */
  onError?: (message: string) => void
}

/** 判断是否为「用户主动中断」导致的异常 */
function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

/**
 * 从 ReadableStream 读取全部文本，逐段回调。抽出来便于单测与复用。
 *
 * 关于中断：用户点「停止生成」时 AbortController 会 abort，`reader.read()` 以
 * AbortError 拒绝 —— 这个异常必须在此处消化掉，否则调用方会收到未处理的 rejection。
 */
export async function readTextStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<void> {
  const { onChunk, onDone, onError } = handlers
  const reader = body.getReader()

  // 关键：整个流的生命周期共用一个 decoder 实例，
  // 这样它才能跨分片保留不完整的多字节序列。
  const decoder = new TextDecoder('utf-8')

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue

      // stream: true —— 允许输出不完整字符，内部暂存剩余字节
      const text = decoder.decode(value, { stream: true })
      if (text) onChunk(text)
    }

    // 流结束，flush decoder 内部可能残留的字节
    const tail = decoder.decode()
    if (tail) onChunk(tail)

    onDone?.()
  } catch (err) {
    // 主动中断：交给 onDone 收尾，不当作错误
    if (isAbortError(err)) {
      // 主动取消底层流，尽快释放连接
      try {
        await reader.cancel()
      } catch {
        /* 已关闭则忽略 */
      }
      onDone?.()
      return
    }
    onError?.('AI 响应读取中断')
  } finally {
    // 确保底层连接被释放，避免内存泄漏
    try {
      reader.releaseLock()
    } catch {
      /* 已释放则忽略 */
    }
  }
}

/**
 * 发起流式请求并读取响应。
 *
 * @param url      相对 BASE_URL 的路径，如 `/ai/chat`
 * @param init     fetch 初始化参数（method / body 等）
 * @param handlers 流式回调
 * @param signal   用于中断（AbortController.signal）
 */
export async function streamFetch(
  url: string,
  init: RequestInit,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const { onChunk, onDone, onError } = handlers

  // 401 分流依据：本次请求是否带了 token（在发请求前记录，见下方 401 分支）
  const hadToken = Boolean(getToken())

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${url}`, { ...init, signal })
  } catch (err) {
    // 主动中断视为正常结束，不当作错误提示给用户
    if (isAbortError(err)) {
      onDone?.()
      return
    }
    onError?.('网络异常，无法连接 AI 服务')
    return
  }

  if (!response.ok) {
    if (response.status === 401) {
      /*
       * 401 分流（与 request.ts 一致）：
       *   带了 token 还 401 → 登录态失效 → 清 token + 提示 + 跳 /login；
       *   没带 token（游客）→ 只是该接口要登录 → 只提示，不清 token、不跳登录。
       *
       * ⚠️ 顺序有意为之：先 `triggerUnauthorized()`（清 token）再 `onError()`，
       * 这样面板里的 401 分诊读到 `getToken()` 已是 null，会走「登录后查看」引导态。
       */
      if (hadToken) {
        triggerUnauthorized()
        onError?.('登录状态已失效，请重新登录')
      } else {
        onError?.('请先登录后再使用 AI 功能')
      }
      return
    }
    if (response.status === 404) {
      onError?.('AI 接口不存在，请确认后端版本')
      return
    }
    if (response.status >= 500) {
      onError?.('AI 服务暂时不可用，请稍后重试')
      return
    }
    onError?.(`AI 服务响应异常（HTTP ${response.status}）`)
    return
  }

  /*
   * 业务错误**不是流式的**：400/403/404 等返回「HTTP 200 + application/json」，
   * 与流式成功的状态码相同，只能靠 Content-Type 区分。
   * 不判的话 {"code":404,...} 会被当成 AI 正文渲染进对话。
   */
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const err = (await response.json()) as { message?: string }
      onError?.(err.message || 'AI 服务返回异常')
    } catch {
      onError?.('AI 服务返回异常')
    }
    return
  }

  if (!response.body) {
    // 极个别环境不支持流式（如某些旧版内核）
    onError?.('当前浏览器不支持流式响应，请更换现代浏览器')
    return
  }

  try {
    await readTextStream(response.body, { onChunk, onDone })
  } catch (err) {
    if (isAbortError(err)) {
      onDone?.()
      return
    }
    onError?.('AI 响应读取中断')
  }
}
