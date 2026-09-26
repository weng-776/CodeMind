/**
 * AI 对话组合式函数：会话列表 + 消息 + 流式接收的状态机。
 *
 * 两处用 `streamSeq` 兜住的坑：
 *   1. 中断后旧流的回调会迟到，可能把新一轮的状态一起清掉 → 回调里先比对序号；
 *   2. 发送失败不能吞掉用户输入 → `sendMessage` 返回「发出去没有」，由页面决定是否还原草稿。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import * as aiApi from '@/api/ai'
import { ApiError } from '@/api/request'
import { streamChat } from '@/api/aiStream'
import type { AiConversationVO, ChatMessage } from '@/types/ai'

/** 生成本地消息 id（后端历史消息没有 id，需要前端自己保证唯一） */
let messageSeed = 0
function createMessageId(): string {
  messageSeed += 1
  return `msg_${Date.now()}_${messageSeed}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 后端给的占位标题形如「新会话000」。
 * **只要还匹配它，就说明真实标题还没生成出来。**
 */
const PLACEHOLDER_TITLE_RE = /^新会话\d+$/

/**
 * 标题轮询的间隔与上限。
 *
 * 后端是在**流结束之后异步**生成标题的（抢占 `title_generated` 标记 →
 * 流正常结束后在 boundedElastic 线程里调子模型 → 再写库），
 * 实测流结束后约 2s 才能查到新标题。所以「流一结束就以为标题已就绪」是错的，
 * 这正是「要刷新页面才看到新标题」的根因。
 *
 * 每 1s 探一次、**最多 6 次** —— 上限必须有，否则标题生成失败（或后端限流）时
 * 会一直轮询下去。用尽上限后不再硬撑；用户下次发消息时会再试一轮（自愈）。
 */
const TITLE_POLL_INTERVAL = 1000
const TITLE_POLL_MAX = 6

/** 把后端历史消息转换为本地视图模型 */
function toChatMessages(list: { role: string; content: string }[]): ChatMessage[] {
  return list.map((m) => ({
    id: createMessageId(),
    role: m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'assistant',
    content: m.content,
  }))
}

export function useAiChat() {
  /* ==================== 会话列表 ==================== */

  const conversations = ref<AiConversationVO[]>([])
  const conversationsLoading = ref(false)
  const conversationsError = ref<string | null>(null)

  /** 当前会话 id */
  const currentConversationId = ref<string | null>(null)

  /* ==================== 消息 ==================== */

  const messages = ref<ChatMessage[]>([])
  const messagesLoading = ref(false)
  const messagesError = ref<string | null>(null)

  /** 是否正在流式生成 */
  const isStreaming = ref(false)

  /** 当前是否有进行中的流（用于「停止生成」） */
  let controller: AbortController | null = null

  /**
   * 流序号。每开一条新流就 +1，回调里比对 —— 不是自己的序号就整段忽略。
   * 「停止生成」也会 +1，把旧流的迟到回调作废（见文件头第 1 条）。
   */
  let streamSeq = 0

  const canSend = computed(() => !isStreaming.value)

  const hasMessages = computed(() => messages.value.length > 0)

  /* ==================== 会话操作 ==================== */

  /** 加载会话列表 */
  async function loadConversations(): Promise<void> {
    conversationsLoading.value = true
    conversationsError.value = null
    try {
      conversations.value = await aiApi.getConversations()
    } catch {
      // 请求层已统一提示，这里只记录状态用于展示 ErrorState
      conversationsError.value = '会话列表加载失败'
      conversations.value = []
    } finally {
      conversationsLoading.value = false
    }
  }

  /** 新建会话并切换过去 */
  async function createConversation(): Promise<AiConversationVO | null> {
    try {
      const conversation = await aiApi.createConversation()
      // 新会话插到列表最前面，符合「最近使用在上」的直觉
      conversations.value = [conversation, ...conversations.value]
      switchConversation(conversation.id)
      return conversation
    } catch {
      return null
    }
  }

  /**
   * 切换会话。
   * 若正在生成则先中断，避免上一个流的 chunk 追加到新会话里。
   */
  function switchConversation(conversationId: string): void {
    if (isStreaming.value) stopGeneration()

    if (currentConversationId.value === conversationId) return

    currentConversationId.value = conversationId
    messages.value = []
    void loadMessages(conversationId)
    /*
     * 顺手补一次标题：如果上次那条消息的轮询用尽了上限（后端标题生成慢或失败），
     * 标题会一直停在「新会话NNN」直到用户再发一条。切回来时再试一轮，
     * 让用户不必为了看标题而多发一条消息。
     * 标题已经是真的话这个调用会立刻返回，不产生任何请求。
     */
    void refreshConversationTitle(conversationId)
  }

  /** 加载指定会话的历史消息 */
  async function loadMessages(conversationId: string): Promise<void> {
    messagesLoading.value = true
    messagesError.value = null
    try {
      const history = await aiApi.getConversationMessages(conversationId)
      // 防止请求期间用户又切了会话，导致消息错位
      if (currentConversationId.value !== conversationId) return
      messages.value = toChatMessages(history)
    } catch {
      if (currentConversationId.value !== conversationId) return
      messagesError.value = '历史消息加载失败'
      messages.value = []
    } finally {
      if (currentConversationId.value === conversationId) {
        messagesLoading.value = false
      }
    }
  }

  /**
   * 删除会话。
   *
   * 两件事：
   *   1. **乐观移除**：先从列表摘掉（失败再**插回原下标**，不是 push 回末尾 ——
   *      与收藏/关注的移除型乐观更新同一套做法，列表顺序不能乱）。
   *   2. **删的是当前会话时的兜底**：立刻切到「原位置的下一个」（没有就上一个），
   *      都没有就把对话区清空。**调用方必须据此把 URL 里的 `?c=` 一并去掉** ——
   *      否则之后拿着已删的 conversationId 发消息会直接 404。
   *
   * @returns `{ ok, nextId }`
   *   `ok=false` 表示失败且**状态已精确回滚**（失败提示由请求层统一给出，这里不重复弹）；
   *   `nextId` 是删除后应该停留的会话 id，`null` 表示已经没有会话了（应清空对话区）。
   */
  async function deleteConversation(
    conversationId: string,
  ): Promise<{ ok: boolean; nextId: string | null }> {
    const index = conversations.value.findIndex((c) => c.id === conversationId)
    // 不在列表里（可能刚被别处删了）：没什么可做的，让调用方按当前状态收尾
    if (index < 0) return { ok: true, nextId: currentConversationId.value }

    const removed = conversations.value[index]
    if (!removed) return { ok: true, nextId: currentConversationId.value }

    const wasCurrent = currentConversationId.value === conversationId
    // 快照：失败时精确还原（不靠重新拉列表 —— 断网时重拉也会失败）
    const prevCurrent = currentConversationId.value
    const prevMessages = messages.value

    // ---- 乐观：摘掉 + 必要时切换 ----
    conversations.value.splice(index, 1)
    const fallback = conversations.value[index] ?? conversations.value[index - 1] ?? null

    if (wasCurrent) {
      currentConversationId.value = fallback ? fallback.id : null
      messages.value = []
      if (fallback) void loadMessages(fallback.id)
    }

    try {
      await aiApi.deleteConversation(conversationId)
      return { ok: true, nextId: fallback ? fallback.id : null }
    } catch (err) {
      /*
       * 404「会话不存在」= 本来就已经没了 → 按**成功**处理（幂等），不回滚。
       * 其余失败（多半是断网）才回滚。
       */
      if (err instanceof ApiError && err.code === 404) {
        return { ok: true, nextId: fallback ? fallback.id : null }
      }

      conversations.value.splice(index, 0, removed)
      if (wasCurrent) {
        currentConversationId.value = prevCurrent
        messages.value = prevMessages
        /*
         * 上面那个 `loadMessages(fallback.id)` 可能已经在飞了 —— 它的 finally 里
         * 会因为「当前会话不是它」而不把 loading 置回 false，
         * 于是消息区会永久停在加载态。回滚时手动收尾。
         */
        messagesLoading.value = false
      }
      return { ok: false, nextId: prevCurrent }
    }
  }

  /**
   * 会话标题的「事后刷新」。
   *
   * 后端在流结束后**异步**生成标题（约 2s 后才写库），所以流一结束就去读
   * 必然还是「新会话NNN」。这里用**有上限的轮询**等它：每 1s 一次、最多 6 次，
   * 一旦拿到非占位标题就立刻收工。
   *
   * 几个刻意的取舍：
   *   - **标题已经是真实的了就直接返回**，一个请求都不发 ——
   *     只有「刚建的新会话」才需要等，后续每条消息不该产生额外请求。
   *   - 只**外科式地更新这一条的 title**，不用 5.2 的整体结果覆盖本地列表：
   *     否则会把「刚乐观删掉、请求还没回来」的会话又刷回来。
   *   - 单次失败不中断（可能只是抖动），但总次数有上限。
   */
  async function refreshConversationTitle(conversationId: string): Promise<void> {
    const local = conversations.value.find((c) => c.id === conversationId)
    if (local && !PLACEHOLDER_TITLE_RE.test(local.title ?? '')) return

    for (let i = 0; i < TITLE_POLL_MAX; i += 1) {
      await sleep(TITLE_POLL_INTERVAL)

      // 期间可能被删了 / 列表被换掉 → 没必要再探
      const target = conversations.value.find((c) => c.id === conversationId)
      if (!target) return

      try {
        const latest = await aiApi.getConversations()
        const hit = latest.find((c) => c.id === conversationId)
        if (!hit) {
          // 后端已经没有这个会话了（别处删的）→ 本地也摘掉，别再探
          conversations.value = conversations.value.filter((c) => c.id !== conversationId)
          return
        }
        target.title = hit.title
        if (!PLACEHOLDER_TITLE_RE.test(hit.title ?? '')) return
      } catch {
        // 单次失败继续下一轮（有上限兜底）
      }
    }
  }

  /* ==================== 发送与流式接收 ==================== */

  /**
   * 发送问题并流式接收回答。
   *
   * @param prompt 用户输入
   * @returns 这条消息是否**已经发出去**（会话就绪 + 流已启动）。
   *   `false` 表示什么都没发生（空输入 / 正在生成 / 建会话失败），
   *   调用方据此把草稿还给用户 —— 输入框是页面清空的，composable 不该替它决定。
   *
   * 注意：**不会 await 整段生成**。流一启动就返回，否则调用方要白等十几秒
   * （面试题接口最慢 13~17s）。
   */
  async function sendMessage(prompt: string): Promise<boolean> {
    const text = prompt.trim()
    if (!text) return false

    if (isStreaming.value) {
      ElMessage.warning('正在生成中，请稍候')
      return false
    }

    // 没有会话时自动创建一个（避免用户必须先点「新建会话」）
    if (!currentConversationId.value) {
      const created = await createConversation()
      if (!created) {
        // 失败提示由请求层给出（约定 D），这里不重复弹
        return false
      }
    }

    const conversationId = currentConversationId.value
    if (!conversationId) return false

    // 1) 追加用户消息
    messages.value.push({
      id: createMessageId(),
      role: 'user',
      content: text,
    })

    // 2) 创建空的 assistant 消息占位，标记为生成中
    const assistantMessage: ChatMessage = {
      id: createMessageId(),
      role: 'assistant',
      content: '',
      streaming: true,
    }
    messages.value.push(assistantMessage)

    isStreaming.value = true
    controller = new AbortController()
    const mySeq = ++streamSeq

    /*
     * ⚠️ 必须拿**数组里的响应式代理**，不能直接用刚 push 进去的原始对象：
     * `push(obj)` 存的是原始对象，之后改它的属性绕过 reactive 的 set 陷阱，
     * **不会触发重新渲染** —— 界面会永远停在「正在思考」。
     */
    const target = messages.value[messages.value.length - 1]
    if (!target) return false

    // 刻意不 await：见函数头说明
    void streamChat(
      { conversationId, prompt: text },
      {
        onChunk(chunk) {
          // 已被「停止」或已切到新一轮 → 丢弃这条迟到流的增量
          if (mySeq !== streamSeq) return
          target.content += chunk
        },
        onDone() {
          if (mySeq !== streamSeq) return
          target.streaming = false
          isStreaming.value = false
          controller = null
          /*
           * 标题是后端**流结束后异步**生成的（约 2s 后才写库），
           * 所以这里不能「就当地址栏那条会话的标题已经好了」——
           * 这正是「要刷新页面才看到新标题」的根因。启动有上限的轮询等它。
           * 已经是有真实标题的会话会立刻返回，不产生额外请求。
           */
          void refreshConversationTitle(conversationId)
        },
        onError(message) {
          if (mySeq !== streamSeq) return
          target.streaming = false
          target.error = true
          /*
           * 没收到任何内容时，把**失败原因**放进气泡正文，让用户看到「为什么失败」。
           * 不要拼成「生成失败：xxx」——气泡下面那条错误行已经写了「生成失败」，
           * 两处重复只会显得啰嗦。
           */
          if (!target.content) target.content = message
          isStreaming.value = false
          controller = null
          // 不再额外弹 toast：错误就展示在对话流里（气泡 + 重试），
          // 再弹一条全局提示既重复又容易在长对话里被忽略。
        },
      },
      controller.signal,
    )

    return true
  }

  /** 停止生成（用户点击「停止」按钮） */
  function stopGeneration(): void {
    if (!controller) return
    controller.abort()
    controller = null

    // 作废这条流的回调：abort 之后 onDone 还会迟到，别让它动到下一轮的状态
    streamSeq += 1

    // 把仍在 streaming 的消息收尾
    const last = messages.value[messages.value.length - 1]
    if (last && last.streaming) {
      last.streaming = false
      if (!last.content) {
        last.content = '（已停止生成）'
      }
    }
    isStreaming.value = false
  }

  /** 清空当前会话的消息（仅前端展示层，不删除后端会话） */
  function clearCurrentMessages(): void {
    messages.value = []
    messagesError.value = null
  }

  return {
    // 会话
    conversations,
    conversationsLoading,
    conversationsError,
    currentConversationId,
    loadConversations,
    createConversation,
    switchConversation,
    deleteConversation,
    refreshConversationTitle,

    // 消息
    messages,
    messagesLoading,
    messagesError,
    hasMessages,
    loadMessages,
    sendMessage,
    stopGeneration,
    clearCurrentMessages,

    // 状态
    isStreaming,
    canSend,
  }
}
