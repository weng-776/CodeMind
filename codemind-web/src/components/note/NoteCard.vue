<script setup lang="ts">
/**
 * 笔记卡片
 * ------------------------------------------------------------------
 * 笔记列表（2.5）、个人中心的笔记 Tab、他人主页的笔记 Tab 共用。
 *
 * 与 ArticleCard 的区别（所以没有复用）：
 *   - 没有浏览/点赞/评论数，改显示**字数**与**更新时间**
 *   - 多了**分类**（列表接口给的是 categoryName 字符串）
 *   - 多了**可见性**（0 私密 / 1 公开）与**状态**（0 草稿 / 1 正常）两个标记
 *   - 笔记是「自己的东西」，所以时间用更新时间更有意义
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'

import type { NoteListItemVO } from '@/types/note'
import { ContentStatus, Visibility } from '@/types/common'
import { formatCount, formatRelativeTime } from '@/utils/format'
import { RouteName } from '@/router/routes-names'

interface Props {
  note: NoteListItemVO
  /** 是否显示可见性 / 草稿标记（我的笔记里需要，公开列表里不需要） */
  showStatus?: boolean
  /** 是否显示封面缩略图 */
  showCover?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  showStatus: true,
  showCover: false,
})

const router = useRouter()

const isDraft = computed(() => props.note.status === ContentStatus.DRAFT)
const isPrivate = computed(() => props.note.visibility === Visibility.PRIVATE)

const hasCover = computed(() => props.showCover && !!props.note.cover?.trim())

/** 更新时间优先，没有则退回创建时间 */
const timeText = computed(() =>
  formatRelativeTime(props.note.updateTime || props.note.createTime),
)

const visibleTags = computed(() => props.note.tags?.slice(0, 3) ?? [])
const extraTagCount = computed(() => Math.max(0, (props.note.tags?.length ?? 0) - 3))

function goDetail() {
  router.push({ name: RouteName.NOTE_DETAIL, params: { id: props.note.id } })
}

/**
 * 分类与标签在这里只作展示，不做点击筛选。
 * 原因：2.5 笔记列表接口只支持 categoryId / visibility / status / keyword 四个筛选参数，
 * **没有 tagId**；而列表返回的分类只有 categoryName 字符串、没有 id。
 * 做成可点击会跳到一个无效筛选，所以老实显示为纯文本。
 * 分类筛选由列表页侧栏的分类树承担（那里拿得到 id）。
 */
</script>

<template>
  <article
    class="cm-note-card"
    :class="{ 'is-draft': isDraft }"
    role="link"
    tabindex="0"
    @click="goDetail"
    @keydown.enter="goDetail"
  >
    <div class="cm-note-card__main">
      <!-- 标记行 -->
      <div v-if="showStatus" class="cm-note-card__flags">
        <span v-if="isDraft" class="cm-note-card__flag cm-note-card__flag--draft">草稿</span>
        <span
          class="cm-note-card__flag"
          :class="isPrivate ? 'cm-note-card__flag--private' : 'cm-note-card__flag--public'"
        >
          <el-icon :size="11">
            <component :is="isPrivate ? 'Lock' : 'View'" />
          </el-icon>
          {{ isPrivate ? '私密' : '公开' }}
        </span>
      </div>

      <h3 class="cm-note-card__title cm-line-clamp-2">{{ note.title }}</h3>

      <p v-if="note.summary" class="cm-note-card__summary cm-line-clamp-2">
        {{ note.summary }}
      </p>

      <div class="cm-note-card__meta">
        <!-- 分类：纯展示，见 script 内说明 -->
        <span v-if="note.categoryName" class="cm-note-card__category">
          <el-icon :size="12"><FolderOpened /></el-icon>
          {{ note.categoryName }}
        </span>

        <span v-if="note.categoryName" class="cm-note-card__sep">·</span>
        <time class="cm-note-card__time">{{ timeText }}</time>

        <!-- 标签：纯展示（列表接口不支持按标签筛选） -->
        <template v-if="visibleTags.length">
          <span class="cm-note-card__sep">·</span>
          <span class="cm-note-card__tags">
            <span v-for="tag in visibleTags" :key="tag.id" class="cm-note-card__tag">
              {{ tag.name }}
            </span>
            <span v-if="extraTagCount > 0" class="cm-note-card__tag-more">+{{ extraTagCount }}</span>
          </span>
        </template>

        <!-- 字数 -->
        <span class="cm-note-card__words">
          <el-icon :size="12"><Document /></el-icon>
          {{ formatCount(note.wordCount) }} 字
        </span>
      </div>
    </div>

    <div v-if="hasCover" class="cm-note-card__cover">
      <img :src="note.cover" :alt="note.title" loading="lazy" />
    </div>
  </article>
</template>

<style scoped>
.cm-note-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--cm-space-5);
  padding: var(--cm-space-5) var(--cm-space-4);
  border-bottom: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  outline: none;
  transition: background-color 0.15s ease;
}

.cm-note-card:hover {
  background-color: var(--cm-bg-hover);
}

.cm-note-card:focus-visible {
  box-shadow: inset 0 0 0 2px var(--cm-accent-300);
}

.cm-note-card:last-child {
  border-bottom: none;
}

.cm-note-card.is-draft .cm-note-card__title {
  color: var(--cm-text-secondary);
}

.cm-note-card__main {
  flex: 1;
  min-width: 0;
}

/* ---------- 标记 ---------- */
.cm-note-card__flags {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  margin-bottom: var(--cm-space-2);
}

.cm-note-card__flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  font-size: var(--cm-font-size-xs);
  border-radius: var(--cm-radius-xs);
}

.cm-note-card__flag--draft {
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border: 1px solid var(--cm-warning-border);
}

.cm-note-card__flag--private {
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-sunken);
  border: 1px solid var(--cm-border-subtle);
}

.cm-note-card__flag--public {
  color: var(--cm-success);
  background-color: var(--cm-success-bg);
  border: 1px solid var(--cm-success-border);
}

/* ---------- 正文 ---------- */
.cm-note-card__title {
  margin: 0;
  font-size: var(--cm-font-size-lg);
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: -0.01em;
  color: var(--cm-text-primary);
  transition: color 0.15s ease;
}

.cm-note-card:hover .cm-note-card__title {
  color: var(--cm-accent-600);
}

.cm-note-card__summary {
  margin: var(--cm-space-3) 0 0;
  font-size: var(--cm-font-size-base);
  line-height: 1.65;
  color: var(--cm-text-tertiary);
}

/* ---------- 元信息 ---------- */
.cm-note-card__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  margin-top: var(--cm-space-3);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-note-card__category {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-tertiary);
}

.cm-note-card__sep {
  color: var(--cm-border-strong);
}

.cm-note-card__tags {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-wrap: wrap;
}

.cm-note-card__tag {
  padding: 1px 7px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-tertiary);
  background-color: var(--cm-bg-sunken);
  border-radius: var(--cm-radius-full);
}

.cm-note-card__tag-more {
  color: var(--cm-text-quaternary);
}

.cm-note-card__words {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  white-space: nowrap;
}

/* ---------- 封面 ---------- */
.cm-note-card__cover {
  flex-shrink: 0;
  width: 120px;
  height: 78px;
  overflow: hidden;
  border-radius: var(--cm-radius-md);
  background-color: var(--cm-bg-sunken);
}

.cm-note-card__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* ---------- 响应式 ---------- */
@media (max-width: 720px) {
  .cm-note-card__cover {
    display: none;
  }

  .cm-note-card__summary {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .cm-note-card__words {
    margin-left: 0;
  }
}
</style>
