<script setup lang="ts">
/**
 * 笔记发布 / 编辑页（同一组件承担两种模式）：
 *   发布 → POST /api/note/createNote（路由 /notes/create）
 *   编辑 → PUT  /api/note/{id}（路由 /notes/:id/edit）
 *
 * 与文章编辑器的关键差异（不要照搬）：
 *   1. 提交格式是 **multipart/form-data**，封面传的是**文件对象**而非 URL
 *      （FormData 在 `api/note.ts` 里组装）。
 *   2. **categoryId 必填**（创建与编辑都是）→ 分类是硬前置条件，
 *      一个分类都没有时必须给出明确引导，不能让用户填完一整篇才发现提交失败。
 *   3. 编辑时**不传 file = 保留原封面**，所以「没选新文件」时不能塞空 file。
 *   4. **不传 tagIds = 清空全部标签**，表单始终提交当前标签集合。
 *
 * 标签候选来自 `GET /api/tag/list`（没有「创建标签」接口，只能从候选里选）；
 * 候选加载失败不影响保存，已有标签原样回传。
 *
 * 封面用原生 `<input type="file">` 而非 el-upload：只需要拿到 File 对象交给 axios，
 * el-upload 自带上传行为反而要额外压制。
 *
 * 分类的两条失败路径要分开：加载成功但一个都没有 → 引导去创建；
 * 加载失败 → 提示重试，**不能谎称「你没有分类」**。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import MarkdownViewer from '@/components/common/MarkdownViewer.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import { createNote, getNoteDetail, updateNote } from '@/api/note'
import { getTagList } from '@/api/article'
import { getCategoryTree } from '@/api/category'
import { ApiError } from '@/api/request'
import { useUserStore } from '@/stores/user'
import { RouteName } from '@/router/routes-names'
import { ContentStatus, Visibility } from '@/types/common'
import type { CategoryVO, TagVO } from '@/types/category'
import { estimateReadingMinutes } from '@/utils/format'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const isEdit = computed(() => route.name === RouteName.NOTE_EDIT)
const noteId = computed(() => Number(route.params.id))
const pageTitle = computed(() => (isEdit.value ? '编辑笔记' : '写笔记'))

/* ==================== 表单 ==================== */

const formRef = ref()

const form = reactive({
  title: '',
  content: '',
  summary: '',
  /** 必填，null 表示未选 */
  categoryId: null as number | null,
  visibility: Visibility.PRIVATE as Visibility,
  tagIds: [] as number[],
  /** 新选择的封面文件；为 null 表示不更换（编辑时即保留原封面） */
  file: null as File | null,
})

const rules = {
  title: [
    { required: true, message: '请输入笔记标题', trigger: 'blur' },
    { min: 2, max: 120, message: '标题长度 2 - 120 个字符', trigger: 'blur' },
  ],
  content: [{ required: true, message: '请输入笔记内容', trigger: 'blur' }],
  categoryId: [{ required: true, message: '请选择分类', trigger: 'change' }],
}

/* ==================== 分类 ==================== */

const categories = ref<CategoryVO[]>([])
const categoriesLoading = ref(true)
/** 分类树加载失败：和「确实没有分类」是两回事，文案与出路都不同 */
const categoriesError = ref(false)

/** 扁平化分类树，带层级缩进，供下拉选择 */
interface FlatCategory {
  id: number
  label: string
}

function flatten(nodes: CategoryVO[], depth = 0, out: FlatCategory[] = []): FlatCategory[] {
  for (const node of nodes) {
    out.push({ id: node.id, label: `${'　'.repeat(depth)}${depth > 0 ? '└ ' : ''}${node.name}` })
    if (node.children?.length) flatten(node.children, depth + 1, out)
  }
  return out
}

const flatCategories = computed(() => flatten(categories.value))

/** 加载成功、且确实一个分类都没有 —— 这才是「你去建一个分类」的确定结论 */
const noCategories = computed(
  () => !categoriesLoading.value && !categoriesError.value && categories.value.length === 0,
)

async function loadCategories() {
  categoriesLoading.value = true
  categoriesError.value = false
  try {
    categories.value = (await getCategoryTree()) ?? []
  } catch {
    categories.value = []
    categoriesError.value = true
  } finally {
    categoriesLoading.value = false
  }
}

/* ==================== 标签（2.12 候选集 + 多选） ==================== */

