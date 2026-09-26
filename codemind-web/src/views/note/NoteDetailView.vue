<script setup lang="ts">
/**
 * 笔记详情页。接口：2.4 详情 ｜ 2.6 切换公开/私密 ｜ 2.3 删除 ｜
 * AI 总结·知识点·面试题（走 useAiContext，target = 'notes'）。
 *
 * 与文章详情页的差异：
 *   1. 没有点赞 / 收藏，取而代之的是**可见性切换**（笔记的核心状态）。
 *   2. 详情响应**带 status**（0 草稿 / 1 正常），所以草稿提示在这里可靠 —— 文章详情没这个字段。
 *   3. 非作者访问**私密笔记**（visibility≠1）或**草稿**（status≠1）后端都返回 403 ——
 *      **同一个 code、只有 message 不同**。要给明确解释，但不能把 403 说死成「私密」（对草稿就是假话）。
 *
 * 游客态：`/api/note/{noteId}` **不在白名单**，不带 token 直接 401；但路由 `requiresAuth: false`
 * （为了让游客能停在页面上看到交代）→ 页面必须自己把 401 渲染成「登录后查看」，不能跳登录、不能是报错页。
 *
 * 失败分诊一律读 `ApiError.code`，禁止比 message 文本：
 *   401 → 游客「登录后查看」（带 redirect 的登录入口）｜ 403 → 私密 / 草稿（文案必须中性）
 *   404 → 笔记不存在或已删除 ｜ 其它 → 通用「加载失败 + 重试」
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import MarkdownViewer from '@/components/common/MarkdownViewer.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import AiContextPanel from '@/components/ai/AiContextPanel.vue'

import { deleteNote, getNoteDetail, updateNoteVisibility } from '@/api/note'
import { ApiError } from '@/api/request'
import { useUserStore } from '@/stores/user'
import { useAiContext, AI_ACTIONS, AI_ACTION_LABELS } from '@/composables/useAiContext'
import { RouteName } from '@/router/routes-names'
import { ContentStatus, Visibility } from '@/types/common'
import type { NoteDetailVO } from '@/types/note'
import { formatDateTime, estimateReadingMinutes } from '@/utils/format'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const noteId = computed(() => Number(route.params.id))

/* ==================== 详情数据 ==================== */

const note = ref<NoteDetailVO | null>(null)
const loading = ref(true)
const error = ref(false)

/** 失败错误码：业务失败 = 响应体 code，传输层失败 = HTTP 状态码（见 request.ts） */
const errorCode = ref<number | null>(null)

/** 游客访问：2.4 不在白名单里，未登录会拿到 HTTP 401 */
const needLogin = computed(
  () => error.value && errorCode.value === 401 && !userStore.isLoggedIn,
)

const errorTitle = computed(() => {
  if (errorCode.value === 403) return '无权查看这篇笔记'
  if (errorCode.value === 404) return '笔记不存在或已删除'
  return '笔记加载失败'
})

const errorDesc = computed(() => {
  /*
   * ⚠️ 403 有**两个来源**，而且共用同一个 code（只有 message 不同）：
   *   - 私密笔记：`visibility != 1`
   *   - 草稿笔记：`status != 1`（2026-09-23 后端新增的读取侧校验）
   * §3.0 约定 D 明令禁止按 message 文本判断失败类型（后端一改文案就静默失效），
   * 所以这里只能给一句**两种情况都成立**的文案 ——
   * 不能说死「这是一篇私密笔记」，那对草稿就是假话。
   */
  if (errorCode.value === 403) return '这篇笔记还没有公开，只有作者本人可以查看'
  if (errorCode.value === 404) return '它可能已被作者删除'
  return '可能是网络问题，或后端服务未启动'
})

const isAuthor = computed(() => {
  const uid = userStore.userId
  return uid !== null && note.value?.user?.id === uid
})

const isPrivate = computed(() => note.value?.visibility === Visibility.PRIVATE)
const isDraft = computed(() => note.value?.status === ContentStatus.DRAFT)

/**
 * 过滤掉后端可能返回的 { id: null, name: null } 占位元素，
 * 避免渲染出空标签胶囊（05 §9「列表出现空白标签胶囊」）。
 */
const tags = computed(() => (note.value?.tags ?? []).filter((t) => t?.id != null && !!t.name))

const readingMinutes = computed(() => estimateReadingMinutes(note.value?.content))

async function loadNote() {
  loading.value = true
  error.value = false
  errorCode.value = null
  try {
    note.value = await getNoteDetail(noteId.value)
  } catch (err) {
    error.value = true
    errorCode.value = err instanceof ApiError ? err.code : null
    note.value = null
  } finally {
    loading.value = false
  }
}

