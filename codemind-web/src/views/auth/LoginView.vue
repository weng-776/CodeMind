<script setup lang="ts">
/**
 * 登录页：双 Tab（验证码 / 密码），共用手机号输入。
 *
 * 设计取舍：
 *   1. 验证码登录是默认 Tab —— 它是「登录 / 注册」二合一，新用户不需要单独的注册流程。
 *   2. 登录后的跳转优先级：`query.redirect` > 首页（守卫注入的 redirect 已含完整 fullPath）。
 *   3. 「发送验证码」按钮单独判断手机号格式，不必等整个表单校验通过才能发码。
 *   4. 倒计时用 setInterval，组件卸载时必须清理，否则切走再回来会有多个计时器同时递减。
 */
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'

import { ApiError } from '@/api/request'
import { loginByCode, loginByPassword, sendCode } from '@/api/user'
import { useUserStore } from '@/stores/user'
import { getToken } from '@/utils/auth'
import { RouteName } from '@/router/routes-names'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/* ==================== 表单 ==================== */
type LoginMode = 'code' | 'password'

const mode = ref<LoginMode>('code')
const submitting = ref(false)

const formRef = ref<FormInstance>()

const form = reactive({
  phone: '',
  code: '',
  password: '',
})

/** 手机号：中国大陆 11 位，1 开头第二位 3-9（与后端一致，前端不比后端更严） */
const PHONE_PATTERN = /^1[3-9]\d{9}$/

/**
 * 密码：与后端 `^\w{4,32}$` 对齐（API 文档 1.6 / 1.3）。
 * 旧实现写的是 6~20 位，会把后端明明接受的 4~5 位密码**提前拦在本地**，
 * 表现为「密码明明对，点登录没反应」。
 */
const PASSWORD_PATTERN = /^\w{4,32}$/

/**
 * ⚠️ 真实后端的「密码错误 / 用户不存在」是 **HTTP 200 + code 401 + `手机号或密码错误`**
 * （API 文档 1.3：两种原因故意返回同一句话，避免枚举手机号）。
 * 而请求层对「本次没带 token 的 401」按 05 §3.1 刻意保持**静默**
 * （否则游客访问受限页面会被莫名弹提示），所以这一条失败**没有任何提示**，
 * 登录页必须自己兜一次，否则用户点「登录」后界面毫无反应。
 *
 * 判断依据是 **code === 401**（请求层透出的业务码），不是 message 文本 ——
 * 后端可以改文案，code 不会（T1.5）。
 */

const phoneValid = computed(() => PHONE_PATTERN.test(form.phone))

const rules = computed<FormRules>(() => {
  const base: FormRules = {
    phone: [
      { required: true, message: '请输入手机号', trigger: 'blur' },
      { pattern: PHONE_PATTERN, message: '手机号格式不正确', trigger: 'blur' },
    ],
  }

  if (mode.value === 'code') {
    base.code = [
      { required: true, message: '请输入验证码', trigger: 'blur' },
      { len: 6, message: '验证码为 6 位数字', trigger: 'blur' },
    ]
  } else {
    base.password = [
      { required: true, message: '请输入密码', trigger: 'blur' },
      { pattern: PASSWORD_PATTERN, message: '密码为 4-32 位字母、数字或下划线', trigger: 'blur' },
    ]
  }

  return base
})

/* ==================== 验证码倒计时 ==================== */
const COUNTDOWN_SECONDS = 60
const countdown = ref(0)
const sendingCode = ref(false)
let countdownTimer: ReturnType<typeof setInterval> | null = null

const codeButtonText = computed(() => {
  if (sendingCode.value) return '发送中'
  if (countdown.value > 0) return `${countdown.value} 秒后重发`
  return '获取验证码'
})

const codeButtonDisabled = computed(
  () => !phoneValid.value || countdown.value > 0 || sendingCode.value,
)

function clearCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

function startCountdown() {
  clearCountdown()
  countdown.value = COUNTDOWN_SECONDS
  countdownTimer = setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) clearCountdown()
  }, 1000)
}

// 组件卸载必须清理，避免计时器泄漏
onBeforeUnmount(clearCountdown)

async function handleSendCode() {
  if (!phoneValid.value) {
    ElMessage.warning('请先填写正确的手机号')
    return
  }
  if (codeButtonDisabled.value) return

  sendingCode.value = true
  try {
    await sendCode({ phone: form.phone })
    ElMessage.success('验证码已发送')
    startCountdown()
  } catch {
    // 具体错误文案已由请求层统一提示，这里只需保证按钮可再次点击
  } finally {
    sendingCode.value = false
  }
}

