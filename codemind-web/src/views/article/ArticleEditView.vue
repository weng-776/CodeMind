<script setup lang="ts">
/**
 * 文章发布 / 编辑页（同一组件两种模式，靠路由名区分）：
 *   发布 → POST /api/article ｜ 编辑 → PUT /api/article/{id}。
 *
 * 关键设计：
 *   1. 提交格式是 **multipart/form-data**，封面是**文件字段 `file`** 而非 URL
 *      （FormData 统一在 api/article.ts 组装）。
 *   2. 编辑模式必须**先回显再提交**，否则保存会把内容清空。
 *   3. **tagIds 传空数组 = 清空标签**，所以不能「空数组就跳过不发」。
 *      候选集来自 2.12 `GET /api/tag/list`；候选加载失败不影响保存，已有 tags 原样回传。
 *   4. 编辑时**不传 file = 保留原封面**，没选新文件不能塞空 file。
 *   5. 双栏实时预览，Tab 窄屏退化为单栏可切换。
 *   6. 草稿与发布走同一接口，只差 status；发布前必须有标题与正文。
 *   7. 离开前有未保存改动时拦截（onBeforeRouteLeave + beforeunload）。
 *
 * 封面用原生 `<input type="file">` 而非 el-upload：只需要 File 对象交给 axios，
 * el-upload 自带上传行为反而要额外压制。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import MarkdownViewer from '@/components/common/MarkdownViewer.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import { createArticle, getArticleDetail, getTagList, updateArticle } from '@/api/article'
import { RouteName } from '@/router/routes-names'
import { ContentStatus } from '@/types/common'
import type { TagVO } from '@/types/category'
import { estimateReadingMinutes } from '@/utils/format'

const route = useRoute()
const router = useRouter()

/** 编辑模式：路由名为 article-edit 时带 id */
const isEdit = computed(() => route.name === RouteName.ARTICLE_EDIT)
const articleId = computed(() => Number(route.params.id))

const pageTitle = computed(() => (isEdit.value ? '编辑文章' : '写文章'))

/* ==================== 表单 ==================== */
const formRef = ref()

const form = reactive({
  title: '',
  summary: '',
  content: '',
  tagIds: [] as number[],
  /** 新选择的封面文件；为 null 表示不更换（编辑时即保留原封面） */
  file: null as File | null,
})

/** 表单校验规则：只约束必填与长度，内容格式不做限制（Markdown） */
const rules = {
  title: [
    { required: true, message: '请输入文章标题', trigger: 'blur' },
    { min: 2, max: 120, message: '标题长度 2 - 120 个字符', trigger: 'blur' },
  ],
  content: [{ required: true, message: '请输入文章内容', trigger: 'blur' }],
}

/* ==================== 封面 ==================== */

/** 已有封面（编辑模式回显用） */
const existingCover = ref('')
/** 本地预览地址（新选文件后生成） */
const previewUrl = ref('')

const fileInputRef = ref<HTMLInputElement>()

const MAX_COVER_SIZE = 5 * 1024 * 1024

/** 当前展示的封面：优先新选文件的本地预览，其次原封面 */
const coverPreview = computed(() => previewUrl.value || existingCover.value)

function pickFile() {
  fileInputRef.value?.click()
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  if (!file.type.startsWith('image/')) {
    ElMessage.error('封面只支持图片文件')
    input.value = ''
    return
  }
  if (file.size > MAX_COVER_SIZE) {
    ElMessage.error('封面图片不能超过 5 MB')
    input.value = ''
    return
  }

  // 释放上一次的 objectURL，避免内存泄漏
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)

  form.file = file
  previewUrl.value = URL.createObjectURL(file)
}

function clearCover() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  form.file = null
  // 新建模式本来就没有原封面；编辑模式要把原封面显示回来
  // （接口只有「不传 file = 保留原封面」，没有删除封面的能力）
  if (!isEdit.value) existingCover.value = ''
  if (fileInputRef.value) fileInputRef.value.value = ''
}

