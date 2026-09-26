# CodeMind API 接口文档

> **Base URL** `/api` ｜ **认证** 请求头 `token: <jwt>`（注意不是 `Authorization`）
> ｜ **在线调试** 启动后访问 `/doc.html`（Knife4j）

完整版（含每个接口的请求/响应示例、错误场景、边界说明）在项目私有仓库中维护，
本文件只列**接口清单与必要约定**，方便快速了解接口全貌。

## 通用约定

**统一响应**

```json
{ "code": 200, "message": "操作成功", "data": {} }
```

- `code` 与 HTTP 状态码语义对齐：**传输层统一 HTTP 200**，前端只看 `code`
- 请求 / 响应均为 `application/json`（上传封面用 `multipart/form-data`）
- 时间格式 `yyyy-MM-dd HH:mm:ss`，时区 GMT+8

**分页**

- 入参 `page`（从 1 开始）、`size`（默认 10，**最大 50**）
- 出参直接返回 MyBatis-Plus 的 `Page`：`records` / `total` / `size` / `current` / `pages`
  —— 当前页码读 **`current`**，没有 `page` 字段

**错误码**

| code | 含义 | 典型场景 |
|---|---|---|
| 200 | 成功 | — |
| 400 | 参数错误 | 缺参数、格式非法、枚举越界、文件不合规、`@Valid` 失败 |
| 401 | 未登录 / 凭证错误 | token 过期、验证码或密码错误 |
| 403 | 无权限 | 操作别人的资源 |
| 404 | 资源不存在 | 文章 / 笔记 / 分类 / 评论 / 会话 / 通知不存在 |
| 405 | 方法不支持 | 该 POST 却发 GET |
| 409 | 状态冲突 | 重复提交、同名校验命中 |
| 413 | 上传体积超限 | 超过 5MB |
| 415 | 格式不支持 | Content-Type 不是 `application/json` |
| 429 | 请求过于频繁 | 验证码 60 秒内重发、错误次数达 5 次 |
| 500 | 服务端异常 | 系统兜底，不泄露内部信息 |
| 503 | 服务暂时不可用 | 并发锁未获取到，稍后重试 |

> 「不存在」（404）与「无权限」（403）在所有写接口上都**分开返回** ——
> 后端先查存在性、再查归属，不用一句「XX 不存在或无权操作」合并表达。

## 接口清单


### 用户模块

| # | 接口 | 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|---|---|
| 1.1 | 发送验证码 | POST | `/api/user/sendCode` | 公开 | 用户通过手机号获取验证码 |
| 1.2 | 验证码登录 / 注册 | POST | `/api/user/login/code` | 公开 | 手机号 + 验证码登录，新用户自动注册，返回 JWT Token |
| 1.3 | 密码登录 | POST | `/api/user/login/password` | 公开 | 手机号 + 密码登录，返回 JWT Token |
| 1.4 | 获取当前用户信息 | GET | `/api/user/info` | 需要 | 通过 Token 获取当前登录用户的详细信息及统计数据 |
| 1.5 | 修改个人资料 | PUT | `/api/user/data` | 需要 | 修改当前用户的昵称、头像、简介 |
| 1.6 | 修改密码 | PUT | `/api/user/updatePassword` | 需要 | 用户修改登录密码 |
| 1.7 | 查看用户主页 | GET | `/api/user/profile/{userId}` | 需要 | 查看指定用户的主页信息 |
| 1.8 | 关注用户 | POST | `/api/user/follow/{followUserId}` | 需要 | 关注某个用户，已关注则重复请求幂等 |
| 1.9 | 取消关注 | DELETE | `/api/user/cancelFollow/{followUserId}` | 需要 | 取消对某个用户的关注 |
| 1.10 | 我的关注列表 | GET | `/api/user/follows` | 需要 | 分页获取当前用户关注的人列表，按关注时间倒序 |
| 1.11 | 我的粉丝列表 | GET | `/api/user/fans` | 需要 | 分页获取当前用户的粉丝列表，按关注时间倒序 |
| 1.12 | 判断关注状态 | GET | `/api/user/follow/status/{userId}` | 需要 | 判断当前用户是否已关注目标用户 |

### 个人知识库（笔记）模块

