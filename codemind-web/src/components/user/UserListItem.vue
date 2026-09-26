<script setup lang="ts">
/**
 * 用户行
 * ------------------------------------------------------------------
 * 「我的关注」(1.10) 与「我的粉丝」(1.11) 两个列表的 records 结构完全相同
 * （FollowUserVO），所以抽成一个组件，避免两处各写一遍卡片样式。
 *
 * 与 ArticleCard / NoteCard 的差别：
 *   - 没有封面，左侧是头像
 *   - 元信息是「文章 / 关注 / 粉丝」三个计数，而不是浏览点赞
 *   - 操作按钮由父级通过 action 插槽注入（关注列表要「取消关注」，
 *     粉丝列表因为拿不到关注状态而不放按钮，见 ProfileFansTab 的说明）
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'

import type { FollowUserVO } from '@/types/user'
import { formatCount, formatRelativeTime } from '@/utils/format'
import { RouteName } from '@/router/routes-names'

interface Props {
  user: FollowUserVO
  /**
   * 时间前缀文案，如「关注于」「成为粉丝于」。
   * 不传则不展示时间 —— 该字段在 1.10/1.11 里分别是关注时间与成为粉丝的时间，
   * 语义不同，所以由调用方决定怎么称呼。
   */
  timeLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  timeLabel: '',
})

const router = useRouter()

const timeText = computed(() => formatRelativeTime(props.user.createTime))

function goProfile() {
  router.push({
    name: RouteName.USER_PROFILE,
    params: { userId: String(props.user.id) },
  })
}
</script>

<template>
  <article
    class="cm-user-item"
    role="link"
    tabindex="0"
    @click="goProfile"
    @keydown.enter="goProfile"
  >
    <el-avatar :size="44" :src="user.avatar || undefined" class="cm-user-item__avatar">
      {{ user.userName?.charAt(0) ?? '?' }}
    </el-avatar>

    <div class="cm-user-item__main">
      <h3 class="cm-user-item__name">{{ user.userName }}</h3>

      <p class="cm-user-item__intro cm-line-clamp-1">
        {{ user.intro || '这个人还没有填写简介' }}
      </p>

      <div class="cm-user-item__meta">
        <span class="cm-user-item__count">{{ formatCount(user.articleCount) }} 文章</span>
        <span class="cm-user-item__sep">·</span>
        <span class="cm-user-item__count">{{ formatCount(user.followCount) }} 关注</span>
        <span class="cm-user-item__sep">·</span>
        <span class="cm-user-item__count">{{ formatCount(user.fansCount) }} 粉丝</span>

        <template v-if="timeLabel && timeText">
          <span class="cm-user-item__sep">·</span>
          <span class="cm-user-item__time">{{ timeLabel }} {{ timeText }}</span>
        </template>
      </div>
    </div>

    <!-- 操作区：阻止冒泡，否则点按钮会顺带跳转到对方主页 -->
    <div v-if="$slots.action" class="cm-user-item__action" @click.stop>
      <slot name="action" />
    </div>
  </article>
</template>

<style scoped>
.cm-user-item {
  display: flex;
  align-items: center;
  gap: var(--cm-space-4);
  padding: var(--cm-space-4);
  border-bottom: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-md);
  cursor: pointer;
  outline: none;
  transition: background-color 0.15s ease;
}

.cm-user-item:hover {
  background-color: var(--cm-bg-hover);
}

.cm-user-item:focus-visible {
  box-shadow: inset 0 0 0 2px var(--cm-accent-300);
}

.cm-user-item:last-child {
  border-bottom: none;
}

.cm-user-item__avatar {
  flex-shrink: 0;
  font-size: var(--cm-font-size-md);
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-user-item__main {
  flex: 1;
  min-width: 0;
}

.cm-user-item__name {
  margin: 0;
  font-size: var(--cm-font-size-md);
  font-weight: 600;
  color: var(--cm-text-primary);
  transition: color 0.15s ease;
}

.cm-user-item:hover .cm-user-item__name {
  color: var(--cm-accent-600);
}

.cm-user-item__intro {
  margin: var(--cm-space-1) 0 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

.cm-user-item__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  margin-top: var(--cm-space-2);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-user-item__sep {
  color: var(--cm-border-strong);
}

.cm-user-item__action {
  flex-shrink: 0;
}

@media (max-width: 560px) {
  .cm-user-item {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .cm-user-item__action {
    width: 100%;
    padding-left: calc(44px + var(--cm-space-4));
  }
}
</style>
