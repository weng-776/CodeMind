/**
 * 分类与标签模块 API（API 文档 v1.2 第 2.7 - 2.12 节）
 */
import { http } from './request'
import type { CategoryVO } from '@/types/category'
import type { CreateCategoryParams, UpdateCategoryParams } from '@/types/category'

/**
 * 2.7 创建分类（需认证，支持多级）
 * 路径以文档正文为准：`POST /api/category/createCategory`
 * （文档 v1.2 更新后，正文已修正为完整路径）
 */
export function createCategory(data: CreateCategoryParams) {
  return http.post<{ id: number }>('/category/createCategory', data)
}

/** 2.8 修改分类（需认证） */
export function updateCategory(categoryId: number, data: UpdateCategoryParams) {
  return http.put<null>(`/category/${categoryId}`, data)
}

/** 2.9 删除分类（需认证，逻辑删除，该分类下笔记分类置 null） */
export function deleteCategory(categoryId: number) {
  return http.delete<null>(`/category/${categoryId}`)
}

/** 2.10 分类树查询（需认证） */
export function getCategoryTree() {
  return http.get<CategoryVO[]>('/category/tree')
}

/*
 * 2.11「为笔记关联标签」只在 `api/note.ts` 保留一份（`addNoteTags → POST /note/{id}/tag`）。
 * 这里曾重复导出 `addTagsToNote`，与 note.ts 的实现指向同一接口，已收敛（T6），
 * 避免「同一件事两份实现」。
 *
 * 关于 2.12「标签列表查询 GET /api/tag/list」：
 *   旧结论「已彻底移除、不要再加回来」**已作废**（2026-09-23 复核）——
 *   TagController 于 2026-09-17 新增，实测可用：需登录、无分页、可选 keyword，
 *   返回 `[{ id, name, createTime }]`。
 *   前端入口在 `api/article.ts` 的 `getTagList`（文章编辑器用它做标签候选集）。
 *   注意它**需要登录**，所以公开页面（社区列表、详情页）仍然不依赖它。
 */
