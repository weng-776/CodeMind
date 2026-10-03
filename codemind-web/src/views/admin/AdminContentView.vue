<script setup lang="ts">
/**
 * 管理后台 · 内容治理
 * ------------------------------------------------------------------
 * 三个 tab（文章 / 笔记 / 评论），各自筛选 + 分页 + 下架/恢复/删除。
 * 接口（设计说明 §2.3，8 个）：
 *   GET    /api/admin/articles?page&size&keyword&status
 *   PUT    /api/admin/articles/{articleId}/status?status=0|1
 *   DELETE /api/admin/articles/{articleId}
 *   GET    /api/admin/notes?page&size&keyword&status&visibility
 *   PUT    /api/admin/notes/{noteId}/status?status=0|1
 *   DELETE /api/admin/notes/{noteId}
 *   GET    /api/admin/comments?page&size&articleId&keyword
 *   DELETE /api/admin/comments/{commentId}
 *
 * 关键设计：
 *   1. **URL 即唯一事实来源**：`tab` / `page` / `keyword` / `status` / `visibility` /
 *      `articleId` 全部由 `route.query` 派生，`buildQuery()` 是唯一出口。
 *      切 tab 会**清空筛选并回到第 1 页**，避免「在文章里筛了草稿，切到评论还带着」的错乱。
 *   2. **管理端是全量视角**：文章列表**含草稿**、笔记列表**含草稿与私密**。
 *      这是设计意图而非越权（实测 `notes?visibility=0` 能拿到私密笔记），
 *      但页面**必须把「草稿 / 私密」标出来**，否则管理员会误以为内容已公开（§7 坑 4）。
 *   3. **删除不可逆**：一律二次确认，且文案**如实说明后果**（§3.2）。
 *      文章的后果最重：连带删标签/评论/点赞/收藏，并从热门榜与向量库移除。
 *   4. **列表 VO 不含正文 `content`**：这是刻意设计（正文是长文本），
 *      所以列表只展示 `summary`，不要以为字段缺失（§7 坑 3）。
 *   5. **改动后重新拉列表**，不做本地乐观更新 —— 带着 `status` 筛选时，
 *      下架后的行必须从当前视图消失，本地 patch 做不到这一点。
 *
 * ⚠️ 页头与表格样式与 AdminDashboardView / AdminUserView 是**刻意的重复**：
 *    `.vue` 的 `<style scoped>` 不能跨文件复用，而本单范围只允许新增本文件。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import EmptyState from '@/components/common/EmptyState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import {
  deleteAdminArticle,
  deleteAdminComment,
  deleteAdminNote,
  getAdminArticles,
  getAdminComments,
  getAdminNotes,
  updateAdminArticleStatus,
  updateAdminNoteStatus,
} from '@/api/admin'
import { ApiError } from '@/api/request'
import { RouteName } from '@/router/routes-names'
import { useUserStore } from '@/stores/user'
import type {
  AdminArticleVO,
  AdminCommentVO,
  AdminNoteVO,
} from '@/types/admin'
import type { PageResult } from '@/types/common'
import AdminArticleTable from './components/AdminArticleTable.vue'
import AdminCommentTable from './components/AdminCommentTable.vue'
import AdminForbidden from './components/AdminForbidden.vue'
import AdminNoteTable from './components/AdminNoteTable.vue'
import AdminPageHead from './components/AdminPageHead.vue'
import AdminTabs from './components/AdminTabs.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/** 每页条数（后端上限 50） */
const PAGE_SIZE = 10
const SEARCH_DEBOUNCE_MS = 300

type ContentTab = 'article' | 'note' | 'comment'

const TABS: { key: ContentTab; label: string; hint: string }[] = [
  { key: 'article', label: '文章', hint: '含草稿，全量视角' },
  { key: 'note', label: '笔记', hint: '含草稿与私密，全量视角' },
  { key: 'comment', label: '评论', hint: '含一级评论与回复' },
]

/** 文章状态：0=草稿/下架 1=公开 */
const ARTICLE_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: '1', label: '公开' },
  { value: '0', label: '草稿' },
]
/** 笔记状态：0=草稿 1=正常 */
const NOTE_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: '1', label: '正常' },
  { value: '0', label: '草稿' },
]
/** 笔记可见性：0=私密 1=公开 */
const VISIBILITY_OPTIONS = [
  { value: '', label: '全部' },
  { value: '1', label: '公开' },
  { value: '0', label: '私密' },
]

