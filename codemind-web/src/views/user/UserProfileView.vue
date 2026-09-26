<script setup lang="ts">
/**
 * 用户主页（他人主页）。接口：1.7 查看主页 ｜ 1.8 关注 ｜ 1.9 取消关注。
 *
 * 两个刻意的取舍：
 *   1. **不额外调 1.12 判断关注状态** —— 1.7 的响应里已经带 `isFollow`，再打一次纯属浪费。
 *      1.12 是给「详情接口不返回关注状态」的场景用的（如文章详情 3.4）。
 *   2. **不做「TA 的文章 / 笔记」列表** —— 文档里没有任何「按 userId 查内容」的接口
 *      （3.5 只接受 page/size，2.5 只返回当前登录用户的数据）。拿全站列表冒充是欺骗用户，
 *      所以这里老实说明 —— 页面上那个提示条就是为此存在。
 *
 * 失败分诊一律读 `ApiError.code`（禁止比 message 文本）：
 *   401 → 游客「登录后查看」，**不跳登录页**（路由 requiresAuth: false，允许游客停留）
 *   404 → 用户不存在 ｜ 其它 → 通用「加载失败 + 重试」
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { cancelFollow, followUser } from '@/api/follow'
import { getUserProfile } from '@/api/user'
import { ApiError } from '@/api/request'
import { useUserStore } from '@/stores/user'
import { RouteName } from '@/router/routes-names'
import { formatCount } from '@/utils/format'
import type { UserProfileVO } from '@/types/user'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/** 路由已用 `(\d+)` 约束，进来必然是数字串 */
const userId = computed(() => Number(route.params.userId))

const profile = ref<UserProfileVO | null>(null)
const loading = ref(true)
const error = ref(false)

/**
 * 失败错误码（`ApiError.code`）：业务失败 = 响应体 code，传输层失败 = HTTP 状态码。
 *
 * ⚠️ 这里是本页最容易写错的地方：早期版本读的是 `err.response?.status`，
 * 而请求层抛的是 `ApiError`（**没有 `response` 字段**），于是 `status` 恒为
 * `undefined`，401 / 404 全都掉进「加载失败」—— 游客打开用户主页看到的是
 * 「用户信息加载失败」，与 05 §3.2 的要求相反。
 */
const errorCode = ref<number | null>(null)

/** 目标用户不存在（404）—— 与「网络失败」区分开，文案不同 */
const notFound = computed(() => errorCode.value === 404)

/**
 * 需要登录（401）。
 *
 * ⚠️ 文档说 1.7「认证可选」，但真实后端的拦截器把 `/api/user/profile/**`
 * 也拦了，游客打开用户主页必然 401（联调实测 2026-09-16，2026-09-23 复核）。
 * 所以这里不能只当成「加载失败」，要如实告诉用户先登录 ——
 * 但**不能**把游客弹去登录页：路由是 requiresAuth: false，页面自己要能停在原地交代清楚。
 */
const needLogin = computed(() => errorCode.value === 401 && !userStore.isLoggedIn)

const followPending = ref(false)

/** 是否是自己的主页 */
const isSelf = computed(
  () => userStore.isLoggedIn && userStore.userId !== null && userStore.userId === userId.value,
)

const following = computed(() => profile.value?.isFollow === true)

const stats = computed(() => {
  const p = profile.value
  return [
    { key: 'article', label: '文章', value: p?.articleCount ?? 0 },
    { key: 'note', label: '笔记', value: p?.noteCount ?? 0 },
    { key: 'follow', label: '关注', value: p?.followCount ?? 0 },
    { key: 'fans', label: '粉丝', value: p?.fansCount ?? 0 },
  ]
})

const avatarFallback = computed(() => profile.value?.userName?.charAt(0) ?? '?')

/** 关注按钮文案 */
const followText = computed(() => (following.value ? '已关注' : '关注'))

/** 请求序号：快速切换 userId 时丢弃过期响应 */
let requestSeq = 0

