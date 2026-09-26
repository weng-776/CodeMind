/**
 * token 存取。单独抽出来是为了让 `api/request.ts` 不依赖 Pinia
 * （否则会循环依赖：store 用 api，api 又读 store）。
 */
const TOKEN_KEY = 'codemind_token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    // localStorage 在隐私模式或禁用 Cookie 时可能抛错
    return null
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* 忽略写入失败 */
  }
}

export function removeToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 忽略移除失败 */
  }
}

/* ==================== 统一认证头构造 ==================== */

/**
 * 构造带认证的请求头（axios 与 fetch/流式共用这一份实现）。
 *
 * ⚠️ 后端 `CodeMindInterceptor` 读的是 `request.getHeader("token")` ——
 * 只发 `Authorization: Bearer` 会让所有需登录接口返回 401
 * （T0 实测 2026-09-23：`POST /api/ai/articles/14/summary` 只发 Authorization → HTTP 401）。
 * 所以 `token` 必须有；`Authorization` 一并带上，兼容按旧文档实现的网关/后续后端改动。
 *
 * 没有 token 时不加任何认证头（游客身份），由调用方按 401 分流规则处理。
 */
export function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  const token = getToken()
  if (token) {
    headers.token = token
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/* ==================== 从 token 解析用户 id ==================== */

/** base64url → 原始字符串（JWT payload 用 base64url 编码，且可能含中文） */
function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * 从 JWT 的 payload 里取后端写入的 `userId`。
 *
 * 为什么需要它：
 *   API 文档 1.4 说 `GET /api/user/info` 会返回 `id`，但真实后端的
 *   `UserDataVO` **没有 id 字段**（联调实测 2026-09-16）。而前端判断
 *   「这篇文章/笔记是不是我自己发的」必须拿到当前用户 id，
 *   否则作者本人永远看不到「编辑 / 删除」入口。
 *
 *   后端签发 token 时写了 `claim("userId", userId)`（见 JwtHelper.createToken），
 *   所以这里直接解 payload 兜底，不需要改后端。
 *
 * 只做 base64url 解码，不验签：签名校验是后端的事，
 * 前端拿它仅用于 UI 上的「我 / 不是我的」判断，不构成安全边界。
 */
export function getUserIdFromJwt(token: string | null): number | null {
  if (!token) return null
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as { userId?: unknown }
    const id = Number(claims.userId)
    return Number.isFinite(id) ? id : null
  } catch {
    return null
  }
}