/* ==================== 提交 ==================== */
async function handleSubmit() {
  const instance = formRef.value
  if (!instance) return

  const valid = await instance.validate().catch(() => false)
  if (!valid) return

  // 必须在发请求前取：请求层在「带了 token 的 401」时会清掉它，
  // 失败后再读就永远拿到 null，判断不出这次请求是「登录态失效」还是「游客形态」。
  const hadToken = Boolean(getToken())

  submitting.value = true
  try {
    const result =
      mode.value === 'code'
        ? await loginByCode({ phone: form.phone, code: form.code })
        : await loginByPassword({ phone: form.phone, password: form.password })

    // token 落库（localStorage + Pinia）
    userStore.setAuthToken(result.token)

    // 登录后补齐用户信息与未读数，避免进入页面后 Header 出现空缺
    await userStore.ensureUserInfo()
    await userStore.fetchUnreadCount()

    ElMessage.success('登录成功')

    // redirect 由守卫写入，形如 /articles/12?from=x，直接可用
    const redirect = route.query.redirect
    const target = typeof redirect === 'string' && redirect ? redirect : null
    if (target) {
      await router.replace(target)
    } else {
      await router.replace({ name: RouteName.HOME })
    }
  } catch (err) {
    /*
     * 谁负责弹提示（T1.5 约定，按「带没带 token」划职责，不靠全局去重 flag）：
     *   - 本次请求**带了 token**（如 localStorage 里留着旧 token 又来登录）：
     *     失败一律由**请求层**负责 —— 它已经按后端 message 弹过 toast，
     *     401 还会顺带清 token + 跳登录。页面再弹就是重复，所以这里一律不弹。
     *   - 本次**没带 token**：请求层只在非 401 的业务失败上弹；
     *     401（密码错误 / 账号被禁用，HTTP 200 + code 401）被它刻意静默，
     *     所以「需要给用户一个交代」的这一类由**页面层**补弹。
     */
    if (!hadToken && err instanceof ApiError && err.code === 401) {
      ElMessage.error(err.message)
    }
  } finally {
    submitting.value = false
  }
}

/** 切换 Tab 时清掉另一模式已填的内容与校验状态，避免误提交 */
function handleModeChange(next: LoginMode) {
  mode.value = next
  form.code = ''
  form.password = ''
  void formRef.value?.clearValidate()
}

function goHome() {
  void router.push({ name: RouteName.HOME })
}
</script>

<template>
  <div class="cm-login">
    <!-- 左侧：品牌区（窄屏隐藏） -->
    <aside class="cm-login__brand">
      <div class="cm-login__brand-inner">
        <RouterLink :to="{ name: RouteName.HOME }" class="cm-login__logo">
          <span class="cm-login__logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="8 6 3 12 8 18" />
              <polyline points="16 6 21 12 16 18" />
              <line x1="13.5" y1="4" x2="10.5" y2="20" />
            </svg>
          </span>
          <span class="cm-login__logo-text">CodeMind</span>
        </RouterLink>

        <h1 class="cm-login__slogan">
          把技术沉淀下来
          <span class="cm-login__slogan-accent">让 AI 帮你整理</span>
        </h1>

        <ul class="cm-login__points">
          <li><el-icon><Reading /></el-icon>阅读与讨论技术文章</li>
          <li><el-icon><Notebook /></el-icon>Markdown 笔记与分类归档</li>
          <li><el-icon><MagicStick /></el-icon>AI 总结 / 知识点提取 / 面试题</li>
        </ul>
      </div>
    </aside>

    <!-- 右侧：表单区 -->
    <main class="cm-login__panel">
      <div class="cm-login__card">
        <header class="cm-login__head">
          <h2 class="cm-login__title">登录 CodeMind</h2>
          <p class="cm-login__subtitle">首次使用将自动创建账号</p>
        </header>

        <!-- 模式切换 -->
        <div class="cm-login__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class="cm-login__tab"
            :class="{ 'is-active': mode === 'code' }"
            :aria-selected="mode === 'code'"
            @click="handleModeChange('code')"
          >
            验证码登录
          </button>
          <button
            type="button"
            role="tab"
            class="cm-login__tab"
            :class="{ 'is-active': mode === 'password' }"
            :aria-selected="mode === 'password'"
            @click="handleModeChange('password')"
          >
            密码登录
          </button>
        </div>

        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          class="cm-login__form"
          @submit.prevent="handleSubmit"
        >
          <el-form-item label="手机号" prop="phone">
            <el-input
              v-model="form.phone"
              placeholder="请输入 11 位手机号"
              maxlength="11"
              clearable
              size="large"
            >
              <template #prefix>
                <el-icon><Iphone /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <!-- 验证码模式 -->
          <el-form-item v-if="mode === 'code'" label="验证码" prop="code">
            <div class="cm-login__code-row">
              <el-input
                v-model="form.code"
                placeholder="6 位数字验证码"
                maxlength="6"
                size="large"
                @keyup.enter="handleSubmit"
              >
                <template #prefix>
                  <el-icon><Message /></el-icon>
                </template>
              </el-input>

              <el-button
                class="cm-login__code-btn"
                size="large"
                :disabled="codeButtonDisabled"
                :loading="sendingCode"
                @click="handleSendCode"
              >
                {{ codeButtonText }}
              </el-button>
            </div>
          </el-form-item>

          <!-- 密码模式 -->
          <el-form-item v-else label="密码" prop="password">
            <el-input
              v-model="form.password"
              type="password"
              placeholder="请输入密码"
              size="large"
              show-password
              @keyup.enter="handleSubmit"
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-button
            class="cm-login__submit"
            type="primary"
            size="large"
            :loading="submitting"
            @click="handleSubmit"
          >
            {{ mode === 'code' ? '登录 / 注册' : '登录' }}
          </el-button>
        </el-form>

        <p class="cm-login__footer">
          <button type="button" class="cm-login__link" @click="goHome">
            先随便逛逛，暂不登录
          </button>
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.cm-login {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  min-height: 100vh;
}

