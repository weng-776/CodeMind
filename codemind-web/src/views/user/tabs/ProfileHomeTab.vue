<script setup lang="ts">
/**
 * 我的主页（个人中心默认 Tab）。
 * 接口：1.4 用户信息（已在 store 里，直接用）｜ 1.5 改资料（multipart）｜
 * 1.6 改密码（JSON）｜ 3.6 我的文章 ｜ 2.5 我的笔记（各取最近 5 篇做预览）。
 *
 * 刻意**不重复渲染头像 / 昵称 / 简介 / 四项统计** —— 那些由 ProfileLayout 的头部统一展示，
 * 且跨 Tab 不变。本 Tab 只放「布局头部没有的东西」：账号字段 + 快捷入口 + 最近内容预览，
 * 以及两个编辑入口（资料 / 密码）。
 *
 * 1.5 的三个关键事实（对真实后端实测 + 读后端 DTO 复核）：
 *   1. **是 multipart，不是 JSON**；字段 `userName` / `intro` / `file`，
 *      **没有 `avatar`（URL）参数** —— 头像只能传文件，不传即保留原头像。
 *   2. `UpdateUserDataDTO` 的 `@Size` **下限也生效**（昵称 3~12、简介 6~200），
 *      但两条 message **只提了上限** → 「昵称太短」会收到「昵称不能超过12个字符」这种自相矛盾的提示。
 *      前端必须自己把 3~12 / 6~200 校验住，别把这个提示原样丢给用户。
 *   3. 由此推出**只提交真正改动过的字段**：接口对没传的字段保留原值，
 *      所以只改头像时不要顺手带上昵称 —— 库里存在 2 个字的昵称（如「小红」），
 *      带上必然撞 `min=3` 被 400 打回，用户会一头雾水。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import ContentSection from '@/components/common/ContentSection.vue'
import ArticleCard from '@/components/article/ArticleCard.vue'
import NoteCard from '@/components/note/NoteCard.vue'
import { getMyArticles } from '@/api/article'
import { getMyNotes } from '@/api/note'
import { updatePassword, updateUserData } from '@/api/user'
import { useUserStore } from '@/stores/user'
import { RouteName } from '@/router/routes-names'
import type { ArticleListItemVO } from '@/types/article'
import type { NoteListItemVO } from '@/types/note'
import type { UpdateUserDataParams } from '@/types/user'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const PREVIEW_SIZE = 5

const userInfo = computed(() => userStore.userInfo)

/**
 * 手机号脱敏：13812345678 → 138****5678
 * 只保留前 3 后 4。长度不足 7 时原样返回，避免出现「1****」这种奇怪的掩码。
 */
const maskedPhone = computed(() => {
  const phone = userInfo.value?.phone ?? ''
  if (phone.length < 7) return phone
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
})

/** 快捷入口 */
const shortcuts = [
  { key: 'write-article', label: '写文章', icon: 'EditPen', to: RouteName.ARTICLE_CREATE },
  { key: 'write-note', label: '写笔记', icon: 'Notebook', to: RouteName.NOTE_CREATE },
  { key: 'categories', label: '分类管理', icon: 'FolderOpened', to: RouteName.CATEGORY_MANAGE },
  { key: 'notify', label: '消息通知', icon: 'Bell', to: RouteName.NOTIFICATIONS },
] as const

/* ==================== 最近文章 ==================== */

const articles = ref<ArticleListItemVO[]>([])
const articlesLoading = ref(true)
const articlesError = ref(false)

async function loadArticles() {
  articlesLoading.value = true
  articlesError.value = false
  try {
    const res = await getMyArticles({ page: 1, size: PREVIEW_SIZE })
    articles.value = res.records ?? []
  } catch {
    articlesError.value = true
    articles.value = []
  } finally {
    articlesLoading.value = false
  }
}

/* ==================== 最近笔记 ==================== */

const notes = ref<NoteListItemVO[]>([])
const notesLoading = ref(true)
const notesError = ref(false)

async function loadNotes() {
  notesLoading.value = true
  notesError.value = false
  try {
    const res = await getMyNotes({ page: 1, size: PREVIEW_SIZE })
    notes.value = res.records ?? []
  } catch {
    notesError.value = true
    notes.value = []
  } finally {
    notesLoading.value = false
  }
}

/* ==================== 编辑资料（1.5 · multipart） ==================== */

