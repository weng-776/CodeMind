<script setup lang="ts">
/**
 * 文章详情页。接口：3.4 详情 ｜ 3.7/3.8 点赞 ｜ 3.10/3.11 收藏 ｜
 * 3.13 评论与回复 ｜ 3.15 删评论 ｜ 3.16 评论列表 ｜ 3.20 回复列表 ｜
 * 1.8/1.9/1.12 关注作者与关注状态 ｜ AI 总结·知识点·面试题（走 useAiContext）。
 *
 * 关键设计：
 *   1. 详情响应自带 isLiked / isFavorited，首屏不必再打 2 个状态接口；
 *      关注状态只在登录态下查，未登录跳过（省一次 401）。
 *   2. 点赞 / 收藏走乐观更新：先改本地数字与标记，失败回滚。
 *   3. 自己的文章不显示关注按钮，改显示「编辑」。
 *   4. 评论只有两层；每个根内联带前 2 条回复，其余走 3.20「查看全部 N 条回复」按需拉。
 *   5. **失败提示只由请求层负责**：本页写请求都带 token，请求层一定会弹后端 message
 *      （比页面自造的「点赞失败」更具体）。这里只做回滚与收尾，不再弹 —— 否则会看到两条提示。
 *      唯一例外是剪贴板失败（不是网络请求，请求层不管）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import MarkdownViewer from '@/components/common/MarkdownViewer.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import AiContextPanel from '@/components/ai/AiContextPanel.vue'

import {
  createComment,
  deleteArticle,
  favoriteArticle,
  getArticleDetail,
  getCommentList,
  getCommentReplies,
  likeArticle,
  unfavoriteArticle,
  unlikeArticle,
} from '@/api/article'
import { ApiError } from '@/api/request'
import { deleteComment } from '@/api/comment'
import { cancelFollow, followUser, getFollowStatus } from '@/api/follow'
import { useUserStore } from '@/stores/user'
import { useAiContext, AI_ACTIONS, AI_ACTION_LABELS } from '@/composables/useAiContext'
import { RouteName } from '@/router/routes-names'
import type { ArticleDetailVO } from '@/types/article'
import type { CommentVO } from '@/types/comment'
import { formatDateTime, formatCount, estimateReadingMinutes } from '@/utils/format'

/*
 * 3.16 的真实出参已在 types/comment.ts 里对齐（T4.5 完成）：
 *   每个一级评论带 `replies`（**前 2 条**回复）+ `replyCount`（该根回复总数），
 *   元素可含 `replyUser`（被回复人；null = 直接回复文章作者，前端不渲染 @）。
 *   层级固定两层：`replies` 里的元素恒不含 replies / replyCount。
 *
 * 保留这个别名纯粹为了可读性 —— `CommentNode` 在模板与函数签名里用了十几处。
 */
type CommentNode = CommentVO

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/** 路由参数 id：路由已用 `(\\d+)` 约束，进来必然是数字串 */
const articleId = computed(() => Number(route.params.id))

/* ==================== 详情数据 ==================== */

const article = ref<ArticleDetailVO | null>(null)
const loading = ref(true)
const error = ref(false)

/**
 * 失败时的错误码（`ApiError.code`）—— 本页的状态分诊依据。
 * **禁止比 message 文本**（后端一改文案就失效）：
 *   401 → 游客：显示「登录后查看」，不跳登录页（详情页允许游客停留）
 *   404 → 文章不存在或已删除 ｜ 403 → 草稿之类别人无权看的 ｜ 其它 → 通用「加载失败 + 重试」
 */
const errorCode = ref<number | null>(null)

/** 游客访问：详情接口对未登录返回 401（白名单里没有 /article/{id}） */
const needLogin = computed(() => error.value && errorCode.value === 401 && !userStore.isLoggedIn)

const errorTitle = computed(() => {
  if (errorCode.value === 404) return '文章不存在或已删除'
  if (errorCode.value === 403) return '无权访问这篇文章'
  return '文章加载失败'
})

const errorDesc = computed(() => {
  if (errorCode.value === 403) return '草稿只有作者本人可以查看'
  if (errorCode.value === 404) return '它可能已被作者删除'
  return '可能是网络问题，或后端服务未启动'
})

/** 是否为当前用户自己的文章 */
const isAuthor = computed(() => {
  const uid = userStore.userId
  return uid !== null && article.value?.user?.id === uid
})

const readingMinutes = computed(() => estimateReadingMinutes(article.value?.content))

/**
 * 可见标签全部展示（详情页不像列表页那样需要截断）。
 * 过滤掉后端返回的 { id: null, name: null } 占位元素，避免渲染出空胶囊、
 * 以及点到「tagId=null」的无效筛选。
 */
const tags = computed(() => (article.value?.tags ?? []).filter((t) => t?.id != null && !!t.name))

/**
 * 头部三个指标。
 * 注意：详情响应（3.4）**不返回 commentCount**，文档里只有 viewCount / likeCount /
 * favoriteCount。评论数只能由评论列表的 total 提供，因此这里单独取 commentsTotal。
 */
