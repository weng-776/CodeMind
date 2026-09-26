/**
 * 统一请求层：附加认证头 → 解包 { code, message, data } → 失败抛 ApiError。
 * 页面层不再出现 response.data.code / response.data.data 这类解析。
 */
import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { ElMessage } from 'element-plus'

import type { ApiResult } from '@/types/common'
import { buildAuthHeaders, getToken, removeToken } from '@/utils/auth'

/** 业务成功码 */
const SUCCESS_CODE = 200

/**
 * 传输层失败（断网、后端没起、超时）统一用的错误码。
 * 取负值是为了不与任何 HTTP 状态码或业务 code 撞车。
 */
export const NETWORK_ERROR_CODE = -1

/**
 * 请求层统一抛出的错误对象。
 *
 * 为什么需要它：业务失败的信息在响应体的 `code` 里（传输层统一 HTTP 200），
 * 页面想按「失败种类」分支时，过去只能拿 `error.message` 做文本比对 ——
 * 后端一改文案就失效。现在把 code 透出来，页面按 `code` 判断即可。
 *
 * 取值：业务失败 = 响应体的 `code`；传输层失败 = HTTP 状态码；
 *       连响应都没有 = `NETWORK_ERROR_CODE`。
 */
export class ApiError extends Error {
  readonly code: number
  /** 原始 AxiosError 或响应体，仅用于排查，页面一般不需要 */
  readonly origin?: unknown

  constructor(message: string, code: number, origin?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.origin = origin
  }
}

/** 后端地址：默认 /api，由 Vite dev server 代理到真实后端 */
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

/** 跳转登录页的回调，由 router 注入，避免 request 层直接依赖 router */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

/** 避免 401 时并发请求弹出一堆重复提示 / 重复跳转 */
let isHandlingUnauthorized = false

/**
 * 401 统一处理。必须区分两种情况：
 *   - 本次请求带了 token 却仍 401 → 确实失效 → 清 token + 提示 + 跳登录；
 *   - 本次本来就没带 token → 只是该接口要求登录 → **什么都不做**，
 *     否则游客打开「认证可选」的页面会被莫名弹到登录页。
 *
 * @returns 是否按「登录态失效」处理了
 */
function handleUnauthorized(hadToken: boolean, serverMessage?: string): boolean {
  if (!hadToken) return false
  if (isHandlingUnauthorized) return true
  isHandlingUnauthorized = true

  removeToken()
  ElMessage.error(serverMessage || '登录状态已失效，请重新登录')
  onUnauthorized?.()

  // 留出跳转时间后复位，保证后续再次失效仍能触发
  setTimeout(() => {
    isHandlingUnauthorized = false
  }, 1000)

  return true
}

/**
 * 供**非 axios 链路**复用的 401 处理入口。
 *
 * AI 流式请求走原生 `fetch`，不经过 axios 拦截器，拿不到上面那套
 * 「清 token + 提示 + 跳登录 + 防重入」。这个函数把那一环补上。
 *
 * ⚠️ 别拿 `setUnauthorizedHandler` 当触发用 —— 那个只是**注册** handler，
 * 触发必须走这里。
 */
export function triggerUnauthorized(): void {
  handleUnauthorized(true)
}

const service: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  headers: {
    'Content-Type': 'application/json',
  },
})

/**
 * 请求配置上的私有标记：本次请求是否真的带了 token。
 * 用于把「登录态失效」和「该接口本来就要登录」区分开（见 401 处理）。
 */
type TrackedConfig = InternalAxiosRequestConfig & { __hadToken?: boolean }

/* ==================== 请求拦截 ==================== */
service.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getToken()
    if (token) {
      /*
       * ⚠️ 后端读的是请求头 `token`，**不是** `Authorization`（与 API 文档旧版不一致）。
       * 只发 Authorization 的话，所有需登录接口都会 401。
       * 统一走 utils/auth 的 buildAuthHeaders，与 AI 流式 fetch 共用一份实现。
       */
      const authHeaders = buildAuthHeaders()
      config.headers.token = authHeaders.token
      config.headers.Authorization = authHeaders.Authorization
      ;(config as TrackedConfig).__hadToken = true
    }

    // FormData 必须让浏览器自行生成 multipart boundary，
    // 因此这里删掉默认的 Content-Type，交给 axios/browser 处理。
    if (config.data instanceof FormData) {
      delete config.headers['Content-Type']
    }

    return config
  },
  (error: unknown) => Promise.reject(error),
)

