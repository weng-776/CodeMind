<script setup lang="ts">
/**
 * 管理后台 · 死信队列
 * ------------------------------------------------------------------
 * 接口（设计说明 §2.4，4 个）：
 *   GET    /api/admin/mq/queues                     → AdminQueueVO[]（**固定 6 条**）
 *   GET    /api/admin/mq/queues/{queue}/messages    → string[]（消息正文数组，**不分页**）
 *   DELETE /api/admin/mq/queues/{queue}/messages    → null（清空）
 *   POST   /api/admin/mq/queues/{queue}/replay      → number（本次重投成功条数）
 *
 * 关键设计：
 *   1. **消息是「JSON 文本」但不能假设一定能 parse**（§7 坑 6）：死信的定义就是
 *      「处理失败的消息」，里面什么都可能有。所以渲染时 `try { JSON.parse } catch { 原样显示 }`，
 *      parse 失败要有可读的降级，**绝不抛异常**（抛了整页就白了）。
 *   2. **重投后不按 `message` 文本分支**（§7 坑 8）：后端可能回「还剩 M 条，请再次执行」。
 *      正确做法是**重投后重新拉一次队列列表**，用 `messageCount` 判断是否归零。
 *   3. **清空与重投都是危险操作**，二次确认，文案**如实说明后果**（§3.2）。
 *   4. 队列名**带点号**（`codemind.cache.queue.dead`）→ 拼 URL 用模板字符串即可，
 *      实测无需特殊处理，但**不要**做后缀截断（§7 坑 7）。
 *
 * ⚠️ 页头/卡片样式与其它管理页是**刻意的重复**：`.vue` 的 `<style scoped>` 不能跨文件复用，
 *    而本单范围只允许新增本文件。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import EmptyState from '@/components/common/EmptyState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import {
  clearAdminQueueMessages,
  getAdminQueueMessages,
  getAdminQueues,
  replayAdminQueue,
} from '@/api/admin'
import { ApiError } from '@/api/request'
import { RouteName } from '@/router/routes-names'
import { useUserStore } from '@/stores/user'
import type { AdminQueueVO } from '@/types/admin'
import AdminForbidden from './components/AdminForbidden.vue'
import AdminPageHead from './components/AdminPageHead.vue'
import AdminTabs from './components/AdminTabs.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/**
 * 队列名的中文短标签。
 * 队列名是 `codemind.xxx.queue.dead` 这种长名字，卡片标题直接用会很难扫；
 * 短标签只是**展示用**，卡片里同时保留完整队列名（mono 字体）——
 * 后者是拼接口 URL 的依据，**不做任何截断**。
 * 映射之外的队列名回退成「死信队列」，不会因为后端加队列就渲染不出来。
 */
const QUEUE_LABELS: Record<string, string> = {
  'codemind.cache.queue.dead': '文章缓存失效',
  'codemind.follow.notice.queue.dead': '关注通知',
  'codemind.like.notice.queue.dead': '点赞通知',
  'codemind.comment.notice.queue.dead': '评论通知',
  'codemind.arg.article-note.queue.dead': 'RAG 入库',
  'codemind.arg.update.article-note.queue.dead': 'RAG 更新',
}

function labelOf(queueName: string): string {
  return QUEUE_LABELS[queueName] ?? '死信队列'
}

/* ==================== 队列列表 ==================== */

const queues = ref<AdminQueueVO[]>([])
const loading = ref(true)
const error = ref(false)
const forbidden = ref(false)
/** 正在清空 / 重投的队列名（该卡片按钮转 loading，防重复点击） */
const busyQueue = ref<string | null>(null)

const isEmpty = computed(() => !loading.value && !error.value && queues.value.length === 0)
const totalBacklog = computed(() =>
  queues.value.reduce((sum, q) => sum + (q.messageCount ?? 0), 0),
)

async function loadQueues(opts: { silent?: boolean } = {}) {
  if (!userStore.isAdmin) {
    forbidden.value = true
    error.value = false
    loading.value = false
    queues.value = []
    return
  }

  // silent：动作后的「重新拉一次确认」，不要再把整页打回骨架屏
  if (!opts.silent) {
    loading.value = true
  }
  error.value = false

  try {
    queues.value = (await getAdminQueues()) ?? []
  } catch (err) {
    // 一律判 err.code，不判 HTTP 状态码
    if (err instanceof ApiError && err.code === 403) {
      forbidden.value = true
    } else {
      error.value = true
    }
    queues.value = []
  } finally {
    loading.value = false
  }
}

