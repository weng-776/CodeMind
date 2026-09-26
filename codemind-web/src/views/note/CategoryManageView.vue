<script setup lang="ts">
/**
 * 分类管理
 * ------------------------------------------------------------------
 * 对应接口：
 *   2.10 分类树查询   GET    /api/category/tree
 *   2.7  创建分类     POST   /api/category/createCategory
 *   2.8  修改分类     PUT    /api/category/{categoryId}
 *   2.9  删除分类     DELETE /api/category/{categoryId}
 *
 * 关键设计：
 *   1. **树用「扁平化 + 缩进」渲染，不引入递归组件**。
 *      分类层级通常不深，扁平列表既能表达层级（缩进 + 折叠箭头），
 *      又让每一行的操作按钮、排序边界判断写起来是线性的，不必层层传事件。
 *   2. **不提供「更换父分类」**。2.8 的请求体只有 name 与 sort，
 *      文档没有提供移动分类的能力，硬做只能靠「删了重建」，会丢掉笔记的归属，
 *      所以编辑弹窗里父分类只读展示，并明确告诉用户接口不支持。
 *   3. **删除必须讲清后果**：2.9 是逻辑删除，该分类下笔记的分类被置空
 *      （笔记本身不删）。若该分类还有子分类，文档没写子分类怎么处理，
 *      弹窗里如实说明「文档未说明」，不替后端编造行为。
 *   4. **排序用「与相邻兄弟交换」实现**：sort 值越大越靠前，
 *      上移 = 取前一个兄弟的 sort + 1，下移 = 后一个兄弟的 sort - 1，
 *      每次只打一个接口，不必重排整层。
 */
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { createCategory, deleteCategory, getCategoryTree, updateCategory } from '@/api/category'
import { RouteName } from '@/router/routes-names'
import type { CategoryVO } from '@/types/category'

const router = useRouter()

/** 顶级分类在 2.7 里用 parentId = 0 表示 */
const ROOT_PARENT_ID = 0

/* ==================== 树数据 ==================== */

const tree = ref<CategoryVO[]>([])
const loading = ref(true)
const error = ref(false)

/** 折叠状态：默认全部展开（管理页要看到全貌） */
const collapsed = ref<Set<number>>(new Set())

function isCollapsed(id: number) {
  return collapsed.value.has(id)
}

function toggleCollapse(id: number) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

/** 正在请求中的分类 id（避免同一行被连点） */
const pendingId = ref<number | null>(null)

async function loadTree() {
  loading.value = true
  error.value = false
  try {
    tree.value = (await getCategoryTree()) ?? []
  } catch {
    error.value = true
    tree.value = []
  } finally {
    loading.value = false
  }
}

/* ==================== 扁平化渲染 ==================== */

interface FlatRow {
  node: CategoryVO
  /** 缩进层级，从 0 开始 */
  depth: number
  /** 在同级中的下标（用于判断能否上移 / 下移） */
  index: number
  /** 同级总数 */
  siblingCount: number
  /** 子分类数量 */
  childCount: number
  /** 父分类名，顶级为空 */
  parentName: string
}

function buildRows(
  nodes: CategoryVO[],
  depth: number,
  parentName: string,
  out: FlatRow[],
): FlatRow[] {
  const siblings = nodes.filter(Boolean)
  siblings.forEach((node, index) => {
    const children = node.children ?? []
    out.push({
      node,
      depth,
      index,
      siblingCount: siblings.length,
      childCount: children.length,
      parentName,
    })
    // 折叠的节点不往下展开
    if (children.length && !isCollapsed(node.id)) {
      buildRows(children, depth + 1, node.name, out)
    }
  })
  return out
}

const rows = computed(() => buildRows(tree.value, 0, '', []))

/** 概览统计，全部由已有的树数据算出，不额外打接口 */
const stats = computed(() => {
  let total = 0
  let maxDepth = 0
  const walk = (nodes: CategoryVO[], depth: number) => {
    for (const node of nodes) {
      total += 1
      if (depth > maxDepth) maxDepth = depth
      walk(node.children ?? [], depth + 1)
    }
  }
  walk(tree.value, 1)
  return { total, top: tree.value.length, maxDepth }
})

/** 定位节点及其所在兄弟数组，供排序交换使用 */
interface Located {
  node: CategoryVO
  siblings: CategoryVO[]
  index: number
}

