<script setup lang="ts">
/**
 * 消息通知页。
 *
 * 接口：4.1 列表（分页，可选 type 筛选）/ 4.2 未读数 / 4.3 标记已读 /
 *       4.4 全部已读 / 删除单条 `DELETE /api/notify/deleteMessage/{id}`。
 *
 * 五个关键设计：
 * 1. **类型筛选走 URL（`?type=1|2|3`）。** 筛选是**在库上做**的，不是只过滤当前页；
 *    状态放 URL 而不是组件内部，刷新 / 分享链接都能复现同一个视图；**切换筛选一律回到第 1 页**。
 *
 * 2. **点击即已读（乐观更新）。** 先本地置为已读并让未读数减一，再发请求；失败回滚。
 *
 * 3. **文案直接用后端拼好的 `content`**，前端不自己组织句子（否则会与后端不一致）。
 *
 * 4. **目标可能已被删除。** 通知是流水账，不随文章 / 评论撤销；后端用
 *    `articleDeleted` / `commentDeleted` 标记，前端据此**只提示、不跳转**（否则会撞 404）。
 *    失效通知**同样算未读**，点击时照常调 4.3。
 *    提示分两层：toast 说「内容已删除」，条目上常驻说明是哪一个没了。
 *    type=2 两个标记都要看；type=3 恒为 false。
 *
 * 5. **删除一条通知。** 二次确认 + 乐观移除（失败插回**原下标**）+ 精确还原。
 *    ⚠️ 删掉未读通知要让未读数 -1（后端会一并处理），否则 Header 红点会多算一条。
 *    404「消息不存在」按已删除处理（幂等），不回滚。
 *
 * 跳转：带 articleId 跳文章详情；再带 commentId 时附锚点 `#comment-{id}`，
 * 详情页会滚到那条评论并高亮。目标已失效则不跳。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { deleteNotify, getNotifyList, markAllNotifyRead, markNotifyRead } from '@/api/notify'
import { ApiError } from '@/api/request'
import { useUserStore } from '@/stores/user'
import { RouteName } from '@/router/routes-names'
import { NotifyReadStatus, NotifyType } from '@/types/notify'
import type { NotifyVO } from '@/types/notify'
import { formatRelativeTime } from '@/utils/format'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/** 文档限定 size 最大 50，取 20 兼顾信息量与首屏速度 */
const PAGE_SIZE = 20

/* ==================== URL 派生状态 ==================== */

/** 类型筛选的取值：`all` 表示不传 type（全部） */
type FilterKey = 'all' | NotifyType

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: NotifyType.LIKE, label: '点赞' },
  { key: NotifyType.COMMENT, label: '评论' },
  { key: NotifyType.FOLLOW, label: '关注' },
]

const page = computed(() => {
  const raw = route.query.page
  const v = Array.isArray(raw) ? raw[0] : raw
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 1
})

/** 当前类型筛选：非法值一律回落到「全部」（手改 URL 不会把页面搞坏） */
const activeFilter = computed<FilterKey>(() => {
  const raw = route.query.type
  const v = Array.isArray(raw) ? raw[0] : raw
  const n = Number(v)
  return n === NotifyType.LIKE || n === NotifyType.COMMENT || n === NotifyType.FOLLOW ? n : 'all'
})

/**
 * 构造 query 的唯一出口（与列表页同一约定：**默认值不写进 URL**）。
 * 这样「全部 + 第 1 页」就是干净的 `/notifications`，分享出去的链接不带噪音。
 */
function buildQuery(next: { filter?: FilterKey; page?: number }): Record<string, string> {
  const filter = next.filter ?? activeFilter.value
  const nextPage = next.page ?? page.value
  const query: Record<string, string> = {}
  if (filter !== 'all') query.type = String(filter)
  if (nextPage > 1) query.page = String(nextPage)
  return query
}

/**
 * 切换类型筛选。
 * **一律回到第 1 页** —— 换了筛选还停在第 3 页，多半会看到空列表。
 */
function switchFilter(next: FilterKey) {
  if (next === activeFilter.value) return
  void router.push({ name: RouteName.NOTIFICATIONS, query: buildQuery({ filter: next, page: 1 }) })
}