/**
 * 「移除封面」只在「刚选了新文件、想撤销这次选择」时才有意义。
 * 编辑模式下已有原封面时不能提供这个按钮 —— 接口没有删除封面的能力，
 * 点了只会让界面看起来删掉了、实际后端仍保留，属于欺骗用户。
 */
const canRemoveCover = computed(() => !!previewUrl.value)

/** 编辑模式下已有原封面、且这次没换图 */
const keepOriginalCover = computed(() => isEdit.value && !!existingCover.value && !previewUrl.value)

onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

/* ==================== 编辑模式的初始加载 ==================== */

const loading = ref(false)
const loadError = ref(false)

async function loadForEdit() {
  if (!isEdit.value) return
  loading.value = true
  loadError.value = false
  try {
    const data = await getArticleDetail(articleId.value)
    form.title = data.title ?? ''
    form.summary = data.summary ?? ''
    form.content = data.content ?? ''
    // 只保留可用标签（后端可能返回 { id: null, name: null } 占位元素），
    // 并原样交给提交逻辑，保证「不改标签 = 标签不变」
    existingTags.value = (data.tags ?? []).filter((t) => t?.id != null && !!t.name)
    form.tagIds = existingTags.value.map((t) => t.id)
    existingCover.value = data.cover ?? ''
    // 回显完成后把基线快照更新掉，否则会被判定为「有未保存改动」
    resetBaseline()
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

/* ==================== 标签（2.12 候选集 + 多选） ==================== */

/**
 * 标签候选集（2.12 `GET /api/tag/list`）。
 *
 * 该接口**需要登录**、无分页，返回全部公共标签。标签是全局预置资源，
 * 没有创建标签的接口，所以只能「从候选里选」。
 * 加载失败（例如后端临时挂掉）不影响保存：已有标签仍会原样回传。
 */
const tagOptions = ref<TagVO[]>([])
const tagsLoading = ref(false)
const tagsLoadFailed = ref(false)

/** 当前文章已有的标签（详情回显），提交时原样带回 */
const existingTags = ref<TagVO[]>([])

/**
 * 下拉里真正展示的选项 = 候选集 + 已有但不在候选集里的标签。
 * 后者兜的是「文章用了某个已被删掉的标签」这种脏数据 ——
 * 不补进去的话 el-select 只能显示一个光秃秃的 id。
 */
const selectOptions = computed<TagVO[]>(() => {
  const known = new Set(tagOptions.value.map((t) => t.id))
  return [...tagOptions.value, ...existingTags.value.filter((t) => !known.has(t.id))]
})

async function loadTagOptions() {
  tagsLoading.value = true
  tagsLoadFailed.value = false
  try {
    const list = await getTagList()
    // 过滤掉 id / name 缺失的占位元素（05 §3.8：后端历史上返回过 {id:null,name:null}）
    tagOptions.value = (list ?? []).filter((t) => t?.id != null && !!t.name)
  } catch {
    tagsLoadFailed.value = true
    tagOptions.value = []
  } finally {
    tagsLoading.value = false
  }
}

/* ==================== 预览 ==================== */

/** 窄屏下的视图切换：edit | preview */
const mobileView = ref<'edit' | 'preview'>('edit')

const readingMinutes = computed(() => estimateReadingMinutes(form.content))

const wordCount = computed(() => form.content.replace(/\s+/g, '').length)

/* ==================== 提交 ==================== */

const submitting = ref<ContentStatus | null>(null)

async function submit(status: ContentStatus) {
  if (submitting.value !== null) return

  // 发布才强校验；存草稿允许标题为空（但后端 title 是必填，所以仍然要填）
  try {
    await formRef.value?.validate()
  } catch {
    ElMessage.warning('请先补全标题与正文')
    return
  }

  submitting.value = status
  try {
    // tagIds 原样提交：编辑时传空数组即「清空标签」，这是文档明确语义，不能跳过
    // file 为 null 时不传 → 编辑模式下后端保留原封面
    const payload = {
      title: form.title.trim(),
      summary: form.summary.trim() || undefined,
      content: form.content,
      file: form.file,
      status,
      tagIds: form.tagIds,
    }

    if (isEdit.value) {
      await updateArticle(articleId.value, payload)
      ElMessage.success(status === ContentStatus.DRAFT ? '草稿已保存' : '文章已更新')
      // 重置基线，否则离开守卫会把刚保存的内容当成"未保存改动"拦下来
      resetBaseline()
      void router.push({ name: RouteName.ARTICLE_DETAIL, params: { id: String(articleId.value) } })
    } else {
      const res = await createArticle(payload)
      ElMessage.success(status === ContentStatus.DRAFT ? '草稿已保存' : '文章已发布')
      resetBaseline()
      const newId = res?.id
      if (newId !== undefined && newId !== null) {
        void router.push({ name: RouteName.ARTICLE_DETAIL, params: { id: String(newId) } })
      } else {
        // 后端没返回 id 时不能猜，退回列表
        void router.push({ name: RouteName.MY_ARTICLES })
      }
    }
  } catch {
    // 失败提示由请求层负责（项目级约定 D）：后端 message 更具体
    // （如「正文或标题不能为空」「文章状态不能为空」），页面不再自造一条。
  } finally {
    submitting.value = null
  }
}

/* ==================== 未保存拦截 ==================== */

/** 表单基线快照：与之比较判断是否有未保存改动 */
let baseline = ''
const dirty = ref(false)

function snapshot(): string {
  return JSON.stringify({
    t: form.title,
    s: form.summary,
    c: form.content,
    f: form.file?.name ?? '',
    g: [...form.tagIds].sort((a, b) => a - b),
  })
}

/**
 * 把当前内容设为「已保存」基线。
 * 提交成功后必须调用它 —— 只把 dirty 置 false 是没用的，
 * 因为路由离开守卫会重新调用 markDirty() 从基线重算，又会被判为脏。
 */
function resetBaseline() {
  baseline = snapshot()
  dirty.value = false
}

function markDirty() {
  if (!baseline) return
  dirty.value = snapshot() !== baseline
}

/**
 * 深度监听表单：输入过程中就要实时反映「未保存」。
 * 不能依赖 el-form 的 @change —— 那是 blur 时才触发的，
 * 用户边打字边看，徽标不会亮。
 */
watch(form, markDirty, { deep: true })

function beforeUnloadHandler(e: BeforeUnloadEvent) {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

onMounted(async () => {
  await loadForEdit()
  // 候选集必须在 resetBaseline 之前拉完：否则它到达时可能被当成「未保存改动」
  await loadTagOptions()
  resetBaseline()
  window.addEventListener('beforeunload', beforeUnloadHandler)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnloadHandler)
})

onBeforeRouteLeave(async () => {
  markDirty()
  if (!dirty.value) return true

  try {
    await ElMessageBox.confirm('有未保存的修改，确定离开吗？', '离开页面', {
      confirmButtonText: '放弃修改',
      cancelButtonText: '继续编辑',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
})

/** 手动保存草稿的按钮在编辑模式下改叫「保存草稿」 */
const draftLabel = computed(() => (isEdit.value ? '保存草稿' : '存为草稿'))
const publishLabel = computed(() => (isEdit.value ? '更新文章' : '发布文章'))
</script>

<template>
  <div class="cm-container cm-editor">
    <!-- ==================== 载入中 ==================== -->
    <LoadingState v-if="loading" variant="spinner" text="正在加载文章" />

    <!-- ==================== 载入失败 ==================== -->
    <ErrorState
      v-else-if="loadError"
      title="文章加载失败"
      description="无法读取这篇文章的内容，可能已被删除或后端不可用"
      @retry="loadForEdit"
    >
      <template #extra>
        <el-button size="small" @click="router.push({ name: RouteName.MY_ARTICLES })">
          返回我的文章
        </el-button>
      </template>
    </ErrorState>

    <!-- ==================== 表单 ==================== -->
    <template v-else>
      <!-- 顶部栏 -->
      <header class="cm-editor__head">
        <div class="cm-editor__head-left">
          <h1 class="cm-editor__title">{{ pageTitle }}</h1>
          <span v-if="dirty" class="cm-editor__dirty">未保存</span>
        </div>

        <div class="cm-editor__head-actions">
          <el-button
            :loading="submitting === ContentStatus.DRAFT"
            :disabled="submitting !== null"
            @click="submit(ContentStatus.DRAFT)"
          >
            {{ draftLabel }}
          </el-button>
          <el-button
            type="primary"
            :loading="submitting === ContentStatus.PUBLISHED"
            :disabled="submitting !== null"
            @click="submit(ContentStatus.PUBLISHED)"
          >
            {{ publishLabel }}
          </el-button>
        </div>
      </header>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        class="cm-editor__form"
      >
        <!-- 标题 -->
        <el-form-item prop="title" class="cm-editor__field">
          <el-input
            v-model="form.title"
            placeholder="输入文章标题…"
            maxlength="120"
            show-word-limit
            size="large"
            class="cm-editor__title-input"
          />
        </el-form-item>

        <!-- 摘要 -->
        <el-form-item label="摘要" prop="summary" class="cm-editor__field">
          <el-input
            v-model="form.summary"
            type="textarea"
            :rows="2"
            maxlength="200"
            show-word-limit
            resize="none"
            placeholder="一句话概括这篇文章（不填时列表页可能直接截取正文）"
          />
        </el-form-item>

        <!-- 封面 + 标签 -->
        <div class="cm-editor__row">
          <el-form-item label="封面" class="cm-editor__col">
            <div class="cm-editor__cover">
              <div v-if="coverPreview" class="cm-editor__cover-preview">
                <img :src="coverPreview" alt="封面预览" />
              </div>
              <div v-else class="cm-editor__cover-placeholder">
                <el-icon :size="22"><Picture /></el-icon>
                <span>暂无封面</span>
              </div>

              <div class="cm-editor__cover-ops">
                <el-button size="small" @click="pickFile">
                  <el-icon><Upload /></el-icon>
                  {{ coverPreview ? '更换图片' : '选择图片' }}
                </el-button>
                <el-button v-if="canRemoveCover" size="small" text @click="clearCover">
                  撤销选择
                </el-button>
                <p class="cm-editor__hint cm-editor__cover-hint">
                  支持图片格式，不超过 5 MB。
                  <template v-if="keepOriginalCover">
                    当前已有封面，选新图即可替换；接口不支持删除已有封面。
                  </template>
                  <template v-else-if="isEdit">不选择则保留原封面。</template>
                </p>
              </div>

              <!-- 原生 file input：只取 File 对象，上传交给 axios 统一处理 -->
              <input
                ref="fileInputRef"
                type="file"
                accept="image/*"
                class="cm-editor__file-input"
                @change="onFileChange"
              />
            </div>
          </el-form-item>

          <el-form-item label="标签" class="cm-editor__col">
            <!-- 候选集来自 2.12（公共资源，只能选不能建）；v-model 直接是 form.tagIds，
                 提交时空数组 = 清空标签，这是后端明确语义 -->
            <div class="cm-editor__tags">
              <el-select
                v-model="form.tagIds"
                multiple
                filterable
                clearable
                collapse-tags
                collapse-tags-tooltip
                :max-collapse-tags="4"
                :loading="tagsLoading"
                :disabled="!selectOptions.length"
                placeholder="选择标签（可多选）"
                class="cm-editor__tag-select"
              >
                <el-option
                  v-for="tag in selectOptions"
                  :key="tag.id"
                  :label="tag.name"
                  :value="tag.id"
                />
              </el-select>
            </div>
            <p class="cm-editor__hint">
              <template v-if="tagsLoadFailed">
                标签候选加载失败，已保留当前标签；保存时仍会原样提交，不影响内容。
              </template>
              <template v-else-if="selectOptions.length">
                标签是公共资源，只能从预置项里选；全部取消 = 清空该文章标签。
              </template>
              <template v-else>暂无可选标签。</template>
            </p>
          </el-form-item>
        </div>

        <!-- 正文：桌面双栏 / 窄屏单栏可切换 -->
        <div class="cm-editor__content-head">
          <label class="cm-editor__content-label">
            正文
            <span class="cm-editor__content-meta">
              {{ wordCount }} 字 · 约 {{ readingMinutes }} 分钟
            </span>
          </label>

          <div class="cm-editor__view-switch">
            <button
              type="button"
              :class="{ 'is-active': mobileView === 'edit' }"
              @click="mobileView = 'edit'"
            >
              编辑
            </button>
            <button
              type="button"
              :class="{ 'is-active': mobileView === 'preview' }"
              @click="mobileView = 'preview'"
            >
              预览
            </button>
          </div>
        </div>

        <div class="cm-editor__panes">
          <div class="cm-editor__pane cm-editor__pane--edit" :class="{ 'is-hidden-mobile': mobileView !== 'edit' }">
            <el-form-item prop="content" class="cm-editor__content-item">
              <el-input
                v-model="form.content"
                type="textarea"
                resize="none"
                placeholder="用 Markdown 写正文…

# 一级标题
## 二级标题

```js
console.log('支持代码块高亮')
```"
                class="cm-editor__textarea"
              />
            </el-form-item>
          </div>

          <div
            class="cm-editor__pane cm-editor__pane--preview"
            :class="{ 'is-hidden-mobile': mobileView !== 'preview' }"
          >
            <div class="cm-editor__preview-body cm-scroll-thin">
              <MarkdownViewer v-if="form.content.trim()" :content="form.content" variant="article" />
              <p v-else class="cm-editor__preview-empty">左侧输入内容后，这里会实时预览</p>
            </div>
          </div>
        </div>
      </el-form>
    </template>
  </div>
</template>

<style scoped>
.cm-editor {
  padding-top: var(--cm-space-8);
  padding-bottom: var(--cm-space-12);
}

/* ==================== 顶部栏 ==================== */
.cm-editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-4);
  padding-bottom: var(--cm-space-5);
  margin-bottom: var(--cm-space-6);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-editor__head-left {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  min-width: 0;
}

.cm-editor__title {
  margin: 0;
  font-size: var(--cm-font-size-xl);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.cm-editor__dirty {
  padding: 1px 8px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border: 1px solid var(--cm-warning-border);
  border-radius: var(--cm-radius-full);
  white-space: nowrap;
}

.cm-editor__head-actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
}

/* ==================== 表单 ==================== */
.cm-editor__field {
  margin-bottom: var(--cm-space-4);
}

.cm-editor__title-input :deep(.el-input__inner) {
  font-size: var(--cm-font-size-lg);
  font-weight: 600;
}

.cm-editor__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--cm-space-6);
}

.cm-editor__col {
  min-width: 0;
}

.cm-editor__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cm-space-2);
  width: 100%;
}

