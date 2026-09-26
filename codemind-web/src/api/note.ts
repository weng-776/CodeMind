/**
 * 个人知识库（笔记）模块 API（API 文档 v1.2 第二章）
 *
 * 重要差异：
 *   - 创建 / 编辑笔记使用 multipart/form-data，不是 JSON（2.1 / 2.2）
 *   - 多个 tagIds 需要在 FormData 中重复 append 同名字段
 *   - 不要手动设置 Content-Type，浏览器会自动生成 multipart boundary
 *   - 编辑时 file 不传 = 保留原封面；tagIds 不传 = 清空全部标签
 *   - **2.11「为笔记添加标签」是 JSON，不是 multipart**（见 addNoteTags），
 *     与 2.1 / 2.2 的 tagIds 字段是两条独立通道，不要混用
 *
 * 返回体形状（2026-09-23 对真实后端 curl 实测，与文档一致）：
 *   - 2.1 createNote → `data` 是**新建笔记 id 的裸数字**（如 `{"data":83}`），不是对象
 *   - 2.2 updateNote → `data` 是 `true`（boolean）
 *   - 2.4 getNoteDetail → `data` 是对象
 */
import { http } from './request'
import type { PageResult } from '@/types/common'
import type {
  CreateNoteParams,
  NoteDetailVO,
  NoteListItemVO,
  NoteListQuery,
  UpdateNoteParams,
  UpdateNoteVisibilityParams,
} from '@/types/note'

/** 把笔记表单参数组装成 FormData */
function buildNoteFormData(
  params: CreateNoteParams | UpdateNoteParams,
): FormData {
  const fd = new FormData()

  if (params.title !== undefined) fd.append('title', params.title)
  if (params.content !== undefined) fd.append('content', params.content)
  if (params.categoryId !== undefined) fd.append('categoryId', String(params.categoryId))
  if (params.summary !== undefined) fd.append('summary', params.summary)
  if (params.visibility !== undefined) fd.append('visibility', String(params.visibility))
  if (params.status !== undefined) fd.append('status', String(params.status))

  // 多个标签必须重复 append 同名字段，不能传数组
  if (params.tagIds && params.tagIds.length > 0) {
    params.tagIds.forEach((id) => fd.append('tagIds', String(id)))
  }

  // 封面：仅在选择了新文件时才追加；不追加即保留原封面
  if (params.file) {
    fd.append('file', params.file)
  }

  return fd
}

/**
 * 2.1 创建笔记（multipart/form-data，需认证）
 *
 * ⚠️ 返回值是**新建笔记 id 的裸数字**（文档明说「不是对象」，实测 `data: 83`）。
 * 早期这里写成 `{ id: number }`，调用方 `res.id` 恒为 `undefined`，
 * 结果「创建笔记后跳到新笔记详情」这条路径**从来没走通过**，只会退回列表。
 */
export function createNote(params: CreateNoteParams) {
  return http.post<number>('/note/createNote', buildNoteFormData(params))
}

/** 2.2 编辑笔记（multipart/form-data，需认证）。`data` 是 `true`（boolean） */
export function updateNote(noteId: number, params: UpdateNoteParams) {
  return http.put<boolean>(`/note/${noteId}`, buildNoteFormData(params))
}

/** 2.3 删除笔记（需认证，逻辑删除） */
export function deleteNote(noteId: number) {
  return http.delete<null>(`/note/${noteId}`)
}

/** 2.4 查看笔记详情（认证可选，私密笔记仅作者可见） */
export function getNoteDetail(noteId: number) {
  return http.get<NoteDetailVO>(`/note/${noteId}`)
}

/** 2.5 我的笔记列表（需认证，支持分类/可见性/状态/关键词筛选） */
export function getMyNotes(params?: NoteListQuery) {
  return http.get<PageResult<NoteListItemVO>>('/note/list', params as Record<string, unknown>)
}

/** 2.6 切换笔记公开/私密（需认证） */
export function updateNoteVisibility(noteId: number, data: UpdateNoteVisibilityParams) {
  return http.put<null>(`/note/${noteId}/visibility`, data)
}

/**
 * 2.11 为笔记批量关联标签（需认证，替换语义：先清空再写入）
 *
 * **请求体是 JSON，不是 multipart**（05 §3.3 末尾专门提醒过这一点）。
 * 注意它和 2.1 / 2.2 里那个同名的 `tagIds` 表单字段是两条独立通道：
 * 编辑器走的是 multipart 的 `tagIds`（随整体覆盖语义一起提交），
 * 本方法只在「单独改标签、不动其它字段」时才有意义 —— 当前页面没有这种入口，
 * 所以它暂时没有被调用；保留是为了让 2.11 在 API 层有唯一且正确的落点。
 */
export function addNoteTags(noteId: number, tagIds: number[]) {
  return http.post<null>(`/note/${noteId}/tag`, { tagIds })
}