function locate(nodes: CategoryVO[], id: number): Located | null {
  const siblings = nodes.filter(Boolean)
  for (let i = 0; i < siblings.length; i += 1) {
    const node = siblings[i]
    if (!node) continue
    if (node.id === id) return { node, siblings, index: i }
    const found = locate(node.children ?? [], id)
    if (found) return found
  }
  return null
}

/* ==================== 弹窗表单 ==================== */

const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  id: 0,
  name: '',
  parentId: ROOT_PARENT_ID,
  sort: 0,
})

const rules: FormRules = {
  name: [
    { required: true, message: '请输入分类名称', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        if (!value || !value.trim()) callback(new Error('分类名称不能只有空格'))
        else callback()
      },
      trigger: 'blur',
    },
  ],
}

const dialogTitle = computed(() => (dialogMode.value === 'create' ? '新建分类' : '重命名分类'))

/** 父分类下拉：顶级 + 整棵树（带缩进），新建时可任选 */
const parentOptions = computed(() => {
  const out: Array<{ id: number; label: string; depth: number }> = [
    { id: ROOT_PARENT_ID, label: '顶级分类', depth: 0 },
  ]
  const walk = (nodes: CategoryVO[], depth: number) => {
    for (const node of nodes) {
      out.push({ id: node.id, label: node.name, depth })
      walk(node.children ?? [], depth + 1)
    }
  }
  walk(tree.value, 1)
  return out
})

/** 编辑时的父分类名称，只读展示 */
const editingParentName = computed(() => {
  const loc = locate(tree.value, form.id)
  if (!loc) return '—'
  for (const row of rows.value) {
    if (row.node.id === form.id) return row.parentName || '顶级分类'
  }
  return '顶级分类'
})

function resetForm() {
  form.id = 0
  form.name = ''
  form.parentId = ROOT_PARENT_ID
  form.sort = 0
  formRef.value?.clearValidate()
}

/** 新建：parent 为 null 表示顶级，传节点表示在该分类下新建子分类 */
function openCreate(parent: CategoryVO | null) {
  dialogMode.value = 'create'
  resetForm()
  form.parentId = parent ? parent.id : ROOT_PARENT_ID
  // 新分类默认排在同级最前，省得用户每次手动改
  form.sort = parent ? (parent.children?.length ?? 0) + 1 : tree.value.length + 1
  // 若在折叠的分类下新建，先把父分类展开，否则建完看不见
  if (parent && isCollapsed(parent.id)) toggleCollapse(parent.id)
  dialogVisible.value = true
}

function openEdit(node: CategoryVO) {
  dialogMode.value = 'edit'
  resetForm()
  form.id = node.id
  form.name = node.name
  form.sort = node.sort
  dialogVisible.value = true
}

async function submitForm() {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch {
    return // 校验未通过
  }

  const name = form.name.trim()
  submitting.value = true
  try {
    if (dialogMode.value === 'create') {
      await createCategory({ name, parentId: form.parentId, sort: form.sort })
      ElMessage.success('分类已创建')
    } else {
      await updateCategory(form.id, { name, sort: form.sort })
      ElMessage.success('分类已更新')
    }
    dialogVisible.value = false
    await loadTree()
  } catch {
    // 失败提示由请求层负责（约定 D）：后端 message 更具体（同名分类、层级过深等）
  } finally {
    submitting.value = false
  }
}

/* ==================== 排序 / 删除 ==================== */

/** 调整顺序：sort 值越大越靠前，所以上移 = 比前一个兄弟更大 */
async function moveCategory(node: CategoryVO, dir: 'up' | 'down') {
  if (pendingId.value !== null) return

  const loc = locate(tree.value, node.id)
  if (!loc) return

  const target = loc.siblings[dir === 'up' ? loc.index - 1 : loc.index + 1]
  if (!target) return

  const nextSort = dir === 'up' ? target.sort + 1 : target.sort - 1

  pendingId.value = node.id
  try {
    await updateCategory(node.id, { sort: nextSort })
    await loadTree()
  } catch {
    // 提示由请求层负责（约定 D）
  } finally {
    pendingId.value = null
  }
}