/* ==================== 展开看消息（状态放 URL，便于刷新/分享还原） ==================== */

const expandedQueue = computed(() => {
  const raw = route.query.queue
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() ? value.trim() : null
})

const messages = ref<string[]>([])
const messagesLoading = ref(false)
const messagesError = ref(false)

/**
 * 把原始消息渲染成可读文本。
 * 死信里的内容**不能假设是合法 JSON** —— parse 失败就原样显示，
 * 并把 `ok=false` 透出来给模板加个「非 JSON」标记。
 */
function renderMessage(raw: string): { ok: boolean; text: string } {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(raw), null, 2) }
  } catch {
    return { ok: false, text: raw }
  }
}

const displayMessages = computed(() =>
  messages.value.map((raw, index) => ({ index, ...renderMessage(raw) })),
)

async function loadMessages(queueName: string) {
  messagesLoading.value = true
  messagesError.value = false
  try {
    messages.value = (await getAdminQueueMessages(queueName)) ?? []
  } catch {
    messagesError.value = true
    messages.value = []
  } finally {
    messagesLoading.value = false
  }
}

function toggleExpand(queueName: string) {
  if (expandedQueue.value === queueName) {
    void router.replace({ name: RouteName.ADMIN_MQ, query: {} })
  } else {
    void router.replace({ name: RouteName.ADMIN_MQ, query: { queue: queueName } })
  }
}

/* ==================== 清空 / 重投 ==================== */

