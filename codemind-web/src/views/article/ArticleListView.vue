<script setup lang="ts">
/**
 * 社区文章列表。四个 tab 与接口一一对应：
 *   3.18 最新（默认）｜ 3.17 热门 ｜ 3.5 列表 ｜ 3.19 标签文章（必须带 tagId）。
 *
 * 关于标签：2.12 `GET /api/tag/list` **是可用的**，但它**需要登录**，而本页对游客开放
 * （白名单含 article/list|hot|latest|tag/**）→ 所以不做标签云侧栏，否则游客进来会看到一块 401 空白。
 * 标签筛选入口是文章卡片上的标签：点一下带 tagId + tagName 跳过来，名字走 URL，不额外查接口。
 *
 * 关键设计：**URL 即唯一事实来源**。tab / page / tagId 全部从 route.query 派生读写访问器，
 * 组件不持有「真状态」→ 分享链接能完整还原、刷新不丢筛选、前进后退天然正确。
 *
 * 过期响应丢弃：快速连点 Tab 会并发多个请求，先发的可能后到。用自增序号标记每次请求，
 * 回来时若不是最新序号就直接 return，避免旧数据覆盖新数据。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import ArticleCard from '@/components/article/ArticleCard.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import {
  getArticleList,
  getArticlesByTag,
  getHotArticles,
  getLatestArticles,
} from '@/api/article'
import { useUserStore } from '@/stores/user'
import { RouteName } from '@/router/routes-names'
import type { ArticleListItemVO } from '@/types/article'
import type { PageResult } from '@/types/common'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

type TabKey = 'latest' | 'hot' | 'all' | 'tag'

/**
 * 可点击的三个 tab。
 * 「标签」不在这里：它必须带一个 tagId 才有意义（3.19 的路径参数），
 * 所以筛选态由 URL 驱动、以 pill 形式出现在 tab 行末尾（见模板）。
 */
const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'latest', label: '最新', hint: '按发布时间倒序' },
  { key: 'hot', label: '热门', hint: '按浏览量排序' },
  { key: 'all', label: '全部', hint: '全部公开文章' },
]

const PAGE_SIZE = 10

/* ==================== URL 派生状态 ==================== */

/** 从 URL 读标签 id：非法值一律视为「未选」 */
function readTagId(): number | null {
  const raw = route.query.tagId
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 当前 tab：非法值一律回落到 latest */
const tab = computed<TabKey>(() => {
  const raw = route.query.tab
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === 'hot') return 'hot'
  if (value === 'all') return 'all'
  if (value === 'tag') return 'tag'
  // 兼容只带 tagId 的链接（老链接、外部跳转）：有标签就按标签筛选。
  // 否则会静默落到「最新」，看起来像标签筛选失效。
  return readTagId() !== null ? 'tag' : 'latest'
})

/** 当前页码：非法值回落 1 */
const page = computed(() => {
  const raw = route.query.page
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : 1
})

/** 当前标签 id：无则在标签 tab 下视为未选 */
const tagId = computed<number | null>(readTagId)

/**
 * 当前标签名。
 * 后端没有标签列表接口，列表页无法由 id 反查名字，所以由跳转方（文章卡片 /
 * 文章详情页）把名字写进 URL。取不到时退回「标签 #id」，不至于显示空白。
 */
const tagName = computed(() => {
  const raw = route.query.tagName
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() ? value : null
})

/** 筛选态展示用的标签文案 */
const activeTagName = computed(() => {
  if (tab.value !== 'tag' || tagId.value === null) return null
  return tagName.value ?? `标签 #${tagId.value}`
})

/**
 * 构造查询串的唯一出口。
 * 默认值（latest / page=1）不写进 URL，保持地址简洁可读。
 */
function buildQuery(next: {
  tab?: TabKey
  page?: number
  tagId?: number | null
  tagName?: string | null
}): Record<string, string> {
  const nextTab = next.tab ?? tab.value
  const nextPage = next.page ?? page.value
  const nextTagId = next.tagId !== undefined ? next.tagId : tagId.value
  const nextTagName = next.tagName !== undefined ? next.tagName : tagName.value

  const query: Record<string, string> = {}
  if (nextTab !== 'latest') query.tab = nextTab
  // 选了标签必然切到 tag tab
  if (nextTab === 'tag' && nextTagId !== null) {
    query.tagId = String(nextTagId)
    if (nextTagName) query.tagName = nextTagName
  }
  if (nextPage > 1) query.page = String(nextPage)
  return query
}

/** 切换 tab：换 tab 一律回到第 1 页，保留标签 */
function switchTab(next: TabKey) {
  if (next === tab.value && page.value === 1) return
  void router.push({
    name: RouteName.ARTICLE_LIST,
    query: buildQuery({ tab: next, page: 1 }),
  })
}