function changePage(next: number) {
  void router.push({ name: RouteName.NOTIFICATIONS, query: buildQuery({ page: next }) })
}

/* ==================== 类型元信息 ==================== */

interface TypeMeta {
  icon: string
  label: string
  /** 附加在根节点上的类名，用于着色 */
  modifier: string
}

function typeMeta(type: NotifyType): TypeMeta {
  switch (type) {
    case NotifyType.LIKE:
      return { icon: 'Star', label: '点赞', modifier: 'is-like' }
    case NotifyType.COMMENT:
      return { icon: 'ChatDotRound', label: '评论', modifier: 'is-comment' }
    case NotifyType.FOLLOW:
      return { icon: 'User', label: '关注', modifier: 'is-follow' }
    default:
      // 后端未来新增类型时不至于渲染成空白
      return { icon: 'Bell', label: '通知', modifier: 'is-other' }
  }
}

/* ==================== 列表数据 ==================== */

const list = ref<NotifyVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)

/** 请求序号：丢弃过期响应 */
let requestSeq = 0

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

/** 空态文案随筛选变化 —— 「一条消息都没有」和「没有点赞消息」是两回事 */
const emptyText = computed(() => {
  const hit = FILTERS.find((f) => f.key === activeFilter.value)
  return activeFilter.value === 'all'
    ? { title: '还没有消息', desc: '有人点赞、评论或关注你时，消息会出现在这里' }
    : { title: `没有${hit?.label ?? ''}消息`, desc: `暂时没有人与你有「${hit?.label ?? ''}」相关的互动` }
})

