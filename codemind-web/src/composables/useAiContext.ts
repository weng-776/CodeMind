/**
 * 文章 / 笔记详情页的上下文 AI 组合式函数：AI 总结、知识点提取、生成面试题。
 *
 * 状态机：idle → loading（流式接收中）→ done / error / needLogin（这 6 个接口对游客一律 401）。
 * 同一时刻只运行一个动作，切换时自动中断上一个流。
 *
 * 读流、跨分片解码、Content-Type 分流都在 `useAiStream` 内核里，本文件只负责面板状态。
 */
import { computed, ref } from 'vue'

import { streamContextAi } from '@/api/aiStream'
import { getToken } from '@/utils/auth'
import type { AiContextAction, AiContextTarget } from '@/types/ai'

/** 动作的中文标签，供按钮与面板标题复用 */
export const AI_ACTION_LABELS: Record<AiContextAction, string> = {
  summary: 'AI 总结',
  'knowledge-points': '知识点提取',
  'interview-questions': '生成面试题',
}

/**
 * 各动作的等待文案。
 *
 * 三个接口耗时差得很远（实测：总结 ~6s、知识点 ~4~8s、**面试题 13~17s**），
 * 用同一句「正在分析内容」会让人以为卡住了。文案里把预期时长说清楚，
 * 用户才知道该等还是该点「停止」。
 */
export const AI_ACTION_LOADING: Record<AiContextAction, string> = {
  summary: '正在阅读全文并生成总结…',
  'knowledge-points': '正在提取核心知识点…',
  'interview-questions': '正在出题，这个动作最慢（约 10~20 秒），请稍候…',
}

/** 三个动作的展示顺序 */
export const AI_ACTIONS: AiContextAction[] = [
  'summary',
  'knowledge-points',
  'interview-questions',
]

export function useAiContext() {
  /** 当前正在展示的动作（null 表示面板未打开） */
  const activeAction = ref<AiContextAction | null>(null)

  /** 流式累积的内容 */
  const content = ref('')

  /** 是否正在生成 */
  const isStreaming = ref(false)

  /** 错误信息 */
  const error = ref<string | null>(null)

  /**
   * 未登录：这 6 个接口（5.5~5.10）**一律返回 HTTP 401**，
   * 文档写明「认证不是可选的」。这不算「出错」，而是「要先登录」，
   * 所以单独一个状态，面板据此展示「登录后查看」而不是红字报错。
   */
  const needLogin = ref(false)

  /** 面板是否可见 */
  const isPanelOpen = ref(false)

  /** 是否已经产出过内容（用于判断「空」状态） */
  const hasContent = computed(() => content.value.length > 0)

  /** 当前动作的标题 */
  const activeTitle = computed(() =>
    activeAction.value ? AI_ACTION_LABELS[activeAction.value] : '',
  )

  /** 当前动作的等待文案（耗时差异大，见 AI_ACTION_LOADING） */
  const loadingText = computed(() =>
    activeAction.value ? AI_ACTION_LOADING[activeAction.value] : '正在处理…',
  )

  let controller: AbortController | null = null

  /**
   * 流序号。每开一条新流 +1，回调里比对 —— 不是自己的就整段忽略。
   * 「停止」也会 +1，把旧流的迟到 onDone/onError 作废，
   * 否则它会把**下一轮**的 controller / isStreaming 一起清掉（T10 踩过）。
   */
  let streamSeq = 0

  /** 中断当前生成 */
  function stop(): void {
    if (!controller) return
    controller.abort()
    controller = null
    streamSeq += 1
    isStreaming.value = false
  }

  /** 关闭面板并清理状态 */
  function closePanel(): void {
    stop()
    isPanelOpen.value = false
    activeAction.value = null
    content.value = ''
    error.value = null
    needLogin.value = false
  }

  /**
   * 触发某个 AI 动作。
   * @param target  articles | notes
   * @param id      文章 ID 或笔记 ID
   * @param action  动作类型
   */
  async function run(
    target: AiContextTarget,
    id: number,
    action: AiContextAction,
  ): Promise<void> {
    // 切换动作时先中断上一个流，避免内容混在一起
    if (isStreaming.value) stop()

    // 重复点击同一个动作且已有内容时，视为重新生成
    activeAction.value = action
    isPanelOpen.value = true
    content.value = ''
    error.value = null
    needLogin.value = false
    isStreaming.value = true

    controller = new AbortController()
    const mySeq = ++streamSeq

    await streamContextAi(
      target,
      id,
      action,
      {
        onChunk(chunk) {
          if (mySeq !== streamSeq) return
          // content 是顶层 ref，直接改 .value 就能触发渲染
          // （别学 T10 那个「改原始对象不触发响应式」的坑）
          content.value += chunk
        },
        onDone() {
          if (mySeq !== streamSeq) return
          isStreaming.value = false
          controller = null
        },
        onError(message) {
          if (mySeq !== streamSeq) return
          isStreaming.value = false
          controller = null
          /*
           * 分诊：这 6 个接口（5.5~5.10）对未登录一律返回 HTTP 401，文档写明
           * 「认证不是可选的」。那不算「出错」，而是「要先登录」，该给
           * 「登录后查看」而不是把红字摊在面板上。
           *
           * 判定依据用 **token 是否存在**，而不是 `userStore.isLoggedIn`：
           *   - 游客：压根没有 token → 要登录；
           *   - 会话中途失效：请求层（useAiStream）在 401 时已经 `removeToken()`，
           *     此刻 token 也没了 → 同样是要登录。
           * 而 `userStore.token` 是 store 创建时从 localStorage 读一次的快照，
           * 上面两种情况下它都可能还是旧值（非空），用它判断会漏掉第二种。
           * 读 `getToken()` 也符合项目约定「token 存取走 utils/auth，不依赖 Pinia」。
           */
          if (!getToken()) needLogin.value = true
          else error.value = message
        },
      },
      controller.signal,
    )
  }

  /** 重新生成当前动作 */
  async function retry(target: AiContextTarget, id: number): Promise<void> {
    if (!activeAction.value) return
    await run(target, id, activeAction.value)
  }

  return {
    // 状态
    activeAction,
    activeTitle,
    loadingText,
    content,
    hasContent,
    isStreaming,
    error,
    needLogin,
    isPanelOpen,
    // 操作
    run,
    stop,
    retry,
    closePanel,
  }
}