/* ==================== URL 派生状态 ==================== */

function readStr(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw.trim() : ''
}

const tab = computed<ContentTab>(() => {
  const value = readStr(route.query.tab)
  return value === 'note' || value === 'comment' ? value : 'article'
})

const page = computed(() => {
  const n = Number(readStr(route.query.page))
  return Number.isInteger(n) && n > 0 ? n : 1
})

const keyword = computed(() => readStr(route.query.keyword))

/** 状态筛选：只认 '0' / '1'，其它一律视为「全部」 */
const statusFilter = computed(() => {
  const value = readStr(route.query.status)
  return value === '0' || value === '1' ? value : ''
})

const visibilityFilter = computed(() => {
  const value = readStr(route.query.visibility)
  return value === '0' || value === '1' ? value : ''
})

/** 评论 tab 的「按文章 ID 筛选」 */
const articleIdFilter = computed<number | null>(() => {
  const n = Number(readStr(route.query.articleId))
  return Number.isInteger(n) && n > 0 ? n : null
})

/** 当前 tab 用的状态选项 */
const statusOptions = computed(() =>
  tab.value === 'note' ? NOTE_STATUS_OPTIONS : ARTICLE_STATUS_OPTIONS,
)

/** 构造查询串的唯一出口；默认值（tab=article / page=1 / 空筛选）不写进 URL */
function buildQuery(next: {
  tab?: ContentTab
  page?: number
  keyword?: string
  status?: string
  visibility?: string
  articleId?: number | null
}): Record<string, string> {
  const nextTab = next.tab ?? tab.value
  const query: Record<string, string> = {}

  if (nextTab !== 'article') query.tab = nextTab

  const nextKeyword = next.keyword !== undefined ? next.keyword : keyword.value
  if (nextKeyword) query.keyword = nextKeyword

  if (nextTab === 'article' || nextTab === 'note') {
    const nextStatus = next.status !== undefined ? next.status : statusFilter.value
    if (nextStatus) query.status = nextStatus
  }

  if (nextTab === 'note') {
    const nextVisibility = next.visibility !== undefined ? next.visibility : visibilityFilter.value
    if (nextVisibility) query.visibility = nextVisibility
  }

  if (nextTab === 'comment') {
    const nextArticleId = next.articleId !== undefined ? next.articleId : articleIdFilter.value
    if (nextArticleId !== null && nextArticleId !== undefined) {
      query.articleId = String(nextArticleId)
    }
  }

  const nextPage = next.page ?? page.value
  if (nextPage > 1) query.page = String(nextPage)

  return query
}

/** 切 tab：**清空所有筛选**并回到第 1 页（各 tab 的筛选维度不同，留着只会错乱） */
function switchTab(next: ContentTab) {
  if (next === tab.value) return
  void router.push({
    name: RouteName.ADMIN_CONTENT,
    query: buildQuery({
      tab: next,
      page: 1,
      keyword: '',
      status: '',
      visibility: '',
      articleId: null,
    }),
  })
}

/** 改筛选：一律回到第 1 页 */
function setFilter(patch: {
  status?: string
  visibility?: string
  keyword?: string
  articleId?: number | null
}) {
  void router.push({
    name: RouteName.ADMIN_CONTENT,
    query: buildQuery({ ...patch, page: 1 }),
  })
}

function changePage(next: number) {
  void router.push({ name: RouteName.ADMIN_CONTENT, query: buildQuery({ page: next }) })
}

/* ==================== 搜索 / 文章 ID 输入（300ms 防抖） ==================== */

const keywordInput = ref(keyword.value)
const articleIdInput = ref(articleIdFilter.value === null ? '' : String(articleIdFilter.value))
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(keyword, (value) => {
  keywordInput.value = value
})
watch(articleIdFilter, (value) => {
  articleIdInput.value = value === null ? '' : String(value)
})

function commitKeyword(next: string) {
  const trimmed = next.trim()
  if (trimmed === keyword.value && page.value === 1) return
  setFilter({ keyword: trimmed })
}

function onKeywordInput(value: string) {
  keywordInput.value = value
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => commitKeyword(value), SEARCH_DEBOUNCE_MS)
}

function onKeywordClear() {
  if (searchTimer) clearTimeout(searchTimer)
  keywordInput.value = ''
  commitKeyword('')
}