async function handleDelete(row: FlatRow) {
  const { node, childCount } = row

  const lines = [
    `确定删除分类「${node.name}」吗？`,
    '',
    '该分类下的笔记不会被删除，但它们的分类会被置空（变为未分类）。',
  ]
  if (childCount > 0) {
    lines.push(
      '',
      `注意：该分类下还有 ${childCount} 个子分类。接口文档未说明删除父分类时子分类如何处理，请确认后端行为后再操作。`,
    )
  }

  try {
    await ElMessageBox.confirm(lines.join('\n'), '删除分类', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }

  pendingId.value = node.id
  try {
    await deleteCategory(node.id)
    ElMessage.success('分类已删除')
    await loadTree()
  } catch {
    // 提示由请求层负责（约定 D）
  } finally {
    pendingId.value = null
  }
}

/* ==================== 跳转 ==================== */

function goNotes() {
  void router.push({ name: RouteName.NOTE_LIST })
}

/** 查看该分类下的笔记：直接复用知识库列表的 URL 筛选 */
function goNotesOf(id: number) {
  void router.push({ name: RouteName.NOTE_LIST, query: { categoryId: String(id) } })
}

/* ==================== 初始化 ==================== */

void loadTree()
</script>

<template>
  <div class="cm-container cm-categories">
    <!-- ==================== 页头 ==================== -->
    <header class="cm-categories__head">
      <div class="cm-categories__head-text">
        <h1 class="cm-categories__title">分类管理</h1>
        <p class="cm-categories__subtitle">
          用分类整理笔记，支持多级嵌套。排序值越大越靠前。
        </p>
      </div>

      <div class="cm-categories__head-actions">
        <el-button @click="goNotes">
          <el-icon><Back /></el-icon>
          返回知识库
        </el-button>
        <el-button type="primary" :disabled="loading || error" @click="openCreate(null)">
          <el-icon><FolderAdd /></el-icon>
          新建分类
        </el-button>
      </div>
    </header>

    <div class="cm-categories__grid">
      <!-- ==================== 左：分类树 ==================== -->
      <main class="cm-categories__main">
        <LoadingState v-if="loading" variant="skeleton" :rows="6" />

        <ErrorState
          v-else-if="error"
          title="分类加载失败"
          description="可能是网络问题，或后端服务未启动"
          @retry="loadTree"
        />

        <EmptyState
          v-else-if="!rows.length"
          title="还没有分类"
          description="建几个分类，笔记就不会散落一地了"
          :size="80"
        >
          <el-button type="primary" plain size="small" @click="openCreate(null)">
            新建第一个分类
          </el-button>
        </EmptyState>

        <ul v-else class="cm-categories__tree">
          <li
            v-for="row in rows"
            :key="row.node.id"
            class="cm-categories__row"
            :class="{ 'is-pending': pendingId === row.node.id }"
            :style="{ paddingLeft: `${row.depth * 22 + 8}px` }"
          >
            <!-- 折叠箭头 / 占位 -->
            <button
              v-if="row.childCount > 0"
              type="button"
              class="cm-categories__toggle"
              :title="isCollapsed(row.node.id) ? '展开' : '收起'"
              @click="toggleCollapse(row.node.id)"
            >
              <el-icon :size="12">
                <component :is="isCollapsed(row.node.id) ? 'CaretRight' : 'CaretBottom'" />
              </el-icon>
            </button>
            <span v-else class="cm-categories__toggle cm-categories__toggle--leaf"></span>

            <el-icon class="cm-categories__icon" :size="14">
              <component :is="row.depth === 0 ? 'FolderOpened' : 'Folder'" />
            </el-icon>

            <button
              type="button"
              class="cm-categories__name"
              :title="`查看「${row.node.name}」下的笔记`"
              @click="goNotesOf(row.node.id)"
            >
              {{ row.node.name }}
            </button>

            <span class="cm-categories__meta">
              <span class="cm-categories__sort">排序 {{ row.node.sort }}</span>
              <span v-if="row.childCount" class="cm-categories__children">
                {{ row.childCount }} 个子分类
              </span>
            </span>

            <div class="cm-categories__ops">
              <button
                type="button"
                class="cm-categories__op cm-categories__op--icon"
                title="上移"
                :disabled="row.index === 0 || pendingId !== null"
                @click="moveCategory(row.node, 'up')"
              >
                <el-icon :size="13"><ArrowUp /></el-icon>
              </button>

              <button
                type="button"
                class="cm-categories__op cm-categories__op--icon"
                title="下移"
                :disabled="row.index === row.siblingCount - 1 || pendingId !== null"
                @click="moveCategory(row.node, 'down')"
              >
                <el-icon :size="13"><ArrowDown /></el-icon>
              </button>

              <button
                type="button"
                class="cm-categories__op"
                :disabled="pendingId !== null"
                @click="openCreate(row.node)"
              >
                <el-icon :size="13"><Plus /></el-icon>
                子分类
              </button>

              <button
                type="button"
                class="cm-categories__op"
                :disabled="pendingId !== null"
                @click="openEdit(row.node)"
              >
                <el-icon :size="13"><EditPen /></el-icon>
                重命名
              </button>

              <button
                type="button"
                class="cm-categories__op cm-categories__op--danger"
                :disabled="pendingId !== null"
                @click="handleDelete(row)"
              >
                <el-icon :size="13"><Delete /></el-icon>
                删除
              </button>
            </div>
          </li>
        </ul>
      </main>

      <!-- ==================== 右：概览与说明 ==================== -->
      <aside class="cm-categories__side">
        <div class="cm-panel cm-categories__panel">
          <h2 class="cm-categories__panel-title">概览</h2>
          <dl class="cm-categories__stats">
            <div class="cm-categories__stat">
              <dt>分类总数</dt>
              <dd>{{ stats.total }}</dd>
            </div>
            <div class="cm-categories__stat">
              <dt>顶级分类</dt>
              <dd>{{ stats.top }}</dd>
            </div>
            <div class="cm-categories__stat">
              <dt>最大层级</dt>
              <dd>{{ stats.maxDepth }}</dd>
            </div>
          </dl>
        </div>

        <div class="cm-panel cm-categories__panel">
          <h2 class="cm-categories__panel-title">说明</h2>
          <ul class="cm-categories__tips">
            <li>删除分类不会删除笔记，笔记的分类会被置空。</li>
            <li>排序值越大越靠前，同级之间才比较。</li>
            <li>修改分类接口只支持改名称与排序，暂不支持更换父分类。</li>
          </ul>
        </div>
      </aside>
    </div>

    <!-- ==================== 新建 / 重命名弹窗 ==================== -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="440px"
      :close-on-click-modal="false"
      append-to-body
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="76px" @submit.prevent>
        <el-form-item label="名称" prop="name">
          <el-input
            v-model="form.name"
            placeholder="例如：Spring、Redis 源码"
            maxlength="40"
            show-word-limit
            @keyup.enter="submitForm"
          />
        </el-form-item>

        <el-form-item v-if="dialogMode === 'create'" label="父分类">
          <el-select v-model="form.parentId" class="cm-categories__select" placeholder="选择父分类">
            <el-option
              v-for="opt in parentOptions"
              :key="opt.id"
              :label="opt.label"
              :value="opt.id"
            >
              <span :style="{ paddingLeft: `${(opt.depth - 1) * 12}px` }">{{ opt.label }}</span>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item v-else label="父分类">
          <div class="cm-categories__readonly">
            <span>{{ editingParentName }}</span>
            <span class="cm-categories__readonly-hint">接口不支持修改父分类</span>
          </div>
        </el-form-item>

        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="-999" :max="999" :step="1" />
          <span class="cm-categories__hint">值越大越靠前</span>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button :disabled="submitting" @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ dialogMode === 'create' ? '创建' : '保存' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cm-categories {
  padding-top: var(--cm-space-10);
  padding-bottom: var(--cm-space-16);
}

/* ==================== 页头 ==================== */
.cm-categories__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--cm-space-6);
  padding-bottom: var(--cm-space-5);
}