const editVisible = ref(false)
const editFormRef = ref()
const editSubmitting = ref(false)

/**
 * 打开弹窗那一刻的原始值快照。
 * 提交时拿它比对，**只把真正改过的字段放进 FormData**（理由见文件头第 3 条）。
 */
const editBaseline = reactive({ userName: '', intro: '' })

const editForm = reactive({
  userName: '',
  intro: '',
  /** 本次新选的头像文件；null = 不换头像（后端语义：不传 file 就保留原头像） */
  file: null as File | null,
})

/** 与后端 `UpdateUserDataDTO` 的 `@Size` 完全对齐，不要放宽也不要收紧 */
const AVATAR_MAX_SIZE = 2 * 1024 * 1024
/** 后端两处都查：MIME（`image/jpeg|png|webp`）与后缀（`jpg|jpeg|png|webp`） */
const AVATAR_MIME = ['image/jpeg', 'image/png', 'image/webp']
const AVATAR_EXT = ['jpg', 'jpeg', 'png', 'webp']
const AVATAR_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp'

const editRules = {
  userName: [
    { required: true, message: '请输入昵称', trigger: 'blur' },
    { min: 3, max: 12, message: '昵称长度 3 - 12 个字符', trigger: 'blur' },
  ],
  intro: [
    { required: true, message: '请输入个人简介', trigger: 'blur' },
    { min: 6, max: 200, message: '简介长度 6 - 200 个字符', trigger: 'blur' },
  ],
}

const avatarInputRef = ref<HTMLInputElement>()
/** 新选头像的本地预览（objectURL），关闭弹窗时释放 */
const avatarPreview = ref('')

/** 弹窗里展示的头像：优先本次新选的预览，其次 store 里的现有头像 */
const avatarShown = computed(() => avatarPreview.value || userInfo.value?.avatar || '')

function releaseAvatarPreview() {
  if (avatarPreview.value) {
    URL.revokeObjectURL(avatarPreview.value)
    avatarPreview.value = ''
  }
}

function pickAvatar() {
  avatarInputRef.value?.click()
}

function onAvatarChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  /*
   * 前端提前拦下，而不是等后端 400：
   * 一是体验（3MB 传上去再被打回，白等一轮），
   * 二是后端对超限/格式错误给的是「头像大小不能超过2MB」这类 message，
   * 但校验顺序在 @Size 之后 —— 昵称不合法时根本轮不到头像的提示。
   */
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  if (!AVATAR_MIME.includes(file.type) || !AVATAR_EXT.includes(ext)) {
    ElMessage.error('头像只支持 jpg / jpeg / png / webp 格式')
    input.value = ''
    return
  }
  if (file.size > AVATAR_MAX_SIZE) {
    ElMessage.error('头像大小不能超过 2MB')
    input.value = ''
    return
  }

  releaseAvatarPreview()
  editForm.file = file
  avatarPreview.value = URL.createObjectURL(file)
}

/** 撤销本次选择（接口没有「删除头像」的能力，只能撤销「这次选的新图」） */
function clearAvatarPick() {
  releaseAvatarPreview()
  editForm.file = null
  if (avatarInputRef.value) avatarInputRef.value.value = ''
}

async function openEdit() {
  // store 可能还没加载（深链直达 /profile/home 时守卫会拉，但别假设它一定成功）
  if (!userStore.userInfo) await userStore.fetchUserInfo()

  const info = userStore.userInfo
  editForm.userName = info?.userName ?? ''
  editForm.intro = info?.intro ?? ''
  editForm.file = null
  releaseAvatarPreview()

  editBaseline.userName = editForm.userName
  editBaseline.intro = editForm.intro

  editVisible.value = true
  void editFormRef.value?.clearValidate?.()
}

function closeEdit() {
  editVisible.value = false
  releaseAvatarPreview()
  editForm.file = null
  if (avatarInputRef.value) avatarInputRef.value.value = ''
}

