<script setup lang="ts">
/**
 * AI 助手 —— 统一对话窗口。
 * 接口：5.1 创建会话 ｜ 5.2 会话列表 ｜ 5.3 历史消息 ｜ 5.4 统一聊天（裸文本流）｜
 * 删除会话 `DELETE /api/ai/DeleteConversation/{id}`（**大写 D**）。
 *
 * 两个「后端异步 / 后置」的坑，本页都有对应处理：
 *   - 会话标题是流结束后**异步**生成的（约 2s 后才写库）→ 由 useAiChat 的
 *     `refreshConversationTitle` 用有上限的轮询补上，否则要刷新页面才看得到新标题；
 *   - 删掉当前会话后 URL 上的 `?c=` 必须摘掉，否则页面还挂着已删的 id，下一条消息直接 404。
 *
 * 状态机与流式读取全在 `composables/useAiChat`（内部用 useAiStream 做逐分片解码），
 * 本组件只负责界面编排 —— 流式内核是全项目风险最高的部分，不该和 DOM 逻辑混在一起。
 *
 * URL 同步：当前会话写进 `?c=<id>`，刷新能回到同一会话、链接可分享。
 *   ⚠️ 反向监听 query 时必须先判断「是否与当前会话相同」，否则 replace 触发的回调会走到
 *   switchConversation，而那里一旦发现 isStreaming 就中断生成 —— 等于每发一条消息都被自己掐断。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import AiMessage from '@/components/ai/AiMessage.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useAiChat } from '@/composables/useAiChat'
import { RouteName } from '@/router/routes-names'
import type { AiConversationVO } from '@/types/ai'

const route = useRoute()
const router = useRouter()

const {
  conversations,
  conversationsLoading,
  conversationsError,
  currentConversationId,
  loadConversations,
  createConversation,
  switchConversation,
  deleteConversation,
  messages,
  messagesLoading,
  messagesError,
  hasMessages,
  loadMessages,
  sendMessage,
  stopGeneration,
  isStreaming,
  canSend,
} = useAiChat()

/* ==================== URL 同步 ==================== */

const queryConversationId = computed<string | null>(() => {
  const raw = route.query.c
  const v = Array.isArray(raw) ? raw[0] : raw
  return v ? String(v) : null
})

// 会话变化 → 写进 URL（replace 不产生历史记录，避免后退键被一堆会话切换塞满）
watch(currentConversationId, (id) => {
  /*
   * ⚠️ `id` 为 null 也要处理：删掉最后一个会话后 currentConversationId 会变成 null，
   * 如果这里直接 return，URL 上还挂着**已经删掉**的 `?c=<id>` ——
   * 刷新页面就会去查一个不存在的会话（404），分享链接也是坏的。
   * 所以必须把 ?c= 摘掉。
   */
  if (!id) {
    if (queryConversationId.value !== null) {
      void router.replace({ name: RouteName.AI_CHAT, query: {} })
    }
    return
  }
  if (queryConversationId.value === id) return
  void router.replace({ name: RouteName.AI_CHAT, query: { c: id } })
})

// URL 变化 → 切换会话（支持浏览器前进/后退）
watch(queryConversationId, (id) => {
  // 关键：相同会话直接返回。否则 replace 回调会进 switchConversation，
  // 那里见 isStreaming 就 stopGeneration，把正在生成的回答掐掉。
  if (!id || id === currentConversationId.value) return
  switchConversation(id)
})

/* ==================== 当前会话 ==================== */

const currentConversation = computed<AiConversationVO | null>(
  () => conversations.value.find((c) => c.id === currentConversationId.value) ?? null,
)

/** 还没有任何会话，也没在加载 → 展示欢迎页 */
const showWelcome = computed(
  () =>
    !messagesLoading.value &&
    !messagesError.value &&
    !hasMessages.value &&
    !isStreaming.value,
)

/* ==================== 滚动 ==================== */

const scrollEl = ref<HTMLElement | null>(null)

/**
 * 是否「贴着底部」。
 * 用户往上翻看历史时不要强行把他拽回底部 —— 那是聊天界面最讨人厌的行为之一。
 * 只有在离底部 80px 以内才自动跟随新内容。
 */
