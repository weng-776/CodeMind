<script setup lang="ts">
/**
 * 根组件
 * ------------------------------------------------------------------
 * 只做一件事：根据 route.meta.layout 决定是否套用主布局。
 * 登录页 meta.layout = false，走全屏独立布局；其余页面均套 MainLayout。
 *
 * 用 computed 而不是在模板里直接读 route，是为了在 layout 未声明时
 * 默认走主布局（默认 true），避免新增页面忘记写 meta 就变成裸页。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import MainLayout from '@/layouts/MainLayout.vue'

const route = useRoute()

const useMainLayout = computed(() => route.meta.layout !== false)
</script>

<template>
  <MainLayout v-if="useMainLayout" />
  <router-view v-else />
</template>