const metrics = computed(() => {
  const a = article.value
  if (!a) return []
  return [
    { key: 'view', label: '浏览', value: formatCount(a.viewCount) },
    { key: 'like', label: '点赞', value: formatCount(a.likeCount) },
    { key: 'favorite', label: '收藏', value: formatCount(a.favoriteCount) },
    { key: 'comment', label: '评论', value: formatCount(commentsTotal.value) },
  ]
})

async function loadArticle() {
  loading.value = true
  error.value = false
  errorCode.value = null
  try {
    const data = await getArticleDetail(articleId.value)
    article.value = data
    // 详情加载完再拉关注状态（依赖作者 id，且只有登录态才需要）
    void loadFollowStatus()
  } catch (err) {
    error.value = true
    errorCode.value = err instanceof ApiError ? err.code : null
    article.value = null
  } finally {
    loading.value = false
  }
}

/* ==================== 点赞 / 收藏（乐观更新） ==================== */

const likePending = ref(false)
const favoritePending = ref(false)

async function toggleLike() {
  const a = article.value
  if (!a || likePending.value) return

  if (!userStore.isLoggedIn) return requireLogin()

  likePending.value = true
  // 乐观更新：先翻转标记与数字
  const wasLiked = a.isLiked
  a.isLiked = !wasLiked
  a.likeCount = Math.max(0, a.likeCount + (wasLiked ? -1 : 1))

  try {
    if (wasLiked) await unlikeArticle(a.id)
    else await likeArticle(a.id)
  } catch {
    // 回滚（提示由请求层负责，见文件头说明）
    a.isLiked = wasLiked
    a.likeCount = Math.max(0, a.likeCount + (wasLiked ? 1 : -1))
  } finally {
    likePending.value = false
  }
}

async function toggleFavorite() {
  const a = article.value
  if (!a || favoritePending.value) return

  if (!userStore.isLoggedIn) return requireLogin()

  favoritePending.value = true
  const wasFavorited = a.isFavorited
  a.isFavorited = !wasFavorited
  a.favoriteCount = Math.max(0, a.favoriteCount + (wasFavorited ? -1 : 1))

  try {
    if (wasFavorited) await unfavoriteArticle(a.id)
    else await favoriteArticle(a.id)
    ElMessage.success(wasFavorited ? '已取消收藏' : '已收藏')
  } catch {
    a.isFavorited = wasFavorited
    a.favoriteCount = Math.max(0, a.favoriteCount + (wasFavorited ? 1 : -1))
  } finally {
    favoritePending.value = false
  }
}

function requireLogin() {
  void router.push({
    name: RouteName.LOGIN,
    query: { redirect: route.fullPath },
  })
}

/* ==================== 关注作者 ==================== */

const following = ref(false)
const followPending = ref(false)

async function loadFollowStatus() {
  const authorId = article.value?.user?.id
  if (!authorId || !userStore.isLoggedIn || isAuthor.value) return
  try {
    following.value = await getFollowStatus(authorId)
  } catch {
    // 状态拿不到就按未关注处理，点击时再走一遍真实接口
    following.value = false
  }
}

async function toggleFollow() {
  const authorId = article.value?.user?.id
  if (!authorId || followPending.value) return
  if (!userStore.isLoggedIn) return requireLogin()

  followPending.value = true
  const was = following.value
  following.value = !was

  try {
    if (was) await cancelFollow(authorId)
    else await followUser(authorId)
    ElMessage.success(was ? '已取消关注' : '已关注')
  } catch {
    following.value = was
  } finally {
    followPending.value = false
  }
}

/* ==================== 作者其它操作 ==================== */

function goEdit() {
  if (!article.value) return
  void router.push({ name: RouteName.ARTICLE_EDIT, params: { id: String(article.value.id) } })
}

function goAuthorProfile() {
  const authorId = article.value?.user?.id
  if (!authorId) return
  void router.push({ name: RouteName.USER_PROFILE, params: { userId: String(authorId) } })
}

function goTag(tagId: number, tagName: string) {
  // 把标签名一起带过去供列表页的筛选态展示（不用再单独请求 /api/tag/list —— 那个接口需要登录）
  void router.push({
    name: RouteName.ARTICLE_LIST,
    query: { tab: 'tag', tagId: String(tagId), tagName },
  })
}

async function handleDelete() {
  if (!article.value) return
  try {
    await deleteArticle(article.value.id)
  } catch {
    // 提示由请求层负责
    return
  }
  ElMessage.success('已删除')
  void router.replace({ name: RouteName.ARTICLE_LIST })
}

/**
 * 草稿提示。
 * 详情响应（3.4）不返回 status 字段，只在「我的文章」列表（3.6）里才有。
 * 因此这里不能靠 status 判断，改为：能读到详情 + 当前用户是作者 + 该文在
 * 「我的文章」里是草稿 —— 这个信息前端拿不到。所以详情页**不显示草稿横幅**，
 * 由「我的文章」列表用草稿角标承担这个提示。
 * 保留一个可在联调后按需开启的判定，避免假装有这个字段。
 */
const showDraftBanner = computed(() => false)

/* ==================== 复制链接 ==================== */

async function copyLink() {
  try {
    await navigator.clipboard.writeText(window.location.href)
    ElMessage.success('链接已复制')
  } catch {
    ElMessage.error('复制失败，请手动复制地址栏链接')
  }
}

