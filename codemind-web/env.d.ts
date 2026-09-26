/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 前端请求基础路径，固定为 /api（走 Vite 代理） */
  readonly VITE_API_BASE_URL: string
  /** 后端真实地址，仅 Vite 代理使用 */
  readonly VITE_PROXY_TARGET: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