/** 登录后回到当前笔记（redirect 带完整路径，登录页会原样回跳） */
function requireLogin() {
  void router.push({
    name: RouteName.LOGIN,
    query: { redirect: route.fullPath },
  })
}

/* ==================== 可见性切换（乐观更新） ==================== */

const visibilityPending = ref(false)

async function toggleVisibility() {
  const n = note.value
  if (!n || visibilityPending.value) return

  const next = n.visibility === Visibility.PUBLIC ? Visibility.PRIVATE : Visibility.PUBLIC
  const prev = n.visibility

  visibilityPending.value = true
  n.visibility = next

  try {
    await updateNoteVisibility(n.id, { visibility: next })
    ElMessage.success(next === Visibility.PUBLIC ? '已设为公开' : '已设为私密')
  } catch {
    n.visibility = prev
    ElMessage.error('修改可见性失败')
  } finally {
    visibilityPending.value = false
  }
}

/* ==================== 作者操作 ==================== */

function goEdit() {
  if (!note.value) return
  void router.push({ name: RouteName.NOTE_EDIT, params: { id: String(note.value.id) } })
}

function goAuthorProfile() {
  const authorId = note.value?.user?.id
  if (!authorId) return
  void router.push({ name: RouteName.USER_PROFILE, params: { userId: String(authorId) } })
}

function goCategory() {
  const catId = note.value?.category?.id
  if (!catId) return
  void router.push({ name: RouteName.NOTE_LIST, query: { categoryId: String(catId) } })
}