async function submitEdit() {
  if (editSubmitting.value) return

  try {
    await editFormRef.value?.validate()
  } catch {
    ElMessage.warning('请检查昵称与简介')
    return
  }

  const nextName = editForm.userName.trim()
  const nextIntro = editForm.intro.trim()

  // 只带改过的字段：没传的字段后端保留原值
  const payload: UpdateUserDataParams = {}
  if (nextName !== editBaseline.userName) payload.userName = nextName
  if (nextIntro !== editBaseline.intro) payload.intro = nextIntro
  if (editForm.file) payload.file = editForm.file

  /*
   * 什么都不传时后端会返回 200「更新成功」但**库里一个字都没变**（文档 1.5 行为说明 1），
   * 那是「假成功」。宁可在前端就说清楚，也不要让用户以为保存成功了。
   */
  if (payload.userName === undefined && payload.intro === undefined && !payload.file) {
    ElMessage.warning('没有需要保存的修改')
    return
  }

  editSubmitting.value = true
  try {
    await updateUserData(payload)
    // 1.5 的响应体不含新头像 URL（实测 `data: null`），必须重新拉 1.4 才能拿到
    await userStore.fetchUserInfo()
    ElMessage.success('资料已更新')
    closeEdit()
  } catch {
    // 提示由请求层统一给出（约定 D）
  } finally {
    editSubmitting.value = false
  }
}

/* ==================== 修改密码（1.6 · JSON） ==================== */

const pwdVisible = ref(false)
const pwdFormRef = ref()
const pwdSubmitting = ref(false)

const pwdForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
})

/** 后端 `UpdatePasswordDTO` 的正则是 `^\w{4,32}$` */
const PWD_PATTERN = /^\w{4,32}$/

const pwdRules = {
  oldPassword: [
    { required: true, message: '请输入当前密码', trigger: 'blur' },
    { pattern: PWD_PATTERN, message: '密码为 4 - 32 位字母、数字或下划线', trigger: 'blur' },
  ],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { pattern: PWD_PATTERN, message: '密码为 4 - 32 位字母、数字或下划线', trigger: 'blur' },
    {
      // 后端也会拦（「新密码不能与旧密码重复」），本地先拦省一次往返
      validator: (_rule: unknown, value: string, callback: (e?: Error) => void) => {
        if (value && value === pwdForm.oldPassword) callback(new Error('新密码不能与当前密码相同'))
        else callback()
      },
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule: unknown, value: string, callback: (e?: Error) => void) => {
        if (value !== pwdForm.newPassword) callback(new Error('两次输入的新密码不一致'))
        else callback()
      },
      trigger: 'blur',
    },
  ],
}

function openPassword() {
  pwdForm.oldPassword = ''
  pwdForm.newPassword = ''
  pwdForm.confirmPassword = ''
  pwdVisible.value = true
  void pwdFormRef.value?.clearValidate?.()
}

function closePassword() {
  pwdVisible.value = false
}

async function submitPassword() {
  if (pwdSubmitting.value) return
  try {
    await pwdFormRef.value?.validate()
  } catch {
    ElMessage.warning('请检查密码填写')
    return
  }

  pwdSubmitting.value = true
  try {
    await updatePassword({
      oldPassword: pwdForm.oldPassword,
      newPassword: pwdForm.newPassword,
    })
    ElMessage.success('密码已修改')
    closePassword()
  } catch {
    // 提示由请求层统一给出（如「旧密码错误」）
  } finally {
    pwdSubmitting.value = false
  }
}

/* ==================== 快捷入口 / 生命周期 ==================== */

function goShortcut(name: string) {
  void router.push({ name })
}

void loadArticles()
void loadNotes()

onMounted(() => {
  /*
   * 从「他人主页」的自己的页面点「编辑资料」过来时带 `?edit=1`，
   * 直接打开编辑弹窗。用完把 query 清掉 —— 否则刷新会莫名弹出表单。
   */
  if (route.query.edit === '1') {
    void openEdit()
    void router.replace({ name: RouteName.MY_PROFILE })
  }
})

onBeforeUnmount(releaseAvatarPreview)
</script>

