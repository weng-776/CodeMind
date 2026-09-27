<script setup lang="ts">
/**
 * 注册后强制设置密码（1.13 POST /api/user/setPassword）
 * ------------------------------------------------------------------
 * 背景（2026-09-27 后端新增）：
 *   手机验证码注册的账号，库里 password 是空串。后端要求「注册完必须设置一个密码」，
 *   并且 `GET /api/user/info` 新增了 `hasPassword` 字段作为唯一判断依据
 *   （登录接口不返回任何相关标志）。
 *
 * 三条不可动摇的规则（踩过就会死循环或拦错人）：
 *   1. 判断「没设过密码」必须写 `hasPassword === false`。
 *      字段缺失时是 `undefined`，写成 `!hasPassword` 会把所有老用户都判成「没设过密码」。
 *   2. 设置成功后**必须** `userStore.patchUserInfo({ hasPassword: true })`。
 *      漏了这一步，路由守卫会立刻把用户弹回本页 → 用户永远出不去。
 *   3. 密码规则与后端对齐 `^\w{4,32}$`，不许自己加严
 *      （历史教训：本地写 6~20 位，会把后端明明接受的 4~5 位密码提前拦掉）。
 *
 * 关于「改密码」：那是另一条路 —— 1.6 `PUT /api/user/updatePassword`（要旧密码）。
 * 本接口只在「从没设过密码」时可用，已设过的账号再调会 400「密码已设置，请使用修改密码」。
 *
 * 本页刻意**没有**「跳过 / 稍后再说」入口：它的意义就是强制。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'

import { setPassword } from '@/api/user'
import { useUserStore } from '@/stores/user'
import { RouteName } from '@/router/routes-names'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/* ==================== 前置判断 ==================== */

/** 手机号必须来自当前登录用户，不让用户手填（后端要求与登录用户一致） */
const phone = computed(() => userStore.userInfo?.phone ?? '')

/**
 * 只有「明确没设过密码」才能停留。
 * `undefined`（字段缺失 / 用户信息没拉到）一律按「不该停留」处理 —— 宁可不拦，不要拦错。
 */
const allowed = computed(() => userStore.userInfo?.hasPassword === false)

function goHome() {
  void router.replace({ name: RouteName.HOME })
}

onMounted(() => {
  if (!allowed.value) {
    // 已设过密码 / 信息未知 → 立刻回首页（后端也会 400，不该把用户卡在这里）
    goHome()
  }
})

/* ==================== 表单 ==================== */

const formRef = ref<FormInstance>()
const submitting = ref(false)

const form = reactive({
  password: '',
  confirm: '',
})

/** 与后端 `^\w{4,32}$` 完全一致，不加严 */
const PASSWORD_PATTERN = /^\w{4,32}$/

const rules = computed<FormRules>(() => ({
  password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { pattern: PASSWORD_PATTERN, message: '密码为 4-32 位字母、数字或下划线', trigger: 'blur' },
  ],
  confirm: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      // 本地校验：两次必须一致，不一致不许提交
      validator: (_rule, value: string, callback) => {
        if (value !== form.password) callback(new Error('两次输入的密码不一致'))
        else callback()
      },
      trigger: 'blur',
    },
  ],
}))

/** 密码可见性只在用户主动点眼睛时改变，默认都遮住 */
async function handleSubmit() {
  const instance = formRef.value
  if (!instance || submitting.value) return

  const valid = await instance.validate().catch(() => false)
  if (!valid) return

  if (!phone.value) {
    ElMessage.error('读不到当前账号的手机号，请重新登录后再试')
    return
  }

  submitting.value = true
  try {
    await setPassword({ password: form.password, phone: phone.value })

    // ⚠️ 必须更新本地 hasPassword，否则守卫会立刻把人弹回本页（死循环）
    userStore.patchUserInfo({ hasPassword: true })

    ElMessage.success('密码设置成功')

    // 回到「当初想去的页面」；redirect 指回本页时忽略，避免自跳自
    const redirect = route.query.redirect
    const target = typeof redirect === 'string' && redirect ? redirect : null
    if (target && !target.startsWith('/set-password')) {
      await router.replace(target)
    } else {
      await router.replace({ name: RouteName.HOME })
    }
  } catch {
    // 失败提示由请求层负责（项目级约定 D）：
    // 本次请求带了 token，请求层会弹后端 message（如「密码已设置，请使用修改密码」），
    // 页面不再自造一条。
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="cm-setpwd">
    <div class="cm-setpwd__card">
      <!-- 不允许停留时（已设过密码 / 信息未知）短暂显示，随即被 replace 走 -->
      <template v-if="allowed">
        <header class="cm-setpwd__head">
          <span class="cm-setpwd__badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <h1 class="cm-setpwd__title">设置登录密码</h1>
          <p class="cm-setpwd__subtitle">
            你当前是用手机验证码登录的，先设置一个密码，之后就能用「密码登录」进来。
          </p>
        </header>

        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          class="cm-setpwd__form"
          @submit.prevent="handleSubmit"
        >
          <el-form-item label="新密码" prop="password">
            <el-input
              v-model="form.password"
              type="password"
              size="large"
              show-password
              placeholder="4-32 位字母、数字或下划线"
              @keyup.enter="handleSubmit"
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item label="确认密码" prop="confirm">
            <el-input
              v-model="form.confirm"
              type="password"
              size="large"
              show-password
              placeholder="再输入一次"
              @keyup.enter="handleSubmit"
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <p class="cm-setpwd__phone">
            账号手机号：<span class="cm-setpwd__phone-value">{{ phone || '读取中…' }}</span>
          </p>

          <el-button
            class="cm-setpwd__submit"
            type="primary"
            size="large"
            :loading="submitting"
            :disabled="!phone"
            @click="handleSubmit"
          >
            设置密码并继续
          </el-button>
        </el-form>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cm-setpwd {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: var(--cm-space-8) var(--cm-space-5);
  background:
    radial-gradient(680px 300px at 50% -20%, var(--cm-accent-50), transparent 62%),
    var(--cm-bg-body);
}

.cm-setpwd__card {
  width: 100%;
  max-width: 400px;
}

.cm-setpwd__head {
  margin-bottom: var(--cm-space-6);
}

.cm-setpwd__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--cm-text-inverse);
  background-color: var(--cm-accent-600);
  border-radius: var(--cm-radius-md);
}

.cm-setpwd__badge svg {
  width: 17px;
  height: 17px;
}

.cm-setpwd__title {
  margin: var(--cm-space-5) 0 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--cm-text-primary);
}

.cm-setpwd__subtitle {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  line-height: 1.7;
  color: var(--cm-text-tertiary);
}

.cm-setpwd__form :deep(.el-form-item) {
  margin-bottom: var(--cm-space-5);
}

.cm-setpwd__form :deep(.el-form-item__label) {
  padding-bottom: var(--cm-space-1);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
}

.cm-setpwd__phone {
  margin: 0 0 var(--cm-space-4);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-setpwd__phone-value {
  font-family: var(--cm-font-mono);
  color: var(--cm-text-tertiary);
}

.cm-setpwd__submit {
  width: 100%;
}
</style>
