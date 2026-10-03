<script setup lang="ts">
/**
 * 管理后台 · 数据看板
 * ------------------------------------------------------------------
 * 接口：`GET /api/admin/dashboard/overview`（设计说明 §2.5）
 * 返回 12 个数字：6 个总量 + 6 个今日新增（「今日」按 **GMT+8**）。
 *
 * 几个刻意的取舍：
 *   1. **不做成传统 Admin**：`05_前端开发SOP` §6 明令禁止「左菜单 + 右表格 +
 *      卡片堆叠」。这里用站点自身的区块语言（`ContentSection` + 令牌变量），
 *      4 个管理页之间用分段控件切换（`AdminTabs`）。
 *   2. **「今日新增 0」是常态，不是空态**：实测库里今日就是 0 —— 照常显示 0，
 *      只是把 0 调成弱化色，绝不进 EmptyState（设计说明 §7 坑 12）。
 *   3. **数字不做 `formatCount` 缩写**：看板要的是精确值，验收也要逐项比对，
 *      写成「1.3万」既难核对也没意义。
 *   4. **403 态优先于 error 态**：后端 403 走的是 HTTP 403（§2.1），
 *      `request.ts` 会把 message 覆盖掉，所以文案由 `AdminForbidden` 自己写。
 *
 * 四态齐全：loading（骨架）/ empty（接口返回空）/ error（带重试）/ success。
 */
import { computed, onMounted, ref } from 'vue'

import ContentSection from '@/components/common/ContentSection.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import { getDashboardOverview } from '@/api/admin'
import { ApiError } from '@/api/request'
import { useUserStore } from '@/stores/user'
import type { DashboardOverviewVO } from '@/types/admin'
import AdminForbidden from './components/AdminForbidden.vue'
import AdminPageHead from './components/AdminPageHead.vue'
import AdminTabs from './components/AdminTabs.vue'

const userStore = useUserStore()

interface StatItem {
  /** 必须与接口字段同名，`data-stat` 也用它，便于逐项核对 */
  key: keyof DashboardOverviewVO
  label: string
}

/** 6 个总量（顺序即展示顺序） */
const TOTAL_STATS: StatItem[] = [
  { key: 'userCount', label: '用户' },
  { key: 'articleCount', label: '文章' },
  { key: 'noteCount', label: '笔记' },
  { key: 'commentCount', label: '评论' },
  { key: 'likeCount', label: '点赞' },
  { key: 'favoriteCount', label: '收藏' },
]

/** 6 个今日新增。⚠️ 接口**没有「今日关注数」**，别自己加维度 */
const TODAY_STATS: StatItem[] = [
  { key: 'todayUserCount', label: '新增用户' },
  { key: 'todayArticleCount', label: '新增文章' },
  { key: 'todayNoteCount', label: '新增笔记' },
  { key: 'todayCommentCount', label: '新增评论' },
  { key: 'todayLikeCount', label: '新增点赞' },
  { key: 'todayFavoriteCount', label: '新增收藏' },
]

const overview = ref<DashboardOverviewVO | null>(null)
const loading = ref(true)
const error = ref(false)
/** 无管理员权限（本地预检命中，或接口 403 兜底） */
const forbidden = ref(false)

/** 接口成功但没返回任何数据 —— 才是真的空态 */
const empty = computed(
  () => !loading.value && !error.value && !forbidden.value && overview.value === null,
)

/** 今日新增合计：用来给「今日全为 0」一个更直白的提示（不是空态） */
const todayTotal = computed(() => {
  const data = overview.value
  if (!data) return 0
  return TODAY_STATS.reduce((sum, item) => sum + (data[item.key] ?? 0), 0)
})

/** 取某个数字：未加载 / 字段缺失时兜 0，绝不显示 NaN 或 undefined */
function valueOf(key: keyof DashboardOverviewVO): number {
  return overview.value?.[key] ?? 0
}