.cm-categories__title {
  margin: 0;
  font-size: var(--cm-font-size-2xl);
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--cm-text-primary);
}

.cm-categories__subtitle {
  margin: var(--cm-space-2) 0 0;
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-tertiary);
}

.cm-categories__head-actions {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  flex-shrink: 0;
}

/* ==================== 栅格 ==================== */
.cm-categories__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 232px;
  gap: var(--cm-space-10);
  align-items: start;
}

.cm-categories__main {
  min-width: 0;
}

.cm-categories__side {
  display: flex;
  flex-direction: column;
  gap: var(--cm-space-4);
  min-width: 0;
  position: sticky;
  top: calc(var(--cm-header-height) + var(--cm-space-6));
}

/* ==================== 树 ==================== */
.cm-categories__tree {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--cm-border-default);
  border-radius: var(--cm-radius-lg);
  background-color: var(--cm-bg-surface);
  overflow: hidden;
}

.cm-categories__row {
  display: flex;
  align-items: center;
  gap: var(--cm-space-2);
  padding-top: 9px;
  padding-bottom: 9px;
  padding-right: var(--cm-space-4);
  border-bottom: 1px solid var(--cm-border-subtle);
  transition: background-color 0.15s ease;
}

.cm-categories__row:last-child {
  border-bottom: none;
}

