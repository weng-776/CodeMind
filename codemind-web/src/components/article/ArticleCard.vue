<script setup lang="ts">
/**
 * 文章卡片
 * ------------------------------------------------------------------
 * 社区列表、首页最新/热门、我的文章、收藏列表共用。
 *
 * 两种密度：
 *   - default：带摘要（列表页、首页），标题 17px
 *   - compact：仅标题 + 元信息（热门榜、侧栏），标题 15px
 *
 * 设计取舍：用「1px 分隔线 + 无背景」而不是「卡片堆叠」，
 * 符合文档「不要大量卡片堆叠 / 内容优先」的要求。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import type { ArticleListItemVO } from '@/types/article'
import type { TagVO } from '@/types/category'
import { ContentStatus } from '@/types/common'
import { formatCount, formatRelativeTime } from '@/utils/format'
import { RouteName } from '@/router/routes-names'

interface Props {
  article: ArticleListItemVO
  /** 显示密度 */
  variant?: 'default' | 'compact'
  /** 是否显示封面缩略图 */
  showCover?: boolean
  /** 是否显示「草稿」角标（我的文章用） */
  showStatus?: boolean
  /** 是否为排名样式（热门榜左侧显示序号，从 1 开始；0 表示不显示） */
  rank?: number
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'default',
  showCover: false,
  showStatus: false,
  rank: 0,
})

const router = useRouter()

const isDraft = computed(() => props.article.status === ContentStatus.DRAFT)

/**
 * 封面是否加载失败。
 * 后端可能返回**指向不存在对象的 URL**（实测 `article_cover/a1.jpg` 在 MinIO 上是 404），
 * 这时浏览器会露出一个灰块 + 一段 alt 文字，比没有封面还难看。
 * 加载失败就把封面整块撤掉，只留文字区。
 */
const coverFailed = ref(false)
watch(
  () => props.article.cover,
  () => {
    coverFailed.value = false
  },
)

/** 是否有可用封面：后端可能返回空串，或地址取不到（见 coverFailed） */
const hasCover = computed(
  () => props.showCover && !coverFailed.value && !!props.article.cover?.trim(),
)

const timeText = computed(() => formatRelativeTime(props.article.createTime))

/**
 * 可用于展示 / 点击的标签。
 * 后端目前会返回 { id: null, name: null } 这种占位元素（tag 表没查到对应行），
 * 直接渲染会得到一排空白胶囊、点进去还会跳到一个无效的 tagId 筛选，
 * 所以这里先过滤掉缺 id 或缺名字的元素。
 */
const validTags = computed(() => (props.article.tags ?? []).filter((t) => t?.id != null && !!t.name))

/** 标签最多展示 4 个，多出的折叠为 +N，避免卡片高度失控 */
const visibleTags = computed(() => validTags.value.slice(0, 4))
const extraTagCount = computed(() => Math.max(0, validTags.value.length - 4))

const stats = computed(() => [
  { key: 'view', icon: 'View', value: props.article.viewCount, label: '浏览' },
  { key: 'like', icon: 'Star', value: props.article.likeCount, label: '点赞' },
  { key: 'comment', icon: 'ChatDotRound', value: props.article.commentCount, label: '评论' },
  { key: 'favorite', icon: 'Collection', value: props.article.favoriteCount, label: '收藏' },
])

function goDetail() {
  router.push({ name: RouteName.ARTICLE_DETAIL, params: { id: props.article.id } })
}

/**
 * 点标签 → 按标签筛选文章。
 *
 * 注意两点（都是联调时踩出来的）：
 *   1. 必须显式带上 tab=tag。列表页虽然也兼容「只有 tagId」的老链接
 *      （会按标签处理），但显式带上更不容易被后续改动误伤。
 *   2. 名字一起放进 URL：列表页不需要为了显示「标签『Redis』下的文章」
 *      再去请求一次 `GET /api/tag/list`（它还需要登录，游客会 401），
 *      卡片本来就拿到了标签名。
 */
function goTag(tag: TagVO, event: Event) {
  // 标签点击不应触发卡片跳转
  event.stopPropagation()
  router.push({
    name: RouteName.ARTICLE_LIST,
    query: { tab: 'tag', tagId: String(tag.id), tagName: tag.name },
  })
}

function goAuthor(event: Event) {
  event.stopPropagation()
  const userId = props.article.user?.id
  if (userId === undefined) return
  router.push({ name: RouteName.USER_PROFILE, params: { userId: String(userId) } })
}
</script>

