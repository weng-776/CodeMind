/**
 * 收藏模块 API
 * 收藏接口在文档中归属社区模块（3.10 / 3.11）与用户模块（3.12 路径属于 user），
 * 为便于按业务域引入，这里做一层语义化再导出。
 */
export { favoriteArticle, unfavoriteArticle } from './article'
export { getMyFavorites } from './user'