function onArticleIdInput(value: string) {
  articleIdInput.value = value
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    const n = Number(value.trim())
    const next = Number.isInteger(n) && n > 0 ? n : null
    if (next === articleIdFilter.value) return
    setFilter({ articleId: next })
  }, SEARCH_DEBOUNCE_MS)
}

/* ==================== 列表数据 ==================== */

const articles = ref<AdminArticleVO[]>([])
const notes = ref<AdminNoteVO[]>([])
const comments = ref<AdminCommentVO[]>([])

const total = ref(0)
const loading = ref(true)
const error = ref(false)
const forbidden = ref(false)

const currentPage = ref(1)
const pages = ref(0)

/** 请求序号：丢弃过期响应（快速连打搜索/切 tab 时会并发） */
let requestSeq = 0
/** 正在提交的行 id（该行按钮转 loading，防重复点击） */
const busyId = ref<number | null>(null)

/** 当前 tab 的行数 */
const itemCount = computed(() => {
  if (tab.value === 'article') return articles.value.length
  if (tab.value === 'note') return notes.value.length
  return comments.value.length
})

const isEmpty = computed(() => !loading.value && !error.value && itemCount.value === 0)

const pageOutOfRange = computed(
  () => isEmpty.value && pages.value > 0 && page.value > pages.value,
)

const emptyTitle = computed(() => {
  if (keyword.value || statusFilter.value || visibilityFilter.value || articleIdFilter.value) {
    return '没有匹配的内容'
  }
  if (tab.value === 'article') return '还没有文章'
  if (tab.value === 'note') return '还没有笔记'
  return '还没有评论'
})

const emptyDesc = computed(() =>
  keyword.value ? `没有找到与「${keyword.value}」匹配的记录` : '换个筛选条件试试',
)

/** 把分页响应套用到公共状态，并返回 records */
function applyPage<T>(res: PageResult<T>): T[] {
  total.value = res.total ?? 0
  currentPage.value = res.current && res.current > 0 ? res.current : page.value
  pages.value = res.pages ?? 0
  return res.records ?? []
}