/**
 * 标签候选集（2.12 `GET /api/tag/list`，需登录、无分页）。
 *
 * 该接口**实测可用**（2026-09-23 对真实后端验证，返回 9 个预置标签），
 * 与文章编辑器（T5）共用 `api/article.ts` 的 `getTagList`。
 * 加载失败不影响保存：已有标签仍会原样回传。
 */
const tagOptions = ref<TagVO[]>([])
const tagsLoading = ref(true)
const tagsLoadFailed = ref(false)

/** 当前笔记已有的标签（编辑模式回显），提交时原样带回 */
const existingTags = ref<TagVO[]>([])

/**
 * 下拉里真正展示的选项 = 候选集 + 已有但不在候选集里的标签。
 * 后者兜的是「笔记用了某个已被删掉的标签」这种脏数据 ——
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
 * 「撤销选择」只在「刚选了新文件、想撤销这次选择」时才有意义。
 * 编辑模式下已有原封面时不能提供删除按钮 —— 接口没有删除封面的能力，
 * 点了只会让界面看起来删掉了、实际后端仍保留，属于欺骗用户。
 */
const canRemoveCover = computed(() => !!previewUrl.value)

/** 编辑模式下已有原封面、且这次没换图 */
const keepOriginalCover = computed(() => isEdit.value && !!existingCover.value && !previewUrl.value)

onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

/* ==================== 编辑模式回显 ==================== */

const loading = ref(false)
const loadError = ref(false)
/** 回显失败的错误码：403 别人的笔记 / 404 不存在 / 其它兜底 */
const loadErrorCode = ref<number | null>(null)

const loadErrorTitle = computed(() => {
  if (loadErrorCode.value === 403) return '无权编辑这篇笔记'
  if (loadErrorCode.value === 404) return '笔记不存在或已删除'
  return '笔记加载失败'
})

const loadErrorDesc = computed(() => {
  if (loadErrorCode.value === 403) return '只有笔记作者本人可以编辑'
  if (loadErrorCode.value === 404) return '它可能已被作者删除'
  return '无法读取这篇笔记，可能是网络问题或后端服务未启动'
})

async function loadForEdit() {
  if (!isEdit.value) return
  loading.value = true
  loadError.value = false
  loadErrorCode.value = null
  try {
    const data = await getNoteDetail(noteId.value)
    form.title = data.title ?? ''
    form.content = data.content ?? ''
    form.summary = data.summary ?? ''
    form.categoryId = data.category?.id ?? null
    form.visibility = data.visibility ?? Visibility.PRIVATE
    // 只保留可用标签（后端可能返回 { id: null, name: null } 占位元素）
    existingTags.value = (data.tags ?? []).filter((t) => t?.id != null && !!t.name)
    form.tagIds = existingTags.value.map((t) => t.id)
    existingCover.value = data.cover ?? ''

    /*
     * 归属校验：必须在**回显阶段**就拦。
     * 编辑接口（2.2）是整体覆盖语义，而对别人的**公开**笔记调 2.4 是会成功的 ——
     * 只靠后端 403 的话，用户会先把别人整篇内容填进编辑器、改完才被打回，白干一场。
     */
    const uid = userStore.userId
    if (uid !== null && data.user?.id != null && data.user.id !== uid) {
      loadError.value = true
      loadErrorCode.value = 403
      return
    }

    resetBaseline()
  } catch (err) {
    loadError.value = true
    loadErrorCode.value = err instanceof ApiError ? err.code : null
  } finally {
    loading.value = false
  }
}

/* ==================== 预览 ==================== */

const mobileView = ref<'edit' | 'preview'>('edit')
const wordCount = computed(() => form.content.replace(/\s+/g, '').length)
const readingMinutes = computed(() => estimateReadingMinutes(form.content))

/* ==================== 提交 ==================== */

const submitting = ref<ContentStatus | null>(null)