<template>
  <article
    class="cm-article-card"
    :class="[`cm-article-card--${variant}`, { 'is-draft': isDraft }]"
    role="link"
    tabindex="0"
    @click="goDetail"
    @keydown.enter="goDetail"
  >
    <!-- 热门榜序号 -->
    <span v-if="rank > 0" class="cm-article-card__rank" :class="{ 'is-top': rank <= 3 }">
      {{ rank }}
    </span>

    <div class="cm-article-card__main">
      <h3 class="cm-article-card__title cm-line-clamp-2">
        <span v-if="showStatus && isDraft" class="cm-article-card__draft">草稿</span>
        {{ article.title }}
      </h3>

      <p v-if="variant === 'default' && article.summary" class="cm-article-card__summary cm-line-clamp-2">
        {{ article.summary }}
      </p>

      <div class="cm-article-card__meta">
        <!-- 作者 -->
        <span
          v-if="article.user"
          class="cm-article-card__author"
          role="link"
          tabindex="0"
          @click="goAuthor"
          @keydown.enter="goAuthor"
        >
          <el-avatar :size="18" :src="article.user.avatar || undefined" class="cm-article-card__avatar">
            {{ article.user.userName?.charAt(0) ?? '?' }}
          </el-avatar>
          <span class="cm-article-card__author-name">{{ article.user.userName }}</span>
        </span>

        <span v-if="article.user && timeText" class="cm-article-card__sep">·</span>
        <time v-if="timeText" class="cm-article-card__time">{{ timeText }}</time>

        <!-- 标签 -->
        <template v-if="visibleTags.length">
          <span class="cm-article-card__sep">·</span>
          <span class="cm-article-card__tags">
            <button
              v-for="tag in visibleTags"
              :key="tag.id"
              type="button"
              class="cm-article-card__tag"
              @click="goTag(tag, $event)"
            >
              {{ tag.name }}
            </button>
            <span v-if="extraTagCount > 0" class="cm-article-card__tag-more">+{{ extraTagCount }}</span>
          </span>
        </template>

        <!-- 统计 -->
        <span class="cm-article-card__stats">
          <span v-for="s in stats" :key="s.key" class="cm-article-card__stat" :title="s.label">
            <el-icon class="cm-article-card__stat-icon"><component :is="s.icon" /></el-icon>
            <span>{{ formatCount(s.value) }}</span>
          </span>
        </span>
      </div>
    </div>

    <div v-if="hasCover" class="cm-article-card__cover">
      <img :src="article.cover" :alt="article.title" loading="lazy" @error="coverFailed = true" />
    </div>
  </article>
</template>

<style scoped>
.cm-article-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--cm-space-5);
  padding: var(--cm-space-5) var(--cm-space-4);
  border-bottom: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  transition: background-color 0.15s ease;
  outline: none;
}

.cm-article-card:hover {
  background-color: var(--cm-bg-hover);
}

/* 键盘可达性：仅在键盘聚焦时显示描边，鼠标点击不出现 */
.cm-article-card:focus-visible {
  box-shadow: inset 0 0 0 2px var(--cm-accent-300);
}

.cm-article-card:last-child {
  border-bottom: none;
}

.cm-article-card.is-draft .cm-article-card__title {
  color: var(--cm-text-secondary);
}

/* ---------- 序号 ---------- */
.cm-article-card__rank {
  flex-shrink: 0;
  width: 22px;
  padding-top: 2px;
  font-family: var(--cm-font-mono);
  font-size: var(--cm-font-size-base);
  font-weight: 600;
  text-align: center;
  color: var(--cm-text-quaternary);
}

.cm-article-card__rank.is-top {
  color: var(--cm-accent-600);
}

/* ---------- 主体 ---------- */
.cm-article-card__main {
  flex: 1;
  min-width: 0;
}

.cm-article-card__title {
  margin: 0;
  font-size: var(--cm-font-size-lg);
  font-weight: 600;
  line-height: 1.45;
  color: var(--cm-text-primary);
  letter-spacing: -0.01em;
  transition: color 0.15s ease;
}

.cm-article-card:hover .cm-article-card__title {
  color: var(--cm-accent-600);
}

.cm-article-card--compact .cm-article-card__title {
  font-size: var(--cm-font-size-md);
  font-weight: 500;
}

.cm-article-card__draft {
  display: inline-block;
  margin-right: var(--cm-space-2);
  padding: 1px 6px;
  font-size: var(--cm-font-size-xs);
  font-weight: 400;
  vertical-align: 2px;
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border: 1px solid var(--cm-warning-border);
  border-radius: var(--cm-radius-xs);
}

.cm-article-card__summary {
  margin: var(--cm-space-3) 0 0;
  font-size: var(--cm-font-size-base);
  line-height: 1.65;
  color: var(--cm-text-tertiary);
}

/* ---------- 元信息 ---------- */
.cm-article-card__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  margin-top: var(--cm-space-3);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-article-card__author {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  color: var(--cm-text-tertiary);
  border-radius: var(--cm-radius-sm);
  transition: color 0.15s ease;
}

.cm-article-card__author:hover {
  color: var(--cm-accent-600);
}

.cm-article-card__avatar {
  flex-shrink: 0;
  font-size: 10px;
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-article-card__author-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cm-article-card__sep {
  color: var(--cm-border-strong);
}

.cm-article-card__tags {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-wrap: wrap;
}

.cm-article-card__tag {
  padding: 1px 7px;
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

.cm-article-card__tag:hover {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
}

.cm-article-card__tag-more {
  color: var(--cm-text-quaternary);
}

.cm-article-card__stats {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-4);
  margin-left: auto;
}

.cm-article-card__stat {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}

.cm-article-card__stat-icon {
  font-size: 13px;
}

/* compact 密度下统计信息收敛一些 */
.cm-article-card--compact .cm-article-card__stats {
  gap: var(--cm-space-3);
}

/* ---------- 封面 ---------- */
.cm-article-card__cover {
  flex-shrink: 0;
  width: 132px;
  height: 84px;
  overflow: hidden;
  border-radius: var(--cm-radius-md);
  background-color: var(--cm-bg-sunken);
}

.cm-article-card__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* ---------- 响应式：窄屏隐藏封面与摘要 ---------- */
@media (max-width: 720px) {
  .cm-article-card__cover {
    display: none;
  }

  .cm-article-card__summary {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .cm-article-card__stats {
    width: 100%;
    margin-left: 0;
    margin-top: var(--cm-space-1);
  }
}
</style>
