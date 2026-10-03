<script setup lang="ts">
/**
 * 管理后台 · 用户治理
 * ------------------------------------------------------------------
 * 接口（设计说明 §2.2）：
 *   GET /api/admin/users?page&size&keyword        → Page<AdminUserVO>
 *   PUT /api/admin/users/{userId}/status?status=0|1
 *
 * 关键设计：
 *   1. **URL 即唯一事实来源**：`page` / `keyword` 都从 `route.query` 派生，
 *      组件不持有第二份"真状态"。好处是分享链接能还原、刷新不丢筛选、
 *      前进/后退天然正确（与 ArticleListView 同一套做法）。
 *   2. **过期响应丢弃**：快速连打搜索时会并发多个请求，先发的可能后到。
 *      用自增序号标记，回来时不是最新序号就直接 return。
 *   3. **封禁是危险操作**：二次确认，文案**如实说明后果**（「该用户将无法登录」）。
 *      解封是「恢复访问」、不具破坏性，按 §3.2 只对封禁做二次确认。
 *   4. **管理员自己那行禁用操作**：后端会返回 400「不能修改自己的账号状态」，
 *      前端提前拦更友好（§7 坑 9）。判据是 `userStore.userId`（从 JWT 取）。
 *   5. **不做乐观更新**：封禁/解封失败时"界面已变、后端没变"是最糟的结果；
 *      这里等接口成功后再改本地那一行（`patchStatus`），失败就什么都不动。
 *
 * ⚠️ 页面头部的样式与 `AdminDashboardView` 是**刻意的重复**：`.vue` 的 `<style scoped>`
 *    不能跨文件复用，而本单范围只允许新增 `AdminUserView.vue`（不能回头改 T16 的文件）。
 *    重复的是十几行排版样式，换来 4 个管理页渲染完全一致，值得。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import EmptyState from '@/components/common/EmptyState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import { getAdminUsers, updateAdminUserStatus } from '@/api/admin'
import { ApiError } from '@/api/request'
import { RouteName } from '@/router/routes-names'
import { useUserStore } from '@/stores/user'
import { UserRole, UserStatus, type AdminUserVO } from '@/types/admin'
import { formatDateTime } from '@/utils/format'
import AdminForbidden from './components/AdminForbidden.vue'
import AdminPageHead from './components/AdminPageHead.vue'
import AdminTabs from './components/AdminTabs.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/** 每页条数：后端上限 50、下限 1，这里固定 10（与站点其它列表一致） */
const PAGE_SIZE = 10
/** 搜索防抖：与笔记列表同一档（300ms），避免每敲一个字就打一次接口 */
const SEARCH_DEBOUNCE_MS = 300

/* ==================== URL 派生状态 ==================== */

/** 当前页码：非法值回落 1（后端 page<1 会 400） */
const page = computed(() => {
  const raw = route.query.page
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : 1
})

/** 当前搜索词：非字符串一律视为未搜索 */
const keyword = computed(() => {
  const raw = route.query.keyword
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
})

/**
 * 构造查询串的唯一出口。
 * 默认值（page=1、空 keyword）不写进 URL，保持地址简洁可读。
 */
function buildQuery(next: { page?: number; keyword?: string }): Record<string, string> {
  const nextPage = next.page ?? page.value
  const nextKeyword = next.keyword !== undefined ? next.keyword : keyword.value

  const query: Record<string, string> = {}
  if (nextKeyword) query.keyword = nextKeyword
  if (nextPage > 1) query.page = String(nextPage)
  return query
}

/* ==================== 列表数据 ==================== */

const list = ref<AdminUserVO[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)
/** 无管理员权限（本地预检命中，或接口 403 兜底） */
const forbidden = ref(false)

/** 响应回来的当前页与总页数（MyBatis-Plus Page 没有 `page` 字段，一律读 `current`） */
const currentPage = ref(1)
const pages = ref(0)

