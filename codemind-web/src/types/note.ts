/**
 * 个人知识库（笔记）模块类型
 * 对应 API 文档 v1.2 第二章。
 */
import type { ID, ContentStatus, Visibility } from './common'
import type { UserSimpleVO } from './user'
import type { CategoryVO, TagVO } from './category'

/** 笔记所属分类（详情页精简结构，无 children） */
export interface NoteCategoryVO {
  id: ID
  name: string
}

/**
 * 笔记列表项（2.5 GET /api/note/list 的 records 元素）
 * 注意：此处分类以 `categoryName` 字符串形式返回，而非对象。
 */
export interface NoteListItemVO {
  id: ID
  title: string
  summary: string
  cover: string
  visibility: Visibility
  status: ContentStatus
  wordCount: number
  categoryName: string | null
  tags: TagVO[]
  createTime: string
  updateTime: string
}

/** 笔记详情（2.4 GET /api/note/{noteId}） */
export interface NoteDetailVO {
  id: ID
  /** 详情中分类为对象结构 */
  user: UserSimpleVO
  title: string
  /** Markdown 原文 */
  content: string
  summary: string
  cover: string
  category: NoteCategoryVO | null
  tags: TagVO[]
  visibility: Visibility
  status: ContentStatus
  wordCount: number
  createTime: string
  updateTime: string
}

/**
 * 笔记创建参数
 * 该接口使用 multipart/form-data，因此这里描述的是「FormData 的语义字段」，
 * 真正的组装逻辑在 api/note.ts 中完成。
 */
export interface CreateNoteParams {
  title: string
  content: string
  categoryId: ID
  /** 封面图片文件，不传则无封面 */
  file?: File | null
  summary?: string
  visibility?: Visibility
  status?: ContentStatus
  tagIds?: ID[]
}

/** 笔记编辑参数（全字段可选；file 不传则保留原封面；tagIds 不传则清空标签） */
export interface UpdateNoteParams {
  title?: string
  content?: string
  /** 文档标注为必填 */
  categoryId: ID
  file?: File | null
  summary?: string
  visibility?: Visibility
  status?: ContentStatus
  tagIds?: ID[]
}

/** 2.5 我的笔记列表查询参数 */
export interface NoteListQuery {
  page?: number
  size?: number
  categoryId?: ID
  visibility?: Visibility
  status?: ContentStatus
  /** 标题关键词模糊匹配 */
  keyword?: string
}

/** 2.6 切换公开/私密 */
export interface UpdateNoteVisibilityParams {
  visibility: Visibility
}

export type { CategoryVO }