async function loadNotifies() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const res = await getNotifyList({
      page: page.value,
      size: PAGE_SIZE,
      // 不传 type = 全部（后端向后兼容；也避免把 `type=all` 这种非法值发出去）
      ...(activeFilter.value === 'all' ? {} : { type: activeFilter.value }),
    })

    if (seq !== requestSeq) return

    list.value = res.records ?? []
    total.value = res.total ?? 0
  } catch {
    if (seq !== requestSeq) return
    error.value = true
    list.value = []
    total.value = 0
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/* ==================== 标记已读 ==================== */

/** 处理中的通知 id */
const pendingIds = ref<Set<number>>(new Set())

function setPending(id: number, on: boolean) {
  const next = new Set(pendingIds.value)
  if (on) next.add(id)
  else next.delete(id)
  pendingIds.value = next
}

/**
 * 标记单条已读。
 * 已读的不重复请求（4.3 虽然幂等，但没必要多打一次接口）。
 *
 * @returns 是否已经「成功置为已读」—— 调用方（handleClick）要靠它决定要不要继续往下走。
 *   已经读过 / 正在请求中 → `true`（没什么可做，但状态是对的）；
 *   请求失败 → `false`（状态已回滚，调用方不该再拿旧数据做判断）。
 */
async function markRead(item: NotifyVO): Promise<boolean> {
  if (item.isRead === NotifyReadStatus.READ || pendingIds.value.has(item.id)) return true

  setPending(item.id, true)
  // 乐观更新
  const prevUnread = userStore.unreadCount
  item.isRead = NotifyReadStatus.READ
  userStore.decrementUnreadCount()

  try {
    await markNotifyRead(item.id)
    return true
  } catch {
    /*
     * 回滚。用**快照精确还原**，而不是 `fetchUnreadCount()` 重新拉一次 ——
     * 因为「标已读失败」最常见的成因就是断网，而断网时重新拉未读数**也会失败**，
     * 未读数就永久停在「乐观 -1」的错误值上，再也回不来（T9 验收 4 正是测这个）。
     *
     * 失败提示由请求层统一给出（约定 D：页面不重复弹）。
     */
    item.isRead = NotifyReadStatus.UNREAD
    userStore.$patch({ unreadCount: prevUnread })
    return false
  } finally {
    setPending(item.id, false)
  }
}

/** 全部已读 */
const markingAll = ref(false)

async function handleMarkAll() {
  if (markingAll.value) return

  try {
    await ElMessageBox.confirm('确定把全部消息标记为已读吗？', '全部已读', {
      confirmButtonText: '全部已读',
      cancelButtonText: '取消',
      type: 'info',
    })
  } catch {
    return // 用户取消
  }

  markingAll.value = true
  const snapshot = list.value.map((item) => item.isRead)
  const prevUnread = userStore.unreadCount

  // 乐观更新：先把当前页全部置为已读，并清零红点
  list.value.forEach((item) => {
    item.isRead = NotifyReadStatus.READ
  })
  userStore.clearUnreadCount()

  try {
    await markAllNotifyRead()
    ElMessage.success('已全部标记为已读')
  } catch {
    // 回滚当前页的标记与红点（同样用快照还原，理由见 markRead 里的注释）
    list.value.forEach((item, index) => {
      const value = snapshot[index]
      if (value !== undefined) item.isRead = value
    })
    userStore.$patch({ unreadCount: prevUnread })
  } finally {
    markingAll.value = false
  }
}

/* ==================== 删除单条 ==================== */

/** 正在删除中的通知 id（防重复点击 + 按钮转圈） */
const deletingIds = ref<Set<number>>(new Set())

function setDeleting(id: number, on: boolean) {
  const next = new Set(deletingIds.value)
  if (on) next.add(id)
  else next.delete(id)
  deletingIds.value = next
}

/**
 * 删除一条通知：二次确认 → 乐观移除 → 失败精确还原。
 *
 * ⚠️ 两个容易漏的点：
 *   1. **删掉未读通知会让未读数 -1**（后端会一并处理）→ 本地必须同步减一，
 *      否则 Header 红点会一直多算一条，直到下次刷新。
 *   2. 回滚要**插回原下标**（`splice(index, 0, item)`），不是 push 回末尾 ——
 *      通知是**按时间倒序**的流水账，顺序错乱比丢一条更难发现。
 */
async function handleDelete(item: NotifyVO) {
  if (deletingIds.value.has(item.id)) return

  try {
    await ElMessageBox.confirm('删除后不可恢复，确定删除这条消息吗？', '删除消息', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }

  const index = list.value.findIndex((n) => n.id === item.id)
  if (index < 0) return

  setDeleting(item.id, true)

  // 快照：失败时精确还原（不靠重新拉列表 —— 断网时重拉也会失败）
  const prevUnread = userStore.unreadCount
  const prevTotal = total.value
  const wasUnread = item.isRead === NotifyReadStatus.UNREAD

  // 乐观：移除 + 未读数 / 总数联动
  list.value.splice(index, 1)
  total.value = Math.max(0, prevTotal - 1)
  if (wasUnread) userStore.decrementUnreadCount()

  try {
    await deleteNotify(item.id)
    ElMessage.success('已删除')
    // 删完这一页的最后一条且不在第 1 页 → 退回上一页，别停在空列表上
    if (list.value.length === 0 && page.value > 1) changePage(page.value - 1)
  } catch (err) {
    /*
     * 404「消息不存在」= 本来就已经没了 → 按**成功**处理（幂等），不回滚：
     * 用户的目标状态（这条没了）已经达成，再弹个错只会让人困惑。
     */
    if (err instanceof ApiError && err.code === 404) {
      ElMessage.success('已删除')
    } else {
      list.value.splice(index, 0, item)
      total.value = prevTotal
      if (wasUnread) userStore.$patch({ unreadCount: prevUnread })
    }
  } finally {
    setDeleting(item.id, false)
  }
}

/* ==================== 跳转 ==================== */

/**
 * 点击一条通知：先标记已读，再按关联字段跳转。
 *
 * 顺序很重要：**无论目标是否还在，都要先标记已读**。失效通知也算未读，
 * 如果因为「已删除」就跳过 4.3，它会永远卡在未读，未读数再也降不下去。
 *
 * 目标已失效时不跳转，只给提示，避免撞上文章详情的 404。
 * 没有 articleId 的（例如「被关注」）只标记已读，不做跳转。
 */
async function handleClick(item: NotifyVO) {
  const ok = await markRead(item)

  /*
   * 标记失败就直接结束。此时：
   *   - 状态已经回滚，用户看到的是「请求层」那条网络错误提示（约定 D）；
   *   - 再补一句「内容已删除」会误导 —— 用户以为是「点了才知道删了」，
   *     实际只是这次请求没发出去；而且会同时弹两条提示，噪音很大。
   */
  if (!ok) return

  // 失效就到此为止：只提示、不跳转（具体是哪一个失效，看条目上的常驻原因）
  if (invalidReason(item)) {
    ElMessage.warning('内容已删除')
    return
  }

  if (item.articleId === null || item.articleId === undefined) return

  const hash = item.commentId !== null && item.commentId !== undefined
    ? `#comment-${item.commentId}`
    : undefined

  void router.push({
    name: RouteName.ARTICLE_DETAIL,
    params: { id: String(item.articleId) },
    hash,
  })
}

/**
 * 目标失效的原因；没失效返回空串。
 *
 * type=2 的**两个标记都要看**：既可能「文章被删（评论连带没了）」，
 * 也可能「文章还在、只是那条评论被删了」—— 后者文章详情仍可访问，
 * 但本页仍然不跳（用户点的是「评论」通知，跳过去却找不到那条评论更困惑）。
 * type=3 关注通知无关联目标，两个标记恒为 false。
 *
 * `articleDeleted` / `commentDeleted` 是后端旧版本可能不返回的可选字段，
 * 缺失时为 `undefined`（falsy），按「还在」处理，向后兼容。
 */
function invalidReason(item: NotifyVO): string {
  if (item.articleDeleted) return '相关文章已被删除'
  if (item.commentDeleted) return '相关评论已被删除'
  return ''
}


function goCommunity() {
  void router.push({ name: RouteName.ARTICLE_LIST })
}

/* ==================== 副作用 ==================== */

watch([page, activeFilter], () => void loadNotifies(), { immediate: true })

// 进页面时校准一次未读数：可能在别的标签页里已经读过了
void userStore.fetchUnreadCount()
</script>

<template>
  <div class="cm-container cm-notify">
    <!-- ==================== 页头 ==================== -->
    <header class="cm-notify__head">
      <div>
        <h1 class="cm-notify__title">消息</h1>
        <p class="cm-notify__subtitle">
          <template v-if="userStore.unreadCount > 0">
            有 <strong>{{ userStore.unreadCount }}</strong> 条未读
          </template>
          <template v-else>没有未读消息</template>
          <span class="cm-notify__total">· 共 {{ total }} 条</span>
        </p>
      </div>

      <el-button
        size="small"
        :disabled="userStore.unreadCount === 0 || loading || error"
        :loading="markingAll"
        @click="handleMarkAll"
      >
        <el-icon class="cm-notify__btn-icon"><Select /></el-icon>
        全部已读
      </el-button>
    </header>

    <!-- ==================== 类型筛选 ====================
         由 URL 的 ?type= 驱动（见 activeFilter），刷新/分享可复现同一个筛选。
         用与社区列表同一套 .cm-tabs 视觉语言。
    -->
    <div class="cm-tabs" role="tablist" aria-label="消息类型筛选">
      <button
        v-for="f in FILTERS"
        :key="String(f.key)"
        type="button"
        role="tab"
        class="cm-tabs__item"
        :class="{ 'is-active': activeFilter === f.key }"
        :aria-selected="activeFilter === f.key"
        @click="switchFilter(f.key)"
      >
        {{ f.label }}
      </button>
    </div>

    <!-- ==================== 列表 ==================== -->
    <div class="cm-notify__body">
      <LoadingState v-if="loading" variant="skeleton" :rows="6" />

      <ErrorState
        v-else-if="error"
        title="消息加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="loadNotifies"
      />

      <EmptyState
        v-else-if="isEmpty"
        :title="emptyText.title"
        :description="emptyText.desc"
        :size="80"
      >
        <el-button type="primary" plain size="small" @click="goCommunity">去社区逛逛</el-button>
      </EmptyState>

      <ul v-else class="cm-notify__list">
        <li v-for="item in list" :key="item.id">
          <article
            class="cm-notify__item"
            :class="[typeMeta(item.type).modifier, { 'is-unread': item.isRead === NotifyReadStatus.UNREAD }]"
            role="button"
            tabindex="0"
            @click="handleClick(item)"
            @keydown.enter="handleClick(item)"
          >
            <!-- 类型图标 -->
            <span class="cm-notify__icon" aria-hidden="true">
              <el-icon :size="15"><component :is="typeMeta(item.type).icon" /></el-icon>
            </span>

            <!-- 触发人头像 -->
            <el-avatar
              :size="34"
              :src="item.fromUser?.avatar || undefined"
              class="cm-notify__avatar"
            >
              {{ item.fromUser?.userName?.charAt(0) ?? '?' }}
            </el-avatar>

            <div class="cm-notify__main">
              <p class="cm-notify__content">
                <!-- 文案由后端拼接，前端直接展示 -->
                {{ item.content }}
              </p>

              <div class="cm-notify__meta">
                <span class="cm-notify__type">{{ typeMeta(item.type).label }}</span>
                <span class="cm-notify__sep">·</span>
                <time>{{ formatRelativeTime(item.createTime) }}</time>
                <!--
                  目标失效：常驻显示**是哪一个**没了。
                  toast 只负责说「内容已删除」，具体原因留在条目上，翻回去还看得到。
                -->
                <template v-if="invalidReason(item)">
                  <span class="cm-notify__sep">·</span>
                  <span class="cm-notify__invalid">{{ invalidReason(item) }}</span>
                </template>
                <!-- 目标还在才显示「查看详情」，避免暗示可跳转 -->
                <template v-else-if="item.articleId !== null && item.articleId !== undefined">
                  <span class="cm-notify__sep">·</span>
                  <span class="cm-notify__link">查看详情</span>
                </template>
              </div>
            </div>

            <!-- 未读点 -->
            <span
              v-if="item.isRead === NotifyReadStatus.UNREAD"
              class="cm-notify__dot"
              aria-label="未读"
            />

            <!--
              删除按钮。
              ⚠️ 必须 `.stop`：条目本身是「点击 = 标记已读 + 跳转」，
              不加就会「点删除顺手把这条标成已读并跳走」。
              keydown 也要 stop —— 按钮聚焦时按 Enter，keydown 会冒泡到条目上。
            -->
            <button
              type="button"
              class="cm-notify__del"
              :disabled="deletingIds.has(item.id)"
              aria-label="删除这条消息"
              title="删除"
              @click.stop="handleDelete(item)"
              @keydown.enter.stop
            >
              <el-icon :size="14"><Delete /></el-icon>
            </button>
          </article>
        </li>
      </ul>
    </div>

    <!-- ==================== 分页 ==================== -->
    <div v-if="!loading && !error && total > PAGE_SIZE" class="cm-notify__pager">
      <el-pagination
        background
        layout="prev, pager, next"
        :total="total"
        :page-size="PAGE_SIZE"
        :current-page="page"
        :hide-on-single-page="true"
        @current-change="changePage"
      />
    </div>
  </div>
</template>

<style scoped>
.cm-notify {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

/* ==================== 页头 ==================== */
.cm-notify__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--cm-space-6);
  padding-bottom: var(--cm-space-5);
}

.cm-notify__title {
  margin: 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-notify__subtitle {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

.cm-notify__subtitle strong {
  font-weight: 600;
  color: var(--cm-danger);
}

.cm-notify__total {
  color: var(--cm-text-quaternary);
}

.cm-notify__btn-icon {
  margin-right: 4px;
}

/* ==================== 类型筛选 ====================
 * 与社区列表、个人主页的 tab 用同一套类名与视觉（下划线压在容器边框上）。
 * ⚠️ 这套样式目前是**每个页面各抄一份**（ArticleListView / ProfileArticlesTab /
 *    ProfileNotesTab + 本页）。抽成公共组件更干净，但那要动 3 个范围外文件，
 *    不在 T14 范围内 —— 已记进交接块。
 */
.cm-tabs {
  display: flex;
  align-items: center;
  gap: var(--cm-space-1);
  margin-bottom: var(--cm-space-4);
  border-bottom: 1px solid var(--cm-border-default);
}

.cm-tabs__item {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  padding: var(--cm-space-3) var(--cm-space-4);
  font-family: inherit;
  font-size: var(--cm-font-size-base);
  color: var(--cm-text-tertiary);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-tabs__item:hover {
  color: var(--cm-text-primary);
}

.cm-tabs__item.is-active {
  color: var(--cm-text-primary);
  font-weight: 600;
}

.cm-tabs__item::after {
  content: '';
  position: absolute;
  left: var(--cm-space-3);
  right: var(--cm-space-3);
  bottom: -1px;
  height: 2px;
  background-color: var(--cm-accent-600);
  border-radius: var(--cm-radius-full);
  transform: scaleX(0);
  transition: transform 0.2s var(--cm-ease-out);
}

.cm-tabs__item.is-active::after {
  transform: scaleX(1);
}

/* ==================== 列表 ==================== */
.cm-notify__body {
  min-height: 240px;
}

.cm-notify__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
  overflow: hidden;
  background-color: var(--cm-bg-surface);
}

.cm-notify__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  padding: var(--cm-space-4) var(--cm-space-5);
  border-bottom: 1px solid var(--cm-border-subtle);
  cursor: pointer;
  outline: none;
  transition: background-color 0.15s ease;
}

.cm-notify__item:last-child {
  border-bottom: none;
}

.cm-notify__item:hover {
  background-color: var(--cm-bg-hover);
}

.cm-notify__item:focus-visible {
  box-shadow: inset 0 0 0 2px var(--cm-accent-300);
}

/* 未读：左侧强调竖条 */
.cm-notify__item.is-unread::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background-color: var(--cm-accent-500);
}

/* ---------- 类型图标 ---------- */
.cm-notify__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: var(--cm-radius-md);
}