/** 请求序号：丢弃过期响应 */
let requestSeq = 0
/** 正在提交状态的用户 id（该行按钮转 loading，防重复点击） */
const togglingId = ref<number | null>(null)

const isEmpty = computed(() => !loading.value && !error.value && list.value.length === 0)

/** 页码越界（手改 URL 到第 99 页这种）：判据全部来自响应，不偷偷改写 URL */
const pageOutOfRange = computed(
  () => isEmpty.value && pages.value > 0 && page.value > pages.value,
)

const emptyTitle = computed(() => (keyword.value ? '没有匹配的用户' : '还没有用户'))
const emptyDesc = computed(() =>
  keyword.value ? `没有找到与「${keyword.value}」匹配的手机号或昵称` : '站内还没有注册用户',
)

async function loadUsers() {
  /*
   * 本地预检：已知非管理员 → 直接 403 态，不发这次注定失败的请求。
   * 降权后本地缓存仍是 admin，请求会真的发出去并拿到 403，由 catch 兜底。
   */
  if (!userStore.isAdmin) {
    forbidden.value = true
    error.value = false
    loading.value = false
    list.value = []
    total.value = 0
    return
  }

  const seq = ++requestSeq
  loading.value = true
  error.value = false

  try {
    const res = await getAdminUsers({
      page: page.value,
      size: PAGE_SIZE,
      keyword: keyword.value || undefined,
    })

    // 期间用户又改了筛选条件 —— 本次结果已过期，直接丢弃
    if (seq !== requestSeq) return

    list.value = res.records ?? []
    total.value = res.total ?? 0
    currentPage.value = res.current && res.current > 0 ? res.current : page.value
    pages.value = res.pages ?? 0
  } catch (err) {
    if (seq !== requestSeq) return
    // 一律判 err.code，**不要判 HTTP 状态码**（403 是 HTTP 403，400/404 是 HTTP 200 + code）
    if (err instanceof ApiError && err.code === 403) {
      forbidden.value = true
    } else {
      error.value = true
    }
    list.value = []
    total.value = 0
    currentPage.value = page.value
    pages.value = 0
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/* ==================== 搜索 ==================== */

/** 输入框的即时值（不等防抖，否则打字会卡）；URL 才是提交后的真状态 */
const keywordInput = ref(keyword.value)
let searchTimer: ReturnType<typeof setTimeout> | undefined

// URL 被外部改动（前进/后退、清空筛选）时同步回输入框
watch(keyword, (value) => {
  keywordInput.value = value
})

function commitKeyword(next: string) {
  const trimmed = next.trim()
  if (trimmed === keyword.value && page.value === 1) return
  // 换搜索词一律回到第 1 页
  void router.push({
    name: RouteName.ADMIN_USERS,
    query: buildQuery({ keyword: trimmed, page: 1 }),
  })
}

function onKeywordInput(value: string) {
  keywordInput.value = value
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => commitKeyword(value), SEARCH_DEBOUNCE_MS)
}

/** 点「×」清空：立即生效，不等防抖 */
function onKeywordClear() {
  if (searchTimer) clearTimeout(searchTimer)
  keywordInput.value = ''
  commitKeyword('')
}

function changePage(next: number) {
  void router.push({ name: RouteName.ADMIN_USERS, query: buildQuery({ page: next }) })
}

/* ==================== 封禁 / 解封 ==================== */

/** 是不是当前登录用户自己 —— 后端禁止改自己的状态，前端提前禁用 */
function isSelf(row: AdminUserVO): boolean {
  return userStore.userId !== null && row.id === userStore.userId
}

function isBanned(row: AdminUserVO): boolean {
  return row.status === UserStatus.DISABLED
}

/** 就地改本地那一行的状态（用下标替换，避免"改了原始对象不触发渲染"的坑） */
function patchStatus(userId: number, status: number) {
  const index = list.value.findIndex((item) => item.id === userId)
  const current = index >= 0 ? list.value[index] : undefined
  if (current) list.value[index] = { ...current, status }
}

async function toggleStatus(row: AdminUserVO) {
  const banning = !isBanned(row)

  // 只有封禁做二次确认：它会让用户**无法登录**，是不可忽视的后果。
  // 解封是恢复访问，不具破坏性（§3.2 只要求封禁按钮二次确认）。
  if (banning) {
    try {
      await ElMessageBox.confirm(
        `确认封禁用户「${row.userName}」？该用户将无法登录。`,
        '封禁用户',
        { confirmButtonText: '封禁', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return // 用户取消
    }
  }

  togglingId.value = row.id
  try {
    await updateAdminUserStatus(row.id, banning ? UserStatus.DISABLED : UserStatus.NORMAL)
    patchStatus(row.id, banning ? UserStatus.DISABLED : UserStatus.NORMAL)
    ElMessage.success(banning ? `已封禁「${row.userName}」` : `已解封「${row.userName}」`)
  } catch {
    /*
     * 失败时**不动本地状态**，界面与后端保持一致。
     * 请求层已按 code 统一提示（如封自己 → 400「不能修改自己的账号状态」）。
     */
  } finally {
    togglingId.value = null
  }
}

/* ==================== 副作用 ==================== */

watch(
  [page, keyword],
  () => {
    void loadUsers()
  },
  { immediate: true },
)
</script>

<template>
  <div class="cm-admin cm-container">
    <AdminPageHead
      title="用户治理"
      description="查看站内用户，按手机号或昵称搜索，并可封禁 / 解封账号。权限由后端判定。"
    />

    <AdminTabs class="cm-admin__tabs" />

    <!-- 无管理员权限：整块替换内容区 -->
    <AdminForbidden v-if="forbidden" />

    <template v-else>
      <!-- 工具条 -->
      <div class="cm-user-toolbar">
        <el-input
          :model-value="keywordInput"
          class="cm-user-toolbar__search"
          placeholder="搜索手机号或昵称"
          clearable
          :disabled="loading || error"
          @input="onKeywordInput"
          @clear="onKeywordClear"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <span class="cm-user-toolbar__count">
          <template v-if="loading">加载中…</template>
          <template v-else-if="keyword">匹配到 {{ total }} 位用户</template>
          <template v-else>共 {{ total }} 位用户</template>
        </span>
      </div>

      <!-- 错误态：带重试 -->
      <ErrorState
        v-if="error"
        title="用户列表加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="loadUsers"
      />

      <div v-else class="cm-user-panel">
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

        <div v-else class="cm-user-table-scroll">
          <table class="cm-user-table">
            <thead>
              <tr>
                <th scope="col">用户</th>
                <th scope="col">手机号</th>
                <th scope="col">角色</th>
                <th scope="col">状态</th>
                <th scope="col">注册时间</th>
                <th scope="col" class="cm-user-table__th-action">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in list" :key="row.id" :class="{ 'is-banned': isBanned(row) }">
                <td>
                  <div class="cm-user-cell">
                    <!--
                      头像必须能加载失败兜底：测试数据里的 Default_avatar.jpg 在 MinIO 上是 404。
                      el-avatar 的默认插槽就是「加载失败 / 无 src 时」的兜底内容。
                    -->
                    <el-avatar
                      :size="34"
                      :src="row.avatar || undefined"
                      class="cm-user-cell__avatar"
                    >
                      {{ row.userName?.charAt(0) ?? '?' }}
                    </el-avatar>
                    <div class="cm-user-cell__text">
                      <span class="cm-user-cell__name">{{ row.userName }}</span>
                      <span v-if="row.intro" class="cm-user-cell__intro cm-line-clamp-1">
                        {{ row.intro }}
                      </span>
                    </div>
                  </div>
                </td>

                <td class="cm-user-table__mono">{{ row.phone }}</td>

                <td>
                  <span v-if="row.role === UserRole.ADMIN" class="cm-badge cm-badge--admin">
                    管理员
                  </span>
                  <span v-else class="cm-badge">普通用户</span>
                </td>

                <td>
                  <span v-if="isBanned(row)" class="cm-badge cm-badge--danger">已封禁</span>
                  <span v-else class="cm-badge cm-badge--success">正常</span>
                </td>

                <td class="cm-user-table__time">{{ formatDateTime(row.createTime) }}</td>

                <td class="cm-user-table__td-action">
                  <!-- 自己那行禁用：后端会 400「不能修改自己的账号状态」 -->
                  <el-tooltip v-if="isSelf(row)" content="不能修改自己的账号状态" placement="top">
                    <span class="cm-user-table__disabled-hit">
                      <el-button size="small" plain disabled>封禁</el-button>
                    </span>
                  </el-tooltip>

                  <el-button
                    v-else
                    size="small"
                    :type="isBanned(row) ? 'primary' : 'danger'"
                    plain
                    :loading="togglingId === row.id"
                    @click="toggleStatus(row)"
                  >
                    {{ isBanned(row) ? '解封' : '封禁' }}
                  </el-button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 分页 -->
      <div v-if="!loading && !error && total > PAGE_SIZE" class="cm-user-pager">
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

/* ==================== 工具条 ==================== */
.cm-user-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-4);
  margin-top: var(--cm-space-6);
  padding-bottom: var(--cm-space-4);
}

.cm-user-toolbar__search {
  max-width: 320px;
}

.cm-user-toolbar__count {
  flex-shrink: 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-quaternary);
  font-variant-numeric: tabular-nums;
}

