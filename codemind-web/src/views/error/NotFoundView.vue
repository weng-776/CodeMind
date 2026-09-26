<script setup lang="ts">
import { useRouter } from 'vue-router'
import { RouteName } from '@/router/routes-names'

const router = useRouter()
</script>

<template>
  <div class="cm-404 cm-container-narrow">
    <p class="cm-404__code cm-text-mono">404</p>
    <h1 class="cm-404__title">这个页面不存在</h1>
    <p class="cm-404__desc">
      链接可能已经失效，或者地址输错了。你可以回到首页，或去社区找找想看的内容。
    </p>

    <div class="cm-404__actions">
      <el-button type="primary" @click="router.push({ name: RouteName.HOME })">回到首页</el-button>
      <el-button plain @click="router.push({ name: RouteName.ARTICLE_LIST })">
        去社区看看
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.cm-404 {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding-top: var(--cm-space-16);
  padding-bottom: var(--cm-space-16);
}

.cm-404__code {
  font-size: 64px;
  font-weight: 500;
  line-height: 1;
  color: var(--cm-border-default);
  letter-spacing: -0.04em;
}

.cm-404__title {
  margin-top: var(--cm-space-4);
  font-size: var(--cm-font-size-2xl);
}

.cm-404__desc {
  margin-top: var(--cm-space-3);
  font-size: var(--cm-font-size-base);
  color: var(--cm-text-tertiary);
  max-width: 46ch;
  line-height: var(--cm-line-height-normal);
}

.cm-404__actions {
  display: flex;
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-8);
}
</style>