.cm-notify__item.is-like .cm-notify__icon {
  color: var(--cm-accent-600);
  background-color: var(--cm-accent-50);
}

.cm-notify__item.is-comment .cm-notify__icon {
  color: var(--cm-success);
  background-color: var(--cm-success-bg);
}

.cm-notify__item.is-follow .cm-notify__icon {
  color: var(--cm-info);
  background-color: var(--cm-info-bg);
}

.cm-notify__item.is-other .cm-notify__icon {
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-sunken);
}

.cm-notify__avatar {
  flex-shrink: 0;
  font-size: var(--cm-font-size-xs);
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

/* ---------- 内容 ---------- */
.cm-notify__main {
  flex: 1;
  min-width: 0;
}

.cm-notify__content {
  margin: 0;
  font-size: var(--cm-font-size-base);
  line-height: 1.6;
  color: var(--cm-text-secondary);
}

/* 未读文案加深，已读淡化，形成清晰的主次 */
.cm-notify__item.is-unread .cm-notify__content {
  font-weight: 500;
  color: var(--cm-text-primary);
}

.cm-notify__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  margin-top: var(--cm-space-1);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-notify__sep {
  color: var(--cm-border-strong);
}

.cm-notify__link {
  color: var(--cm-text-link);
}

/* 目标已删除：用弱化的警示色，明确区别于可点击的「查看详情」 */
.cm-notify__invalid {
  color: var(--cm-warning);
}

.cm-notify__item:hover .cm-notify__link {
  text-decoration: underline;
}

/* ---------- 未读点 ---------- */
.cm-notify__dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--cm-danger);
}

/*
 * 删除按钮：常驻但低存在感（灰），hover 才转成危险色。
 * 刻意不做「hover 才显示」—— 触屏上没有 hover，用户会根本找不到入口。
 */
.cm-notify__del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--cm-text-quaternary);
  background: none;
  border: none;
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.cm-notify__del:hover:not(:disabled) {
  color: var(--cm-danger);
  background-color: var(--cm-danger-bg);
}

.cm-notify__del:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

/* ==================== 分页 ==================== */
.cm-notify__pager {
  display: flex;
  justify-content: center;
  padding-top: var(--cm-space-8);
}

/* ==================== 响应式 ==================== */
@media (max-width: 560px) {
  .cm-notify__head {
    flex-direction: column;
    align-items: stretch;
    gap: var(--cm-space-3);
  }

  .cm-notify__item {
    padding: var(--cm-space-4);
  }

  .cm-notify__icon {
    display: none;
  }
}
</style>
