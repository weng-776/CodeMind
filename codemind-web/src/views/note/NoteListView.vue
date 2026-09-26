<script setup lang="ts">
/**
 * 我的知识库 —— 笔记列表
 * ------------------------------------------------------------------
 * 对应接口：
 *   2.5  我的笔记列表      GET    /api/note/list
 *   2.6  切换公开/私密     PUT    /api/note/{id}/visibility
 *   2.3  删除笔记          DELETE /api/note/{id}
 *   2.10 分类树（侧栏）    GET    /api/category/tree
 *
 * 关键设计：
 *   1. **筛选条件全部走 URL query**（categoryId / visibility / status / keyword / page），
 *      与文章列表页保持同一套模式：可分享、可刷新、前进后退正确。
 *   2. **关键词搜索要防抖**：输入框本地维护，停顿 300ms 后才写进 URL 触发请求，
 *      否则每敲一个字母都会打一次接口。
 *   3. 过期响应丢弃：快速切换筛选时先发后到的旧响应必须丢弃。
 *   4. 可见性切换与删除都做乐观更新 / 即时移除，失败回滚并提示。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import NoteCard from '@/components/note/NoteCard.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { deleteNote, getMyNotes, updateNoteVisibility } from '@/api/note'
import { getCategoryTree } from '@/api/category'
import { RouteName } from '@/router/routes-names'
import { ContentStatus, Visibility } from '@/types/common'
import type { NoteListItemVO } from '@/types/note'
import type { CategoryVO } from '@/types/category'

const route = useRoute()
const router = useRouter()

const PAGE_SIZE = 10

/** 状态 / 可见性筛选项。value 为 null 表示不筛选 */
const STATUS_OPTIONS = [
  { value: null, label: '全部状态' },
  { value: ContentStatus.PUBLISHED, label: '正常' },
  { value: ContentStatus.DRAFT, label: '草稿' },
]

const VISIBILITY_OPTIONS = [
  { value: null, label: '全部可见性' },
  { value: Visibility.PUBLIC, label: '公开' },
  { value: Visibility.PRIVATE, label: '私密' },
]

/* ==================== URL 派生状态 ==================== */

function queryValue(key: string): string | null {
  const raw = route.query[key]
  const v = Array.isArray(raw) ? raw[0] : raw
  return v === undefined || v === null || v === '' ? null : String(v)
}

const page = computed(() => {
  const n = Number(queryValue('page'))
  return Number.isInteger(n) && n > 0 ? n : 1
})

const categoryId = computed(() => {
  const n = Number(queryValue('categoryId'))
  return Number.isInteger(n) && n > 0 ? n : null
})

/** 只接受 0 / 1，其它值一律当作不筛选 */
function enumFilter(key: string): number | null {
  const v = queryValue(key)
  return v === '0' ? 0 : v === '1' ? 1 : null
}

const visibility = computed(() => enumFilter('visibility'))
const status = computed(() => enumFilter('status'))
const keyword = computed(() => queryValue('keyword') ?? '')

/**
 * 构造 query 的唯一出口。默认值不写进 URL，保持地址简洁。
 */
function buildQuery(next: {
  page?: number
  categoryId?: number | null
  visibility?: number | null
  status?: number | null
  keyword?: string
}): Record<string, string> {
  const q: Record<string, string> = {}

  const nextCategory = next.categoryId !== undefined ? next.categoryId : categoryId.value
  const nextVisibility = next.visibility !== undefined ? next.visibility : visibility.value
  const nextStatus = next.status !== undefined ? next.status : status.value
  const nextKeyword = next.keyword !== undefined ? next.keyword : keyword.value
  const nextPage = next.page ?? page.value

  if (nextCategory !== null) q.categoryId = String(nextCategory)
  if (nextVisibility !== null) q.visibility = String(nextVisibility)
  if (nextStatus !== null) q.status = String(nextStatus)
  if (nextKeyword.trim()) q.keyword = nextKeyword.trim()
  if (nextPage > 1) q.page = String(nextPage)

  return q
}

/** 改任一筛选条件都要回到第 1 页 */
function applyFilter(patch: Parameters<typeof buildQuery>[0]) {
  void router.push({
    name: RouteName.NOTE_LIST,
    query: buildQuery({ ...patch, page: 1 }),
  })
}

function changePage(next: number) {
  void router.push({ name: RouteName.NOTE_LIST, query: buildQuery({ page: next }) })
}

function resetFilters() {
  void router.push({ name: RouteName.NOTE_LIST })
}

/* ==================== 关键词搜索（防抖） ==================== */

const keywordInput = ref(keyword.value)
let keywordTimer: ReturnType<typeof setTimeout> | null = null