async function handleDelete() {
  if (!note.value) return
  try {
    await ElMessageBox.confirm(`确定删除「${note.value.title}」吗？删除后无法恢复。`, '删除笔记', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }

  try {
    await deleteNote(note.value.id)
    ElMessage.success('已删除')
    void router.replace({ name: RouteName.NOTE_LIST })
  } catch {
    ElMessage.error('删除失败')
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(window.location.href)
    ElMessage.success('链接已复制')
  } catch {
    ElMessage.error('复制失败，请手动复制地址栏链接')
  }
}

/* ==================== AI 上下文操作 ==================== */

const ai = useAiContext()

function runAi(action: (typeof AI_ACTIONS)[number]) {
  if (!note.value) return
  // 生成中不重复触发（按钮已 disabled，这里再兜一道：脚本化点击也拦得住）
  if (ai.isStreaming.value) return
  void ai.run('notes', note.value.id, action)
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
  noteId,
  () => {
    ai.closePanel()
    void loadNote()
    window.scrollTo({ top: 0, behavior: 'auto' })
  },
  { immediate: true },
)
</script>

<template>
  <div class="cm-container cm-note-detail">
    <div v-if="loading" class="cm-note-detail__state">
      <LoadingState variant="spinner" text="正在加载笔记" />
    </div>

    <!--
      游客态：2.4 不在白名单里，未登录直接 401。
      这不是「加载失败」，也不该把游客弹去登录页 —— 页面必须自己交代清楚。
    -->
    <div v-else-if="needLogin" class="cm-note-detail__state">
      <EmptyState
        title="登录后查看"
        description="笔记详情需要登录后才能查看，登录后会回到这篇笔记"
        :size="88"
      >
        <el-button size="small" type="primary" @click="requireLogin">立即登录</el-button>
        <el-button size="small" @click="router.push({ name: RouteName.NOTE_LIST })">
          返回笔记列表
        </el-button>
      </EmptyState>
    </div>

    <!-- 加载失败：按 ApiError.code 分诊（403 私密 / 404 不存在 / 其它兜底） -->
    <div v-else-if="error" class="cm-note-detail__state">
      <ErrorState :title="errorTitle" :description="errorDesc" @retry="loadNote">
        <template #extra>
          <el-button size="small" @click="router.push({ name: RouteName.NOTE_LIST })">
            返回笔记列表
          </el-button>
        </template>
      </ErrorState>
    </div>

    <template v-else-if="note">
      <article class="cm-note-detail__article">
        <!-- 草稿 / 私密提示：详情接口确实返回 status 与 visibility，可以可靠判断 -->
        <!--
          草稿横幅只陈述「未正式发布」这个确定的事实，不去替**可见性**下结论
          —— 可见性由旁边那条私密横幅负责说，两者语义独立、互不代替。
          （历史：2026-09-23 之前后端 `getNote` 只校验 `visibility`、不校验 `status`，
            那时「只有你自己可见」对「公开的草稿」是假话。后端已在读取侧补上 `status` 校验，
            但这里仍保持中性文案 —— 不让一句用户可见的文案去依赖后端实现细节。）
        -->
        <div v-if="isAuthor && (isDraft || isPrivate)" class="cm-note-detail__banners">
          <span v-if="isDraft" class="cm-note-detail__banner cm-note-detail__banner--draft">
            <el-icon :size="13"><Warning /></el-icon>
            这是一篇草稿，还没有正式发布
          </span>
          <span v-if="isPrivate" class="cm-note-detail__banner cm-note-detail__banner--private">
            <el-icon :size="13"><Lock /></el-icon>
            这是一篇私密笔记，只有你自己可见
          </span>
        </div>

        <!-- 标题区 -->
        <header class="cm-note-detail__head">
          <h1 class="cm-note-detail__title">{{ note.title }}</h1>

          <div class="cm-note-detail__meta">
            <span
              class="cm-note-detail__author"
              role="link"
              tabindex="0"
              @click="goAuthorProfile"
              @keydown.enter="goAuthorProfile"
            >
              <el-avatar :size="32" :src="note.user?.avatar || undefined" class="cm-note-detail__avatar">
                {{ note.user?.userName?.charAt(0) ?? '?' }}
              </el-avatar>
              <span class="cm-note-detail__author-name">{{ note.user?.userName ?? '匿名' }}</span>
            </span>

            <span class="cm-note-detail__meta-right">
              <time>{{ formatDateTime(note.updateTime || note.createTime) }}</time>
              <span class="cm-note-detail__dot">·</span>
              <span>{{ note.wordCount ?? 0 }} 字</span>
              <span class="cm-note-detail__dot">·</span>
              <span>约 {{ readingMinutes }} 分钟</span>
            </span>
          </div>

          <!-- 分类 -->
          <div v-if="note.category" class="cm-note-detail__category-row">
            <button type="button" class="cm-note-detail__category" @click="goCategory">
              <el-icon :size="13"><FolderOpened /></el-icon>
              {{ note.category.name }}
            </button>
          </div>
        </header>

        <!-- 封面 -->
        <img
          v-if="note.cover?.trim()"
          class="cm-note-detail__cover"
          :src="note.cover"
          :alt="note.title"
        />

        <!-- 正文 -->
        <MarkdownViewer class="cm-note-detail__body" :content="note.content" variant="article" />

        <!-- 标签 -->
        <div v-if="tags.length" class="cm-note-detail__tags">
          <span v-for="tag in tags" :key="tag.id" class="cm-note-detail__tag">{{ tag.name }}</span>
        </div>

        <!-- ==================== 操作栏 ==================== -->
        <div class="cm-note-detail__actions">
          <!-- 作者：可见性切换 -->
          <template v-if="isAuthor">
            <button
              type="button"
              class="cm-note-detail__action"
              :class="{ 'is-active': isPrivate }"
              :disabled="visibilityPending"
              @click="toggleVisibility"
            >
              <el-icon>
                <component :is="isPrivate ? 'Lock' : 'View'" />
              </el-icon>
              <span>{{ isPrivate ? '私密' : '公开' }}</span>
              <span class="cm-note-detail__action-hint">点击切换</span>
            </button>

            <el-button size="small" plain @click="goEdit">
              <el-icon><EditPen /></el-icon>
              编辑
            </el-button>
          </template>

          <button type="button" class="cm-note-detail__action" @click="copyLink">
            <el-icon><Link /></el-icon>
            <span>复制链接</span>
          </button>

          <el-dropdown v-if="isAuthor" trigger="click">
            <button type="button" class="cm-note-detail__action" aria-label="更多操作">
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="goEdit">
                  <el-icon><EditPen /></el-icon>编辑笔记
                </el-dropdown-item>
                <el-dropdown-item divided @click="handleDelete">
                  <el-icon><Delete /></el-icon>删除笔记
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <!-- ==================== AI 助手条 ==================== -->
        <div class="cm-note-detail__ai">
          <div class="cm-note-detail__ai-head">
            <span class="cm-note-detail__ai-badge" aria-hidden="true">
              <el-icon :size="13"><MagicStick /></el-icon>
            </span>
            <span class="cm-note-detail__ai-label">AI 助手</span>
            <span class="cm-note-detail__ai-hint">基于本篇笔记生成</span>
          </div>

          <!--
            生成中把三个入口一起禁用（含重复点当前动作）：
            想换一个动作先点面板里的「停止」，避免同一个流被反复重启。
          -->
          <div class="cm-note-detail__ai-actions">
            <button
              v-for="action in AI_ACTIONS"
              :key="action"
              type="button"
              class="cm-note-detail__ai-btn"
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
      @retry="ai.retry('notes', noteId)"
      @copy="copyAiContent"
      @login="requireLogin"
    />
  </div>
</template>

<style scoped>
.cm-note-detail {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

.cm-note-detail__state {
  min-height: 40vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cm-note-detail__article {
  max-width: var(--cm-container-reading, 720px);
  margin: 0 auto;
}

/* ==================== 提示条 ==================== */
.cm-note-detail__banners {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  margin-bottom: var(--cm-space-5);
}

.cm-note-detail__banner {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  padding: var(--cm-space-2) var(--cm-space-3);
  font-size: var(--cm-font-size-sm);
  border-radius: var(--cm-radius-md);
}

.cm-note-detail__banner--draft {
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border: 1px solid var(--cm-warning-border);
}

.cm-note-detail__banner--private {
  color: var(--cm-text-secondary);
  background-color: var(--cm-bg-sunken);
  border: 1px solid var(--cm-border-default);
}

/* ==================== 标题区 ==================== */
.cm-note-detail__head {
  padding-bottom: var(--cm-space-6);
}

.cm-note-detail__title {
  margin: 0;
  font-size: var(--cm-font-size-3xl);
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-note-detail__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-5);
}

.cm-note-detail__author {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  color: var(--cm-text-secondary);
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-note-detail__author:hover {
  color: var(--cm-accent-600);
}

.cm-note-detail__avatar {
  flex-shrink: 0;
  font-size: 13px;
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-note-detail__author-name {
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-text-primary);
}

.cm-note-detail__meta-right {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  margin-left: auto;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-note-detail__dot {
  color: var(--cm-border-strong);
}

/* ==================== 分类 ==================== */
.cm-note-detail__category-row {
  margin-top: var(--cm-space-4);
}

.cm-note-detail__category {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  padding: 3px 10px;
  font-family: inherit;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-sunken);
  border: 1px solid transparent;
  border-radius: var(--cm-radius-full);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.cm-note-detail__category:hover {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
  border-color: var(--cm-accent-200);
}

/* ==================== 封面 / 正文 ==================== */
.cm-note-detail__cover {
  width: 100%;
  max-height: 380px;
  margin: 0 0 var(--cm-space-8);
  object-fit: cover;
  border-radius: var(--cm-radius-lg);
}

.cm-note-detail__body {
  margin-bottom: var(--cm-space-8);
}

/* ==================== 标签 ==================== */
.cm-note-detail__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  margin-bottom: var(--cm-space-8);
}

.cm-note-detail__tag {
  padding: 3px 11px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-sunken);
  border-radius: var(--cm-radius-full);
}

/* ==================== 操作栏 ==================== */
.cm-note-detail__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  padding: var(--cm-space-4) 0;
  border-top: 1px solid var(--cm-border-subtle);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-note-detail__action {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  padding: var(--cm-space-2) var(--cm-space-3);
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
  text-decoration: none;
  background: none;
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-full);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.cm-note-detail__action:hover:not(:disabled) {
  color: var(--cm-text-primary);
  background-color: var(--cm-bg-hover);
  border-color: var(--cm-border-default);
}

.cm-note-detail__action:disabled {
  opacity: 0.6;
  cursor: default;
}

.cm-note-detail__action.is-active {
  color: var(--cm-text-secondary);
  background-color: var(--cm-bg-sunken);
  border-color: var(--cm-border-default);
}

.cm-note-detail__action-hint {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

/* ==================== AI 助手条 ==================== */
.cm-note-detail__ai {
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

.cm-note-detail__ai-head {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  min-width: 0;
}

.cm-note-detail__ai-badge {
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

.cm-note-detail__ai-label {
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-accent-800);
}

.cm-note-detail__ai-hint {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-accent-600);
}

.cm-note-detail__ai-actions {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
}

.cm-note-detail__ai-btn {
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

.cm-note-detail__ai-btn:not(:disabled):hover {
  color: var(--cm-text-inverse);
  background-color: var(--cm-accent-600);
  border-color: var(--cm-accent-600);
}

/* 生成中：入口禁用但不要「消失」，让人看得到它还在那儿 */
.cm-note-detail__ai-btn:disabled {
  color: var(--cm-accent-600);
  background-color: var(--cm-accent-50);
  border-color: var(--cm-accent-100);
  cursor: not-allowed;
  opacity: 0.75;
}

/* ==================== 响应式 ==================== */
@media (max-width: 720px) {
  .cm-note-detail__title {
    font-size: var(--cm-font-size-2xl);
  }

  .cm-note-detail__meta-right {
    width: 100%;
    margin-left: 0;
  }

  .cm-note-detail__ai {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-note-detail__ai-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-note-detail__ai-btn {
    text-align: center;
  }
}
</style>