/* ==================== 响应拦截 ==================== */
service.interceptors.response.use(
  (response: AxiosResponse<ApiResult>) => {
    const res = response.data

    // 后端约定所有接口返回 { code, message, data }。
    // 个别场景可能直接返回裸数据（如某些静态资源），这里做兼容。
    if (res === null || typeof res !== 'object' || !('code' in res)) {
      return response.data as never
    }

    if (res.code === SUCCESS_CODE) {
      // 直接解包，调用方拿到的是 data 本身
      return res.data as never
    }

    // 业务层面未登录（HTTP 200 + code 401 的写法，部分接口可能这样返回）
    if (res.code === 401) {
      const hadToken = Boolean((response.config as TrackedConfig).__hadToken)
      /*
       * 401 的提示职责：
       *   带了 token → 登录态失效，**请求层负责**提示 + 跳登录；
       *   没带 token → 只是该接口要登录，请求层**刻意不弹**，
       *               需要交代的页面（如登录页的「密码错误」）自己按 code 判断后再弹。
       */
      handleUnauthorized(hadToken, res.message)
      return Promise.reject(new ApiError(res.message || '该操作需要登录后再试', res.code, res))
    }

    const msg = res.message || '请求失败'
    ElMessage.error(msg)
    return Promise.reject(new ApiError(msg, res.code, res))
  },
  (error: unknown) => {
    // 网络层错误：无响应、超时、或 HTTP 状态码非 2xx
    if (axios.isAxiosError(error)) {
      // 主动取消的请求不提示，也**刻意不包成 ApiError** ——
      // 取消是控制流信号，调用方要靠 axios.isCancel(err) 认出它，包一层就认不出了。
      if (axios.isCancel(error)) {
        return Promise.reject(error)
      }

      const status = error.response?.status
      if (status === 401) {
        /*
         * 真实后端的 401 走这条分支：拦截器会 setStatus(401) 并写回
         * {"code":401,"message":"登陆过期请重新登陆"}，所以 axios 直接 reject。
         */
        const cfg = error.config as TrackedConfig | undefined
        const serverMessage = (error.response?.data as { message?: string } | undefined)?.message
        handleUnauthorized(Boolean(cfg?.__hadToken), serverMessage)
        return Promise.reject(
          new ApiError(serverMessage || '登陆过期请重新登陆', status, error),
        )
      }

      let msg: string
      if (error.code === 'ECONNABORTED') {
        msg = '请求超时，请稍后重试'
      } else if (!error.response) {
        msg = '网络异常，无法连接服务器'
      } else if (status === 403) {
        msg = '没有权限执行该操作'
      } else if (status === 404) {
        msg = '请求的资源不存在'
      } else if (status && status >= 500) {
        msg = '服务器开小差了，请稍后重试'
      } else {
        msg = error.message || '请求失败'
      }

      ElMessage.error(msg)
      // 无响应（断网 / 后端没起 / 超时）→ NETWORK_ERROR_CODE；有响应 → HTTP 状态码
      return Promise.reject(new ApiError(msg, status ?? NETWORK_ERROR_CODE, error))
    }

    ElMessage.error('未知错误，请稍后重试')
    return Promise.reject(new ApiError('未知错误，请稍后重试', NETWORK_ERROR_CODE, error))
  },
)

/**
 * 对外暴露的请求方法。泛型 T 是「解包后 data 的类型」，不是 axios 原始响应类型。
 * axios 的类型定义感知不到拦截器已经解包，所以这里需要一次显式断言。
 */
export function request<T = unknown>(config: AxiosRequestConfig): Promise<T> {
  return service.request(config) as unknown as Promise<T>
}

export const http = {
  get<T = unknown>(url: string, params?: Record<string, unknown>, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'GET', url, params })
  },

  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'POST', url, data })
  },

  put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'PUT', url, data })
  },

  delete<T = unknown>(url: string, params?: Record<string, unknown>, config?: AxiosRequestConfig) {
    return request<T>({ ...config, method: 'DELETE', url, params })
  },
}

export default service