async function load() {
  /*
   * 本地预检：`isAdmin` 为 false 时直接进 403 态，不发这次注定失败的请求。
   * 这不影响「接口 403 兜底」那条路 —— 降权后本地缓存仍是 admin，
   * 请求会真的发出去并拿到 403，由下面的 catch 处理。
   */
  if (!userStore.isAdmin) {
    forbidden.value = true
    error.value = false
    loading.value = false
    overview.value = null
    return
  }

  loading.value = true
  error.value = false
  forbidden.value = false
  try {
    overview.value = await getDashboardOverview()
  } catch (err) {
    // 一律判 err.code，**不要判 HTTP 状态码**（设计说明 §2.1）
    if (err instanceof ApiError && err.code === 403) {
      forbidden.value = true
    } else {
      error.value = true
    }
    overview.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="cm-admin cm-container">
    <AdminPageHead
      title="数据看板"
      description="站内累计与今日新增一览。数字来自后端实时统计，权限由后端判定。"
    />

    <AdminTabs class="cm-admin__tabs" />

    <!-- 无管理员权限：整块替换内容区（四态之外的第五态，必须存在） -->
    <AdminForbidden v-if="forbidden" />

    <template v-else>
      <!--
        两个区块共用**同一个请求**，所以错误态提到页面级只显示一次 ——
        否则会并排出现两个一模一样的「加载失败」。
        loading / empty 仍交给 ContentSection 各自渲染（多区块页的既定分工）。
      -->
      <ErrorState
        v-if="error"
        title="数据看板加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="load"
      />

      <template v-else>
        <ContentSection
          title="总量"
          subtitle="站内累计"
          :loading="loading"
          :empty="empty"
          empty-text="暂无统计数据"
          :skeleton-rows="2"
        >
          <ul class="cm-stat-grid">
            <li v-for="item in TOTAL_STATS" :key="item.key" class="cm-stat">
              <span class="cm-stat__label">{{ item.label }}</span>
              <span class="cm-stat__value" :data-stat="item.key">{{ valueOf(item.key) }}</span>
            </li>
          </ul>
        </ContentSection>

        <ContentSection
          title="今日新增"
          subtitle="按 GMT+8 统计"
          :loading="loading"
          :empty="empty"
          empty-text="暂无统计数据"
          :skeleton-rows="2"
        >
          <ul class="cm-stat-grid">
            <li v-for="item in TODAY_STATS" :key="item.key" class="cm-stat">
              <span class="cm-stat__label">{{ item.label }}</span>
              <span
                class="cm-stat__value"
                :class="{ 'is-zero': valueOf(item.key) === 0 }"
                :data-stat="item.key"
              >
                {{ valueOf(item.key) }}
              </span>
            </li>
          </ul>

          <!-- 全为 0 是常态：给一句解释，而不是把 0 当异常 -->
          <p v-if="todayTotal === 0" class="cm-stat__note">
            今日暂无新增。这一栏全为 0 属正常现象，不代表统计出错。
          </p>
        </ContentSection>
      </template>
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

/* ==================== 数字栅格 ==================== */
.cm-stat-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--cm-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.cm-stat {
  display: flex;
  flex-direction: column;
  gap: var(--cm-space-2);
  padding: var(--cm-space-4);
  background-color: var(--cm-bg-surface);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
  transition: border-color 0.15s ease;
}

.cm-stat:hover {
  border-color: var(--cm-border-default);
}

.cm-stat__label {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-stat__value {
  font-size: var(--cm-font-size-2xl);
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--cm-text-primary);
}

/* 今日为 0 时弱化，但**照样显示 0**（不隐藏、不进空态） */
.cm-stat__value.is-zero {
  color: var(--cm-text-quaternary);
}

.cm-stat__note {
  margin: var(--cm-space-4) 0 0;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

/* ==================== 响应式 ==================== */
@media (max-width: 1024px) {
  .cm-stat-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .cm-stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 480px) {
  .cm-stat__value {
    font-size: var(--cm-font-size-xl);
  }
}
</style>
