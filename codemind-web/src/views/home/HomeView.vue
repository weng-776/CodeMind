<script setup lang="ts">
/**
 * 首页
 * ------------------------------------------------------------------
 * 结构（对应文档「首页」章节）：
 *   1. Hero —— 产品定位说明 + 主要入口，仅在未登录时强调
 *   2. 最新文章  —— GET /api/article/latest
 *   3. 热门文章  —— GET /api/article/hot（左侧榜单，紧凑密度）
 *   4. 最新文章区块内的首次体验引导
 *
 * 三态处理原则：
 *   两个数据区块各自独立请求、独立维护 loading/error/empty，
 *   任一接口挂掉不影响另一块渲染 —— 首页是流量入口，不能整页白屏。
 */
import { computed, onMounted, ref } from 'vue'

import ContentSection from '@/components/common/ContentSection.vue'
import ArticleCard from '@/components/article/ArticleCard.vue'
import { getHotArticles, getLatestArticles } from '@/api/article'
import { useUserStore } from '@/stores/user'
import { RouteName } from '@/router/routes-names'
import type { ArticleListItemVO } from '@/types/article'

const userStore = useUserStore()

const PAGE_SIZE = 8

/* ---------- 最新文章 ---------- */
const latest = ref<ArticleListItemVO[]>([])
const latestLoading = ref(true)
const latestError = ref(false)

/* ---------- 热门文章 ---------- */
const hot = ref<ArticleListItemVO[]>([])
const hotLoading = ref(true)
const hotError = ref(false)

const latestEmpty = computed(() => !latestLoading.value && !latestError.value && latest.value.length === 0)
const hotEmpty = computed(() => !hotLoading.value && !hotError.value && hot.value.length === 0)

/** 未登录时的欢迎语，让空社区也有明确引导 */
const greeting = computed(() => {
  if (!userStore.isLoggedIn) return '把技术沉淀下来，也看看别人在写什么'
  const name = userStore.userName
  return name ? `欢迎回来，${name}` : '欢迎回来'
})

async function loadLatest() {
  latestLoading.value = true
  latestError.value = false
  try {
    const res = await getLatestArticles({ page: 1, size: PAGE_SIZE })
    latest.value = res.records ?? []
  } catch {
    latestError.value = true
    latest.value = []
  } finally {
    latestLoading.value = false
  }
}

async function loadHot() {
  hotLoading.value = true
  hotError.value = false
  try {
    const res = await getHotArticles({ page: 1, size: 6 })
    hot.value = res.records ?? []
  } catch {
    hotError.value = true
    hot.value = []
  } finally {
    hotLoading.value = false
  }
}

onMounted(() => {
  // 并发发起，两个区块互不等待
  void loadLatest()
  void loadHot()
})
</script>

<template>
  <div class="cm-home">
    <!-- ==================== Hero ==================== -->
    <section class="cm-hero">
      <div class="cm-container cm-hero__inner">
        <div class="cm-hero__text">
          <p class="cm-hero__eyebrow">CodeMind</p>
          <h1 class="cm-hero__title">
            技术社区 · 个人知识库
            <span class="cm-hero__title-accent">与 AI 助手</span>
          </h1>
          <p class="cm-hero__desc">{{ greeting }}</p>

          <div class="cm-hero__actions">
            <el-button type="primary" @click="$router.push({ name: RouteName.ARTICLE_LIST })">
              浏览社区文章
            </el-button>

            <template v-if="userStore.isLoggedIn">
              <el-button @click="$router.push({ name: RouteName.NOTE_LIST })">
                写一篇笔记
              </el-button>
              <el-button text @click="$router.push({ name: RouteName.AI_CHAT })">
                去问 AI 助手
                <el-icon class="cm-hero__arrow"><ArrowRight /></el-icon>
              </el-button>
            </template>

            <el-button v-else @click="$router.push({ name: RouteName.LOGIN })">
              登录 / 注册
            </el-button>
          </div>

          <!-- 能力速览：用文字而非卡片，避免"卡片堆叠" -->
          <ul class="cm-hero__features">
            <li><el-icon><Reading /></el-icon>阅读与讨论技术文章</li>
            <li><el-icon><Notebook /></el-icon>Markdown 笔记与分类归档</li>
            <li><el-icon><MagicStick /></el-icon>AI 总结 / 知识点提取 / 面试题</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ==================== 主内容 ==================== -->
    <div class="cm-container cm-home__body">
      <div class="cm-home__grid">
        <!-- 左：最新文章 -->
        <div class="cm-home__main">
          <ContentSection
            title="最新文章"
            subtitle="按发布时间倒序"
            :loading="latestLoading"
            :error="latestError"
            :empty="latestEmpty"
            empty-text="还没有人发布文章，来做第一个吧"
            :more-to="{ name: RouteName.ARTICLE_LIST }"
            :skeleton-rows="5"
            @retry="loadLatest"
          >
            <ArticleCard
              v-for="item in latest"
              :key="item.id"
              :article="item"
            />
          </ContentSection>
        </div>

        <!-- 右：热门文章 -->
        <aside class="cm-home__side">
          <ContentSection
            title="热门"
            subtitle="按浏览量"
            :loading="hotLoading"
            :error="hotError"
            :empty="hotEmpty"
            empty-text="暂无热门内容"
            :skeleton-rows="5"
            @retry="loadHot"
          >
            <ol class="cm-home__hot-list">
              <li v-for="(item, index) in hot" :key="item.id">
                <ArticleCard :article="item" variant="compact" :rank="index + 1" />
              </li>
            </ol>
          </ContentSection>

          <!-- 未登录引导 -->
          <div v-if="!userStore.isLoggedIn" class="cm-home__cta cm-panel">
            <p class="cm-home__cta-title">还没账号？</p>
            <p class="cm-home__cta-desc">
              登录后即可发布文章、记录笔记，并用 AI 帮你整理知识。
            </p>
            <el-button class="cm-home__cta-btn" size="small" @click="$router.push({ name: RouteName.LOGIN })">
              立即登录
            </el-button>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cm-home {
  padding-bottom: var(--cm-space-16);
}