async function handleClear(queue: AdminQueueVO) {
  try {
    await ElMessageBox.confirm(
      `将永久删除该队列里的 ${queue.messageCount} 条消息，且不可恢复。`,
      `清空「${labelOf(queue.queueName)}」`,
      { confirmButtonText: '清空', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return // 用户取消
  }

  busyQueue.value = queue.queueName
  try {
    await clearAdminQueueMessages(queue.queueName)
    ElMessage.success('队列已清空')
    await loadQueues({ silent: true })
    if (expandedQueue.value === queue.queueName) await loadMessages(queue.queueName)
  } catch {
    /* 请求层已按 code 统一提示 */
  } finally {
    busyQueue.value = null
  }
}

async function handleReplay(queue: AdminQueueVO) {
  try {
    await ElMessageBox.confirm(
      '将把消息重新投递回原交换机，消费失败的会被再次打回死信队列。',
      `重投「${labelOf(queue.queueName)}」`,
      { confirmButtonText: '重投', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return // 用户取消
  }

  busyQueue.value = queue.queueName
  try {
    const replayed = await replayAdminQueue(queue.queueName)

    /*
     * ⚠️ 这里**不读 message 文本**（后端可能回「还剩 M 条，请再次执行」，
     *    按文本分支一改文案就失效）。正确判据是重新拉一次队列列表看 `messageCount`。
     */
    await loadQueues({ silent: true })
    const after = queues.value.find((item) => item.queueName === queue.queueName)
    const remaining = after?.messageCount ?? 0

    if (remaining > 0) {
      ElMessage.warning(`本次重投 ${replayed} 条，队列还剩 ${remaining} 条，请再次执行重投`)
    } else {
      ElMessage.success(`已重投 ${replayed} 条，队列已清空`)
    }

    // 展开态下同步刷新消息预览（重投后消息会少掉/变空）
    if (expandedQueue.value === queue.queueName) await loadMessages(queue.queueName)
  } catch {
    /* 请求层已按 code 统一提示 */
  } finally {
    busyQueue.value = null
  }
}

/* ==================== 副作用 ==================== */

watch(
  expandedQueue,
  (queueName) => {
    if (queueName) void loadMessages(queueName)
    else messages.value = []
  },
  { immediate: true },
)

// 首次进页面拉队列列表（展开态由上面的 watch 顺带处理）
onMounted(() => {
  void loadQueues()
})
</script>

<template>
  <div class="cm-admin cm-container">
    <AdminPageHead
      title="死信队列"
      description="6 个死信队列的积压与消费者情况。可展开查看消息原文、清空队列，或把消息重投回原交换机。"
    />

    <AdminTabs class="cm-admin__tabs" />

    <AdminForbidden v-if="forbidden" />

    <template v-else>
      <!-- 工具条 -->
      <div class="cm-mq-toolbar">
        <span class="cm-mq-toolbar__count">
          <template v-if="loading">加载中…</template>
          <template v-else>
            {{ queues.length }} 个队列 · 总积压
            <strong :class="{ 'is-zero': totalBacklog === 0 }">{{ totalBacklog }}</strong> 条
          </template>
        </span>
        <el-button size="small" plain :disabled="loading" @click="loadQueues()">
          <el-icon class="cm-mq-toolbar__icon"><Refresh /></el-icon>
          刷新
        </el-button>
      </div>

      <!-- 错误态：带重试 -->
      <ErrorState
        v-if="error"
        title="队列信息加载失败"
        description="可能是网络问题，或 RabbitMQ 未就绪"
        @retry="loadQueues()"
      />

      <LoadingState v-else-if="loading" variant="skeleton" :rows="4" />

      <EmptyState
        v-else-if="isEmpty"
        title="没有可用的死信队列"
        description="后端没有返回任何队列元数据"
        :size="80"
      />

      <!-- 6 个队列卡片 -->
      <div v-else class="cm-mq-grid">
        <section
          v-for="queue in queues"
          :key="queue.queueName"
          class="cm-mq-card"
          :class="{
            'is-expanded': expandedQueue === queue.queueName,
            'is-backlog': (queue.messageCount ?? 0) > 0,
          }"
        >
          <header class="cm-mq-card__head">
            <div class="cm-mq-card__titles">
              <h2 class="cm-mq-card__label">{{ labelOf(queue.queueName) }}</h2>
              <!-- 完整队列名：拼接口 URL 的依据，绝不截断 -->
              <p class="cm-mq-card__name cm-text-mono">{{ queue.queueName }}</p>
            </div>
          </header>

          <dl class="cm-mq-card__stats">
            <div class="cm-mq-stat">
              <dt class="cm-mq-stat__label">积压</dt>
              <dd
                class="cm-mq-stat__value"
                :class="{ 'is-zero': (queue.messageCount ?? 0) === 0 }"
                :data-backlog="queue.queueName"
              >
                {{ queue.messageCount ?? 0 }}
              </dd>
            </div>
            <div class="cm-mq-stat">
              <dt class="cm-mq-stat__label">消费者</dt>
              <dd class="cm-mq-stat__value" :data-consumers="queue.queueName">
                {{ queue.consumerCount ?? 0 }}
              </dd>
            </div>
          </dl>

          <div class="cm-mq-card__actions">
            <el-button size="small" plain @click="toggleExpand(queue.queueName)">
              {{ expandedQueue === queue.queueName ? '收起消息' : '查看消息' }}
            </el-button>
            <el-button
              size="small"
              plain
              :loading="busyQueue === queue.queueName"
              @click="handleReplay(queue)"
            >
              重投
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :loading="busyQueue === queue.queueName"
              @click="handleClear(queue)"
            >
              清空
            </el-button>
          </div>

          <!-- 展开：消息预览 -->
          <div v-if="expandedQueue === queue.queueName" class="cm-mq-card__messages">
            <LoadingState v-if="messagesLoading" text="读取消息中" />

            <ErrorState
              v-else-if="messagesError"
              title="消息读取失败"
              description="队列消息暂时取不到"
              @retry="loadMessages(queue.queueName)"
            />

            <EmptyState
              v-else-if="displayMessages.length === 0"
              title="队列里没有消息"
              description="积压为 0，无需清理或重投"
              :size="64"
            />

            <template v-else>
              <p class="cm-mq-card__messages-head">
                共 {{ displayMessages.length }} 条消息（消息原文，不分页）
              </p>
              <ol class="cm-mq-messages">
                <li v-for="msg in displayMessages" :key="msg.index" class="cm-mq-message">
                  <div class="cm-mq-message__head">
                    <span class="cm-mq-message__index">#{{ msg.index + 1 }}</span>
                    <!-- parse 失败的降级标记：让管理员知道这条不是合法 JSON -->
                    <span v-if="!msg.ok" class="cm-badge cm-badge--warning">非 JSON</span>
                    <span v-else class="cm-badge cm-badge--success">JSON</span>
                  </div>
                  <pre class="cm-mq-message__body cm-text-mono">{{ msg.text }}</pre>
                </li>
              </ol>
            </template>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cm-admin {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

/* ==================== 页头 ====================
 * 已抽成 `components/AdminPageHead.vue`（T21）—— 原来这里有一份内联的
 * `.cm-admin__eyebrow / __title / __desc`，四个管理页各抄了一遍。
 */
.cm-admin__tabs {
  margin-top: var(--cm-space-6);
}

/* ==================== 工具条 ==================== */
.cm-mq-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-4);
  margin-top: var(--cm-space-6);
  padding-bottom: var(--cm-space-4);
}

.cm-mq-toolbar__count {
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

.cm-mq-toolbar__count strong {
  font-size: var(--cm-font-size-md);
  font-variant-numeric: tabular-nums;
  color: var(--cm-text-primary);
}

.cm-mq-toolbar__count strong.is-zero {
  color: var(--cm-text-quaternary);
}

.cm-mq-toolbar__icon {
  margin-right: 4px;
}

/* ==================== 卡片栅格 ==================== */
.cm-mq-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--cm-space-4);
  align-items: start;
}

.cm-mq-card {
  padding: var(--cm-space-5);
  background-color: var(--cm-bg-surface);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-xl);
  transition: border-color 0.15s ease;
}