async function loadProfile() {
  const seq = ++requestSeq
  loading.value = true
  error.value = false
  errorCode.value = null

  try {
    const data = await getUserProfile(userId.value)
    if (seq !== requestSeq) return
    profile.value = data
  } catch (err) {
    if (seq !== requestSeq) return
    profile.value = null
    // 请求层已统一提示，这里只负责把「要登录 / 不存在 / 加载失败」分开呈现
    errorCode.value = err instanceof ApiError ? err.code : null
    if (!notFound.value && !needLogin.value) error.value = true
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function requireLogin() {
  void router.push({
    name: RouteName.LOGIN,
    query: { redirect: route.fullPath },
  })
}

/** 关注 / 取消关注：乐观更新，失败回滚 */
async function toggleFollow() {
  if (!profile.value || followPending.value) return
  if (!userStore.isLoggedIn) return requireLogin()

  const target = userId.value
  const was = following.value

  followPending.value = true
  // 先改本地：点一下立刻有反馈，比转圈等接口好得多
  profile.value.isFollow = !was
  // 粉丝数同步跟着动，避免按钮变了数字没变
  profile.value.fansCount = Math.max(0, profile.value.fansCount + (was ? -1 : 1))

  try {
    if (was) await cancelFollow(target)
    else await followUser(target)
    ElMessage.success(was ? '已取消关注' : '已关注')
  } catch {
    // 回滚
    if (profile.value) {
      profile.value.isFollow = was
      profile.value.fansCount = Math.max(0, profile.value.fansCount + (was ? 1 : -1))
    }
    ElMessage.error(was ? '取消关注失败' : '关注失败')
  } finally {
    followPending.value = false
  }
}

function goMyProfile() {
  void router.push({ name: RouteName.MY_PROFILE })
}

/**
 * 自己的主页 → 编辑资料。
 *
 * 带 `?edit=1` 是为了「一键直达编辑表单」：个人中心的「我的主页」Tab 上
 * 挂着一个编辑资料弹窗，靠这个 query 自动打开，用户不用再找一次按钮。
 */
function goEditProfile() {
  void router.push({ name: RouteName.MY_PROFILE, query: { edit: '1' } })
}

function retry() {
  void loadProfile()
}

watch(userId, () => void loadProfile(), { immediate: true })
</script>

<template>
  <div class="cm-container cm-up">
    <!-- ==================== 加载 / 错误 ==================== -->
    <LoadingState v-if="loading" variant="spinner" text="加载用户信息" />

    <!--
      真实后端把 1.7 也放进了鉴权拦截器，游客拿不到用户主页数据。
      如实说明并给出登录入口，而不是伪装成「加载失败」，也不把游客弹去登录页。
    -->
    <div v-else-if="needLogin" class="cm-up__state">
      <EmptyState
        title="登录后查看"
        description="用户主页需要登录后才能查看，登录后会回到这个页面"
        :size="80"
      >
        <el-button type="primary" size="small" @click="requireLogin">立即登录</el-button>
        <el-button size="small" @click="router.back()">返回上一页</el-button>
      </EmptyState>
    </div>

    <div v-else-if="notFound" class="cm-up__state">
      <EmptyState
        title="用户不存在"
        description="这个用户可能已经注销，或者链接有误"
        :size="80"
      >
        <el-button size="small" @click="router.back()">返回上一页</el-button>
      </EmptyState>
    </div>

    <div v-else-if="error" class="cm-up__state">
      <ErrorState
        title="用户信息加载失败"
        description="可能是网络问题，或后端服务未启动"
        @retry="retry"
      />
    </div>

    <!-- ==================== 主体 ==================== -->
    <template v-else-if="profile">
      <header class="cm-up__header cm-panel">
        <el-avatar :size="80" :src="profile.avatar || undefined" class="cm-up__avatar">
          {{ avatarFallback }}
        </el-avatar>

        <div class="cm-up__ident">
          <h1 class="cm-up__name">{{ profile.userName }}</h1>
          <p class="cm-up__intro">{{ profile.intro || '这个人还没有填写简介' }}</p>
        </div>

        <div class="cm-up__actions">
          <!-- 自己的主页：给「编辑入口」，不是只让用户看自己的资料 -->
          <template v-if="isSelf">
            <el-button type="primary" @click="goEditProfile">
              <el-icon class="cm-up__btn-icon"><EditPen /></el-icon>
              编辑资料
            </el-button>
            <el-button @click="goMyProfile">去个人中心</el-button>
          </template>

          <el-button
            v-else
            :type="following ? 'default' : 'primary'"
            :loading="followPending"
            @click="toggleFollow"
          >
            <el-icon v-if="following" class="cm-up__btn-icon"><Select /></el-icon>
            {{ followText }}
          </el-button>
        </div>
      </header>

      <dl class="cm-up__stats">
        <div v-for="s in stats" :key="s.key" class="cm-up__stat">
          <dt>{{ s.label }}</dt>
          <dd>{{ formatCount(s.value) }}</dd>
        </div>
      </dl>

      <!--
        文档能力缺口说明。
        不写这一条的话，用户会以为「这个页面怎么什么都没有」是 bug；
        写清楚了才知道是接口没提供，而不是前端没做。
      -->
      <section class="cm-up__notice">
        <el-icon class="cm-up__notice-icon" :size="15"><InfoFilled /></el-icon>
        <div class="cm-up__notice-body">
          <p class="cm-up__notice-title">这里没有内容列表，是接口层面的限制</p>
          <p class="cm-up__notice-desc">
            接口文档未提供「按用户查询文章 / 笔记」的能力：3.5 文章列表只接受
            page / size，2.5 我的笔记只返回当前登录用户自己的数据。
            所以上方「文章 / 笔记」的计数来自 1.7 的统计字段，但无法列出具体条目。
            需要后端补充相应接口后，这个页面才能展示 TA 的作品。
          </p>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.cm-up {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

/* 整页状态（空 / 错）：给个最小高度，避免图标贴在顶栏下面 */
.cm-up__state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40vh;
}

/* ==================== 头部 ==================== */
.cm-up__header {
  display: flex;
  align-items: center;
  gap: var(--cm-space-5);
  padding: var(--cm-space-6);
}

.cm-up__avatar {
  flex-shrink: 0;
  font-size: var(--cm-font-size-2xl);
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-up__ident {
  flex: 1;
  min-width: 0;
}

.cm-up__name {
  margin: 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--cm-text-primary);
}

.cm-up__intro {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-base);
  color: var(--cm-text-tertiary);
}

.cm-up__actions {
  flex-shrink: 0;
}

.cm-up__btn-icon {
  margin-right: 4px;
}

/* ==================== 统计 ==================== */
.cm-up__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--cm-space-4);
  margin: var(--cm-space-5) 0 0;
  padding: var(--cm-space-5) var(--cm-space-6);
  background-color: var(--cm-bg-subtle);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
}

.cm-up__stat {
  text-align: center;
}

.cm-up__stat dt {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-up__stat dd {
  margin: var(--cm-space-1) 0 0;
  font-family: var(--cm-font-mono);
  font-size: var(--cm-font-size-xl);
  font-weight: 500;
  color: var(--cm-text-primary);
}

/* ==================== 缺口说明 ==================== */
.cm-up__notice {
  display: flex;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-6);
  padding: var(--cm-space-4) var(--cm-space-5);
  color: var(--cm-info);
  background-color: var(--cm-info-bg);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
}

.cm-up__notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.cm-up__notice-title {
  margin: 0;
  font-size: var(--cm-font-size-sm);
  font-weight: 600;
}

.cm-up__notice-desc {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  line-height: 1.7;
  color: var(--cm-text-tertiary);
}

/* ==================== 响应式 ==================== */
@media (max-width: 720px) {
  .cm-up__header {
    flex-wrap: wrap;
  }

  .cm-up__actions {
    width: 100%;
  }

  .cm-up__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--cm-space-5);
  }
}
</style>