.cm-categories__row:hover {
  background-color: var(--cm-bg-hover);
}

.cm-categories__row.is-pending {
  opacity: 0.55;
}

.cm-categories__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  padding: 0;
  color: var(--cm-text-quaternary);
  background: none;
  border: none;
  border-radius: var(--cm-radius-xs);
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-categories__toggle:hover {
  color: var(--cm-text-secondary);
}

.cm-categories__toggle--leaf {
  cursor: default;
}

.cm-categories__icon {
  flex-shrink: 0;
  color: var(--cm-text-quaternary);
}

.cm-categories__name {
  flex-shrink: 0;
  max-width: 260px;
  padding: 0;
  overflow: hidden;
  font-family: inherit;
  font-size: var(--cm-font-size-sm);
  font-weight: 500;
  color: var(--cm-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-categories__name:hover {
  color: var(--cm-accent-600);
}

.cm-categories__meta {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  flex: 1;
  min-width: 0;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-categories__children {
  white-space: nowrap;
}

.cm-categories__ops {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  flex-shrink: 0;
}

.cm-categories__op {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  font-family: inherit;
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s ease;
}

.cm-categories__op--icon {
  padding: 2px;
}

.cm-categories__op:hover:not(:disabled) {
  color: var(--cm-accent-600);
}

.cm-categories__op:disabled {
  opacity: 0.35;
  cursor: default;
}

.cm-categories__op--danger:hover:not(:disabled) {
  color: var(--cm-danger);
}

/* ==================== 侧栏 ==================== */
.cm-categories__panel {
  padding: var(--cm-space-4) var(--cm-space-4) var(--cm-space-5);
}

.cm-categories__panel-title {
  margin: 0 0 var(--cm-space-3);
  font-size: var(--cm-font-size-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--cm-text-secondary);
}

.cm-categories__stats {
  margin: 0;
}

.cm-categories__stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 5px 0;
  font-size: var(--cm-font-size-sm);
}

.cm-categories__stat + .cm-categories__stat {
  border-top: 1px dashed var(--cm-border-subtle);
}

.cm-categories__stat dt {
  color: var(--cm-text-tertiary);
}

.cm-categories__stat dd {
  margin: 0;
  font-family: var(--cm-font-mono);
  font-weight: 600;
  color: var(--cm-text-primary);
}

.cm-categories__tips {
  margin: 0;
  padding-left: 1.1em;
  font-size: var(--cm-font-size-xs);
  line-height: var(--cm-line-height-relaxed);
  color: var(--cm-text-tertiary);
}

.cm-categories__tips li + li {
  margin-top: 6px;
}

/* ==================== 弹窗内元素 ==================== */
.cm-categories__select {
  width: 100%;
}

.cm-categories__readonly {
  display: flex;
  align-items: center;
  gap: var(--cm-space-3);
  font-size: var(--cm-font-size-sm);
  color: var(--cm-text-secondary);
}

.cm-categories__readonly-hint {
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

.cm-categories__hint {
  margin-left: var(--cm-space-3);
  font-size: var(--cm-font-size-xs);
  color: var(--cm-text-quaternary);
}

/* ==================== 响应式 ==================== */
@media (max-width: 1024px) {
  .cm-categories__grid {
    grid-template-columns: minmax(0, 1fr) 200px;
    gap: var(--cm-space-8);
  }

  .cm-categories__name {
    max-width: 180px;
  }
}

@media (max-width: 860px) {
  .cm-categories__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cm-space-8);
  }

  .cm-categories__side {
    position: static;
    order: 2;
    flex-direction: row;
    flex-wrap: wrap;
  }

  .cm-categories__side > * {
    flex: 1 1 220px;
  }

  .cm-categories__main {
    order: 1;
  }

  .cm-categories__row {
    flex-wrap: wrap;
  }

  .cm-categories__meta {
    flex-basis: auto;
  }
}

@media (max-width: 560px) {
  .cm-categories__head {
    flex-direction: column;
    align-items: stretch;
  }

  .cm-categories__name {
    max-width: 120px;
  }

  .cm-categories__ops {
    flex-basis: 100%;
    padding-left: 44px;
  }
}
</style>