.cm-mq-card:hover {
  border-color: var(--cm-border-default);
}

/* 有积压的队列给一条左侧色条，扫一眼就能找到 */
.cm-mq-card.is-backlog {
  border-left: 3px solid var(--cm-warning);
}

.cm-mq-card.is-expanded {
  grid-column: 1 / -1;
  border-color: var(--cm-accent-300);
}

.cm-mq-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--cm-space-3);
}

.cm-mq-card__label {
  margin: 0;
  font-size: var(--cm-font-size-md);
  font-weight: 600;
  color: var(--cm-text-primary);
}

.cm-mq-card__name {
  margin: var(--cm-space-1) 0 0;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  word-break: break-all;
}

/* ==================== 统计 ==================== */
.cm-mq-card__stats {
  display: flex;
  gap: var(--cm-space-8);
  margin: var(--cm-space-4) 0 0;
}

.cm-mq-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cm-mq-stat__label {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-mq-stat__value {
  margin: 0;
  font-size: var(--cm-font-size-xl);
  font-weight: 650;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--cm-text-primary);
}

/* 积压为 0 是常态，弱化即可，不是空态 */
.cm-mq-stat__value.is-zero {
  color: var(--cm-text-quaternary);
}

/* ==================== 操作 ==================== */
.cm-mq-card__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  margin-top: var(--cm-space-4);
}

.cm-mq-card__actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

/* ==================== 消息预览 ==================== */
.cm-mq-card__messages {
  margin-top: var(--cm-space-5);
  padding-top: var(--cm-space-4);
  border-top: 1px dashed var(--cm-border-default);
}

.cm-mq-card__messages-head {
  margin: 0 0 var(--cm-space-3);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-mq-messages {
  display: flex;
  flex-direction: column;
  gap: var(--cm-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.cm-mq-message {
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
  overflow: hidden;
}

.cm-mq-message__head {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  padding: var(--cm-space-2) var(--cm-space-3);
  background-color: var(--cm-bg-subtle);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-mq-message__index {
  font-family: var(--cm-font-mono);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-mq-message__body {
  margin: 0;
  padding: var(--cm-space-3);
  font-size: var(--cm-font-size-xs);
  line-height: 1.65;
  color: var(--cm-text-secondary);
  background-color: var(--cm-bg-surface);
  /* 长消息横向滚动，不要把卡片撑破 */
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 260px;
  overflow-y: auto;
}

/* ==================== 标签 ==================== */
.cm-badge {
  display: inline-block;
  padding: 1px 7px;
  font-size: var(--cm-font-size-xs);
  line-height: 18px;
  white-space: nowrap;
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-surface);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-sm);
}

.cm-badge--success {
  color: var(--cm-success);
  background-color: var(--cm-success-bg);
  border-color: var(--cm-success-border);
}

.cm-badge--warning {
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border-color: var(--cm-warning-border);
  font-weight: 500;
}

/* ==================== 响应式 ==================== */
@media (max-width: 860px) {
  .cm-mq-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
