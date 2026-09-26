<script setup lang="ts">
/**
 * 我的文章
 * ------------------------------------------------------------------
 * 对应接口：
 *   3.6  我的文章   GET    /api/article/my       （含草稿，支持 status 过滤）
 *   3.3  删除文章   DELETE /api/article/{id}     （逻辑删除）
 *
 * 与社区列表（ArticleListView）的关系：
 *   两者共用 ArticleCard，但筛选维度完全不同 —— 社区列表是「最新/热门/标签」，
 *   这里是「全部/已发布/草稿」。所以没有抽成一个通用列表页：参数语义不同，
 *   硬合并会让两边都变复杂。
 *
 * 筛选条件同样走 URL query（status / page），保持全站一致的可分享、可刷新行为。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import ArticleCard from '@/components/article/ArticleCard.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { deleteArticle, getMyArticles } from '@/api/article'
import { RouteName } from '@/router/routes-names'
import { ContentStatus } from '@/types/common'
import type { ArticleListItemVO } from '@/types/article'

const route = useRoute()
const router = useRouter()

const PAGE_SIZE = 10

/** 筛选 tab。value 为 null 表示不传 status（查全部） */
const TABS = [
  { value: null, label: '全部' },
  { value: ContentStatus.PUBLISHED, label: '已发布' },
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

/** 只接受 0 / 1，其它值一律回落到「全部」 */
const status = computed<number | null>(() => {
  const v = queryValue('status')
  return v === '0' ? 0 : v === '1' ? 1 : null
})

/** 构造 query 的唯一出口：默认值（全部 / 第 1 页）不写进 URL */
function buildQuery(next: { status?: number | null; page?: number }): Record<string, string> {
  const q: Record<string, string> = {}
  const nextStatus = next.status !== undefined ? next.status : status.value
  const nextPage = next.page ?? page.value

  if (nextStatus !== null) q.status = String(nextStatus)
  if (nextPage > 1) q.page = String(nextPage)
  return q
}

/** 切筛选一律回到第 1 页 */
function switchTab(next: number | null) {
  if (next === status.value && page.value === 1) return
  void router.push({ name: RouteName.MY_ARTICLES, query: buildQuery({ status: next, page: 1 }) })
}

function changePage(next: number) {
  void router.push({ name: RouteName.MY_ARTICLES, query: buildQuery({ page: next }) })
}

/* ==================== 列表数据 ==================== */

const list = ref<ArticleListItemVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)

/** 请求序号：丢弃过期响应 */
let requestSeq = 0

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

const emptyTitle = computed(() => {
  if (status.value === ContentStatus.DRAFT) return '没有草稿'
  if (status.value === ContentStatus.PUBLISHED) return '还没有发布过文章'
  return '还没有写过文章'
})

const emptyDesc = computed(() =>
  status.value === null ? '把踩过的坑写下来，下次就不用重新踩' : '换个筛选条件看看',
)

async function loadArticles() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const res = await getMyArticles({
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

async function handleDelete(article: ArticleListItemVO) {
  try {
    await ElMessageBox.confirm(`确定删除「${article.title}」吗？删除后无法恢复。`, '删除文章', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }

  try {
    await deleteArticle(article.id)
    ElMessage.success('已删除')
    // 删掉当前页最后一条时往前退一页，避免停在空页
    if (list.value.length === 1 && page.value > 1) {
      changePage(page.value - 1)
    } else {
      await loadArticles()
    }
  } catch {
    ElMessage.error('删除失败')
  }
}

function goCreate() {
  void router.push({ name: RouteName.ARTICLE_CREATE })
}

watch([page, status], () => void loadArticles(), { immediate: true })
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

      <el-button type="primary" size="small" @click="goCreate">
        <el-icon class="cm-tab-list__btn-icon"><EditPen /></el-icon>
        写文章
      </el-button>
    </div>

    <p class="cm-tab-list__count">共 {{ total }} 篇</p>

    <!-- ==================== 列表 ==================== -->
    <div class="cm-tab-list__body">
      <LoadingState v-if="loading" variant="skeleton" :rows="5" with-cover />

      <ErrorState
        v-else-if="error"
        title="文章加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="loadArticles"
      />

      <EmptyState v-else-if="isEmpty" :title="emptyTitle" :description="emptyDesc" :size="80">
        <el-button v-if="status !== null" size="small" @click="switchTab(null)">看全部</el-button>
        <el-button v-else type="primary" plain size="small" @click="goCreate">写第一篇</el-button>
      </EmptyState>

      <ul v-else class="cm-tab-list__items">
        <li v-for="item in list" :key="item.id" class="cm-tab-list__item">
          <ArticleCard :article="item" show-cover show-status />

          <div class="cm-tab-list__ops">
            <RouterLink
              class="cm-tab-list__op"
              :to="{ name: RouteName.ARTICLE_EDIT, params: { id: String(item.id) } }"
              @click.stop
            >
              <el-icon :size="13"><EditPen /></el-icon>
              编辑
            </RouterLink>

            <button
              type="button"
              class="cm-tab-list__op cm-tab-list__op--danger"
              @click.stop="handleDelete(item)"
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

/* 操作区默认隐藏，悬停/聚焦时出现，避免列表过于嘈杂 */
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

.cm-tab-list__op:hover {
  color: var(--cm-accent-600);
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
  /* 窄屏没有 hover，操作区常驻显示 */
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
}
</style>
