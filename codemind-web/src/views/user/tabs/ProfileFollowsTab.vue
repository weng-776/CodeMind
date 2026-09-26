<script setup lang="ts">
/**
 * 我的关注
 * ------------------------------------------------------------------
 * 对应接口：
 *   1.10  我的关注列表   GET    /api/user/follows   （分页）
 *   1.9   取消关注       DELETE /api/user/cancelFollow/{userId}  （硬删除）
 *
 * 取消关注要二次确认：1.9 是**硬删除**，没有撤销入口，误点就真没了。
 * 确认通过后走乐观移除（立刻从列表消失），失败插回原下标。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import UserListItem from '@/components/user/UserListItem.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { cancelFollow, getMyFollows } from '@/api/follow'
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
  void router.push({ name: RouteName.MY_FOLLOWS, query })
}

/* ==================== 列表数据 ==================== */

const list = ref<FollowUserVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)

/** 请求序号：丢弃过期响应 */
let requestSeq = 0

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

async function loadFollows() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const res = await getMyFollows({ page: page.value, size: PAGE_SIZE })

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

/* ==================== 取消关注 ==================== */

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

async function handleUnfollow(user: FollowUserVO) {
  if (isPending(user.id)) return

  try {
    await ElMessageBox.confirm(`确定不再关注「${user.userName}」吗？`, '取消关注', {
      confirmButtonText: '取消关注',
      cancelButtonText: '再想想',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }

  const index = list.value.findIndex((item) => item.id === user.id)
  if (index === -1) return

  setPending(user.id, true)

  // 乐观移除，失败插回原下标
  const removed = list.value.splice(index, 1)[0]
  total.value = Math.max(0, total.value - 1)

  try {
    await cancelFollow(user.id)
    ElMessage.success('已取消关注')
    if (list.value.length === 0 && page.value > 1) {
      changePage(page.value - 1)
    }
  } catch {
    if (removed) list.value.splice(index, 0, removed)
    total.value += 1
    ElMessage.error('取消关注失败')
  } finally {
    setPending(user.id, false)
  }
}

function goCommunity() {
  void router.push({ name: RouteName.ARTICLE_LIST })
}

watch(page, () => void loadFollows(), { immediate: true })
</script>

<template>
  <div class="cm-tab-list">
    <p class="cm-tab-list__count">共关注 {{ total }} 位用户</p>

    <div class="cm-tab-list__body">
      <LoadingState v-if="loading" variant="skeleton" :rows="5" />

      <ErrorState
        v-else-if="error"
        title="关注列表加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="loadFollows"
      />

      <EmptyState
        v-else-if="isEmpty"
        title="还没有关注任何人"
        description="在社区里看到喜欢的作者，关注后就能第一时间看到更新"
        :size="80"
      >
        <el-button type="primary" plain size="small" @click="goCommunity">去社区逛逛</el-button>
      </EmptyState>

      <div v-else class="cm-tab-list__users">
        <UserListItem
          v-for="user in list"
          :key="user.id"
          :user="user"
          time-label="关注于"
        >
          <template #action>
            <el-button
              size="small"
              :loading="isPending(user.id)"
              @click="handleUnfollow(user)"
            >
              取消关注
            </el-button>
          </template>
        </UserListItem>
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