async function submit(status: ContentStatus) {
  if (submitting.value !== null) return

  /*
   * 分类是硬前置条件，必须在表单校验之前拦下并给出**对应的**出路：
   *   - 加载失败 → 让用户重试（不能说「你没有分类」，那是没根据的结论）
   *   - 一个都没有 → 引导去创建分类
   * 按钮上虽然也做了 disabled，但这里是最后一道闸：
   * 分类未就绪时绝不允许把请求发出去（后端只会回 400 残句）。
   */
  if (categoriesError.value) {
    ElMessage.warning('分类还没加载成功，请先点击「重新加载分类」')
    return
  }
  if (noCategories.value) {
    ElMessage.warning('还没有任何分类，请先创建一个分类再保存笔记')
    return
  }
  if (categoriesLoading.value) {
    ElMessage.warning('分类还在加载，请稍候')
    return
  }

  try {
    await formRef.value?.validate()
  } catch {
    ElMessage.warning('请补全标题、正文与分类')
    return
  }

  // validate 已保证 categoryId 非空，这里做一次收窄让类型成立
  if (form.categoryId === null) {
    ElMessage.warning('请选择分类')
    return
  }

  submitting.value = status
  try {
    // 注意：file 为 null 时不传 → 编辑模式下后端保留原封面
    const payload = {
      title: form.title.trim(),
      content: form.content,
      categoryId: form.categoryId,
      summary: form.summary.trim() || undefined,
      visibility: form.visibility,
      status,
      // 始终提交当前标签集合：不传会被后端理解为「清空全部标签」
      tagIds: form.tagIds,
      file: form.file,
    }

    if (isEdit.value) {
      await updateNote(noteId.value, payload)
      ElMessage.success(status === ContentStatus.DRAFT ? '草稿已保存' : '笔记已更新')
      resetBaseline()
      void router.push({ name: RouteName.NOTE_DETAIL, params: { id: String(noteId.value) } })
    } else {
      // 2.1 的 data 是**新建笔记 id 的裸数字**（不是对象），实测 `{"data":83}`
      const newId = await createNote(payload)
      ElMessage.success(status === ContentStatus.DRAFT ? '草稿已保存' : '笔记已创建')
      resetBaseline()
      if (typeof newId === 'number' && Number.isFinite(newId)) {
        void router.push({ name: RouteName.NOTE_DETAIL, params: { id: String(newId) } })
      } else {
        // 后端没回 id 时退回列表，至少不把用户留在空编辑器里
        void router.push({ name: RouteName.NOTE_LIST })
      }
    }
  } catch {
    ElMessage.error(isEdit.value ? '保存失败' : '创建失败')
  } finally {
    submitting.value = null
  }
}

/* ==================== 未保存拦截 ==================== */

let baseline = ''
const dirty = ref(false)

function snapshot(): string {
  return JSON.stringify({
    t: form.title,
    c: form.content,
    s: form.summary,
    cat: form.categoryId,
    v: form.visibility,
    g: [...form.tagIds].sort((a, b) => a - b),
    f: form.file?.name ?? '',
  })
}

/** 提交成功后必须重置基线，否则离开守卫会把刚保存的内容当改动拦下 */
function resetBaseline() {
  baseline = snapshot()
  dirty.value = false
}

function markDirty() {
  if (!baseline) return
  dirty.value = snapshot() !== baseline
}

// 深度监听：输入过程中就要实时反映「未保存」（el-form 的 change 是 blur 才触发）
watch(form, markDirty, { deep: true })

