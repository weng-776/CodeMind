<script setup lang="ts">
/**
 * 我的收藏
 * ------------------------------------------------------------------
 * 对应接口：
 *   3.12  我的收藏列表   GET    /api/user/favorites
 *   3.11  取消收藏       DELETE /api/article/{articleId}/favorite
 *
 * 设计取舍：
 *   取消收藏做成**乐观移除** —— 点一下卡片立刻从列表消失，不必等接口。
 *   失败再插回原位置。收藏列表本来就是「用户自己维护的清单」，
 *   删除后还要留在原地等一圈转圈，体感很差。
 *   插回时用 splice 还原下标，而不是 push 到末尾，保证顺序不乱。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import ArticleCard from '@/components/article/ArticleCard.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { getMyFavorites } from '@/api/favorite'
import { unfavoriteArticle } from '@/api/article'
import { RouteName } from '@/router/routes-names'
import type { ArticleListItemVO } from '@/types/article'

const route = useRoute()
const router = useRouter()

const PAGE_SIZE = 10

/* ==================== URL 派生状态 ==================== */

const page = computed(() => {
  const raw = route.query.page
  const v = Array.isArray(raw) ? raw[0] : raw
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 1
})

function changePage(next: number) {
  const query: Record<string, string> = {}
  if (next > 1) query.page = String(next)
  void router.push({ name: RouteName.MY_FAVORITES, query })
}

/* ==================== 列表数据 ==================== */

const list = ref<ArticleListItemVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)

/** 请求序号：丢弃过期响应 */
let requestSeq = 0

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

async function loadFavorites() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const res = await getMyFavorites({ page: page.value, size: PAGE_SIZE })

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

/* ==================== 取消收藏 ==================== */

/** 处理中的文章 id，避免重复点击 */
const pendingIds = ref<Set<number>>(new Set())

function isPending(id: number) {
  return pendingIds.value.has(id)
}

async function removeFavorite(article: ArticleListItemVO) {
  if (isPending(article.id)) return

  const index = list.value.findIndex((item) => item.id === article.id)
  if (index === -1) return

  setPending(article.id, true)

  // 乐观移除：先摘掉，失败再插回原位
  const removed = list.value.splice(index, 1)[0]
  total.value = Math.max(0, total.value - 1)

  try {
    await unfavoriteArticle(article.id)
    ElMessage.success('已取消收藏')
    // 当前页被摘空且不是第一页时，退一页
    if (list.value.length === 0 && page.value > 1) {
      changePage(page.value - 1)
    }
  } catch {
    // 插回原下标，保证顺序不变
    if (removed) list.value.splice(index, 0, removed)
    total.value += 1
    ElMessage.error('取消收藏失败')
  } finally {
    setPending(article.id, false)
  }
}

function setPending(id: number, on: boolean) {
  const next = new Set(pendingIds.value)
  if (on) next.add(id)
  else next.delete(id)
  pendingIds.value = next
}

function goCommunity() {
  void router.push({ name: RouteName.ARTICLE_LIST })
}

watch(page, () => void loadFavorites(), { immediate: true })
</script>

<template>
  <div class="cm-tab-list">
    <p class="cm-tab-list__count">共收藏 {{ total }} 篇文章</p>

    <div class="cm-tab-list__body">
      <LoadingState v-if="loading" variant="skeleton" :rows="5" with-cover />

      <ErrorState
        v-else-if="error"
        title="收藏列表加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="loadFavorites"
      />

      <EmptyState
        v-else-if="isEmpty"
        title="还没有收藏文章"
        description="在社区里遇到好文章，点一下收藏就会出现在这里"
        :size="80"
      >
        <el-button type="primary" plain size="small" @click="goCommunity">去社区看看</el-button>
      </EmptyState>

      <ul v-else class="cm-tab-list__items">
        <li v-for="item in list" :key="item.id" class="cm-tab-list__item">
          <ArticleCard :article="item" show-cover />

          <div class="cm-tab-list__ops">
            <button
              type="button"
              class="cm-tab-list__op cm-tab-list__op--danger"
              :disabled="isPending(item.id)"
              @click.stop="removeFavorite(item)"
            >
              <el-icon :size="13"><Delete /></el-icon>
              取消收藏
            </button>
          </div>
        </li>
      </ul>
    </div>

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
.cm-tab-list__count {
  margin: 0 0 var(--cm-space-2);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-tab-list__body {
  min-height: 200px;
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
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-tab-list__op:disabled {
  opacity: 0.5;
  cursor: default;
}

.cm-tab-list__op--danger:hover:not(:disabled) {
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
</style>
