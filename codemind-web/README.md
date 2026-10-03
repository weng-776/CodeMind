# CodeMind Web · 前端

> 面向开发者的智能知识管理与技术社区平台 —— 社区文章、个人知识库、消息通知、AI 智能助手与管理后台的统一前端。
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

## 必须知道的硬约束

| # | 约束 |
|---|---|
| 1 | **认证请求头是 `token: <jwt>`**，不是 `Authorization: Bearer`（只发后者会导致所有需登录接口 401） |
| 2 | **AI 流式接口返回裸文本流**（`text/html;charset=UTF-8`），不是 JSON 也不是 SSE → 用 `fetch` + `ReadableStream` |
| 3 | 响应体的 `code` 与 HTTP 状态码语义对齐：**传输层恒为 HTTP 200**，业务错误要看 `code`，**不能按 `status === 200` 判断成功** |
| 4 | 分页响应当前页码字段是 **`current`**（MyBatis-Plus 的 `Page`），没有 `page` |
| 5 | **管理端（`/api/admin/**`）的「非管理员」返回的是真 HTTP 403**（不是 200 + `code`）→ axios 落 error 分支，拦截器会把 message 覆盖成通用文案，**后端那句「无管理员权限」前端收不到**，页面必须自己写文案 |

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

scripts/            验证脚本（离线套件 + 端到端 + 管理端四单）
API接口文档.md        接口清单与通用约定（75 个接口一览，含管理端 15 个）
管理端前端设计说明.md   管理端四单（T16~T21）的设计说明、接口契约与核验记录
交付前自检报告.md      交付前自检（05 §8 清单）的逐项结果与证据
```

---

## 管理后台

`/admin` 下四个页面，**仅管理员可见**（`role = 1`）。走站点自身的设计语言，
四页之间用**分段控件**切换，**刻意不做成「左菜单 + 右表格」的传统 Admin**。

| 路径 | 页面 | 能力 |
|---|---|---|
| `/admin` | 数据看板 | 12 个统计数字（6 个总量 + 6 个今日新增，按 GMT+8） |
| `/admin/users` | 用户治理 | 列表 / 搜索（手机号或昵称）/ 分页 / 封禁 / 解封 |
| `/admin/content` | 内容治理 | 文章 / 笔记 / 评论三个 tab，各自筛选 + 下架 / 恢复 / 删除 |
| `/admin/mq` | 死信队列 | 6 个队列卡片 + 展开看消息原文 + 清空 + 重投回原交换机 |

**权限门控是两层，缺一不可**：

1. **界面门控**：`GET /api/user/info` 的 `role` 字段 → `stores/user.ts` 的 `isAdmin` getter
   → 控制入口按钮显示与页面的 403 态
2. **真实权限**：始终在后端 `AdminInterceptor`（**每次请求都查库**取 role）

> ⚠️ 由此推出三条必须守住的纪律：
> ① `role` **只是界面门控，不是权限依据**；
> ② 后端改角色**立即生效**，而前端 `userInfo` 是**登录时的缓存** →
> 被降权的管理员前端可能还显示着入口 → **每个管理页都必须能渲染 403 态**，不能只靠守卫；
> ③ 守卫判 `isAdmin` 前必须确保 `infoLoaded`（刷新页面 Pinia 会丢），否则会误拦管理员。
>
> 路由守卫**刻意不做跳转**，只 `ensureUserInfo()` 后把门控交给页面 ——
> 若守卫直接跳走，页面就永远没机会渲染 403 态。

**死信队列的两条实现要点**（都在 `api/admin.ts` 的注释里）：

- 消息预览返回的是 **`string[]`（正文原文数组，不分页）**，里面存的是 JSON 文本但**可能 parse 失败**
  → 渲染时 `try { JSON.parse } catch { 原样显示 }`
- **重投后重新拉一次队列列表**看 `messageCount` 是否为 0，**不要按 `message` 文本分支**
  （`message` 里可能带「还剩 M 条，请再次执行」）

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
└── views/        auth / home / article / note / user / notify / ai / **admin** / error
```

---

## 已知边界

- 游客只能访问 7 条白名单路径，**文章详情 / 笔记详情 / 用户主页对游客返回 401** → 页面需有「登录后查看」状态
- `GET /api/user/info` **不返回 `id`** → 当前用户 id 从 JWT payload 的 `userId` claim 取；
  但**返回 `role`**（0 普通 / 1 管理员）—— **它只是界面门控，权限判定始终在后端**
- 后端没有删除封面/头像的接口（不传 `file` = 保留原图）
- AI 会话标题是**流结束后异步**生成的（约 2s 才写库）→ 前端用有上限轮询补上，不要「一结束就去读」
- `prompt` 无长度限制（前端自行限长）
- 标签候选集走 `GET /api/tag/list`（需登录、无分页）