function beforeUnloadHandler(e: BeforeUnloadEvent) {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

onMounted(async () => {
  await Promise.all([loadForEdit(), loadCategories(), loadTagOptions()])
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

const draftLabel = computed(() => (isEdit.value ? '保存草稿' : '存为草稿'))
const publishLabel = computed(() => (isEdit.value ? '更新笔记' : '创建笔记'))

const VISIBILITY_OPTIONS = [
  { value: Visibility.PRIVATE, label: '私密' },
  { value: Visibility.PUBLIC, label: '公开' },
]
</script>

<template>
  <div class="cm-container cm-note-editor">
    <LoadingState v-if="loading" variant="spinner" text="正在加载笔记" />

    <ErrorState
      v-else-if="loadError"
      :title="loadErrorTitle"
      :description="loadErrorDesc"
      @retry="loadForEdit"
    >
      <template #extra>
        <el-button size="small" @click="router.push({ name: RouteName.NOTE_LIST })">
          返回笔记列表
        </el-button>
      </template>
    </ErrorState>

    <template v-else>
      <!-- 顶部栏 -->
      <header class="cm-note-editor__head">
        <div class="cm-note-editor__head-left">
          <h1 class="cm-note-editor__title">{{ pageTitle }}</h1>
          <span v-if="dirty" class="cm-note-editor__dirty">未保存</span>
        </div>

        <div class="cm-note-editor__head-actions">
          <!--
            刻意**不**因为「分类没准备好」而禁用：按钮禁用了，用户点下去什么反馈都没有，
            只会以为页面卡住。保持可点，由 submit() 拦下并说明原因 + 指向上面那条阻断提示。
          -->
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

      <!--
        分类是 categoryId 必填的硬前置条件，提前拦下并给出**对应的**出路。
        两种失败原因分开写：加载失败是「不知道」，一个都没有才是「确定没有」。
      -->
      <div v-if="noCategories" class="cm-note-editor__blocker">
        <el-icon class="cm-note-editor__blocker-icon"><Warning /></el-icon>
        <div class="cm-note-editor__blocker-text">
          <p class="cm-note-editor__blocker-title">还没有任何分类，暂时无法保存笔记</p>
          <p class="cm-note-editor__blocker-desc">
            笔记的分类是必填项。先创建一个分类，再回来继续写。
          </p>
        </div>
        <el-button
          type="primary"
          size="small"
          @click="router.push({ name: RouteName.CATEGORY_MANAGE })"
        >
          去创建分类
        </el-button>
      </div>

      <div v-else-if="categoriesError" class="cm-note-editor__blocker">
        <el-icon class="cm-note-editor__blocker-icon"><Warning /></el-icon>
        <div class="cm-note-editor__blocker-text">
          <p class="cm-note-editor__blocker-title">分类加载失败，暂时无法保存笔记</p>
          <p class="cm-note-editor__blocker-desc">
            没有分类就无法确定笔记归属。请重试，或先去分类管理页确认分类是否存在。
          </p>
        </div>
        <div class="cm-note-editor__blocker-actions">
          <el-button type="primary" size="small" @click="loadCategories">重新加载分类</el-button>
          <el-button size="small" @click="router.push({ name: RouteName.CATEGORY_MANAGE })">
            分类管理
          </el-button>
        </div>
      </div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        class="cm-note-editor__form"
      >
        <el-form-item prop="title" class="cm-note-editor__field">
          <el-input
            v-model="form.title"
            placeholder="输入笔记标题…"
            maxlength="120"
            show-word-limit
            size="large"
            class="cm-note-editor__title-input"
          />
        </el-form-item>

        <!-- 分类 / 可见性 / 标签 -->
        <div class="cm-note-editor__row cm-note-editor__row--three">
          <el-form-item label="分类" prop="categoryId" class="cm-note-editor__col">
            <LoadingState v-if="categoriesLoading" variant="spinner" text="加载分类" />
            <el-select
              v-else
              v-model="form.categoryId"
              placeholder="选择一个分类（必填）"
              class="cm-note-editor__control cm-note-editor__category-select"
              filterable
            >
              <el-option
                v-for="cat in flatCategories"
                :key="cat.id"
                :label="cat.label"
                :value="cat.id"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="可见性" class="cm-note-editor__col">
            <el-radio-group v-model="form.visibility" class="cm-note-editor__visibility">
              <el-radio-button
                v-for="opt in VISIBILITY_OPTIONS"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </el-radio-button>
            </el-radio-group>
            <p class="cm-note-editor__hint">
              {{ form.visibility === Visibility.PRIVATE ? '仅自己可见' : '其他人可查看' }}
            </p>
          </el-form-item>

          <el-form-item label="标签" class="cm-note-editor__col">
            <!-- 候选集来自 2.12（公共资源，只能选不能建）；v-model 直接是 form.tagIds，
                 提交时空数组 = 清空标签，这是后端明确语义，不能跳过 -->
            <el-select
              v-model="form.tagIds"
              multiple
              filterable
              clearable
              collapse-tags
              collapse-tags-tooltip
              :max-collapse-tags="3"
              :loading="tagsLoading"
              :disabled="!selectOptions.length"
              placeholder="选择标签（可多选）"
              class="cm-note-editor__control cm-note-editor__tag-select"
            >
              <el-option
                v-for="tag in selectOptions"
                :key="tag.id"
                :label="tag.name"
                :value="tag.id"
              />
            </el-select>
            <p class="cm-note-editor__hint">
              <template v-if="tagsLoadFailed">
                标签候选加载失败，已保留当前标签；保存时仍会原样提交，不影响内容。
              </template>
              <template v-else-if="selectOptions.length">
                标签是公共资源，只能从预置项里选；全部取消 = 清空该笔记标签。
              </template>
              <template v-else>暂无可选标签。</template>
            </p>
          </el-form-item>
        </div>

        <!-- 摘要 -->
        <el-form-item label="摘要" prop="summary" class="cm-note-editor__field">
          <el-input
            v-model="form.summary"
            type="textarea"
            :rows="2"
            maxlength="200"
            show-word-limit
            resize="none"
            placeholder="不填时后端会自动截取正文前 20 字"
          />
        </el-form-item>

        <!-- 封面：文件上传（与文章的 URL 输入不同） -->
        <el-form-item label="封面" class="cm-note-editor__field">
          <div class="cm-note-editor__cover">
            <div v-if="coverPreview" class="cm-note-editor__cover-preview">
              <img :src="coverPreview" alt="封面预览" />
            </div>
            <div v-else class="cm-note-editor__cover-placeholder">
              <el-icon :size="22"><Picture /></el-icon>
              <span>暂无封面</span>
            </div>

            <div class="cm-note-editor__cover-ops">
              <el-button size="small" @click="pickFile">
                <el-icon><Upload /></el-icon>
                {{ coverPreview ? '更换图片' : '选择图片' }}
              </el-button>
              <el-button v-if="canRemoveCover" size="small" text @click="clearCover">
                撤销选择
              </el-button>
              <p class="cm-note-editor__hint cm-note-editor__cover-hint">
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
              class="cm-note-editor__file-input"
              @change="onFileChange"
            />
          </div>
        </el-form-item>

        <!-- 正文 -->
        <div class="cm-note-editor__content-head">
          <label class="cm-note-editor__content-label">
            正文
            <span class="cm-note-editor__content-meta">
              {{ wordCount }} 字 · 约 {{ readingMinutes }} 分钟
            </span>
          </label>

          <div class="cm-note-editor__view-switch">
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

        <div class="cm-note-editor__panes">
          <div class="cm-note-editor__pane" :class="{ 'is-hidden-mobile': mobileView !== 'edit' }">
            <el-form-item prop="content" class="cm-note-editor__content-item">
              <el-input
                v-model="form.content"
                type="textarea"
                resize="none"
                placeholder="用 Markdown 记录你的知识…

# 标题
## 小节

```js
console.log('支持代码块高亮')
```"
                class="cm-note-editor__textarea"
              />
            </el-form-item>
          </div>

          <div
            class="cm-note-editor__pane cm-note-editor__pane--preview"
            :class="{ 'is-hidden-mobile': mobileView !== 'preview' }"
          >
            <div class="cm-note-editor__preview-body cm-scroll-thin">
              <MarkdownViewer
                v-if="form.content.trim()"
                :content="form.content"
                variant="article"
              />
              <p v-else class="cm-note-editor__preview-empty">左侧输入内容后，这里会实时预览</p>
            </div>
          </div>
        </div>
      </el-form>
    </template>
  </div>
</template>

<style scoped>
.cm-note-editor {
  padding-top: var(--cm-space-8);
  padding-bottom: var(--cm-space-12);
}

/* ==================== 顶部栏 ==================== */
.cm-note-editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-4);
  padding-bottom: var(--cm-space-5);
  margin-bottom: var(--cm-space-6);
  border-bottom: 1px solid var(--cm-border-subtle);
}

.cm-note-editor__head-left {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  min-width: 0;
}

.cm-note-editor__title {
  margin: 0;
  font-size: var(--cm-font-size-xl);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.cm-note-editor__dirty {
  padding: 1px 8px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-warning);
  background-color: var(--cm-warning-bg);
  border: 1px solid var(--cm-warning-border);
  border-radius: var(--cm-radius-full);
  white-space: nowrap;
}

.cm-note-editor__head-actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
}

