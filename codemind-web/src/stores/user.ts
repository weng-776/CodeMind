/**
 * 当前登录用户状态
 * ------------------------------------------------------------------
 * 只保留「全局用户态」：token、用户信息、未读消息数。
 * 页面数据（文章列表、笔记列表等）一律不进 Pinia，由页面自己管理。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import * as userApi from '@/api/user'
import * as notifyApi from '@/api/notify'
import { UserRole } from '@/types/admin'
import type { UserInfoVO } from '@/types/user'
import { getToken, getUserIdFromJwt, removeToken, setToken } from '@/utils/auth'

export const useUserStore = defineStore('user', () => {
  /* ==================== state ==================== */

  const token = ref<string | null>(getToken())
  const userInfo = ref<UserInfoVO | null>(null)
  const unreadCount = ref(0)

  /** 是否已请求过用户信息，避免重复拉取 */
  const infoLoaded = ref(false)

  /* ==================== getters ==================== */

  /** 是否已登录（有 token 即视为已登录，真实有效性由接口 401 兜底） */
  const isLoggedIn = computed(() => !!token.value)

  /**
   * 当前用户 id。
   *
   * ⚠️ 真实后端的 `GET /api/user/info` 不返回 `id`（文档里写了，但 `UserDataVO`
   * 没有这个字段），所以这里以 token 里的 `userId` 兜底 —— 后端签发时就写进去了。
   * 这个 id 是「作者本人 / 别人」判断的依据（文章详情的编辑入口、用户主页的
   * 「这是你的主页」都依赖它），拿不到就会退化成「看自己的文章也像看别人的」。
   */
  const userId = computed(() => userInfo.value?.id ?? getUserIdFromJwt(token.value))

  const userName = computed(() => userInfo.value?.userName ?? '')

  const avatar = computed(() => userInfo.value?.avatar ?? '')

  /**
   * 当前用户是否管理员（界面门控用）。
   *
   * ⚠️ 三条纪律（`管理端前端设计说明.md` §0.1）：
   *   1. 这只是**界面门控，不是权限依据** —— 真判定在后端 `AdminInterceptor`。
   *   2. `userInfo` 是**登录时拉一次的缓存**：管理员被降权后，这里可能仍为 true。
   *      → 所以每个管理端页面都必须能渲染接口 403 的兜底态，不能只靠这个 getter。
   *   3. 刷新页面时 Pinia 会丢，`userInfo` 可能还没加载 → 判 `isAdmin` 前必须确保
   *      `infoLoaded`（路由守卫里 `ensureUserInfo()` 已负责）。
   *      未加载时这里返回 false，属于「宁可不显示入口」，不会误放行。
   */
  const isAdmin = computed(() => userInfo.value?.role === UserRole.ADMIN)

  /* ==================== actions ==================== */

  /** 登录成功后写入 token */
  function setAuthToken(newToken: string) {
    token.value = newToken
    setToken(newToken)
  }

  /** 拉取当前用户信息 */
  async function fetchUserInfo(): Promise<UserInfoVO | null> {
    if (!token.value) return null
    try {
      const info = await userApi.getUserInfo()
      userInfo.value = info
      infoLoaded.value = true
      return info
    } catch {
      // 失败不抛出：401 已由请求层统一处理并跳转登录
      return null
    }
  }

  /**
   * 确保用户信息已加载。
   * 用于路由守卫：首次进入受保护页面时按需加载。
   */
  async function ensureUserInfo(): Promise<void> {
    if (infoLoaded.value || !token.value) return
    await fetchUserInfo()
  }

  /** 局部更新用户信息（修改资料后调用，避免整轮重新请求） */
  function patchUserInfo(patch: Partial<UserInfoVO>) {
    if (!userInfo.value) return
    userInfo.value = { ...userInfo.value, ...patch }
  }

  /** 拉取未读消息数（Header 红点用） */
  async function fetchUnreadCount(): Promise<void> {
    if (!token.value) {
      unreadCount.value = 0
      return
    }
    try {
      unreadCount.value = await notifyApi.getUnreadCount()
    } catch {
      /* 静默失败，不打扰用户 */
    }
  }

  /** 本地把未读数清零（全部已读后调用） */
  function clearUnreadCount() {
    unreadCount.value = 0
  }

  /** 未读数减一（单条已读后调用，不小于 0） */
  function decrementUnreadCount() {
    unreadCount.value = Math.max(0, unreadCount.value - 1)
  }

  /** 退出登录：清空全部本地状态 */
  function logout() {
    token.value = null
    userInfo.value = null
    unreadCount.value = 0
    infoLoaded.value = false
    removeToken()
  }

  return {
    // state
    token,
    userInfo,
    unreadCount,
    infoLoaded,
    // getters
    isLoggedIn,
    userId,
    userName,
    avatar,
    isAdmin,
    // actions
    setAuthToken,
    fetchUserInfo,
    ensureUserInfo,
    patchUserInfo,
    fetchUnreadCount,
    clearUnreadCount,
    decrementUnreadCount,
    logout,
  }
})