/* ==================== Hero ==================== */
.cm-hero {
  /* 极淡的径向底纹，替代渐变块 */
  background:
    radial-gradient(760px 300px at 18% -30%, var(--cm-accent-50), transparent 62%),
    var(--cm-bg-surface);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-hero__inner {
  padding-top: var(--cm-space-12);
  padding-bottom: var(--cm-space-12);
}

.cm-hero__text {
  max-width: 640px;
}

.cm-hero__eyebrow {
  margin: 0;
  font-family: var(--cm-font-mono);
  font-size: var(--cm-font-size-xs);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--cm-accent-600);
}

.cm-hero__title {
  margin: var(--cm-space-4) 0 0;
  font-size: var(--cm-font-size-3xl);
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-hero__title-accent {
  display: block;
  color: var(--cm-accent-600);
}

.cm-hero__desc {
  margin: var(--cm-space-4) 0 0;
  font-size: var(--cm-font-size-md);
  line-height: 1.7;
  color: var(--cm-text-tertiary);
}

.cm-hero__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-6);
}

.cm-hero__arrow {
  margin-left: 2px;
}

.cm-hero__features {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cm-space-2) var(--cm-space-6);
  margin: var(--cm-space-8) 0 0;
  padding: 0;
  list-style: none;
}

.cm-hero__features li {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

.cm-hero__features :deep(.el-icon) {
  color: var(--cm-accent-500);
}

/* ==================== 主体网格 ==================== */
.cm-home__body {
  margin-top: var(--cm-space-10);
}

.cm-home__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--cm-space-10);
  align-items: start;
}

.cm-home__main {
  min-width: 0;
}

.cm-home__side {
  min-width: 0;
  position: sticky;
  top: calc(var(--cm-header-height) + var(--cm-space-6));
}

.cm-home__hot-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 热门榜：紧凑内边距，序号在左 */
.cm-home__hot-list :deep(.cm-article-card) {
  padding: var(--cm-space-3) var(--cm-space-2);
}

/* ==================== 侧栏登录引导 ==================== */
.cm-home__cta {
  margin-top: var(--cm-space-8);
  padding: var(--cm-space-5);
}

.cm-home__cta-title {
  margin: 0;
  font-size: var(--cm-font-size-md);
  font-weight: 600;
  color: var(--cm-text-primary);
}

.cm-home__cta-desc {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  line-height: 1.65;
  color: var(--cm-text-tertiary);
}

.cm-home__cta-btn {
  margin-top: var(--cm-space-4);
  width: 100%;
}

/* ==================== 响应式 ==================== */
@media (max-width: 1024px) {
  .cm-home__grid {
    grid-template-columns: minmax(0, 1fr) 280px;
    gap: var(--cm-space-8);
  }
}

@media (max-width: 860px) {
  .cm-home__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cm-space-10);
  }

  .cm-home__side {
    position: static;
  }

  .cm-hero__title {
    font-size: var(--cm-font-size-2xl);
  }
}
</style>