const stickToBottom = ref(true)

function onScroll() {
  const el = scrollEl.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

async function scrollToBottom(behavior: ScrollBehavior = 'auto') {
  await nextTick()
  const el = scrollEl.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior })
}

// 消息条数变化（新增消息）或最后一条内容增长（流式追加）时跟随滚动
watch(
  [
    () => messages.value.length,
    () => messages.value[messages.value.length - 1]?.content.length ?? 0,
  ],
  () => {
    if (stickToBottom.value) void scrollToBottom()
  },
)

// 历史消息加载完成后直接落到最新一条
watch(messagesLoading, (loading) => {
  if (loading) return
  stickToBottom.value = true
  void scrollToBottom()
})

/* ==================== 输入 ==================== */

const draft = ref('')

/**
 * prompt 前端限长。
 *
 * 5.4 接口**没有长度限制**（实测 20000 字照样返回，而且全文落库），
 * 超长会持续抬高存储与 token 成本，所以这个约束只能前端自己兜。
 * 2000 字对「贴一段代码问问题」足够，再长就该走文章 / 笔记的 AI 上下文接口。
 */
const PROMPT_MAX = 2000

const SUGGESTIONS = [
  '用通俗的话解释一下什么是闭包',
  'Redis 分布式锁有哪些坑？',
  'Spring Boot 自动装配的原理是什么？',
  'MySQL 索引失效的常见场景有哪些',
]

function useSuggestion(text: string) {
  draft.value = text
  void handleSend()
}

async function handleSend() {
  const text = draft.value.trim()
  if (!text || isStreaming.value) return

  // 先清空输入框：让用户能立刻接着打字，而不是等流结束
  draft.value = ''
  stickToBottom.value = true

  // sendMessage 只等「流启动」，不等整段生成结束，所以这里可以放心 await
  const accepted = await sendMessage(text)
  if (!accepted) {
    // 没发出去（建会话失败 / 又处于生成中）→ 把输入还给用户，别让他重打一遍
    draft.value = text
  }
}

function handleStop() {
  stopGeneration()
}

/** 新建会话 */
const creating = ref(false)

async function handleNewConversation() {
  if (creating.value) return
  creating.value = true
  try {
    const created = await createConversation()
    if (!created) {
      ElMessage.error('新建会话失败')
      return
    }
    sidebarOpen.value = false
  } finally {
    creating.value = false
  }
}

function selectConversation(id: string) {
  switchConversation(id)
  sidebarOpen.value = false
}

/* ==================== 删除会话 ==================== */

/** 正在删除中的会话 id（防重复点击） */
const deletingConvId = ref<string | null>(null)

/**
 * 删除会话：二次确认 → 乐观移除 → 失败精确还原。两件事必须一起做对：
 *   1. 失败要**插回原下标**（不是 push 回末尾）—— 列表按「最近使用在上」排，顺序错乱更难发现；
 *   2. 删的是当前会话时要兜底：`deleteConversation` 会切到相邻会话，一个不剩时置 null，
 *      URL 的 `?c=` 由上面的 watcher 摘掉。少了这步，下一条消息直接 404。
 */
