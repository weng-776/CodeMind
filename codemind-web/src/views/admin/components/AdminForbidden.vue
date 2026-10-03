<script setup lang="ts">
/**
 * 「无管理员权限」态
 * ------------------------------------------------------------------
 * 每个管理端页面都**必须**能渲染这个态（设计说明 §0.1 纪律 2），不能只靠路由守卫。
 *
 * 两条触发路径：
 *   1. 本地预检：`userStore.isAdmin === false`（省掉一次注定 403 的请求）；
 *   2. 接口兜底：本地缓存还是 admin，但后端已降权 → `ApiError.code === 403`。
 *
 * ⚠️ 文案必须自己写：后端 403 走的是 **HTTP 403**，axios 落到 error 分支后
 *    `request.ts` 会把 message 覆盖成「没有权限执行该操作」，
 *    **后端那句「无管理员权限」前端根本收不到**（设计说明 §7 坑 1）。
 *    所以这里用固定文案，不去读 `err.message`。
 *
 * 为什么给「重新登录」而不是「重试」：降权后重试还是 403，重登才能刷新
 * `userInfo` 缓存里的 role。
 */
import { useRouter } from 'vue-router'

import ErrorState from '@/components/common/ErrorState.vue'
import { RouteName } from '@/router/routes-names'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const userStore = useUserStore()

function goHome() {
  void router.push({ name: RouteName.HOME })
}

function relogin() {
  userStore.logout()
  void router.push({
    name: RouteName.LOGIN,
    query: { redirect: router.currentRoute.value.fullPath },
  })
}
</script>

<template>
  <ErrorState
    title="无管理员权限"
    description="当前账号不是管理员，无法访问管理后台。如果你认为这是误判，请重新登录后再试；权限以后端判定为准。"
    :retryable="false"
  >
    <el-button size="small" plain @click="goHome">返回首页</el-button>
    <template #extra>
      <el-button size="small" plain @click="relogin">重新登录</el-button>
    </template>
  </ErrorState>
</template>
