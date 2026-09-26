# CodeMind Web · 前端

> 面向开发者的智能知识管理与技术社区平台 —— 社区文章、个人知识库、消息通知与 AI 智能助手的统一前端。
>
> Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router + Axios。

---

## 快速开始

```bash
npm install
npm run dev            # http://localhost:5173
```

**前置**：后端需在 `http://localhost:8080` 运行。前端所有请求走 `/api`，由 Vite dev server 代理转发
（见 `.env` 的 `VITE_PROXY_TARGET` 与 `vite.config.ts` 的 `server.proxy`），因此**不需要处理跨域**。

后端未启动时页面会进入错误态（**不会用 mock 数据兜底**），这是预期行为。

---

## 环境变量（`.env`）

```env
VITE_API_BASE_URL=/api                        # 前端代码里只用它
VITE_PROXY_TARGET=http://localhost:8080       # 仅 Vite 代理使用，不进产物
```

**代码里不允许出现 `http://localhost:8080`**。后端换地址只改这里。

---

## 两条必须知道的硬约束

| # | 约束 |
|---|---|
| 1 | **认证请求头是 `token: <jwt>`**，不是 `Authorization: Bearer`（只发后者会导致所有需登录接口 401） |
| 2 | **AI 流式接口返回裸文本流**（`text/html;charset=UTF-8`），不是 JSON 也不是 SSE → 用 `fetch` + `ReadableStream` |
| 3 | 响应体的 `code` 与 HTTP 状态码语义对齐：**传输层恒为 HTTP 200**，业务错误要看 `code`，**不能按 `status === 200` 判断成功** |
| 4 | 分页响应当前页码字段是 **`current`**（MyBatis-Plus 的 `Page`），没有 `page` |

---

## 项目结构

```
src/
├── api/            请求封装（axios 实例 + 各业务模块接口）
├── composables/    组合式函数（AI 流式内核、会话管理、AI 面板…）
├── stores/         Pinia 状态
├── views/          页面
├── components/     通用组件
├── router/         路由
├── types/          TypeScript 类型
└── utils/          工具（token、格式化…）

scripts/            验证脚本（离线套件 + 端到端）
API接口文档.md        接口清单与通用约定（59 个接口一览）
```

---

## 命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发服务器（5173） |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run type-check` | `vue-tsc --build` |
| `npm test` | 离线套件：解码 / 流式 / Markdown / 布局 / 渲染 |
| `npm run test:login` / `test:list` / `test:detail` / `test:note` | 各模块端到端（桩后端 + 真实 Chrome） |
| **`npm run test:login:real`** | **真实后端**登录端到端（**需后端在 8080**） |
| `npm run test:browser` | 浏览器行为（**假设后端未启动**，后端在跑时必然失败，不算回归） |
| `npm run shot:home` / `shot:list` / `shot:detail` / `shot:note` | 截图 → `docs/screenshots/` |

> Windows + Git Bash 环境下 `npm run` 可能因 PATH 不完整而失败，可直接用绝对路径 node 跑脚本：
> `node scripts/verify-note.mjs`。注意本机管道（`|`）常不可用。

---

## 目录

```text
src/
├── api/          请求层（request.ts 统一机制 + 各业务域接口 + aiStream.ts 流式）
├── components/   layout / article / note / ai / user / common
├── composables/  useAiChat、useAiStream、useAiContext
├── layouts/      MainLayout
├── router/       index.ts（守卫）+ modules/*
├── stores/       user、app
├── styles/       tokens / base / markdown / element-override
├── types/        各业务域类型 + common（ApiResult / PageResult / ID）
├── utils/        auth（token + JWT 解 userId）/ format / markdown
└── views/        auth / home / article / note / user / notify / ai / error
```

---

## 已知边界

- 游客只能访问 7 条白名单路径，**文章详情 / 笔记详情 / 用户主页对游客返回 401** → 页面需有「登录后查看」状态
- `GET /api/user/info` **不返回 `id`** → 当前用户 id 从 JWT payload 的 `userId` claim 取
- 后端没有删除封面/头像的接口（不传 `file` = 保留原图）
- AI 会话标题是**流结束后异步**生成的（约 2s 才写库）→ 前端用有上限轮询补上，不要「一结束就去读」
- `prompt` 无长度限制（前端自行限长）
- 标签候选集走 `GET /api/tag/list`（需登录、无分页）
