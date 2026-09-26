/**
 * API 统一出口
 *
 * 使用建议：
 *   import { getArticleList, likeArticle } from '@/api'
 * 或按域引入：
 *   import * as articleApi from '@/api/article'
 *
 * 注意：AI 流式接口不在 './ai' 中，而在 './aiStream'，
 * 因为它使用 fetch + ReadableStream 而非 axios，签名不同，不应混用。
 */

export * from './request'
export * from './user'
export * from './article'
export * from './note'
export * from './category'
export * from './notify'
export * from './ai'
export * from './aiStream'