async function handleDeleteConversation(conv: AiConversationVO) {
  if (deletingConvId.value) return

  try {
    await ElMessageBox.confirm(
      `确定删除会话「${conv.title || '未命名会话'}」吗？删除后对话记录不可恢复。`,
      '删除会话',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return // 用户取消
  }

  deletingConvId.value = conv.id
  const { ok } = await deleteConversation(conv.id)
  deletingConvId.value = null

  // 失败时状态已精确回滚，提示由请求层统一给出，这里不重复弹
  if (ok) ElMessage.success('会话已删除')
}

/** 重试当前会话的历史消息 */
function retryMessages() {
  const id = currentConversationId.value
  if (!id) return
  void loadMessages(id)
}

/**
 * 重试失败的生成。
 * 不能直接调用 handleSend —— 那时输入框已经空了，发出去的是空串。
 * 正确做法是把失败的那轮（assistant 错误气泡 + 它对应的 user 气泡）一起摘掉，
 * 再用原问题重发一次，这样 UI 上不会多出重复的提问。
 */
function retryLast() {
  if (isStreaming.value) return

  const last = messages.value[messages.value.length - 1]
  if (!last || last.role !== 'assistant' || !last.error) return

  messages.value.pop()

  const prev = messages.value[messages.value.length - 1]
  if (!prev || prev.role !== 'user') return

  const prompt = prev.content
  messages.value.pop()

  stickToBottom.value = true
  void sendMessage(prompt)
}

/* ==================== 移动端侧栏 ==================== */

const sidebarOpen = ref(false)

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

/** 窄屏下按 Esc 收起侧栏 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && sidebarOpen.value) sidebarOpen.value = false
}

/* ==================== 初始化 ==================== */

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)

  await loadConversations()

  // 优先恢复 URL 指定的会话；它不在列表里（已删除 / 别人的链接）则退回最近一个
  const wanted = queryConversationId.value
  if (wanted && conversations.value.some((c) => c.id === wanted)) {
    switchConversation(wanted)
    return
  }

  const first = conversations.value[0]
  if (first) switchConversation(first.id)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  // 离开页面时中断未完成的流，避免组件销毁后回调继续写已失效的 ref
  if (isStreaming.value) stopGeneration()
})
</script>

