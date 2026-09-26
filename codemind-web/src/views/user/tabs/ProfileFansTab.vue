<script setup lang="ts">
/**
 * 我的粉丝
 * ------------------------------------------------------------------
 * 对应接口：
 *   1.11  我的粉丝列表   GET /api/user/fans   （分页）
 *
 * 为什么这里**没有**「回关」按钮？
 *   1.11 的 records 是 FollowUserVO，里面**不含 isFollow**，也就是说
 *   后端没有告诉前端「这个人我是否已经关注了」。
 *
 *   两个看起来可行的替代方案都不成立：
 *     - 默认渲染成「未关注」→ 对已经互关的人显示错误状态，是在骗用户；
 *     - 对每一行都调一次 1.12 判断关注状态 → 一页 10 行就是 10 个额外请求，
 *       列表页打 N+1 个接口不可接受。
 *
 *   所以这里只展示信息 + 可点进主页。对方主页走 1.7，那里的 `isFollow` 是
 *   权威的，关注/取关在那边操作一定正确。这是「宁可少一个按钮，也不显示错状态」
 *   的取舍，页面顶部的提示条把这件事告诉了用户。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import UserListItem from '@/components/user/UserListItem.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { getMyFans } from '@/api/follow'
import { RouteName } from '@/router/routes-names'
import type { FollowUserVO } from '@/types/user'

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
  void router.push({ name: RouteName.MY_FANS, query })
}

/* ==================== 列表数据 ==================== */

const list = ref<FollowUserVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)

/** 请求序号：丢弃过期响应 */
let requestSeq = 0

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

async function loadFans() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const res = await getMyFans({ page: page.value, size: PAGE_SIZE })

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

function goCommunity() {
  void router.push({ name: RouteName.ARTICLE_LIST })
}

watch(page, () => void loadFans(), { immediate: true })
</script>

<template>
  <div class="cm-tab-list">
    <p class="cm-tab-list__count">共 {{ total }} 位粉丝</p>

    <!--
      能力说明：不是忘了做按钮，而是接口没给关注状态。
      不写清楚的话，用户会以为是 bug。
    -->
    <p class="cm-tab-list__hint">
      <el-icon :size="13"><InfoFilled /></el-icon>
      粉丝列表接口（1.11）不返回「是否已关注」，所以这里不显示关注按钮。
      点进对方主页即可关注或取关 —— 那里用 1.7 返回的关注状态，是准确的。
    </p>

    <div class="cm-tab-list__body">
      <LoadingState v-if="loading" variant="skeleton" :rows="5" />

      <ErrorState
        v-else-if="error"
        title="粉丝列表加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="loadFans"
      />

      <EmptyState
        v-else-if="isEmpty"
        title="还没有粉丝"
        description="多写点东西，被更多人看到就会有人关注你了"
        :size="80"
      >
        <el-button type="primary" plain size="small" @click="goCommunity">去写一篇</el-button>
      </EmptyState>

      <div v-else class="cm-tab-list__users">
        <UserListItem
          v-for="user in list"
          :key="user.id"
          :user="user"
          time-label="成为粉丝于"
        />
      </div>
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

.cm-tab-list__hint {
  display: flex;
  align-items: flex-start;
  gap: var(--cm-space-2);
  margin: 0 0 var(--cm-space-4);
  padding: var(--cm-space-3) var(--cm-space-4);
  font-size: var(--cm-font-size-xs);
  line-height: 1.7;
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-subtle);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-md);
}

.cm-tab-list__hint .el-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--cm-text-quaternary);
}

.cm-tab-list__body {
  min-height: 200px;
}

.cm-tab-list__users {
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
  overflow: hidden;
}

.cm-tab-list__pager {
  display: flex;
  justify-content: center;
  padding-top: var(--cm-space-8);
}
</style>