/* ==================== 表格 ==================== */
.cm-user-panel {
  min-height: 260px;
}

/* 窄屏横向滚动，而不是把表格压变形 */
.cm-user-table-scroll {
  overflow-x: auto;
}

.cm-user-table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  font-size: var(--cm-font-size-sm);
}

.cm-user-table th {
  padding: var(--cm-space-3);
  font-size: var(--cm-font-size-xs);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  color: var(--cm-text-quaternary);
  border-bottom: 1px solid var(--cm-border-default);
}

.cm-user-table td {
  padding: var(--cm-space-3);
  vertical-align: middle;
  color: var(--cm-text-secondary);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-user-table tbody tr {
  transition: background-color 0.15s ease;
}

.cm-user-table tbody tr:hover {
  background-color: var(--cm-bg-hover);
}

/* 已封禁的行整体弱化，扫一眼就能分辨 */
.cm-user-table tbody tr.is-banned td {
  color: var(--cm-text-quaternary);
}

.cm-user-table__mono {
  font-family: var(--cm-font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cm-user-table__time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.cm-user-table__th-action,
.cm-user-table__td-action {
  text-align: right;
}

.cm-user-table__disabled-hit {
  display: inline-flex;
}

/* ==================== 用户单元格 ==================== */
.cm-user-cell {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  min-width: 0;
}

.cm-user-cell__avatar {
  flex-shrink: 0;
  font-size: var(--cm-font-size-sm);
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-user-cell__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.cm-user-cell__name {
  font-size: var(--cm-font-size-base);
  font-weight: 500;
  color: var(--cm-text-primary);
}

.cm-user-cell__intro {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  max-width: 26ch;
}

/* ==================== 标签 ==================== */
.cm-badge {
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

.cm-badge--admin {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
  border-color: var(--cm-accent-200);
}

.cm-badge--success {
  color: var(--cm-success);
  background-color: var(--cm-success-bg);
  border-color: var(--cm-success-border);
}

.cm-badge--danger {
  color: var(--cm-danger);
  background-color: var(--cm-danger-bg);
  border-color: var(--cm-danger-border);
}

/* ==================== 分页 ==================== */
.cm-user-pager {
  display: flex;
  justify-content: center;
  padding-top: var(--cm-space-8);
}

/* ==================== 响应式 ==================== */
@media (max-width: 640px) {
  .cm-user-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-user-toolbar__search {
    max-width: none;
  }

  .cm-user-toolbar__count {
    text-align: right;
  }
}
</style>