async function load() {
  if (!userStore.isAdmin) {
    forbidden.value = true
    error.value = false
    loading.value = false
    articles.value = []
    notes.value = []
    comments.value = []
    total.value = 0
    return
  }

  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const common = {
      page: page.value,
      size: PAGE_SIZE,
      keyword: keyword.value || undefined,
    }

    if (tab.value === 'article') {
      const res = await getAdminArticles({
        ...common,
        status: statusFilter.value === '' ? undefined : Number(statusFilter.value),
      })
      if (seq !== requestSeq) return
      articles.value = applyPage(res)
    } else if (tab.value === 'note') {
      const res = await getAdminNotes({
        ...common,
        status: statusFilter.value === '' ? undefined : Number(statusFilter.value),
        visibility: visibilityFilter.value === '' ? undefined : Number(visibilityFilter.value),
      })
      if (seq !== requestSeq) return
      notes.value = applyPage(res)
    } else {
      const res = await getAdminComments({
        ...common,
        articleId: articleIdFilter.value ?? undefined,
      })
      if (seq !== requestSeq) return
      comments.value = applyPage(res)
    }
  } catch (err) {
    if (seq !== requestSeq) return
    // 一律判 err.code，不判 HTTP 状态码（403 是 HTTP 403，400/404 是 HTTP 200 + code）
    if (err instanceof ApiError && err.code === 403) {
      forbidden.value = true
    } else {
      error.value = true
    }
    articles.value = []
    notes.value = []
    comments.value = []
    total.value = 0
    currentPage.value = page.value
    pages.value = 0
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/* ==================== 下架 / 恢复 ==================== */

async function toggleStatus(kind: 'article' | 'note', id: number, current: number, title: string) {
  const next = current === 1 ? 0 : 1
  busyId.value = id
  try {
    if (kind === 'article') {
      await updateAdminArticleStatus(id, next)
    } else {
      await updateAdminNoteStatus(id, next)
    }
    ElMessage.success(next === 1 ? `已恢复「${title}」` : `已下架「${title}」`)
    await load()
  } catch {
    /* 请求层已按 code 统一提示 */
  } finally {
    busyId.value = null
  }
}

/* ==================== 删除（不可逆，必须二次确认） ==================== */

/** 删除确认文案：**如实说明后果**（§3.2），不要写「确定删除吗」这种无信息量的话 */
function deleteConfirmText(kind: ContentTab, title: string): string {
  if (kind === 'article') {
    return `确认删除文章「${title}」？将连带删除其标签、评论、点赞、收藏，并从热门榜与向量库移除。此操作不可恢复。`
  }
  if (kind === 'note') {
    return `确认删除笔记「${title}」？该笔记将被永久删除，且不可恢复。`
  }
  return '确认删除这条评论？该评论将不再展示，且不可恢复。'
}

async function removeContent(kind: ContentTab, id: number, title: string) {
  try {
    await ElMessageBox.confirm(deleteConfirmText(kind, title), '删除内容', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }

  busyId.value = id
  try {
    if (kind === 'article') await deleteAdminArticle(id)
    else if (kind === 'note') await deleteAdminNote(id)
    else await deleteAdminComment(id)

    ElMessage.success('已删除')

    // 删掉本页最后一条 → 退回上一页，否则会停在越界页看到「这一页没有内容」
    if (itemCount.value === 1 && page.value > 1) {
      changePage(page.value - 1)
    } else {
      await load()
    }
  } catch {
    /* 请求层已按 code 统一提示；不本地删行，界面与后端保持一致 */
  } finally {
    busyId.value = null
  }
}

/* ==================== 子组件事件适配 ====================
 * 三张表是**纯展示组件**，只把「哪一行」抛上来；「是哪一类内容」由本组件补上
 * （三个 tab 的动作语义不同：文章叫「下架」、笔记叫「转草稿」，文案在子组件里）。
 * 这样写还有个好处：子组件完全不认识 `deleteAdminArticle` 之类的接口，
 * 将来换接口只改这里。
 */
function onArticleToggleStatus(row: AdminArticleVO) {
  void toggleStatus('article', row.id, row.status, row.title)
}

function onArticleRemove(row: AdminArticleVO) {
  void removeContent('article', row.id, row.title)
}

function onNoteToggleStatus(row: AdminNoteVO) {
  void toggleStatus('note', row.id, row.status, row.title)
}

function onNoteRemove(row: AdminNoteVO) {
  void removeContent('note', row.id, row.title)
}

function onCommentRemove(row: AdminCommentVO) {
  void removeContent('comment', row.id, row.content)
}

/* ==================== 副作用 ==================== */

watch(
  [tab, page, keyword, statusFilter, visibilityFilter, articleIdFilter],
  () => {
    void load()
  },
  { immediate: true },
)
</script>

<template>
  <div class="cm-admin cm-container">
    <AdminPageHead
      title="内容治理"
      description="文章 / 笔记 / 评论的全量视角（含草稿与私密）。可下架、恢复与删除，权限由后端判定。"
    />

    <AdminTabs class="cm-admin__tabs" />

    <AdminForbidden v-if="forbidden" />

    <template v-else>
      <!-- ==================== 内容类型 tab ==================== -->
      <div class="cm-tabs" role="tablist">
        <button
          v-for="item in TABS"
          :key="item.key"
          type="button"
          role="tab"
          class="cm-tabs__item"
          :class="{ 'is-active': tab === item.key }"
          :aria-selected="tab === item.key"
          :title="item.hint"
          @click="switchTab(item.key)"
        >
          {{ item.label }}
        </button>
      </div>

      <!-- ==================== 筛选条 ==================== -->
      <div class="cm-filters">
        <el-input
          :model-value="keywordInput"
          class="cm-filters__search"
          placeholder="搜索标题或内容关键词"
          clearable
          :disabled="loading || error"
          @input="onKeywordInput"
          @clear="onKeywordClear"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <!-- 状态：分段控件（比 el-select 更贴合站点风格，也更好点） -->
        <div v-if="tab !== 'comment'" class="cm-seg" role="group" aria-label="状态筛选">
          <button
            v-for="opt in statusOptions"
            :key="`st-${opt.value}`"
            type="button"
            class="cm-seg__item"
            :class="{ 'is-active': statusFilter === opt.value }"
            @click="setFilter({ status: opt.value })"
          >
            {{ opt.label }}
          </button>
        </div>

        <!-- 可见性：只有笔记有 -->
        <div v-if="tab === 'note'" class="cm-seg" role="group" aria-label="可见性筛选">
          <button
            v-for="opt in VISIBILITY_OPTIONS"
            :key="`vis-${opt.value}`"
            type="button"
            class="cm-seg__item"
            :class="{ 'is-active': visibilityFilter === opt.value }"
            @click="setFilter({ visibility: opt.value })"
          >
            {{ opt.label }}
          </button>
        </div>

        <!-- 按文章 ID 筛选：只有评论有 -->
        <el-input
          v-if="tab === 'comment'"
          :model-value="articleIdInput"
          class="cm-filters__article-id"
          placeholder="按文章 ID 筛选"
          clearable
          :disabled="loading || error"
          @input="onArticleIdInput"
          @clear="setFilter({ articleId: null })"
        />

        <span class="cm-filters__count">
          <template v-if="loading">加载中…</template>
          <template v-else>共 {{ total }} 条</template>
        </span>
      </div>

      <!-- ==================== 状态区 ==================== -->
      <ErrorState
        v-if="error"
        title="内容列表加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="load"
      />

      <div v-else class="cm-content-panel">
        <LoadingState v-if="loading" variant="skeleton" :rows="5" />

        <EmptyState
          v-else-if="pageOutOfRange"
          title="这一页没有内容"
          :description="`当前共 ${pages} 页，你请求的是第 ${page} 页`"
          :size="80"
        >
          <el-button size="small" plain @click="changePage(1)">回到第 1 页</el-button>
        </EmptyState>

        <EmptyState v-else-if="isEmpty" :title="emptyTitle" :description="emptyDesc" :size="80" />

        <!--
          三张表各自拆成子组件（T21）。
          ⚠️ 外层 `.cm-table-scroll` 留在**本组件**里：它是横向滚动的容器，
             而子组件的根是 `<table>` —— 这样最终 DOM 与重构前完全一致
             （`<div class="cm-table-scroll"><table>…`），也让这条样式能作为
             普通的 scoped 规则命中（`:deep()` 打不到组件根元素自身）。
        -->
        <div v-else class="cm-table-scroll">
          <AdminArticleTable
            v-if="tab === 'article'"
            :rows="articles"
            :busy-id="busyId"
            @toggle-status="onArticleToggleStatus"
            @remove="onArticleRemove"
          />
          <AdminNoteTable
            v-else-if="tab === 'note'"
            :rows="notes"
            :busy-id="busyId"
            @toggle-status="onNoteToggleStatus"
            @remove="onNoteRemove"
          />
          <AdminCommentTable
            v-else
            :rows="comments"
            :busy-id="busyId"
            @remove="onCommentRemove"
          />
        </div>
      </div>

      <div v-if="!loading && !error && total > PAGE_SIZE" class="cm-content-pager">
        <el-pagination
          background
          layout="prev, pager, next"
          :total="total"
          :page-size="PAGE_SIZE"
          :current-page="currentPage"
          :hide-on-single-page="true"
          @current-change="changePage"
        />
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

/* ==================== 内容类型 tab ==================== */
.cm-tabs {
  display: flex;
  align-items: center;
  gap: var(--cm-space-1);
  margin-top: var(--cm-space-6);
  border-bottom: 1px solid var(--cm-border-default);
}

.cm-tabs__item {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: var(--cm-space-3) var(--cm-space-5);
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
  left: var(--cm-space-4);
  right: var(--cm-space-4);
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

/* ==================== 筛选条 ==================== */
.cm-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-3);
  padding: var(--cm-space-4) 0;
}

.cm-filters__search {
  width: 260px;
}

.cm-filters__article-id {
  width: 150px;
}

.cm-filters__count {
  margin-left: auto;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-quaternary);
  font-variant-numeric: tabular-nums;
}