| # | 接口 | 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|---|---|
| 2.1 | 创建笔记 | POST | `/api/note/createNote` | 需要 | 创建一篇新笔记 |
| 2.2 | 编辑笔记 | PUT | `/api/note/{noteId}` | 需要 | 编辑自己的笔记，只能修改自己的笔记 |
| 2.3 | 删除笔记 | DELETE | `/api/note/{noteId}` | 需要 | 逻辑删除自己的笔记 |
| 2.4 | 查看笔记详情 | GET | `/api/note/{noteId}` | 需要 | 查看笔记详细内容及关联标签 |
| 2.5 | 我的笔记列表 | GET | `/api/note/list` | 需要 | 分页获取当前用户的笔记列表 |
| 2.6 | 切换笔记公开/私密 | PUT | `/api/note/{noteId}/visibility` | 需要 | 快速切换笔记的可见性 |
| 2.7 | 创建分类 | POST | `/api/category/createCategory` | 需要 | 创建个人笔记分类，支持多级 |
| 2.8 | 修改分类 | PUT | `/api/category/{categoryId}` | 需要 | 修改自己分类的名称与排序 |
| 2.9 | 删除分类 | DELETE | `/api/category/{categoryId}` | 需要 | 逻辑删除分类。删除时会做数据迁移，不是简单置空。 |
| 2.10 | 分类树查询 | GET | `/api/category/tree` | 需要 | 获取当前用户的分类树结构 |
| 2.11 | 为笔记添加标签 | POST | `/api/note/{noteId}/tag` | 需要 | 为指定笔记设置标签 |
| 2.12 | 标签列表查询 | GET | `/api/tag/list` | 需要 | 获取公共标签列表 |

### 社区模块

| # | 接口 | 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|---|---|
| 3.1 | 发布文章 | POST | `/api/article` | 需要 | 发布一篇社区文章 |
| 3.2 | 编辑文章 | PUT | `/api/article/{articleId}` | 需要 | 编辑自己的文章 |
| 3.3 | 删除文章 | DELETE | `/api/article/{articleId}` | 需要 | 逻辑删除自己的文章 |
| 3.4 | 查看文章详情 | GET | `/api/article/{articleId}` | 需要 | 查看文章完整内容，访问时浏览量 +1 |
| 3.5 | 文章列表 | GET | `/api/article/list` | 公开 | 社区文章分页列表，按时间倒序 |
| 3.6 | 我的文章 | GET | `/api/article/my` | 需要 | 分页获取当前用户发布的文章 |
| 3.7 | 点赞文章 | POST | `/api/article/{articleId}/like` | 需要 | 点赞文章（每个用户对同一文章只能点一次） |
| 3.8 | 取消点赞 | DELETE | `/api/article/{articleId}/like` | 需要 | 取消对文章的点赞 |
| 3.9 | 判断点赞状态 | GET | `/api/article/{articleId}/like/status` | 需要 | 判断当前用户是否点赞了该文章 |
| 3.10 | 收藏文章 | POST | `/api/article/{articleId}/favorite` | 需要 | 收藏文章（幂等 —— 重复收藏返回相同成功响应，不会重复计数） |
| 3.11 | 取消收藏 | DELETE | `/api/article/{articleId}/favorite` | 需要 | 取消对文章的收藏 |
| 3.12 | 我的收藏列表 | GET | `/api/user/favorites` | 需要 | 分页获取当前用户收藏的文章列表 |
| 3.13 | 发布评论 / 回复评论 | POST | `/api/comment` | 需要 | 对文章发表评论或回复评论 |
| 3.15 | 删除评论 | DELETE | `/api/comment/{commentId}` | 需要 | 逻辑删除自己发的评论 |
| 3.16 | 查看评论列表 | GET | `/api/article/{articleId}/comment` | 需要 | 分页获取文章的一级评论 |
| 3.17 | 热门文章 | GET | `/api/article/hot` | 公开 | 热门文章列表（顺序取自 Redis 有序集合 codemind:article:hot） |
| 3.18 | 最新文章 | GET | `/api/article/latest` | 公开 | 按发布时间倒序的最新文章列表 |
| 3.19 | 标签下的文章 | GET | `/api/article/tag/{tagId}` | 公开 | 查询指定标签下的文章列表 |
| 3.20 | 查看回复列表 | GET | `/api/comment/{rootId}/replies` | 需要 | 分页获取某条一级评论下的全部回复，按时间正序 |

