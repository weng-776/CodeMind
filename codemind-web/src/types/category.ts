/**
 * 分类与标签类型
 * 对应 API 文档 v1.2 第 2.7 - 2.12 节。
 */
import type { ID } from './common'

/** 标签（公共标签，所有用户共享） */
export interface TagVO {
  id: ID
  name: string
  createTime?: string
}

/** 分类树节点（2.10 GET /api/category/tree） */
export interface CategoryVO {
  id: ID
  name: string
  sort: number
  children: CategoryVO[]
}

/* ==================== 请求参数 ==================== */

/** 2.7 创建分类 */
export interface CreateCategoryParams {
  name: string
  /** 父分类 ID，默认 0 表示顶级 */
  parentId?: ID
  /** 排序，值越大越靠前，默认 0 */
  sort?: number
}

/** 2.8 修改分类 */
export interface UpdateCategoryParams {
  name?: string
  sort?: number
}

/** 2.11 为笔记批量关联标签（替换已有） */
export interface AddNoteTagParams {
  tagIds: ID[]
}