<template>
  <div class="cm-home-tab">
    <!-- ==================== 账号字段 ==================== -->
    <section class="cm-home-tab__card cm-panel">
      <div class="cm-home-tab__card-head">
        <h2 class="cm-home-tab__card-title">账号信息</h2>
        <div class="cm-home-tab__card-actions">
          <el-button size="small" type="primary" @click="openEdit">
            <el-icon><EditPen /></el-icon>
            编辑资料
          </el-button>
          <el-button size="small" @click="openPassword">
            <el-icon><Lock /></el-icon>
            修改密码
          </el-button>
        </div>
      </div>

      <dl class="cm-home-tab__fields">
        <div class="cm-home-tab__field">
          <dt>手机号</dt>
          <dd class="cm-home-tab__mono">{{ maskedPhone || '—' }}</dd>
        </div>
        <div class="cm-home-tab__field">
          <dt>用户 ID</dt>
          <!--
            用 store 的 userId 而不是 userInfo.id：真实后端的 /user/info 不返回 id，
            store 里已从 JWT 的 userId claim 兜底（见 stores/user.ts），
            直接读 userInfo.id 会永远显示「—」。
          -->
          <dd class="cm-home-tab__mono">{{ userStore.userId ?? '—' }}</dd>
        </div>
      </dl>

      <p class="cm-home-tab__note">
        昵称与简介的长度限制由接口决定（昵称 3 - 12 字、简介 6 - 200 字），
        头像只能上传文件、不支持填 URL，也不支持删除已有头像。
      </p>
    </section>

    <!-- ==================== 快捷入口 ==================== -->
    <section class="cm-home-tab__shortcuts">
      <button
        v-for="item in shortcuts"
        :key="item.key"
        type="button"
        class="cm-home-tab__shortcut"
        @click="goShortcut(item.to)"
      >
        <el-icon :size="17" class="cm-home-tab__shortcut-icon">
          <component :is="item.icon" />
        </el-icon>
        <span>{{ item.label }}</span>
      </button>
    </section>

    <!-- ==================== 最近文章 ==================== -->
    <ContentSection
      title="最近文章"
      subtitle="含草稿"
      :loading="articlesLoading"
      :error="articlesError"
      :empty="articles.length === 0"
      empty-text="还没有写过文章"
      :more-to="{ name: RouteName.MY_ARTICLES }"
      :skeleton-rows="3"
      class="cm-home-tab__section"
      @retry="loadArticles"
    >
      <div class="cm-home-tab__list">
        <ArticleCard
          v-for="item in articles"
          :key="item.id"
          :article="item"
          variant="compact"
          show-status
        />
      </div>
    </ContentSection>

    <!-- ==================== 最近笔记 ==================== -->
    <ContentSection
      title="最近笔记"
      subtitle="私密笔记也会出现在这里"
      :loading="notesLoading"
      :error="notesError"
      :empty="notes.length === 0"
      empty-text="知识库还是空的"
      :more-to="{ name: RouteName.MY_NOTES }"
      :skeleton-rows="3"
      class="cm-home-tab__section"
      @retry="loadNotes"
    >
      <div class="cm-home-tab__list">
        <NoteCard v-for="item in notes" :key="item.id" :note="item" />
      </div>
    </ContentSection>

    <!-- ==================== 编辑资料（1.5） ==================== -->
    <el-dialog
      v-model="editVisible"
      title="编辑资料"
      width="520px"
      class="cm-home-tab__dialog"
      :close-on-click-modal="false"
      @close="closeEdit"
    >
      <el-form
        ref="editFormRef"
        :model="editForm"
        :rules="editRules"
        label-position="top"
        class="cm-home-tab__form"
      >
        <!-- 头像：文件上传（接口没有 avatar URL 参数） -->
        <el-form-item label="头像">
          <div class="cm-home-tab__avatar-row">
            <el-avatar :size="64" :src="avatarShown || undefined" class="cm-home-tab__avatar">
              {{ userInfo?.userName?.charAt(0) ?? '?' }}
            </el-avatar>

            <div class="cm-home-tab__avatar-ops">
              <el-button size="small" @click="pickAvatar">
                <el-icon><Upload /></el-icon>
                {{ editForm.file ? '更换图片' : '选择图片' }}
              </el-button>
              <!-- 只能「撤销本次选择」：接口没有删除已有头像的能力 -->
              <el-button v-if="editForm.file" size="small" text @click="clearAvatarPick">
                撤销选择
              </el-button>
              <p class="cm-home-tab__hint">
                支持 jpg / jpeg / png / webp，不超过 2 MB。
                <template v-if="editForm.file">已选新图，保存后替换现有头像。</template>
                <template v-else-if="avatarShown">不选择则保留现有头像。</template>
              </p>
            </div>

            <!-- 原生 input：只取 File 对象，上传交给 axios 统一处理 -->
            <input
              ref="avatarInputRef"
              type="file"
              :accept="AVATAR_ACCEPT"
              class="cm-home-tab__file-input"
              @change="onAvatarChange"
            />
          </div>
        </el-form-item>

        <el-form-item label="昵称" prop="userName">
          <el-input v-model="editForm.userName" maxlength="12" show-word-limit placeholder="3 - 12 个字符" />
        </el-form-item>

        <el-form-item label="个人简介" prop="intro">
          <el-input
            v-model="editForm.intro"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            resize="none"
            placeholder="6 - 200 个字符"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="closeEdit">取消</el-button>
        <el-button type="primary" :loading="editSubmitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- ==================== 修改密码（1.6） ==================== -->
    <el-dialog
      v-model="pwdVisible"
      title="修改密码"
      width="460px"
      :close-on-click-modal="false"
      @close="closePassword"
    >
      <el-form
        ref="pwdFormRef"
        :model="pwdForm"
        :rules="pwdRules"
        label-position="top"
        class="cm-home-tab__form"
      >
        <el-form-item label="当前密码" prop="oldPassword">
          <el-input
            v-model="pwdForm.oldPassword"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="请输入当前密码"
          />
        </el-form-item>

        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="pwdForm.newPassword"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="4 - 32 位字母、数字或下划线"
          />
        </el-form-item>

        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="pwdForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="再次输入新密码"
          />
        </el-form-item>

        <p class="cm-home-tab__hint">
          修改成功后当前登录状态仍然有效；下次登录请使用新密码。
        </p>
      </el-form>

      <template #footer>
        <el-button @click="closePassword">取消</el-button>
        <el-button type="primary" :loading="pwdSubmitting" @click="submitPassword">
          确认修改
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ==================== 账号卡片 ==================== */
.cm-home-tab__card {
  padding: var(--cm-space-5) var(--cm-space-6);
}