/**
 * 取消标签筛选 → 回到「最新」第一页。
 * 标签筛选的「选中」入口不在这里：文章卡片 / 详情页的标签直接跳 URL，
 * 本页只负责把 URL 里的 tagId/tagName 渲染成筛选态并提供清除。
 */
function clearTagFilter() {
  void router.push({
    name: RouteName.ARTICLE_LIST,
    query: buildQuery({ tab: 'latest', page: 1, tagId: null, tagName: null }),
  })
}

/** 翻页：仅改 page，保留 tab 与标签 */
function changePage(next: number) {
  void router.push({
    name: RouteName.ARTICLE_LIST,
    query: buildQuery({ page: next }),
  })
}

/* ==================== 列表数据 ==================== */

/**
 * 列表接口的分页响应。
 * MyBatis-Plus 的 `Page` 原样返回，除了 `records/total/size/current` 还带 `pages`，
 * 但 `types/common.ts` 的 `PageResult` 只声明到 `current`（那个文件不在本单范围内，
 * 不能改），所以这里就地窄化一次，把 `pages` 补上。
 */
type ArticlePage = PageResult<ArticleListItemVO> & { current?: number; pages?: number }

const list = ref<ArticleListItemVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)

/**
 * 响应里的当前页与总页数。
 * 分页响应是 MyBatis-Plus 的 Page：`records / total / size / current / pages`，
 * **没有 `page` 字段** —— 所以分页器与热门榜序号一律用响应回来的 `current`，
 * 而不是 URL 里那个「我以为的页码」。
 */
const currentPage = ref(1)
const pages = ref(0)

/** 请求序号：用于丢弃过期响应 */
let requestSeq = 0

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

/**
 * 页码越界（手改 URL 到第 99 页这种）。
 * 判据全部来自**响应**：`pages` 是后端给的总页数，`page` 是 URL 里请求的那一页。
 * 库里文章只有一页时访问 page=2 就会命中这里 —— 给一个明确的「这一页没有内容」，
 * 而不是静默把 URL 改掉（URL 是事实来源，页面不该偷偷改写它）。
 */
const pageOutOfRange = computed(
  () => isEmpty.value && pages.value > 0 && page.value > pages.value,
)

/** 空状态文案：区分「这个标签下没有」与「整个社区还没有」 */
const emptyTitle = computed(() => {
  if (tab.value === 'tag' && tagId.value !== null) return '这个标签下还没有文章'
  if (tab.value === 'hot') return '还没有数据可供排序'
  return '社区里还没有文章'
})

const emptyDesc = computed(() => {
  if (tab.value === 'tag' && tagId.value !== null) return '换个标签看看，或者自己写一篇'
  return '发布第一篇文章，让大家看到你的技术沉淀'
})