/* 多选下拉占满该列，避免和封面列宽度不一致 */
.cm-editor__tag-select {
  width: 100%;
}

.cm-editor__hint {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-xs);
  line-height: 1.5;
  color: var(--cm-text-quaternary);
}

/* ==================== 封面 ==================== */
.cm-editor__cover {
  display: flex;
  align-items: flex-start;
  gap: var(--cm-space-4);
}

.cm-editor__cover-preview {
  flex-shrink: 0;
  width: 148px;
  height: 96px;
  overflow: hidden;
  border: 1px solid var(--cm-border-default);
  border-radius: var(--cm-radius-md);
  background-color: var(--cm-bg-sunken);
}

.cm-editor__cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cm-editor__cover-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
  width: 148px;
  height: 96px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  background-color: var(--cm-bg-sunken);
  border: 1px dashed var(--cm-border-default);
  border-radius: var(--cm-radius-md);
}

.cm-editor__cover-ops {
  min-width: 0;
  padding-top: var(--cm-space-1);
}

.cm-editor__cover-hint {
  max-width: 40ch;
}

/* 原生 input 隐藏，由按钮触发 */
.cm-editor__file-input {
  display: none;
}

/* ==================== 正文区 ==================== */
.cm-editor__content-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-3);
  margin-bottom: var(--cm-space-3);
}