/* ==================== 评论 ==================== */

const comments = ref<CommentNode[]>([])
const commentsLoading = ref(true)
const commentsError = ref(false)
const commentsTotal = ref(0)

const COMMENT_PAGE_SIZE = 20
const commentPage = ref(1)

/**
 * 展开后的完整回复：rootId → 回复列表。
 * 3.16 每个根只给前 2 条，剩下的要主动调 3.20 拉 —— 拉过一次就放这里，
 * 再点「加载更多回复」时在当前结果上追加。
 */
const expandedReplies = ref<Record<number, CommentNode[]>>({})
/** 正在加载回复的根 id（同一时刻只允许一个，避免连点） */
const repliesLoading = ref<number | null>(null)
const REPLY_PAGE_SIZE = 20

/** 当前要显示的回复：已展开过就用展开结果，否则用 3.16 带回来的前 2 条 */
function repliesOf(root: CommentNode): CommentNode[] {
  return expandedReplies.value[root.id] ?? root.replies ?? []
}

/** 该根下的回复总数（`replyCount` 才是总数，`replies` 只是前 2 条） */
function replyCountOf(root: CommentNode): number {
  return root.replyCount ?? (root.replies?.length ?? 0)
}

/** 是否还有没显示出来的回复 */
function hasMoreReplies(root: CommentNode): boolean {
  return repliesOf(root).length < replyCountOf(root)
}

/** 3.20：按需拉取该根下的回复（每页 20，点一次追加一页） */
async function expandReplies(root: CommentNode) {
  if (repliesLoading.value !== null) return
  const already = expandedReplies.value[root.id] ?? []
  const nextPage = Math.floor(already.length / REPLY_PAGE_SIZE) + 1
  repliesLoading.value = root.id
  try {
    const res = await getCommentReplies(root.id, {
      page: nextPage,
      size: REPLY_PAGE_SIZE,
    })
    const items = (res.records ?? []) as CommentNode[]
    expandedReplies.value = {
      ...expandedReplies.value,
      [root.id]: nextPage === 1 ? items : [...already, ...items],
    }
  } catch {
    // 提示由请求层负责
  } finally {
    repliesLoading.value = null
  }
}

/** 正在回复的评论 id（null 表示没在回复） */
const replyingTo = ref<number | null>(null)
const replyContent = ref('')
const replySubmitting = ref(false)

/** 一级评论输入 */
const commentContent = ref('')
const commentSubmitting = ref(false)

const commentsEmpty = computed(
  () => !commentsLoading.value && !commentsError.value && comments.value.length === 0,
)

/** 是否还有更多评论（后端只支持一层嵌套，此处仍按分页取） */
const hasMoreComments = computed(() => comments.value.length < commentsTotal.value)

async function loadComments() {
  commentsLoading.value = true
  commentsError.value = false
  try {
    const res = await getCommentList(articleId.value, {
      page: commentPage.value,
      size: COMMENT_PAGE_SIZE,
    })
    comments.value = (res.records ?? []) as CommentNode[]
    commentsTotal.value = res.total ?? 0
    // 重新拉评论后，之前展开的回复已不对应，清掉避免串味
    expandedReplies.value = {}
  } catch {
    commentsError.value = true
    comments.value = []
    commentsTotal.value = 0
  } finally {
    commentsLoading.value = false
  }
}

async function loadMoreComments() {
  try {
    const next = commentPage.value + 1
    const res = await getCommentList(articleId.value, { page: next, size: COMMENT_PAGE_SIZE })
    comments.value = [...comments.value, ...((res.records ?? []) as CommentNode[])]
    commentPage.value = next
  } catch {
    // 提示由请求层负责
  }
}

/* ==================== 评论锚点定位 ==================== */

/**
 * 支持从消息通知跳转过来时定位到具体评论（通知页会带 `#comment-{commentId}`）。
 *
 * 一个现实限制：3.16 的评论按**时间正序**返回，新评论在最后一页，而首屏只加载第一页
 * —— 通知里那条新评论大概率还没进 DOM。这时不「默默多翻十页」，而是退一步把评论区
 * 滚进视野；若它恰好在已加载的列表里，就精确滚动并短暂高亮。
 */
const highlightedCommentId = ref<number | null>(null)

/** 本次路由带来的锚点评论 id（非 `#comment-{数字}` 形式则为 null） */
const commentAnchorId = computed<number | null>(() => {
  const matched = /^#comment-(\d+)$/.exec(route.hash)
  if (!matched || !matched[1]) return null
  const id = Number(matched[1])
  return Number.isInteger(id) && id > 0 ? id : null
})

/** 同一篇文章内只处理一次锚点，避免后续刷新评论时反复滚动 */
let anchorHandled = false