/* 分段控件 */
.cm-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background-color: var(--cm-bg-subtle);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-md);
}

.cm-seg__item {
  padding: 3px var(--cm-space-3);
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
  background: none;
  border: none;
  border-radius: var(--cm-radius-sm);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.cm-seg__item:hover {
  color: var(--cm-text-primary);
}

.cm-seg__item.is-active {
  color: var(--cm-accent-700);
  background-color: var(--cm-bg-surface);
  font-weight: 500;
}

/* ==================== 表格 ==================== */
.cm-content-panel {
  min-height: 260px;
}

.cm-table-scroll {
  overflow-x: auto;
}

/*
 * ⚠️ 下面这些表格样式用的是 `:deep()`：表格已拆到三个子组件里
 * （`AdminArticleTable` / `AdminNoteTable` / `AdminCommentTable`），
 * 而 scoped 样式默认只能命中**本组件模板里**的元素。
 *
 * 为什么样式留在父级、而不是跟着表格进子组件：三张表共用同一套
 * `.cm-table*` / `.cm-author*` / `.cm-badge*`，在三个子组件里各复制一遍，
 * 就是把「页面头样式刻意重复」那个毛病换个地方复发 —— 而 T21 要解的正是这个。
 *
 * 能命中的前提：子组件的**根元素**会带上父级的 scope id（Vue 的既定行为），
 * 而表格外层还套着父级自己的 `.cm-table-scroll`（上面那条普通 scoped 规则），
 * 所以 `:deep(...)` 编译出的 `[data-v-父] xxx` 必然匹配得到。
 */
:deep(.cm-table) {
  width: 100%;
  min-width: 860px;
  border-collapse: collapse;
  font-size: var(--cm-font-size-sm);
}

:deep(.cm-table th) {
  padding: var(--cm-space-3);
  font-size: var(--cm-font-size-xs);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  color: var(--cm-text-quaternary);
  border-bottom: 1px solid var(--cm-border-default);
}

:deep(.cm-table td) {
  padding: var(--cm-space-3);
  vertical-align: middle;
  color: var(--cm-text-secondary);
  border-bottom: 1px solid var(--cm-border-subtle);
}

:deep(.cm-table tbody tr) {
  transition: background-color 0.15s ease;
}

:deep(.cm-table tbody tr:hover) {
  background-color: var(--cm-bg-hover);
}

:deep(.cm-table__main) {
  min-width: 240px;
}

:deep(.cm-table__title) {
  display: block;
  font-size: var(--cm-font-size-base);
  font-weight: 500;
  color: var(--cm-text-primary);
}

:deep(.cm-table__sub) {
  display: block;
  margin-top: 2px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  max-width: 40ch;
}

:deep(.cm-table__comment) {
  /* 两行截断：-webkit-box 才是最终生效的 display，不要在前面再写 display:block */
  display: -webkit-box;
  max-width: 44ch;
  line-height: 1.55;
  color: var(--cm-text-secondary);
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

:deep(.cm-table__mono) {
  white-space: nowrap;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-tertiary);
  font-variant-numeric: tabular-nums;
}

:deep(.cm-table__time) {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

:deep(.cm-table__right) {
  text-align: right;
  white-space: nowrap;
}

/* 行内按钮不要被 Element Plus 的相邻 margin 撑开 */
:deep(.cm-table__right .el-button + .el-button) {
  margin-left: var(--cm-space-2);
}

/* ==================== 作者 ==================== */
:deep(.cm-author) {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  min-width: 0;
}

:deep(.cm-author__avatar) {
  flex-shrink: 0;
  font-size: var(--cm-font-size-xs);
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

:deep(.cm-author__name) {
  white-space: nowrap;
  color: var(--cm-text-secondary);
}

/* ==================== 标签 ==================== */
:deep(.cm-badge-group) {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-wrap: wrap;
}

:deep(.cm-badge) {
  display: inline-block;
  padding: 1px 7px;
  font-size: var(--cm-font-size-xs);
  line-height: 18px;
  white-space: nowrap;
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-subtle);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-sm);
}

:deep(.cm-badge--success) {
  color: var(--cm-success);
  background-color: var(--cm-success-bg);
  border-color: var(--cm-success-border);
}

/* 草稿：醒目（管理端含草稿，必须让人一眼看出没公开） */
:deep(.cm-badge--warning) {
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border-color: var(--cm-warning-border);
  font-weight: 500;
}

/* 私密：醒目 */
:deep(.cm-badge--danger) {
  color: var(--cm-danger);
  background-color: var(--cm-danger-bg);
  border-color: var(--cm-danger-border);
  font-weight: 500;
}

/* ==================== 分页 ==================== */
.cm-content-pager {
  display: flex;
  justify-content: center;
  padding-top: var(--cm-space-8);
}

/* ==================== 响应式 ==================== */
@media (max-width: 860px) {
  .cm-filters__search {
    width: 100%;
  }

  .cm-filters__count {
    margin-left: 0;
  }
}
</style>