<template>
  <div class="cm-ai">
    <!-- ==================== 侧栏 ==================== -->
    <aside class="cm-ai__side" :class="{ 'is-open': sidebarOpen }">
      <div class="cm-ai__side-head">
        <span class="cm-ai__side-title">会话</span>
        <el-button size="small" type="primary" :loading="creating" @click="handleNewConversation">
          <el-icon class="cm-ai__btn-icon"><Plus /></el-icon>
          新建会话
        </el-button>
      </div>

      <div class="cm-ai__side-body cm-scroll-thin">
        <LoadingState v-if="conversationsLoading" variant="spinner" text="加载会话" />

        <ErrorState
          v-else-if="conversationsError"
          title="会话列表加载失败"
          description="点重试再拉一次"
          @retry="loadConversations"
        />

        <EmptyState
          v-else-if="conversations.length === 0"
          title="还没有会话"
          description="点上方「新建会话」开始第一次对话"
          :size="64"
        />

        <ul v-else class="cm-ai__conv-list">
          <li v-for="conv in conversations" :key="conv.id" class="cm-ai__conv-row">
            <button
              type="button"
              class="cm-ai__conv"
              :class="{ 'is-active': conv.id === currentConversationId }"
              :title="conv.title"
              @click="selectConversation(conv.id)"
            >
              <el-icon :size="13" class="cm-ai__conv-icon"><ChatLineSquare /></el-icon>
              <span class="cm-ai__conv-title cm-truncate">{{ conv.title || '未命名会话' }}</span>
            </button>

            <!--
              删除按钮：鼠标悬停在整行时才浮现（触屏用 (hover: none) 常驻，见样式）。
              不加 .stop 的话，点删除会顺带触发外面那个「选中会话」的按钮。
            -->
            <button
              type="button"
              class="cm-ai__conv-del"
              :disabled="deletingConvId === conv.id"
              :aria-label="`删除会话 ${conv.title || '未命名会话'}`"
              title="删除会话"
              @click.stop="handleDeleteConversation(conv)"
            >
              <el-icon :size="13"><Delete /></el-icon>
            </button>
          </li>
        </ul>
      </div>

      <p class="cm-ai__side-foot">
        回答由 AI 生成，请自行判断准确性
      </p>
    </aside>

    <!-- 移动端遮罩 -->
    <div v-if="sidebarOpen" class="cm-ai__mask" @click="sidebarOpen = false" />

    <!-- ==================== 主区 ==================== -->
    <section class="cm-ai__main">
      <!-- 头部 -->
      <header class="cm-ai__head">
        <button
          type="button"
          class="cm-ai__sidebar-toggle"
          aria-label="打开会话列表"
          @click="toggleSidebar"
        >
          <el-icon :size="17"><Menu /></el-icon>
        </button>

        <div class="cm-ai__head-text">
          <h1 class="cm-ai__title">{{ currentConversation?.title || 'AI 助手' }}</h1>
          <p class="cm-ai__subtitle">
            <template v-if="isStreaming">
              <span class="cm-ai__pulse" aria-hidden="true" />
              正在生成…
            </template>
            <template v-else-if="hasMessages">对话进行中 · Enter 发送，Shift + Enter 换行</template>
            <template v-else>基于你的问题给出技术解答</template>
          </p>
        </div>
      </header>

      <!-- 消息区：本页**唯一**的消息滚动容器（整页不滚动，见 MainLayout .is-app-shell） -->
      <div ref="scrollEl" class="cm-ai__scroll cm-scroll-thin" @scroll.passive="onScroll">
        <!-- 欢迎页 -->
        <div v-if="showWelcome" class="cm-ai__welcome">
          <div class="cm-ai__welcome-mark" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5 6.4 9.1 2 7.5l4.4-1.6L8 1.5z"
                fill="currentColor"
              />
            </svg>
          </div>

          <h2 class="cm-ai__welcome-title">有什么想问的？</h2>
          <p class="cm-ai__welcome-desc">
            可以直接提问技术问题、让我帮你梳理知识点，或者贴一段代码一起看。
          </p>

          <div class="cm-ai__suggestions">
            <button
              v-for="text in SUGGESTIONS"
              :key="text"
              type="button"
              class="cm-ai__suggestion"
              @click="useSuggestion(text)"
            >
              {{ text }}
            </button>
          </div>
        </div>

        <!-- 历史消息加载中 -->
        <LoadingState v-else-if="messagesLoading" variant="spinner" text="加载历史消息" />

        <!-- 历史消息失败 -->
        <ErrorState
          v-else-if="messagesError"
          title="历史消息加载失败"
          description="当前会话的记录暂时取不到，可重试"
          @retry="retryMessages"
        />

        <!-- 消息列表 -->
        <div v-else class="cm-ai__messages">
          <AiMessage
            v-for="message in messages"
            :key="message.id"
            :message="message"
            @retry="retryLast"
          />
        </div>
      </div>

      <!-- 输入区 -->
      <footer class="cm-ai__composer">
        <div class="cm-ai__composer-box">
          <el-input
            v-model="draft"
            type="textarea"
            :rows="1"
            :autosize="{ minRows: 1, maxRows: 6 }"
            :maxlength="PROMPT_MAX"
            resize="none"
            placeholder="问点什么…（Enter 发送，Shift + Enter 换行）"
            class="cm-ai__input"
            @keydown.enter.exact.prevent="handleSend"
          />

          <div class="cm-ai__composer-actions">
            <!--
              生成中「发送」保持在场但禁用（而不是被「停止」顶掉）：
              按钮位置不跳动，用户一眼就知道「现在不能发，但可以停」。
            -->
            <el-button
              type="primary"
              size="small"
              :disabled="!draft.trim() || !canSend"
              @click="handleSend"
            >
              <el-icon class="cm-ai__btn-icon">
                <component :is="isStreaming ? 'Loading' : 'Promotion'" />
              </el-icon>
              {{ isStreaming ? '生成中…' : '发送' }}
            </el-button>

            <el-button v-if="isStreaming" size="small" @click="handleStop">
              <el-icon class="cm-ai__btn-icon"><VideoPause /></el-icon>
              停止生成
            </el-button>
          </div>
        </div>

        <p class="cm-ai__composer-hint">
          <span>流式返回，可以随时点「停止生成」中断。</span>
          <span
            v-if="draft.length"
            class="cm-ai__composer-count"
            :class="{ 'is-near-limit': draft.length >= PROMPT_MAX * 0.9 }"
          >
            {{ draft.length }} / {{ PROMPT_MAX }}
          </span>
        </p>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/*
 * 高度链条：
 *   .cm-layout (min-height:100vh, flex column)
 *     └ .cm-layout__main.is-full-width (flex:1, flex column, min-height:0)
 *         └ .cm-ai (flex:1, min-height:0)  ← 本页，内部两栏
 * 因为 AI 页不渲染页脚，可用高度正好是 100vh - header，不会有嵌套滚动条。
 */