/* ==================== 无分类拦截 ==================== */
.cm-note-editor__blocker {
  display: flex;
  align-items: center;
  gap: var(--cm-space-4);
  padding: var(--cm-space-4) var(--cm-space-5);
  margin-bottom: var(--cm-space-6);
  background-color: var(--cm-warning-bg);
  border: 1px solid var(--cm-warning-border);
  border-radius: var(--cm-radius-lg);
}

.cm-note-editor__blocker-icon {
  flex-shrink: 0;
  font-size: 20px;
  color: var(--cm-warning);
}

.cm-note-editor__blocker-text {
  flex: 1;
  min-width: 0;
}

.cm-note-editor__blocker-title {
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-text-primary);
}

.cm-note-editor__blocker-desc {
  margin-top: 2px;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-tertiary);
}

.cm-note-editor__blocker-actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
}

/* ==================== 表单 ==================== */
.cm-note-editor__field {
  margin-bottom: var(--cm-space-4);
}

.cm-note-editor__title-input :deep(.el-input__inner) {
  font-size: var(--cm-font-size-lg);
  font-weight: 600;
}

.cm-note-editor__row {
  display: grid;
  gap: var(--cm-space-6);
}

.cm-note-editor__row--three {
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.2fr);
}

.cm-note-editor__col {
  min-width: 0;
}