// URL 上的关键词被外部改变（如点「重置」）时同步回输入框
watch(keyword, (v) => {
  if (v !== keywordInput.value) keywordInput.value = v
})

function onKeywordInput() {
  if (keywordTimer) clearTimeout(keywordTimer)
  keywordTimer = setTimeout(() => {
    if (keywordInput.value.trim() === keyword.value) return
    applyFilter({ keyword: keywordInput.value })
  }, 300)
}

onBeforeUnmount(() => {
  if (keywordTimer) clearTimeout(keywordTimer)
})

/* ==================== 列表数据 ==================== */

const list = ref<NoteListItemVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)

/** 请求序号：丢弃过期响应 */
let requestSeq = 0

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

/** 是否有任何筛选条件生效（决定空状态文案） */
const hasFilter = computed(
  () =>
    categoryId.value !== null ||
    visibility.value !== null ||
    status.value !== null ||
    keyword.value !== '',
)

const emptyTitle = computed(() => (hasFilter.value ? '没有符合条件的笔记' : '知识库还是空的'))
const emptyDesc = computed(() =>
  hasFilter.value ? '换个筛选条件试试，或者清空筛选' : '把学到的记下来，之后就不用重新查了',
)

async function loadNotes() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const res = await getMyNotes({
      page: page.value,
      size: PAGE_SIZE,
      ...(categoryId.value !== null ? { categoryId: categoryId.value } : {}),
      ...(visibility.value !== null ? { visibility: visibility.value as Visibility } : {}),
      ...(status.value !== null ? { status: status.value as ContentStatus } : {}),
      ...(keyword.value ? { keyword: keyword.value } : {}),
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

/* ==================== 分类侧栏 ==================== */

const categories = ref<CategoryVO[]>([])
const categoriesLoading = ref(true)

async function loadCategories() {
  categoriesLoading.value = true
  try {
    categories.value = (await getCategoryTree()) ?? []
  } catch {
    categories.value = []
  } finally {
    categoriesLoading.value = false
  }
}

/** 扁平化以便在侧栏用缩进展示层级 */
interface FlatCategory {
  id: number
  name: string
  depth: number
}

function flatten(nodes: CategoryVO[], depth = 0, out: FlatCategory[] = []): FlatCategory[] {
  for (const node of nodes) {
    out.push({ id: node.id, name: node.name, depth })
    if (node.children?.length) flatten(node.children, depth + 1, out)
  }
  return out
}

const flatCategories = computed(() => flatten(categories.value))

function selectCategory(id: number | null) {
  applyFilter({ categoryId: id })
}

/* ==================== 单条操作 ==================== */

/** 正在处理中的笔记 id 集合，避免重复点击 */
const pendingIds = ref<Set<number>>(new Set())

function isPending(id: number) {
  return pendingIds.value.has(id)
}

function setPending(id: number, on: boolean) {
  const next = new Set(pendingIds.value)
  if (on) next.add(id)
  else next.delete(id)
  pendingIds.value = next
}

/** 切换可见性：乐观更新，失败回滚 */
async function toggleVisibility(note: NoteListItemVO) {
  if (isPending(note.id)) return

  const nextVisibility =
    note.visibility === Visibility.PUBLIC ? Visibility.PRIVATE : Visibility.PUBLIC
  const prev = note.visibility

  setPending(note.id, true)
  note.visibility = nextVisibility

  try {
    await updateNoteVisibility(note.id, { visibility: nextVisibility })
    ElMessage.success(nextVisibility === Visibility.PUBLIC ? '已设为公开' : '已设为私密')
  } catch {
    // 回滚；失败提示由请求层负责（项目级约定 D，页面不再自造一条）
    note.visibility = prev
  } finally {
    setPending(note.id, false)
  }
}

async function handleDelete(note: NoteListItemVO) {
  try {
    await ElMessageBox.confirm(`确定删除「${note.title}」吗？删除后无法恢复。`, '删除笔记', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }

  try {
    await deleteNote(note.id)
    ElMessage.success('已删除')
    // 删掉当前页最后一条时往前退一页，避免停在空页
    if (list.value.length === 1 && page.value > 1) {
      changePage(page.value - 1)
    } else {
      await loadNotes()
    }
  } catch {
    // 提示由请求层负责（约定 D）
  }
}

function goCreate() {
  void router.push({ name: RouteName.NOTE_CREATE })
}

function goCategories() {
  void router.push({ name: RouteName.CATEGORY_MANAGE })
}

/* ==================== 副作用 ==================== */

watch([page, categoryId, visibility, status, keyword], () => void loadNotes(), {
  immediate: true,
})

void loadCategories()
</script>

<template>
  <div class="cm-container cm-note-list">
    <!-- ==================== 页头 ==================== -->
    <header class="cm-note-list__head">
      <div class="cm-note-list__head-text">
        <h1 class="cm-note-list__title">我的知识库</h1>
        <p class="cm-note-list__subtitle">
          共 {{ total }} 篇笔记
          <template v-if="hasFilter">（已筛选）</template>
        </p>
      </div>

      <div class="cm-note-list__head-actions">
        <el-button @click="goCategories">
          <el-icon><FolderOpened /></el-icon>
          分类管理
        </el-button>
        <el-button type="primary" @click="goCreate">
          <el-icon><EditPen /></el-icon>
          写笔记
        </el-button>
      </div>
    </header>

    <div class="cm-note-list__grid">
      <!-- ==================== 左：筛选 + 列表 ==================== -->
      <div class="cm-note-list__main">
        <!-- 筛选条 -->
        <div class="cm-note-list__filters">
          <el-input
            v-model="keywordInput"
            placeholder="搜索笔记标题…"
            clearable
            class="cm-note-list__search"
            @input="onKeywordInput"
            @keyup.enter="applyFilter({ keyword: keywordInput })"
            @clear="applyFilter({ keyword: '' })"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>

          <el-select
            :model-value="status"
            placeholder="全部状态"
            class="cm-note-list__filter-select"
            @update:model-value="(v: number | null) => applyFilter({ status: v })"
          >
            <el-option
              v-for="opt in STATUS_OPTIONS"
              :key="String(opt.value)"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>

          <el-select
            :model-value="visibility"
            placeholder="全部可见性"
            class="cm-note-list__filter-select"
            @update:model-value="(v: number | null) => applyFilter({ visibility: v })"
          >
            <el-option
              v-for="opt in VISIBILITY_OPTIONS"
              :key="String(opt.value)"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>

          <el-button v-if="hasFilter" text size="small" @click="resetFilters">清空筛选</el-button>
        </div>

        <!-- 列表主体 -->
        <div class="cm-note-list__body">
          <LoadingState v-if="loading" variant="skeleton" :rows="6" with-cover />

          <ErrorState
            v-else-if="error"
            title="笔记加载失败"
            description="可能是网络问题，或后端服务未启动"
            @retry="loadNotes"
          />

          <EmptyState v-else-if="isEmpty" :title="emptyTitle" :description="emptyDesc" :size="80">
            <el-button v-if="hasFilter" size="small" @click="resetFilters">清空筛选</el-button>
            <el-button v-else type="primary" plain size="small" @click="goCreate">
              写第一篇笔记
            </el-button>
          </EmptyState>

          <ul v-else class="cm-note-list__items">
            <li v-for="note in list" :key="note.id" class="cm-note-list__item">
              <NoteCard :note="note" show-cover />

              <!-- 单条操作 -->
              <div class="cm-note-list__item-ops">
                <button
                  type="button"
                  class="cm-note-list__op"
                  :disabled="isPending(note.id)"
                  :title="note.visibility === Visibility.PUBLIC ? '设为私密' : '设为公开'"
                  @click.stop="toggleVisibility(note)"
                >
                  <el-icon :size="13">
                    <component :is="note.visibility === Visibility.PUBLIC ? 'Lock' : 'View'" />
                  </el-icon>
                  {{ note.visibility === Visibility.PUBLIC ? '设为私密' : '设为公开' }}
                </button>

                <RouterLink
                  class="cm-note-list__op"
                  :to="{ name: RouteName.NOTE_EDIT, params: { id: String(note.id) } }"
                  @click.stop
                >
                  <el-icon :size="13"><EditPen /></el-icon>
                  编辑
                </RouterLink>

                <button
                  type="button"
                  class="cm-note-list__op cm-note-list__op--danger"
                  @click.stop="handleDelete(note)"
                >
                  <el-icon :size="13"><Delete /></el-icon>
                  删除
                </button>
              </div>
            </li>
          </ul>
        </div>

        <!-- 分页 -->
        <div v-if="!loading && !error && total > PAGE_SIZE" class="cm-note-list__pager">
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

      <!-- ==================== 右：分类树 ==================== -->
      <aside class="cm-note-list__side">
        <div class="cm-panel cm-note-list__cats-panel">
          <h2 class="cm-note-list__panel-title">
            分类
            <RouterLink
              v-if="categoryId !== null"
              class="cm-note-list__panel-reset"
              :to="{ name: RouteName.NOTE_LIST, query: buildQuery({ categoryId: null, page: 1 }) }"
            >
              全部
            </RouterLink>
          </h2>

          <LoadingState v-if="categoriesLoading" variant="spinner" text="加载分类" />

          <p v-else-if="!flatCategories.length" class="cm-note-list__cats-empty">
            还没有分类。
            <button type="button" class="cm-note-list__cats-link" @click="goCategories">
              去创建
            </button>
          </p>

          <ul v-else class="cm-note-list__cats">
            <li v-for="cat in flatCategories" :key="cat.id">
              <button
                type="button"
                class="cm-note-list__cat"
                :class="{ 'is-active': categoryId === cat.id }"
                :style="{ paddingLeft: `${cat.depth * 12 + 10}px` }"
                @click="selectCategory(cat.id)"
              >
                <el-icon :size="12"><FolderOpened /></el-icon>
                <span class="cm-truncate">{{ cat.name }}</span>
              </button>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.cm-note-list {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

/* ==================== 页头 ==================== */
.cm-note-list__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--cm-space-6);
  padding-bottom: var(--cm-space-5);
}

.cm-note-list__title {
  margin: 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-note-list__subtitle {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

.cm-note-list__head-actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
}

/* ==================== 栅格 ==================== */
.cm-note-list__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 232px;
  gap: var(--cm-space-10);
  align-items: start;
}

.cm-note-list__main {
  min-width: 0;
}

.cm-note-list__side {
  min-width: 0;
  position: sticky;
  top: calc(var(--cm-header-height) + var(--cm-space-6));
}

/* ==================== 筛选条 ==================== */
.cm-note-list__filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-3);
  padding-bottom: var(--cm-space-4);
  border-bottom: 1px solid var(--cm-border-default);
}