.cm-ai {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background-color: var(--cm-bg-surface);
}

/* ==================== 侧栏 ==================== */
.cm-ai__side {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 248px;
  border-right: 1px solid var(--cm-border-subtle);
  background-color: var(--cm-bg-subtle);
}

.cm-ai__side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-2);
  padding: var(--cm-space-4);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-ai__side-title {
  font-size: var(--cm-font-size-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--cm-text-secondary);
}

.cm-ai__btn-icon {
  margin-right: 4px;
}

.cm-ai__side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--cm-space-2);
}

.cm-ai__conv-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cm-ai__conv {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  width: 100%;
  padding: var(--cm-space-3);
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
  text-align: left;
  background: none;
  border: none;
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.cm-ai__conv:hover {
  color: var(--cm-text-primary);
  background-color: var(--cm-bg-hover);
}

.cm-ai__conv.is-active {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
  font-weight: 500;
}

.cm-ai__conv-icon {
  flex-shrink: 0;
  color: var(--cm-text-quaternary);
}

.cm-ai__conv.is-active .cm-ai__conv-icon {
  color: var(--cm-accent-600);
}

.cm-ai__conv-title {
  min-width: 0;
}

/* 一行 = 会话按钮 + 删除按钮 */
.cm-ai__conv-row {
  display: flex;
  align-items: center;
  gap: var(--cm-space-1);
}

/* 原来是 width:100%，进了 flex 行要改成可伸缩 + 允许收缩（否则长标题把删除键挤出去） */
.cm-ai__conv-row .cm-ai__conv {
  flex: 1;
  min-width: 0;
}

/*
 * 删除按钮：悬停整行才浮现。
 * 用 opacity 而不是 display —— 保证它始终占位、不引起行内抖动，
 * 也让「键盘 Tab 到它」时能正常聚焦（配合 :focus-visible 强制显示）。
 */
.cm-ai__conv-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--cm-text-quaternary);
  background: none;
  border: none;
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    color 0.15s ease,
    background-color 0.15s ease;
}

.cm-ai__conv-row:hover .cm-ai__conv-del,
.cm-ai__conv-del:focus-visible {
  opacity: 1;
}

.cm-ai__conv-del:hover:not(:disabled) {
  color: var(--cm-danger);
  background-color: var(--cm-danger-bg);
}

.cm-ai__conv-del:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

/* 触屏设备没有 hover —— 常驻显示，否则删除入口根本找不到 */
@media (hover: none) {
  .cm-ai__conv-del {
    opacity: 1;
  }
}

.cm-ai__side-foot {
  margin: 0;
  padding: var(--cm-space-3) var(--cm-space-4);
  font-size: 11px;
  line-height: 1.6;
  color: var(--cm-text-quaternary);
  border-top: 1px solid var(--cm-border-subtle);
}

.cm-ai__mask {
  display: none;
}

/* ==================== 主区 ==================== */
.cm-ai__main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.cm-ai__head {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  flex-shrink: 0;
  padding: var(--cm-space-4) var(--cm-space-6);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-ai__sidebar-toggle {
  display: none;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  color: var(--cm-text-secondary);
  background: none;
  border: none;
  border-radius: var(--cm-radius-md);
  cursor: pointer;
}

.cm-ai__sidebar-toggle:hover {
  background-color: var(--cm-bg-hover);
}

.cm-ai__head-text {
  min-width: 0;
}

.cm-ai__title {
  margin: 0;
  font-size: var(--cm-font-size-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--cm-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cm-ai__subtitle {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  margin: var(--cm-space-1) 0 0;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-ai__pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--cm-accent-500);
  animation: cm-ai-pulse 1.2s ease-in-out infinite;
}

@keyframes cm-ai-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

/* ==================== 消息滚动区 ==================== */
.cm-ai__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* ==================== 欢迎页 ==================== */
.cm-ai__welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: var(--cm-space-12) var(--cm-space-6);
  text-align: center;
}

.cm-ai__welcome-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  color: var(--cm-text-inverse);
  background: linear-gradient(135deg, var(--cm-accent-500), var(--cm-accent-700));
  border-radius: var(--cm-radius-xl);
  box-shadow: var(--cm-shadow-md);
}

