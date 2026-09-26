/**
 * 全局 UI 状态
 * ------------------------------------------------------------------
 * 只放真正跨页面共享的 UI 态。不要演变成「什么状态都往里塞」的桶。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useAppStore = defineStore('app', () => {
  /** 移动端/窄屏下的导航抽屉 */
  const mobileNavOpen = ref(false)

  function openMobileNav() {
    mobileNavOpen.value = true
  }

  function closeMobileNav() {
    mobileNavOpen.value = false
  }

  function toggleMobileNav() {
    mobileNavOpen.value = !mobileNavOpen.value
  }

  return {
    mobileNavOpen,
    openMobileNav,
    closeMobileNav,
    toggleMobileNav,
  }
})