.cm-editor__content-label {
  display: inline-flex;
  align-items: baseline;
  gap: var(--cm-space-3);
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-text-secondary);
}

.cm-editor__content-meta {
  font-size: var(--cm-font-size-xs);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--cm-text-quaternary);
}

/* 窄屏切换开关：桌面下隐藏（两栏都显示） */
.cm-editor__view-switch {
  display: none;
  gap: 1px;
  padding: 2px;
  background-color: var(--cm-bg-sunken);
  border-radius: var(--cm-radius-md);
}

.cm-editor__view-switch button {
  padding: 3px 12px;
  font-family: inherit;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-tertiary);
  background: none;
  border: none;
  border-radius: var(--cm-radius-sm);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.cm-editor__view-switch button.is-active {
  color: var(--cm-text-primary);
  background-color: var(--cm-bg-surface);
}

/* ---------- 双栏 ---------- */
.cm-editor__panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--cm-space-5);
  align-items: stretch;
}

.cm-editor__pane {
  min-width: 0;
}

/* 输入框要把 el-form-item 的 margin 去掉，才能与预览等高 */
.cm-editor__content-item {
  margin-bottom: 0;
  height: 100%;
}

.cm-editor__content-item :deep(.el-form-item__content) {
  height: 100%;
}

.cm-editor__textarea {
  height: 100%;
  min-height: 520px;
}