async function loadArticles() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const params = { page: page.value, size: PAGE_SIZE }

    let res
    if (tab.value === 'hot') {
      res = await getHotArticles(params)
    } else if (tab.value === 'all') {
      res = await getArticleList(params)
    } else if (tab.value === 'tag' && tagId.value !== null) {
      res = await getArticlesByTag(tagId.value, params)
    } else {
      res = await getLatestArticles(params)
    }

    // 期间用户又切了筛选条件 —— 本次结果已过期，直接丢弃
    if (seq !== requestSeq) return

    const result = res as ArticlePage
    list.value = result.records ?? []
    total.value = result.total ?? 0
    currentPage.value = result.current && result.current > 0 ? result.current : page.value
    pages.value = result.pages ?? 0
  } catch {
    if (seq !== requestSeq) return
    error.value = true
    list.value = []
    total.value = 0
    currentPage.value = page.value
    pages.value = 0
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/* ==================== 其他交互 ==================== */

function goCreate() {
  if (!userStore.isLoggedIn) {
    void router.push({
      name: RouteName.LOGIN,
      query: { redirect: router.resolve({ name: RouteName.ARTICLE_CREATE }).fullPath },
    })
    return
  }
  void router.push({ name: RouteName.ARTICLE_CREATE })
}

function retry() {
  void loadArticles()
}

/* ==================== 副作用 ==================== */

// tab / page / tagId 任一变化都要重新拉数据。
// 三者都是从 URL 派生的 computed，所以「改 URL」和「点 UI」走的是同一条路径。
watch(
  [tab, page, tagId],
  () => {
    void loadArticles()
  },
  { immediate: true },
)
</script>

<template>
  <div class="cm-container cm-article-list">
    <!-- ==================== 页头 ==================== -->
    <header class="cm-article-list__head">
      <div class="cm-article-list__head-text">
        <h1 class="cm-article-list__title">社区</h1>
        <p class="cm-article-list__subtitle">
          <template v-if="tab === 'tag'">
            <!-- 名字来自 URL；直接手敲 tagId 进来时没有名字，就别硬凑「标签「标签 #3」」 -->
            <template v-if="tagName">标签「{{ tagName }}」下的文章</template>
            <template v-else>该标签下的文章</template>
          </template>
          <template v-else-if="tab === 'hot'">按浏览量排序的技术文章</template>
          <template v-else-if="tab === 'all'">全部公开文章</template>
          <template v-else>开发者们的技术沉淀与经验分享</template>
        </p>
      </div>

      <el-button type="primary" @click="goCreate">
        <el-icon class="cm-article-list__btn-icon"><EditPen /></el-icon>
        写文章
      </el-button>
    </header>

    <div class="cm-article-list__main">
      <!-- Tab -->
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

        <!-- 标签筛选态也占一个 tab 位，便于一眼看出当前在被筛选 -->
        <span v-if="tab === 'tag'" class="cm-tabs__item is-active is-tag" role="tab" aria-selected="true">
          <el-icon :size="12"><PriceTag /></el-icon>
          {{ activeTagName }}
          <button
            type="button"
            class="cm-tabs__close"
            aria-label="取消标签筛选"
            @click="clearTagFilter()"
          >
            <el-icon :size="11"><Close /></el-icon>
          </button>
        </span>
      </div>

      <!-- 列表主体 -->
      <div class="cm-article-list__body">
        <LoadingState v-if="loading" variant="skeleton" :rows="6" with-cover />

        <ErrorState
          v-else-if="error"
          title="文章列表加载失败"
          description="可能是网络问题，或后端服务未启动"
          @retry="retry"
        />

        <!-- 页码越界：不是「社区没文章」，而是请求的那一页确实没有内容 -->
        <EmptyState
          v-else-if="pageOutOfRange"
          title="这一页没有内容"
          :description="`当前共 ${pages} 页，你请求的是第 ${page} 页`"
          :size="80"
        >
          <el-button size="small" plain @click="changePage(1)">回到第 1 页</el-button>
        </EmptyState>

        <EmptyState v-else-if="isEmpty" :title="emptyTitle" :description="emptyDesc" :size="80">
          <el-button size="small" @click="goCreate">写第一篇</el-button>
        </EmptyState>

        <div v-else class="cm-article-list__items">
          <ArticleCard
            v-for="(item, index) in list"
            :key="item.id"
            :article="item"
            :rank="tab === 'hot' ? (currentPage - 1) * PAGE_SIZE + index + 1 : 0"
            show-cover
          />
        </div>
      </div>

      <!-- 分页 -->
      <div v-if="!loading && !error && total > PAGE_SIZE" class="cm-article-list__pager">
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
    </div>
  </div>
</template>

<style scoped>
.cm-article-list {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

/* ==================== 页头 ==================== */
.cm-article-list__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--cm-space-6);
  padding-bottom: var(--cm-space-5);
}

.cm-article-list__title {
  margin: 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-article-list__subtitle {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

.cm-article-list__btn-icon {
  margin-right: 4px;
}

/* ==================== 主体 ==================== */
.cm-article-list__main {
  min-width: 0;
}

/* ==================== Tab ==================== */
.cm-tabs {
  display: flex;
  align-items: center;
  gap: var(--cm-space-1);
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

/* 下划线压在容器边框上，形成"选中"指示 */
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

/* 标签筛选态：pill 样式，与普通 tab 区分 */
.cm-tabs__item.is-tag {
  margin-left: var(--cm-space-2);
  padding: 3px var(--cm-space-2) 3px var(--cm-space-3);
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
  border: 1px solid var(--cm-accent-200);
  border-radius: var(--cm-radius-full);
  cursor: default;
}

.cm-tabs__item.is-tag::after {
  display: none;
}

.cm-tabs__item.is-tag:hover {
  color: var(--cm-accent-700);
}

.cm-tabs__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  color: var(--cm-accent-600);
  background: none;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.cm-tabs__close:hover {
  background-color: var(--cm-accent-100);
}

/* ==================== 列表 ==================== */
.cm-article-list__body {
  min-height: 240px;
}

.cm-article-list__items :deep(.cm-article-card) {
  padding-left: var(--cm-space-2);
  padding-right: var(--cm-space-2);
}

.cm-article-list__pager {
  display: flex;
  justify-content: center;
  padding-top: var(--cm-space-8);
}

/* ==================== 响应式 ==================== */
@media (max-width: 860px) {
  .cm-article-list__head {
    align-items: flex-start;
  }
}

@media (max-width: 480px) {
  .cm-article-list__head {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-tabs__item {
    padding: var(--cm-space-3) var(--cm-space-3);
  }
}
</style>