.cm-note-list__search {
  flex: 1;
  min-width: 180px;
  max-width: 320px;
}

.cm-note-list__filter-select {
  width: 132px;
}

/* ==================== 列表 ==================== */
.cm-note-list__body {
  min-height: 240px;
}

.cm-note-list__items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cm-note-list__item {
  position: relative;
}

/* 操作区默认隐藏，悬停或聚焦时出现，避免列表过于嘈杂 */
.cm-note-list__item-ops {
  display: flex;
  align-items: center;
  gap: var(--cm-space-4);
  padding: 0 var(--cm-space-4) var(--cm-space-4);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.cm-note-list__item:hover .cm-note-list__item-ops,
.cm-note-list__item:focus-within .cm-note-list__item-ops {
  opacity: 1;
}

.cm-note-list__op {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  font-family: inherit;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  text-decoration: none;
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-note-list__op:hover:not(:disabled) {
  color: var(--cm-accent-600);
}

.cm-note-list__op:disabled {
  opacity: 0.5;
  cursor: default;
}

.cm-note-list__op--danger:hover {
  color: var(--cm-danger);
}

.cm-note-list__pager {
  display: flex;
  justify-content: center;
  padding-top: var(--cm-space-8);
}

/* ==================== 分类侧栏 ==================== */
.cm-note-list__cats-panel {
  padding: var(--cm-space-4) var(--cm-space-3) var(--cm-space-4);
}

.cm-note-list__panel-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0 0 var(--cm-space-2);
  padding: 0 var(--cm-space-2);
  font-size: var(--cm-font-size-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--cm-text-secondary);
}

.cm-note-list__panel-reset {
  font-size: var(--cm-font-size-xs);
  font-weight: 400;
  color: var(--cm-text-quaternary);
}

.cm-note-list__panel-reset:hover {
  color: var(--cm-accent-600);
}

.cm-note-list__cats {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cm-note-list__cats-empty {
  padding: 0 var(--cm-space-2);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-quaternary);
}

.cm-note-list__cats-link {
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: var(--cm-accent-600);
  background: none;
  border: none;
  cursor: pointer;
}

.cm-note-list__cat {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  width: 100%;
  padding: 6px 10px;
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
  text-align: left;
  background: none;
  border: none;
  border-radius: var(--cm-radius-sm);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.cm-note-list__cat:hover {
  color: var(--cm-text-primary);
  background-color: var(--cm-bg-hover);
}

.cm-note-list__cat.is-active {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
  font-weight: 500;
}

.cm-note-list__cat span {
  min-width: 0;
}

/* ==================== 响应式 ==================== */
@media (max-width: 1024px) {
  .cm-note-list__grid {
    grid-template-columns: minmax(0, 1fr) 200px;
    gap: var(--cm-space-8);
  }
}

@media (max-width: 860px) {
  .cm-note-list__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cm-space-8);
  }

  .cm-note-list__side {
    position: static;
    order: 2;
  }

  .cm-note-list__main {
    order: 1;
  }

  .cm-note-list__head {
    align-items: flex-start;
  }

  /* 窄屏没有 hover，操作区常驻显示 */
  .cm-note-list__item-ops {
    opacity: 1;
  }
}

@media (max-width: 560px) {
  .cm-note-list__head {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-note-list__search {
    max-width: none;
  }

  .cm-note-list__filter-select {
    width: 100%;
  }
}
</style>