async function applyCommentAnchor() {
  const target = commentAnchorId.value
  if (target === null || anchorHandled) return
  anchorHandled = true

  // 等评论列表渲染进 DOM，否则 getElementById 一定拿不到
  await nextTick()

  const el = document.getElementById(`comment-${target}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightedCommentId.value = target
    window.setTimeout(() => {
      highlightedCommentId.value = null
    }, 2600)
    return
  }

  document.getElementById('cm-comments')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 评论加载完成后尝试定位（首屏加载与后续翻页都会经过这里）
watch(commentsLoading, (loading) => {
  if (!loading) void applyCommentAnchor()
})

async function submitComment() {
  const content = commentContent.value.trim()
  if (!content) {
    ElMessage.warning('请输入评论内容')
    return
  }
  if (!userStore.isLoggedIn) return requireLogin()
  if (commentSubmitting.value) return

  commentSubmitting.value = true
  try {
    await createComment({ articleId: articleId.value, content, parentId: 0 })
    commentContent.value = ''
    ElMessage.success('评论已发布')
    commentPage.value = 1
    await loadComments()
  } catch {
    // 提示由请求层负责
  } finally {
    commentSubmitting.value = false
  }
}

function startReply(commentId: number) {
  if (!userStore.isLoggedIn) return requireLogin()
  replyingTo.value = replyingTo.value === commentId ? null : commentId
  replyContent.value = ''
}

function cancelReply() {
  replyingTo.value = null
  replyContent.value = ''
}

async function submitReply(parentId: number) {
  const content = replyContent.value.trim()
  if (!content) {
    ElMessage.warning('请输入回复内容')
    return
  }
  if (replySubmitting.value) return

    replySubmitting.value = true
  try {
    await createComment({ articleId: articleId.value, content, parentId })
    cancelReply()
    ElMessage.success('回复已发布')
    commentPage.value = 1
    await loadComments()
  } catch {
    // 提示由请求层负责
  } finally {
    replySubmitting.value = false
  }
}

/** 只有评论作者本人能删自己的评论 */
function canDeleteComment(userId: number | undefined): boolean {
  const uid = userStore.userId
  return uid !== null && userId !== undefined && uid === userId
}

async function handleDeleteComment(commentId: number) {
  try {
    await deleteComment(commentId)
  } catch {
    // 提示由请求层负责（后端会给出「无权删除该评论」这类具体文案）
    return
  }
  ElMessage.success('已删除')
  commentPage.value = 1
  await loadComments()
}

/* ==================== AI 上下文操作 ==================== */

const ai = useAiContext()

function runAi(action: (typeof AI_ACTIONS)[number]) {
  if (!article.value) return
  // 生成中不重复触发（按钮已 disabled，这里再兜一道：脚本化点击也拦得住）
  if (ai.isStreaming.value) return
  void ai.run('articles', article.value.id, action)
}

async function copyAiContent(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
}

/* ==================== 副作用 ==================== */

watch(
  articleId,
  () => {
    // 详情页内切换文章（例如从相关推荐跳转）需要重置全部子状态
    ai.closePanel()
    replyingTo.value = null
    commentContent.value = ''
    replyContent.value = ''
    commentPage.value = 1
    // 换文章后允许重新处理一次评论锚点
    anchorHandled = false
    highlightedCommentId.value = null
    void loadArticle()
    void loadComments()
    // 切换文章后回到顶部，否则会停在上一篇文章的滚动位置
    window.scrollTo({ top: 0, behavior: 'auto' })
  },
  { immediate: true },
)
</script>

<template>
  <div class="cm-container cm-detail">
    <!-- ==================== 加载中 ==================== -->
    <div v-if="loading" class="cm-detail__state">
      <LoadingState variant="spinner" text="正在加载文章" />
    </div>

    <!-- ==================== 游客：需要登录 ==================== -->
    <!-- 详情接口对游客是 401，但这不是「加载失败」，也不该把游客弹去登录页 -->
    <div v-else-if="needLogin" class="cm-detail__state">
      <EmptyState
        title="登录后查看"
        description="文章详情需要登录后才能查看，登录后会回到这篇文章"
        :size="88"
      >
        <el-button size="small" type="primary" @click="requireLogin">立即登录</el-button>
        <el-button size="small" @click="router.push({ name: RouteName.ARTICLE_LIST })">
          先去列表逛逛
        </el-button>
      </EmptyState>
    </div>

    <!-- ==================== 加载失败（按 ApiError.code 分诊） ==================== -->
    <div v-else-if="error" class="cm-detail__state">
      <ErrorState :title="errorTitle" :description="errorDesc" @retry="loadArticle">
        <template #extra>
          <el-button size="small" @click="router.push({ name: RouteName.ARTICLE_LIST })">
            返回列表
          </el-button>
        </template>
      </ErrorState>
    </div>

    <!-- ==================== 正文 ==================== -->
    <template v-else-if="article">
      <article class="cm-detail__article">
        <!-- 草稿提示：详情接口不返回 status，此横幅默认关闭，见 script 内说明 -->
        <div v-if="showDraftBanner" class="cm-detail__draft-banner">
          <el-icon><Warning /></el-icon>
          这是一篇草稿，只有你自己可见
        </div>

        <!-- 标题区 -->
        <header class="cm-detail__head">
          <h1 class="cm-detail__title">{{ article.title }}</h1>

          <div class="cm-detail__meta">
            <!-- 作者 -->
            <span
              class="cm-detail__author"
              role="link"
              tabindex="0"
              @click="goAuthorProfile"
              @keydown.enter="goAuthorProfile"
            >
              <el-avatar :size="36" :src="article.user?.avatar || undefined" class="cm-detail__avatar">
                {{ article.user?.userName?.charAt(0) ?? '?' }}
              </el-avatar>
              <span class="cm-detail__author-info">
                <span class="cm-detail__author-name">{{ article.user?.userName ?? '匿名' }}</span>
                <span v-if="article.user?.intro" class="cm-detail__author-intro cm-truncate">
                  {{ article.user.intro }}
                </span>
              </span>
            </span>

            <!-- 关注 / 编辑 -->
            <el-button
              v-if="!isAuthor"
              size="small"
              :type="following ? 'default' : 'primary'"
              :plain="following"
              :loading="followPending"
              @click="toggleFollow"
            >
              {{ following ? '已关注' : '关注' }}
            </el-button>
            <el-button v-else size="small" plain @click="goEdit">
              <el-icon><EditPen /></el-icon>
              编辑
            </el-button>

            <span class="cm-detail__meta-right">
              <time class="cm-detail__time">{{ formatDateTime(article.createTime) }}</time>
              <span class="cm-detail__dot">·</span>
              <span>约 {{ readingMinutes }} 分钟阅读</span>
            </span>
          </div>
        </header>

        <!-- 封面 -->
        <img
          v-if="article.cover?.trim()"
          class="cm-detail__cover"
          :src="article.cover"
          :alt="article.title"
        />

        <!-- 正文 -->
        <MarkdownViewer class="cm-detail__body" :content="article.content" variant="article" />

        <!-- 标签 -->
        <div v-if="tags.length" class="cm-detail__tags">
          <button
            v-for="tag in tags"
            :key="tag.id"
            type="button"
            class="cm-detail__tag"
            @click="goTag(tag.id, tag.name)"
          >
            {{ tag.name }}
          </button>
        </div>

        <!-- ==================== 指标条 ==================== -->
        <dl class="cm-detail__metrics">
          <div v-for="m in metrics" :key="m.key" class="cm-detail__metric">
            <dt class="cm-detail__metric-label">{{ m.label }}</dt>
            <dd class="cm-detail__metric-value">{{ m.value }}</dd>
          </div>
        </dl>

        <!-- ==================== 操作栏 ==================== -->
        <div class="cm-detail__actions">
          <button
            type="button"
            class="cm-detail__action"
            :class="{ 'is-active': article.isLiked }"
            :disabled="likePending"
            @click="toggleLike"
          >
            <el-icon><Star /></el-icon>
            <span>{{ article.isLiked ? '已点赞' : '点赞' }}</span>
            <span class="cm-detail__action-num">{{ formatCount(article.likeCount) }}</span>
          </button>

          <button
            type="button"
            class="cm-detail__action"
            :class="{ 'is-active': article.isFavorited }"
            :disabled="favoritePending"
            @click="toggleFavorite"
          >
            <el-icon><Collection /></el-icon>
            <span>{{ article.isFavorited ? '已收藏' : '收藏' }}</span>
            <span class="cm-detail__action-num">{{ formatCount(article.favoriteCount) }}</span>
          </button>

          <button type="button" class="cm-detail__action" @click="copyLink">
            <el-icon><Link /></el-icon>
            <span>复制链接</span>
          </button>

          <!-- 作者本人：删除 -->
          <el-dropdown v-if="isAuthor" trigger="click">
            <button type="button" class="cm-detail__action" aria-label="更多操作">
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="goEdit">
                  <el-icon><EditPen /></el-icon>编辑文章
                </el-dropdown-item>
                <el-dropdown-item divided @click="handleDelete">
                  <el-icon><Delete /></el-icon>删除文章
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <!-- ==================== AI 助手条 ==================== -->
        <!-- 单独一行：三个动作挤在操作栏里会互相抢视觉，这里给它独立区块 -->
        <div class="cm-detail__ai">
          <div class="cm-detail__ai-head">
            <span class="cm-detail__ai-badge" aria-hidden="true">
              <el-icon :size="13"><MagicStick /></el-icon>
            </span>
            <span class="cm-detail__ai-label">AI 助手</span>
            <span class="cm-detail__ai-hint">基于本文内容生成</span>
          </div>

          <!--
            生成中把三个入口一起禁用（含重复点当前动作）：
            想换一个动作先点面板里的「停止」，避免同一个流被反复重启。
          -->
          <div class="cm-detail__ai-actions">
            <button
              v-for="action in AI_ACTIONS"
              :key="action"
              type="button"
              class="cm-detail__ai-btn"
              :disabled="ai.isStreaming.value"
              @click="runAi(action)"
            >
              {{
                ai.isStreaming.value && ai.activeAction.value === action
                  ? '生成中…'
                  : AI_ACTION_LABELS[action]
              }}
            </button>
          </div>
        </div>
      </article>

      <!-- ==================== 评论区 ==================== -->
      <section id="cm-comments" class="cm-detail__comments">
        <h2 class="cm-detail__comments-title">
          评论
          <span v-if="commentsTotal > 0" class="cm-detail__comments-count">{{ commentsTotal }}</span>
        </h2>

        <!-- 发表评论 -->
        <div class="cm-detail__composer">
          <el-input
            v-model="commentContent"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            :placeholder="
              userStore.isLoggedIn ? '说点什么…（支持 Markdown 之外纯文本）' : '登录后即可参与讨论'
            "
            resize="none"
          />
          <div class="cm-detail__composer-actions">
            <span class="cm-detail__composer-hint">
              {{ userStore.isLoggedIn ? '' : '发表评论需要先登录' }}
            </span>
            <el-button
              type="primary"
              size="small"
              :loading="commentSubmitting"
              :disabled="!commentContent.trim()"
              @click="submitComment"
            >
              发表评论
            </el-button>
          </div>
        </div>

        <!-- 评论列表 -->
        <LoadingState v-if="commentsLoading" variant="skeleton" :rows="3" />

        <ErrorState
          v-else-if="commentsError"
          title="评论加载失败"
          description="评论区暂时取不到数据，可单独重试"
          @retry="loadComments"
        />

        <EmptyState
          v-else-if="commentsEmpty"
          title="还没有评论"
          :description="userStore.isLoggedIn ? '来说点什么吧' : '登录后可以参与讨论'"
          :size="72"
        />

        <ul v-else class="cm-detail__comment-list">
          <li
            v-for="comment in comments"
            :id="`comment-${comment.id}`"
            :key="comment.id"
            class="cm-detail__comment"
            :class="{ 'is-highlight': highlightedCommentId === comment.id }"
          >
            <el-avatar
              :size="30"
              :src="comment.user?.avatar || undefined"
              class="cm-detail__comment-avatar"
            >
              {{ comment.user?.userName?.charAt(0) ?? '?' }}
            </el-avatar>

            <div class="cm-detail__comment-main">
              <div class="cm-detail__comment-head">
                <span class="cm-detail__comment-name">{{ comment.user?.userName ?? '匿名' }}</span>
                <time class="cm-detail__comment-time">{{ formatDateTime(comment.createTime) }}</time>
              </div>

              <p class="cm-detail__comment-text">{{ comment.content }}</p>

              <div class="cm-detail__comment-ops">
                <button
                  type="button"
                  class="cm-detail__comment-op"
                  @click="startReply(comment.id)"
                >
                  {{ replyingTo === comment.id ? '取消回复' : '回复' }}
                </button>
                <button
                  v-if="canDeleteComment(comment.user?.id)"
                  type="button"
                  class="cm-detail__comment-op cm-detail__comment-op--danger"
                  @click="handleDeleteComment(comment.id)"
                >
                  删除
                </button>
              </div>

              <!-- 内联回复框 -->
              <div v-if="replyingTo === comment.id" class="cm-detail__reply-box">
                <el-input
                  v-model="replyContent"
                  type="textarea"
                  :rows="2"
                  maxlength="500"
                  resize="none"
                  :placeholder="`回复 @${comment.user?.userName ?? '匿名'}`"
                />
                <div class="cm-detail__reply-actions">
                  <el-button size="small" text @click="cancelReply">取消</el-button>
                  <el-button
                    size="small"
                    type="primary"
                    :loading="replySubmitting"
                    :disabled="!replyContent.trim()"
                    @click="submitReply(comment.id)"
                  >
                    回复
                  </el-button>
                </div>
              </div>

              <!-- 二级回复：后端库里只有两层，replies 里的元素恒无子级，不做递归 -->
              <ul v-if="repliesOf(comment).length" class="cm-detail__replies">
                <li
                  v-for="reply in repliesOf(comment)"
                  :id="`comment-${reply.id}`"
                  :key="reply.id"
                  class="cm-detail__reply"
                  :class="{ 'is-highlight': highlightedCommentId === reply.id }"
                >
                  <el-avatar
                    :size="24"
                    :src="reply.user?.avatar || undefined"
                    class="cm-detail__comment-avatar"
                  >
                    {{ reply.user?.userName?.charAt(0) ?? '?' }}
                  </el-avatar>

                  <div class="cm-detail__reply-main">
                    <div class="cm-detail__comment-head">
                      <span class="cm-detail__comment-name">{{ reply.user?.userName ?? '匿名' }}</span>
                      <!-- replyUser 为 null 表示直接回复文章作者，此时不渲染 @ -->
                      <span v-if="reply.replyUser" class="cm-detail__reply-to">
                        回复 @{{ reply.replyUser.userName }}
                      </span>
                      <time class="cm-detail__comment-time">
                        {{ formatDateTime(reply.createTime) }}
                      </time>
                    </div>
                    <p class="cm-detail__comment-text">{{ reply.content }}</p>
                    <div class="cm-detail__comment-ops">
                      <button
                        v-if="canDeleteComment(reply.user?.id)"
                        type="button"
                        class="cm-detail__comment-op cm-detail__comment-op--danger"
                        @click="handleDeleteComment(reply.id)"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </li>
              </ul>

              <!-- 「查看全部 N 条回复」：走 3.20，每次追加一页（最多 20 条） -->
              <div v-if="hasMoreReplies(comment)" class="cm-detail__replies-more">
                <button
                  type="button"
                  class="cm-detail__comment-op"
                  :disabled="repliesLoading === comment.id"
                  @click="expandReplies(comment)"
                >
                  {{ repliesLoading === comment.id ? '加载中…' : `查看全部 ${replyCountOf(comment)} 条回复` }}
                </button>
              </div>
            </div>
          </li>
        </ul>

        <div v-if="hasMoreComments && !commentsLoading" class="cm-detail__load-more">
          <el-button size="small" @click="loadMoreComments">
            加载更多评论（还有 {{ commentsTotal - comments.length }} 条）
          </el-button>
        </div>
      </section>
    </template>

    <!-- ==================== AI 面板 ==================== -->
    <AiContextPanel
      :visible="ai.isPanelOpen.value"
      :title="ai.activeTitle.value"
      :content="ai.content.value"
      :streaming="ai.isStreaming.value"
      :error="ai.error.value"
      :loading-text="ai.loadingText.value"
      :need-login="ai.needLogin.value"
      :active-action="ai.activeAction.value"
      @close="ai.closePanel"
      @stop="ai.stop"
      @retry="ai.retry('articles', articleId)"
      @copy="copyAiContent"
      @login="requireLogin"
    />
  </div>
</template>

<style scoped>
.cm-detail {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

.cm-detail__state {
  min-height: 40vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ==================== 文章容器 ==================== */
.cm-detail__article {
  max-width: var(--cm-container-reading, 720px);
  margin: 0 auto;
}

.cm-detail__draft-banner {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  margin-bottom: var(--cm-space-5);
  padding: var(--cm-space-3) var(--cm-space-4);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border: 1px solid var(--cm-warning-border);
  border-radius: var(--cm-radius-md);
}

/* ==================== 标题区 ==================== */
.cm-detail__head {
  padding-bottom: var(--cm-space-6);
}

.cm-detail__title {
  margin: 0;
  font-size: var(--cm-font-size-3xl);
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-detail__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-5);
}

.cm-detail__author {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-3);
  color: var(--cm-text-secondary);
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-detail__author:hover {
  color: var(--cm-accent-600);
}

.cm-detail__avatar {
  flex-shrink: 0;
  font-size: 14px;
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-detail__author-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.cm-detail__author-name {
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-text-primary);
}

.cm-detail__author-intro {
  max-width: 26ch;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-detail__meta-right {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  margin-left: auto;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-detail__dot {
  color: var(--cm-border-strong);
}

/* ==================== 封面 ==================== */
.cm-detail__cover {
  width: 100%;
  max-height: 380px;
  margin: 0 0 var(--cm-space-8);
  object-fit: cover;
  border-radius: var(--cm-radius-lg);
}

/* ==================== 正文 ==================== */
.cm-detail__body {
  margin-bottom: var(--cm-space-8);
}

/* ==================== 标签 ==================== */
.cm-detail__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  margin-bottom: var(--cm-space-8);
}

.cm-detail__tag {
  padding: 3px 11px;
  font-family: inherit;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-sunken);
  border: none;
  border-radius: var(--cm-radius-full);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.cm-detail__tag:hover {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
}

/* ==================== 指标条 ==================== */
.cm-detail__metrics {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cm-space-8);
  margin: 0 0 var(--cm-space-6);
  padding: var(--cm-space-4) var(--cm-space-5);
  background-color: var(--cm-bg-sunken);
  border-radius: var(--cm-radius-lg);
}

.cm-detail__metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cm-detail__metric-label {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-detail__metric-value {
  margin: 0;
  font-size: var(--cm-font-size-md);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--cm-text-primary);
}

/* ==================== 操作栏 ==================== */
.cm-detail__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  padding: var(--cm-space-4) 0;
  border-top: 1px solid var(--cm-border-subtle);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-detail__action {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  padding: var(--cm-space-2) var(--cm-space-3);
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
  background: none;
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-full);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.cm-detail__action:hover:not(:disabled) {
  color: var(--cm-text-primary);
  background-color: var(--cm-bg-hover);
  border-color: var(--cm-border-default);
}

.cm-detail__action:disabled {
  opacity: 0.6;
  cursor: default;
}

.cm-detail__action.is-active {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
  border-color: var(--cm-accent-200);
}

.cm-detail__action-num {
  font-variant-numeric: tabular-nums;
  color: var(--cm-text-quaternary);
}

.cm-detail__action.is-active .cm-detail__action-num {
  color: var(--cm-accent-600);
}

/* AI 动作条：独立一行，用浅靛蓝底与操作栏区分开 */
.cm-detail__ai {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-4);
  padding: var(--cm-space-3) var(--cm-space-4);
  background-color: var(--cm-accent-50);
  border: 1px solid var(--cm-accent-100);
  border-radius: var(--cm-radius-lg);
}

.cm-detail__ai-head {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  min-width: 0;
}

.cm-detail__ai-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  color: var(--cm-accent-600);
  background-color: var(--cm-bg-surface);
  border: 1px solid var(--cm-accent-200);
  border-radius: var(--cm-radius-sm);
}

.cm-detail__ai-label {
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-accent-800);
}

.cm-detail__ai-hint {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-accent-600);
}

.cm-detail__ai-actions {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
}

.cm-detail__ai-btn {
  padding: 4px var(--cm-space-3);
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-accent-700);
  background-color: var(--cm-bg-surface);
  border: 1px solid var(--cm-accent-200);
  border-radius: var(--cm-radius-full);
  cursor: pointer;
  white-space: nowrap;
  transition:
    color 0.15s ease,
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.cm-detail__ai-btn:not(:disabled):hover {
  color: var(--cm-text-inverse);
  background-color: var(--cm-accent-600);
  border-color: var(--cm-accent-600);
}

/* 生成中：入口禁用但不要「消失」，让人看得到它还在那儿 */
.cm-detail__ai-btn:disabled {
  color: var(--cm-accent-600);
  background-color: var(--cm-accent-50);
  border-color: var(--cm-accent-100);
  cursor: not-allowed;
  opacity: 0.75;
}

/* ==================== 评论区 ==================== */
.cm-detail__comments {
  max-width: var(--cm-container-reading, 720px);
  margin: var(--cm-space-12) auto 0;
}

.cm-detail__comments-title {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  margin: 0 0 var(--cm-space-5);
  font-size: var(--cm-font-size-xl);
  font-weight: 600;
}

.cm-detail__comments-count {
  padding: 1px 8px;
  font-size: var(--cm-font-size-xs);
  font-weight: 400;
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-sunken);
  border-radius: var(--cm-radius-full);
}

.cm-detail__composer {
  margin-bottom: var(--cm-space-8);
}

.cm-detail__composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-3);
}

.cm-detail__composer-hint {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

/* ---------- 评论项 ---------- */
.cm-detail__comment-list,
.cm-detail__replies {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cm-detail__comment {
  display: flex;
  gap: var(--cm-space-3);
  padding: var(--cm-space-5) 0;
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-detail__comment:last-child {
  border-bottom: none;
}

/*
 * 从消息通知带 #comment-{id} 跳进来时的定位高亮。
 * 用淡出的底色而不是描边：描边会让整行位移，淡出更安静。
 */
.cm-detail__comment.is-highlight,
.cm-detail__reply.is-highlight {
  background-color: var(--cm-accent-50);
  border-radius: var(--cm-radius-md);
  animation: cm-comment-fade 2.6s ease-out forwards;
}

@keyframes cm-comment-fade {
  0%,
  55% {
    background-color: var(--cm-accent-50);
  }
  100% {
    background-color: transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cm-detail__comment.is-highlight,
  .cm-detail__reply.is-highlight {
    animation: none;
    background-color: var(--cm-accent-50);
  }
}

.cm-detail__comment-avatar {
  flex-shrink: 0;
  font-size: 12px;
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-detail__comment-main,
.cm-detail__reply-main {
  flex: 1;
  min-width: 0;
}

.cm-detail__comment-head {
  display: flex;
  align-items: baseline;
  gap: var(--cm-space-2);
}

.cm-detail__comment-name {
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-text-primary);
}

.cm-detail__comment-time {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-detail__comment-text {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-base);
  line-height: 1.7;
  color: var(--cm-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.cm-detail__comment-ops {
  display: flex;
  align-items: center;
  gap: var(--cm-space-4);
  margin-top: var(--cm-space-2);
}

.cm-detail__comment-op {
  padding: 0;
  font-family: inherit;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-detail__comment-op:hover {
  color: var(--cm-accent-600);
}

.cm-detail__comment-op--danger:hover {
  color: var(--cm-danger);
}

/* ---------- 回复框 ---------- */
.cm-detail__reply-box {
  margin-top: var(--cm-space-3);
}

.cm-detail__reply-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--cm-space-2);
  margin-top: var(--cm-space-2);
}

/* ---------- 二级回复 ---------- */
.cm-detail__replies {
  margin-top: var(--cm-space-4);
  padding-left: var(--cm-space-4);
  border-left: 2px solid var(--cm-border-subtle);
}

/* 「回复 @某人」标记（replyUser 为 null 时不渲染） */
.cm-detail__reply-to {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-accent-600);
}

/* 「查看全部 N 条回复」：跟回复列表左对齐，不额外缩进 */
.cm-detail__replies-more {
  padding-left: var(--cm-space-4);
  margin-top: var(--cm-space-1);
}

.cm-detail__reply {
  display: flex;
  gap: var(--cm-space-3);
  padding: var(--cm-space-3) 0;
}

.cm-detail__reply:first-child {
  padding-top: 0;
}

.cm-detail__load-more {
  display: flex;
  justify-content: center;
  padding-top: var(--cm-space-6);
}

/* ==================== 响应式 ==================== */
@media (max-width: 720px) {
  .cm-detail__title {
    font-size: var(--cm-font-size-2xl);
  }

  .cm-detail__meta-right {
    width: 100%;
    margin-left: 0;
  }

  .cm-detail__actions {
    gap: var(--cm-space-1);
  }

  .cm-detail__action span:not(.cm-detail__action-num) {
    display: none;
  }

  /* 窄屏：AI 条改为纵向堆叠，按钮占满宽度更好点 */
  .cm-detail__ai {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-detail__ai-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-detail__ai-btn {
    text-align: center;
  }
}
</style>