.cm-ai__welcome-title {
  margin: var(--cm-space-5) 0 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-ai__welcome-desc {
  margin: var(--cm-space-3) 0 0;
  max-width: 46ch;
  font-size: var(--cm-font-size-base);
  line-height: 1.7;
  color: var(--cm-text-tertiary);
}

.cm-ai__suggestions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-8);
  max-width: 640px;
}

.cm-ai__suggestion {
  padding: var(--cm-space-3) var(--cm-space-4);
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
  background-color: var(--cm-bg-surface);
  border: 1px solid var(--cm-border-default);
  border-radius: var(--cm-radius-full);
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.cm-ai__suggestion:hover {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
  border-color: var(--cm-accent-300);
}

/* ==================== 消息列表 ==================== */
.cm-ai__messages {
  max-width: 780px;
  margin: 0 auto;
  padding: var(--cm-space-4) var(--cm-space-6) var(--cm-space-8);
}

/* ==================== 输入区 ==================== */
.cm-ai__composer {
  flex-shrink: 0;
  padding: var(--cm-space-4) var(--cm-space-6) var(--cm-space-5);
  border-top: 1px solid var(--cm-border-subtle);
  background-color: var(--cm-bg-surface);
}

.cm-ai__composer-box {
  position: relative;
  max-width: 780px;
  margin: 0 auto;
  padding: var(--cm-space-3) var(--cm-space-3) var(--cm-space-2);
  background-color: var(--cm-bg-body);
  border: 1px solid var(--cm-border-default);
  border-radius: var(--cm-radius-lg);
  transition: border-color 0.15s ease;
}

.cm-ai__composer-box:focus-within {
  border-color: var(--cm-accent-400);
}

/* 去掉 EP textarea 自带的边框，让整块 composer 看起来是一个整体 */
.cm-ai__input :deep(.el-textarea__inner) {
  padding: 0;
  font-size: var(--cm-font-size-base);
  line-height: 1.7;
  background-color: transparent;
  border: none;
  box-shadow: none;
  resize: none;
}

.cm-ai__composer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--cm-space-2);
  margin-top: var(--cm-space-2);
}

.cm-ai__composer-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--cm-space-3);
  max-width: 780px;
  margin: var(--cm-space-2) auto 0;
  font-size: 11px;
  text-align: center;
  color: var(--cm-text-quaternary);
}

.cm-ai__composer-count {
  font-family: var(--cm-font-mono);
  font-variant-numeric: tabular-nums;
}

.cm-ai__composer-count.is-near-limit {
  color: var(--cm-warning);
}

/* ==================== 响应式 ==================== */
@media (max-width: 900px) {
  /* 窄屏：侧栏变成抽屉，盖在主区上方 */
  .cm-ai__side {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: var(--cm-z-drawer);
    width: 264px;
    transform: translateX(-100%);
    transition: transform var(--cm-duration-base) var(--cm-ease-out);
    box-shadow: var(--cm-shadow-lg);
  }

  .cm-ai__side.is-open {
    transform: translateX(0);
  }

  .cm-ai__sidebar-toggle {
    display: inline-flex;
  }

  .cm-ai__mask {
    display: block;
    position: absolute;
    inset: 0;
    z-index: var(--cm-z-header);
    background-color: var(--cm-bg-overlay);
  }

  .cm-ai__head,
  .cm-ai__composer {
    padding-left: var(--cm-space-4);
    padding-right: var(--cm-space-4);
  }

  .cm-ai__messages {
    padding-left: var(--cm-space-4);
    padding-right: var(--cm-space-4);
  }
}

@media (prefers-reduced-motion: reduce) {
  .cm-ai__side {
    transition: none;
  }

  .cm-ai__pulse {
    animation: none;
  }
}
</style>
