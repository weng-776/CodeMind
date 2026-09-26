<script setup lang="ts">
/**
 * 我的笔记（个人中心 Tab）
 * ------------------------------------------------------------------
 * 对应接口：
 *   2.5  我的笔记列表      GET    /api/note/list
 *   2.6  切换公开/私密     PUT    /api/note/{id}/visibility
 *   2.3  删除笔记          DELETE /api/note/{id}
 *
 * 与「我的知识库」(NoteListView) 的分工：
 *   知识库页是**管理台**，带分类侧栏、可见性筛选、防抖搜索；
 *   这里只做**概览**，保留最常用的三个动作（编辑 / 切可见性 / 删除）与状态筛选，
 *   其余筛选引导到知识库页。两页共用 NoteCard，不重复实现卡片。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import NoteCard from '@/components/note/NoteCard.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { deleteNote, getMyNotes, updateNoteVisibility } from '@/api/note'
import { RouteName } from '@/router/routes-names'
import { ContentStatus, Visibility } from '@/types/common'
import type { NoteListItemVO } from '@/types/note'

const route = useRoute()
const router = useRouter()

const PAGE_SIZE = 10

const TABS = [
  { value: null, label: '全部' },
  { value: ContentStatus.PUBLISHED, label: '正常' },
  { value: ContentStatus.DRAFT, label: '草稿' },
] as const

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

const status = computed<number | null>(() => {
  const v = queryValue('status')
  return v === '0' ? 0 : v === '1' ? 1 : null
})

function buildQuery(next: { status?: number | null; page?: number }): Record<string, string> {
  const q: Record<string, string> = {}
  const nextStatus = next.status !== undefined ? next.status : status.value
  const nextPage = next.page ?? page.value

  if (nextStatus !== null) q.status = String(nextStatus)
  if (nextPage > 1) q.page = String(nextPage)
  return q
}

function switchTab(next: number | null) {
  if (next === status.value && page.value === 1) return
  void router.push({ name: RouteName.MY_NOTES, query: buildQuery({ status: next, page: 1 }) })
}

function changePage(next: number) {
  void router.push({ name: RouteName.MY_NOTES, query: buildQuery({ page: next }) })
}

/* ==================== 列表数据 ==================== */

const list = ref<NoteListItemVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)

/** 请求序号：丢弃过期响应 */
let requestSeq = 0

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

const emptyTitle = computed(() => {
  if (status.value === ContentStatus.DRAFT) return '没有草稿'
  if (status.value === ContentStatus.PUBLISHED) return '还没有正常的笔记'
  return '知识库还是空的'
})

const emptyDesc = computed(() =>
  status.value === null ? '把学到的记下来，之后就不用重新查了' : '换个筛选条件看看',
)

async function loadNotes() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const res = await getMyNotes({
      page: page.value,
      size: PAGE_SIZE,
      ...(status.value !== null ? { status: status.value as ContentStatus } : {}),
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

/* ==================== 单条操作 ==================== */

/** 处理中的笔记 id，避免重复点击 */
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
    note.visibility = prev
    ElMessage.error('修改可见性失败')
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
    ElMessage.error('删除失败')
  }
}

function goCreate() {
  void router.push({ name: RouteName.NOTE_CREATE })
}

function goKnowledgeBase() {
  void router.push({ name: RouteName.NOTE_LIST })
}

watch([page, status], () => void loadNotes(), { immediate: true })
</script>

<template>
  <div class="cm-tab-list">
    <!-- ==================== 工具条 ==================== -->
    <div class="cm-tab-list__bar">
      <div class="cm-tabs" role="tablist">
        <button
          v-for="tab in TABS"
          :key="String(tab.value)"
          type="button"
          role="tab"
          class="cm-tabs__item"
          :class="{ 'is-active': status === tab.value }"
          :aria-selected="status === tab.value"
          @click="switchTab(tab.value)"
        >
          {{ tab.label }}
        </button>
      </div>

      <div class="cm-tab-list__bar-actions">
        <el-button size="small" @click="goKnowledgeBase">在知识库中管理</el-button>
        <el-button type="primary" size="small" @click="goCreate">
          <el-icon class="cm-tab-list__btn-icon"><EditPen /></el-icon>
          写笔记
        </el-button>
      </div>
    </div>

    <p class="cm-tab-list__count">共 {{ total }} 篇</p>

    <!-- ==================== 列表 ==================== -->
    <div class="cm-tab-list__body">
      <LoadingState v-if="loading" variant="skeleton" :rows="5" with-cover />

      <ErrorState
        v-else-if="error"
        title="笔记加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="loadNotes"
      />

      <EmptyState v-else-if="isEmpty" :title="emptyTitle" :description="emptyDesc" :size="80">
        <el-button v-if="status !== null" size="small" @click="switchTab(null)">看全部</el-button>
        <el-button v-else type="primary" plain size="small" @click="goCreate">写第一篇</el-button>
      </EmptyState>

      <ul v-else class="cm-tab-list__items">
        <li v-for="note in list" :key="note.id" class="cm-tab-list__item">
          <NoteCard :note="note" show-cover />

          <div class="cm-tab-list__ops">
            <button
              type="button"
              class="cm-tab-list__op"
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
              class="cm-tab-list__op"
              :to="{ name: RouteName.NOTE_EDIT, params: { id: String(note.id) } }"
              @click.stop
            >
              <el-icon :size="13"><EditPen /></el-icon>
              编辑
            </RouterLink>

            <button
              type="button"
              class="cm-tab-list__op cm-tab-list__op--danger"
              @click.stop="handleDelete(note)"
            >
              <el-icon :size="13"><Delete /></el-icon>
              删除
            </button>
          </div>
        </li>
      </ul>
    </div>

    <!-- ==================== 分页 ==================== -->
    <div v-if="!loading && !error && total > PAGE_SIZE" class="cm-tab-list__pager">
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
/* ==================== 工具条 ==================== */
.cm-tab-list__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-4);
  border-bottom: 1px solid var(--cm-border-default);
}

.cm-tab-list__bar-actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
}

.cm-tab-list__btn-icon {
  margin-right: 4px;
}

.cm-tab-list__count {
  margin: var(--cm-space-3) 0 0;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

/* ==================== 列表 ==================== */
.cm-tab-list__body {
  min-height: 200px;
  margin-top: var(--cm-space-2);
}

.cm-tab-list__items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cm-tab-list__item {
  position: relative;
}

.cm-tab-list__ops {
  display: flex;
  align-items: center;
  gap: var(--cm-space-4);
  padding: 0 var(--cm-space-4) var(--cm-space-4);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.cm-tab-list__item:hover .cm-tab-list__ops,
.cm-tab-list__item:focus-within .cm-tab-list__ops {
  opacity: 1;
}

.cm-tab-list__op {
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

.cm-tab-list__op:hover:not(:disabled) {
  color: var(--cm-accent-600);
}

.cm-tab-list__op:disabled {
  opacity: 0.5;
  cursor: default;
}

.cm-tab-list__op--danger:hover {
  color: var(--cm-danger);
}

.cm-tab-list__pager {
  display: flex;
  justify-content: center;
  padding-top: var(--cm-space-8);
}

@media (max-width: 860px) {
  .cm-tab-list__ops {
    opacity: 1;
  }
}

@media (max-width: 560px) {
  .cm-tab-list__bar {
    flex-direction: column;
    align-items: stretch;
    gap: var(--cm-space-2);
    padding-bottom: var(--cm-space-2);
  }

  .cm-tab-list__bar-actions {
    justify-content: flex-end;
  }
}
</style>
