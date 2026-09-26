import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // 后端联调地址，仅用于 Vite 开发服务器的代理转发，不会打进前端产物。
  // 默认 http://localhost:8080，可在 .env.local 中用 VITE_PROXY_TARGET 覆盖。
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://localhost:8080'

  return {
    plugins: [vue(), vueDevTools()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      // 统一走代理：前端一律请求 /api/xxx，由 dev server 转发到后端。
      // 这样可以彻底避开跨域（CORS）与 multipart/form-data 的跨域预检问题。
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