.cm-note-editor__control {
  width: 100%;
}

.cm-note-editor__visibility {
  width: 100%;
}

.cm-note-editor__hint {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-xs);
  line-height: 1.5;
  color: var(--cm-text-quaternary);
}

/* ==================== 封面 ==================== */
.cm-note-editor__cover {
  display: flex;
  align-items: flex-start;
  gap: var(--cm-space-4);
}

.cm-note-editor__cover-preview {
  flex-shrink: 0;
  width: 148px;
  height: 96px;
  overflow: hidden;
  border: 1px solid var(--cm-border-default);
  border-radius: var(--cm-radius-md);
  background-color: var(--cm-bg-sunken);
}

.cm-note-editor__cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cm-note-editor__cover-placeholder {
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

.cm-note-editor__cover-ops {
  min-width: 0;
  padding-top: var(--cm-space-1);
}

.cm-note-editor__cover-hint {
  max-width: 40ch;
}

/* 原生 input 隐藏，由按钮触发 */
.cm-note-editor__file-input {
  display: none;
}

/* ==================== 正文区 ==================== */
.cm-note-editor__content-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cm-space-3);
  margin-bottom: var(--cm-space-3);
}

.cm-note-editor__content-label {
  display: inline-flex;
  align-items: baseline;
  gap: var(--cm-space-3);
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-text-secondary);
}

.cm-note-editor__content-meta {
  font-size: var(--cm-font-size-xs);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--cm-text-quaternary);
}

.cm-note-editor__view-switch {
  display: none;
  gap: 1px;
  padding: 2px;
  background-color: var(--cm-bg-sunken);
  border-radius: var(--cm-radius-md);
}

.cm-note-editor__view-switch button {
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

.cm-note-editor__view-switch button.is-active {
  color: var(--cm-text-primary);
  background-color: var(--cm-bg-surface);
}

.cm-note-editor__panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--cm-space-5);
  align-items: stretch;
}

.cm-note-editor__pane {
  min-width: 0;
}

.cm-note-editor__content-item {
  margin-bottom: 0;
  height: 100%;
}

.cm-note-editor__content-item :deep(.el-form-item__content) {
  height: 100%;
}

.cm-note-editor__textarea {
  height: 100%;
  min-height: 520px;
}

.cm-note-editor__textarea :deep(.el-textarea__inner) {
  height: 100%;
  min-height: 520px !important;
  font-family: var(--cm-font-mono);
  font-size: var(--cm-font-size-sm);
  line-height: 1.7;
}

.cm-note-editor__pane--preview {
  border: 1px solid var(--cm-border-subtle);
  border-radius: var(--cm-radius-md);
  background-color: var(--cm-bg-surface);
  overflow: hidden;
}

.cm-note-editor__preview-body {
  height: 100%;
  min-height: 520px;
  max-height: 720px;
  overflow-y: auto;
  padding: var(--cm-space-5);
}

.cm-note-editor__preview-empty {
  padding-top: var(--cm-space-10);
  font-size: var(--cm-font-size-sm);
  text-align: center;
  color: var(--cm-text-quaternary);
}

/* ==================== 响应式 ==================== */
@media (max-width: 1024px) {
  .cm-note-editor__row--three {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}

@media (max-width: 860px) {
  .cm-note-editor__row--three {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  .cm-note-editor__panes {
    grid-template-columns: minmax(0, 1fr);
  }

  .cm-note-editor__view-switch {
    display: inline-flex;
  }

  .cm-note-editor__pane.is-hidden-mobile {
    display: none;
  }

  .cm-note-editor__textarea,
  .cm-note-editor__textarea :deep(.el-textarea__inner),
  .cm-note-editor__preview-body {
    min-height: 420px;
  }

  .cm-note-editor__blocker {
    flex-direction: column;
    align-items: flex-start;
  }
}

@media (max-width: 560px) {
  .cm-note-editor__head {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-note-editor__head-actions {
    justify-content: flex-end;
  }

  .cm-note-editor__cover {
    flex-direction: column;
  }
}
</style>