/* ==================== 左侧品牌区 ==================== */
.cm-login__brand {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--cm-space-12);
  background:
    radial-gradient(680px 420px at 12% -10%, var(--cm-accent-100), transparent 62%),
    var(--cm-bg-surface);
  border-right: 1px solid var(--cm-border-subtle);
}

.cm-login__brand-inner {
  max-width: 420px;
}

.cm-login__logo {
  display: inline-flex;
  align-items: center;
  gap: var(--cm-space-2);
  text-decoration: none;
  color: var(--cm-text-primary);
}

.cm-login__logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--cm-text-inverse);
  background-color: var(--cm-accent-600);
  border-radius: var(--cm-radius-md);
}

.cm-login__logo-mark svg {
  width: 17px;
  height: 17px;
}

.cm-login__logo-text {
  font-size: var(--cm-font-size-xl);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.cm-login__slogan {
  margin: var(--cm-space-10) 0 0;
  font-size: var(--cm-font-size-3xl);
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-login__slogan-accent {
  display: block;
  color: var(--cm-accent-600);
}

.cm-login__points {
  display: flex;
  flex-direction: column;
  gap: var(--cm-space-3);
  margin: var(--cm-space-10) 0 0;
  padding: 0;
  list-style: none;
}

.cm-login__points li {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  font-size: var(--cm-font-size-base);
  color: var(--cm-text-tertiary);
}

.cm-login__points :deep(.el-icon) {
  color: var(--cm-accent-500);
}

/* ==================== 右侧表单区 ==================== */
.cm-login__panel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--cm-space-12) var(--cm-space-6);
  background-color: var(--cm-bg-body);
}

.cm-login__card {
  width: 100%;
  max-width: 380px;
}

.cm-login__head {
  margin-bottom: var(--cm-space-6);
}

.cm-login__title {
  margin: 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--cm-text-primary);
}

.cm-login__subtitle {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

/* ---------- Tab ---------- */
.cm-login__tabs {
  display: flex;
  gap: var(--cm-space-6);
  margin-bottom: var(--cm-space-6);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-login__tab {
  position: relative;
  padding: 0 0 var(--cm-space-3);
  font-family: inherit;
  font-size: var(--cm-font-size-base);
  color: var(--cm-text-tertiary);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-login__tab:hover {
  color: var(--cm-text-secondary);
}

.cm-login__tab.is-active {
  color: var(--cm-text-primary);
  font-weight: 500;
}

.cm-login__tab::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background-color: var(--cm-accent-600);
  border-radius: var(--cm-radius-full);
  transform: scaleX(0);
  transition: transform 0.2s var(--cm-ease-out);
}

.cm-login__tab.is-active::after {
  transform: scaleX(1);
}

/* ---------- 表单 ---------- */
.cm-login__form :deep(.el-form-item) {
  margin-bottom: var(--cm-space-5);
}

.cm-login__form :deep(.el-form-item__label) {
  padding-bottom: var(--cm-space-1);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
}

.cm-login__code-row {
  display: flex;
  gap: var(--cm-space-3);
  width: 100%;
}

.cm-login__code-row :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

.cm-login__code-btn {
  flex-shrink: 0;
  width: 118px;
  font-variant-numeric: tabular-nums;
}

.cm-login__submit {
  width: 100%;
  margin-top: var(--cm-space-2);
}

.cm-login__footer {
  margin: var(--cm-space-6) 0 0;
  text-align: center;
}

.cm-login__link {
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-login__link:hover {
  color: var(--cm-accent-600);
}

/* ==================== 响应式 ==================== */
@media (max-width: 900px) {
  .cm-login {
    grid-template-columns: 1fr;
  }

  .cm-login__brand {
    display: none;
  }

  .cm-login__panel {
    padding: var(--cm-space-10) var(--cm-space-5);
  }
}

@media (max-width: 420px) {
  .cm-login__code-row {
    flex-direction: column;
  }

  .cm-login__code-btn {
    width: 100%;
  }
}
</style>