### 消息通知模块

| # | 接口 | 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|---|---|
| 4.1 | 我的消息列表 | GET | `/api/notify/list` | 需要 | 分页获取当前登录用户的消息通知列表，包括被点赞、被评论、被关注等通知 |
| 4.2 | 未读消息数量 | GET | `/api/notify/unread` | 需要 | 获取当前登录用户的未读消息数量 |
| 4.3 | 标记某条消息已读 | PUT | `/api/notify/read/{notifyId}` | 需要 | 将指定消息标记为已读 |
| 4.4 | 全部消息已读 | PUT | `/api/notify/readAll` | 需要 | 将当前登录用户的全部未读消息标记为已读 |
| 4.5 | 删除某条消息 | DELETE | `/api/notify/deleteMessage/{notifyId}` | 需要 | 删除单条消息通知（**删未读消息会让未读数 -1**） |

### AI 智能助手模块

| # | 接口 | 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|---|---|
| 5.1 | 创建 AI 会话 | POST | `/api/ai/conversations` | 需要 | 为当前登录用户创建一个新的 AI 会话 |
| 5.2 | 查询当前用户 AI 会话列表 | GET | `/api/ai/conversations` | 需要 | 查询当前登录用户创建的全部 AI 会话，用于前端 AI 聊天窗口左侧/侧边栏的会话列表 |
| 5.3 | 查询指定 AI 会话历史消息 | GET | `/api/ai/conversations/{conversationId}/messages` | 需要 | 查询指定 AI 会话的历史消息，用于打开已有会话时恢复聊天记录 |
| 5.4 | AI 统一聊天 | POST | `/api/ai/chat` | 需要 | CodeMind 统一 AI 聊天入口 |
| 5.5 | 文章 AI 总结 | POST | `/api/ai/articles/{articleId}/summary` | 需要 | 根据指定文章的标题和正文内容生成文章总结 |
| 5.6 | 文章知识点提取 | POST | `/api/ai/articles/{articleId}/knowledge-points` | 需要 | 根据指定文章的标题和正文提取核心知识点 |
| 5.7 | 文章生成面试题 | POST | `/api/ai/articles/{articleId}/interview-questions` | 需要 | 根据指定文章的标题和正文生成面试题 |
| 5.8 | 笔记 AI 总结 | POST | `/api/ai/notes/{noteId}/summary` | 需要 | 根据指定笔记的标题和正文内容生成笔记总结 |
| 5.9 | 笔记知识点提取 | POST | `/api/ai/notes/{noteId}/knowledge-points` | 需要 | 根据指定笔记的标题和正文提取核心知识点 |
| 5.10 | 笔记生成面试题 | POST | `/api/ai/notes/{noteId}/interview-questions` | 需要 | 根据指定笔记的标题和正文生成面试题 |
| 5.11 | 删除 AI 会话 | DELETE | `/api/ai/DeleteConversation/{conversationId}` | 需要 | 删除指定 AI 会话（**后端会同时清掉该会话的记忆**） |

### 附：消息通知的 `type` 取值

| type | 类型 | 说明 |
|---|---|---|
| 1 | 被点赞 | 其他用户点赞当前用户的文章 |
| 2 | 被评论 | 其他用户评论当前用户的文章，或回复当前用户的评论 |
| 3 | 被关注 | 其他用户关注当前用户 |

> 通知的 `content` 是**后端拼接好的整句文案**（各类型格式不统一），
> 前端**直接整句展示**即可，不要尝试解析、也不要自己重拼。

---

**接口总数：59**（用户 12 ／ 知识库 12 ／ 社区 19 ／ 消息 5 ／ AI 11）

**说明**

- 「认证 = 公开」的接口无需 token 即可访问（对应后端拦截器白名单），其余都需要
- 未登录访问需认证的接口 → HTTP 401 `{"code":401,"message":"登陆过期请重新登陆"}`
- ⚠️ **两个删除接口的路径大小写不常规**，别按 REST 习惯猜：
  - `DELETE /api/notify/deleteMessage/{notifyId}` —— **小写 `d`**
  - `DELETE /api/ai/DeleteConversation/{conversationId}` —— **大写 `D`**
    （同模块的其它接口都是小写开头，只有它例外）
- 每个接口的完整请求参数、响应结构、错误场景与示例，见私有仓库的完整版文档