.cm-editor__textarea :deep(.el-textarea__inner) {
  height: 100%;
  min-height: 520px !important;
  font-family: var(--cm-font-mono);
  font-size: var(--cm-font-size-sm);
  line-height: 1.7;
}

/* ---------- 预览 ---------- */
.cm-editor__pane--preview {
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-md);
  background-color: var(--cm-bg-surface);
  overflow: hidden;
}

.cm-editor__preview-body {
  height: 100%;
  min-height: 520px;
  max-height: 720px;
  overflow-y: auto;
  padding: var(--cm-space-5);
}

.cm-editor__preview-empty {
  padding-top: var(--cm-space-10);
  font-size: var(--cm-font-size-sm);
  text-align: center;
  color: var(--cm-text-quaternary);
}

/* ==================== 响应式 ==================== */
@media (max-width: 1024px) {
  .cm-editor__row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}

@media (max-width: 860px) {
  .cm-editor__panes {
    grid-template-columns: minmax(0, 1fr);
  }

  .cm-editor__view-switch {
    display: inline-flex;
  }

  /* 窄屏下由切换开关决定显示哪一栏 */
  .cm-editor__pane.is-hidden-mobile {
    display: none;
  }

  .cm-editor__textarea,
  .cm-editor__textarea :deep(.el-textarea__inner),
  .cm-editor__preview-body {
    min-height: 420px;
  }
}

@media (max-width: 560px) {
  .cm-editor__head {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-editor__head-actions {
    justify-content: flex-end;
  }

  .cm-editor__cover {
    flex-direction: column;
  }
}
</style>