.cm-home-tab__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-3);
  flex-wrap: wrap;
}

.cm-home-tab__card-title {
  margin: 0;
  font-size: var(--cm-font-size-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--cm-text-secondary);
}

.cm-home-tab__card-actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
}

/* ==================== 编辑资料弹窗 ==================== */
.cm-home-tab__form {
  padding-top: var(--cm-space-1);
}

.cm-home-tab__avatar-row {
  display: flex;
  align-items: flex-start;
  gap: var(--cm-space-4);
}

.cm-home-tab__avatar {
  flex-shrink: 0;
  font-size: var(--cm-font-size-lg);
  background-color: var(--cm-accent-100);
  color: var(--cm-accent-700);
}

.cm-home-tab__avatar-ops {
  min-width: 0;
}

.cm-home-tab__hint {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-xs);
  line-height: 1.6;
  color: var(--cm-text-quaternary);
}

/* 原生 input 隐藏，由按钮触发 */
.cm-home-tab__file-input {
  display: none;
}

.cm-home-tab__fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cm-space-10);
  margin: var(--cm-space-4) 0 0;
}

.cm-home-tab__field dt {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-home-tab__field dd {
  margin: var(--cm-space-1) 0 0;
  font-size: var(--cm-font-size-base);
  color: var(--cm-text-primary);
}

.cm-home-tab__mono {
  font-family: var(--cm-font-mono);
}

.cm-home-tab__note {
  margin: var(--cm-space-4) 0 0;
  padding-top: var(--cm-space-3);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  border-top: 1px solid var(--cm-border-subtle);
}

/* ==================== 快捷入口 ==================== */
.cm-home-tab__shortcuts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--cm-space-3);
  margin-top: var(--cm-space-5);
}

.cm-home-tab__shortcut {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--cm-space-2);
  padding: var(--cm-space-4) var(--cm-space-3);
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
  background-color: var(--cm-bg-surface);
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-lg);
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.cm-home-tab__shortcut:hover {
  color: var(--cm-accent-700);
  background-color: var(--cm-accent-50);
  border-color: var(--cm-accent-200);
}

.cm-home-tab__shortcut-icon {
  color: var(--cm-accent-600);
}

/* ==================== 区块 ==================== */
.cm-home-tab__section {
  margin-top: var(--cm-space-10);
}

.cm-home-tab__list {
  margin-top: var(--cm-space-1);
}

/* ==================== 响应式 ==================== */
@media (max-width: 720px) {
  .cm-home-tab__shortcuts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .cm-home-tab__fields {
    gap: var(--cm-space-6);
  }
}
</style>
