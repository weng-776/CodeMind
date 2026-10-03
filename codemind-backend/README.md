# CodeMind · 后端服务

> 面向开发者的智能知识管理与技术社区平台 —— 个人知识库、技术社区、消息通知与 RAG 智能助手的一体化后端。

一个基于 Spring Boot 3 + Spring AI 的单体后端，覆盖 **用户、个人知识库、技术社区、消息通知、AI 智能助手** 五个业务域，共 **75+ 个 REST 接口**，全部为后端独立设计与实现。

项目的重点不在接口数量，而在几个有真实取舍的设计：**两级评论的「写入压平」模型**、**点赞与收藏计数链路的缓存 + 异步最终一致**、以及 **RAG 的写入侧权限收口**。

---

## 目录

- [技术栈](#技术栈)
- [功能模块](#功能模块)
- [核心设计](#核心设计)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [接口文档](#接口文档)
- [已知限制](#已知限制)

---

## 技术栈

| 层次 | 选型 |
|---|---|
| 语言 / 框架 | Java 17、Spring Boot 3.4.13 |
| 持久层 | MyBatis-Plus 3.5.7、MySQL 8.0.33、HikariCP |
| 缓存 / 分布式 | Redis（`spring-data-redis` + 连接池）、**Redisson 3.24.3**（分布式锁） |
| 消息队列 | RabbitMQ（`spring-boot-starter-amqp`，消费端手动 ACK） |
| AI | **Spring AI 1.1.8**、DeepSeek（对话）、通义千问（Embedding，1024 维）、Milvus（向量库） |
| 对象存储 | MinIO 8.5.7 |
| 认证 | JWT（jjwt 0.12.5）、`spring-security-crypto`（BCrypt） |
| API 文档 | Knife4j 4.4.0（OpenAPI 3） |
| 工具 | Lombok、Jackson、Hutool 5.7.17、Validation、Actuator |

Spring AI 的子依赖各司其职：

| 依赖 | 作用 |
|---|---|
| `spring-ai-starter-model-deepseek` | 对话模型 |
| `spring-ai-starter-model-openai` | 以 OpenAI 兼容协议接入通义 Embedding |
| `spring-ai-starter-vector-store-milvus` | 向量存储（`ivf_flat` 索引、cosine 相似度） |
| `spring-ai-starter-model-chat-memory-repository-jdbc` | 会话记忆持久化到 MySQL |
| `spring-ai-markdown-document-reader` | RAG 文档按 Markdown 语义切分 |

---

## 功能模块

| 模块 | 接口数 | 能力 |
|---|---|---|
| 用户 | 12 | 验证码、登录 / 注册、个人资料、改密码、用户主页、关注 / 粉丝 |
| 知识库 | 12 | 笔记 CRUD、可见性切换、多级分类树、标签 |
| 社区 | 19 | 文章 CRUD、列表 / 热门 / 最新 / 按标签、点赞、收藏、两级评论 |
| 消息通知 | 5 | 通知列表、未读数、单条已读、全部已读、删除消息 |
| AI 助手 | 11 | 会话 CRUD（含删除）、历史消息、统一聊天（流式）、文章与笔记的总结 / 知识点 / 面试题 |
| **管理端** | **15** | 数据看板、用户治理（封禁 / 解封）、内容治理（文章 / 笔记 / 评论的上下架与删除）、死信队列（查看 / 清空 / 重投） |

---

## 核心设计

### 1. 评论：展示像无限嵌套，存储只有两级

掘金、知乎式的评论区看起来可以无限层级回复，但**递归结构在读取和级联删除上都会失控**（N+1 查询、递归收集子孙 id、深层数据查询不到）。这里的做法是**写入时压平**：

- **不变量**：任何一行的 `parent_id` 要么是 `0`，要么指向一条 `parent_id = 0` 的行 —— 库里不存在第三层
- **写入上浮**：前端传用户实际点的那条评论（一级二级都可能），服务端把它挂到所属的根上。因为父评论本身也满足同一不变量，**一次上浮即可**（归纳保证）
- `reply_user_id`（被回复人）、`reply_comment_id`（被回复的那条）由**服务端推导，不收前端入参**，避免伪造
- 换来两个简化：删根评论时一条 `parent_id = 根id` 条件即可**级联**逻辑删除全部回复；读取是「查根 + 一次 `IN` 查回复」两步，**全程无递归**

读取拆成两个接口：`GET /api/article/{id}/comment`（分页根评论，每条附带前 2 条回复与 `replyCount`）与 `GET /api/comment/{rootId}/replies`（指定根分页翻全部回复）。

> 一个踩过的坑：批量查用户时**必须把 `replyUserId` 与 `userId` 一起并入 id 集合**。被回复人可能不在本批数据里，漏掉不报错，只会让「回复 @某某」偶尔空白 —— 最难排查的那类问题。

### 2. 计数链路：缓存扛读，MQ 兜写

点赞、收藏、浏览量这类高频写操作如果直连 MySQL，行锁竞争会很严重。这里的方案：

- 计数写 Redis，经 **RabbitMQ 异步刷回 MySQL**（最终一致），业务接口立即返回
- 文章详情走 Cache Aside，兜底策略齐全：**空值缓存**防穿透（TTL 60s）、**过期时间随机抖动**防雪崩、写侧**先更新 DB 再删缓存**
- 浏览量、热门榜 ZSet **刻意不放进详情缓存**，否则浏览一次就与 DB 打架
- 发布文章用 **Redisson 分布式锁**防重复提交，看门狗自动续期

RabbitMQ 拓扑为 3 组交换机、9 个队列，覆盖计数落库、缓存失效通知、关注 / 点赞 / 评论通知、RAG 入库与更新，消费端手动 ACK。

### 3. RAG：把权限收口在写入侧

这是整个 AI 模块的关键取舍 —— **只向量化「公开且已发布」的内容**（笔记要求 `visibility=1 且 status=1`，文章要求已发布），私密内容永不入库，可见性变更时同步增删向量。

带来的收益是：**检索侧无需再做权限过滤**，权限不变量只在一个地方保证，不会因为某条检索路径漏了 `if` 就泄漏私密笔记。

其余实现要点：

- **语义切分**：`MarkdownDocumentReader` 按标题 / 代码块 / 引用块切分，比按字数硬切保留的语义更完整，metadata 带 `type` / `id` / `title`
- **检索**：`similaritySearch` topK=5、相似度阈值 0.6，按 `type` 过滤文章与笔记
- **Tool Calling**：`ai/tools/` 下用 `@Tool` / `@ToolParam` 定义文章搜索、笔记搜索、知识库语义检索等工具，交给模型自主路由
- **结构化输出**：`.entity(...)` 直接映射为对象；**流式输出**：`stream().content()` 返回 `Flux<String>`，`Content-Type: text/html;charset=UTF-8` —— 是**裸文本 chunk，不是 SSE**（没有 `data:` 前缀），前端用 `fetch` + `ReadableStream` 读取并做流式 UTF-8 解码
- **会话记忆**：`MessageWindowChatMemory` + JDBC 仓储，窗口 20 条，每次读写都按 `id + userId` 校验归属

### 4. 统一鉴权与错误码

- 鉴权走拦截器：从请求头读 **`token`**（非 `Authorization`），校验后把 `userId` 放入 `UserContext`（ThreadLocal），请求结束清理；白名单放行登录、验证码与文章公开列表
- 统一响应 `Result<T>{code, message, data}`，**`code` 与 HTTP 状态码语义对齐**：400 参数、401 未登录、403 无权限、404 不存在、409 冲突、413 体积超限、415 格式不支持、429 过于频繁、500 服务端异常、503 服务暂时不可用
- 业务异常统一由 `BusinessException` 静态工厂抛出（`badRequest` / `notFound` / `forbidden`…），全局异常处理器按 4xx / 5xx 分流日志级别，并对 `NoResourceFoundException`、`HttpRequestMethodNotSupported` 等框架异常给出正确状态码
- **硬规则：「不存在」（404）与「无权限」（403）必须分开报** —— 先查存在性再比对归属。合并成「XX 不存在或无权操作」既给不出可区分状态码，也是越权探测的信息面

### 5. 管理端：权限收口在拦截器，死信队列做成可运维

管理端（`/api/admin/**`）与业务模块是**两套鉴权**，这样业务侧的改动不会影响管理侧：

- 业务侧走 `CodeMindInterceptor`（验 token → `UserContext`）；
  **管理侧额外挂 `AdminInterceptor`**，它在 token 校验之外**每次请求都查库**取 `role` 并校验 `= 1`
  —— 用「每次查库」换「改角色立即生效」，管理端这种低频场景完全值得
- **「非管理员」返回的是真 HTTP 403**（`response.setStatus(403)`），
  而参数越界 / 资源不存在仍是 HTTP 200 + `code` —— **前端一律判 `code`，不要判 HTTP 状态码**
- 路径前缀统一 `/api/admin/**`，拦截器按前缀匹配，新增管理接口不会漏鉴权

**死信队列做成可运维**是这个模块里最有价值的一块：RabbitMQ 拓扑有 3 组交换机、9 个队列，
消费端手动 ACK，重试耗尽后消息进死信队列。如果不做成接口，出问题时只能登管理台手工处理。

- **查看**：`basicGet` 逐条取，读完**不确认、重新入队** —— 预览是只读的，不会吃掉消息
- **重投**：把消息投回**它原本的交换机与 routingKey**（**不是 DLX**，投 DLX 会死循环），
  单次上限 500 条，剩余的下次再投
- **清空**：不可逆，前端必须二次确认
- 三个接口共用一份**队列名白名单**，非法名字统一 400，避免把 broker 的异常兜成 500

> 一个踩过的坑：给已有队列**新加** `x-dead-letter-exchange` 会 `PRECONDITION_FAILED(406)`
> —— RabbitMQ 不允许修改已存在队列的参数，必须先删队列再声明。
>
> 另一个：**`x-death` 是 RabbitMQ 系统保留头，发布时会被清空** ——
> 想验死信头只能造真死信，用管理端 API 伪造灌进去到达时就是 `[]`。

---

## 快速开始

### 环境要求

- JDK 17
- Maven —— **不需要自己装**，用项目自带的 Wrapper：`./mvnw`（Windows 用 `mvnw.cmd`），
  首次运行会自动下载 Maven 3.9.9
  - ⚠️ macOS / Linux 若提示 `Permission denied`，先执行一次 `chmod +x mvnw`
    （Windows 提交时代执行位可能丢失；Windows 用户直接用 `mvnw.cmd`，不受影响）
- 若仍想用本机 `mvn`，版本必须 **≥ 3.6.3**（Spring Boot 3.4.13 的 `maven-compiler-plugin 3.13.0` 的硬性要求）
- MySQL 8、Redis、RabbitMQ、Milvus、MinIO（**缺任何一个都会导致启动或调用失败**）

### 1. 初始化数据库

只需一份脚本 —— `codemind建表语句.sql` **已覆盖全部 14 张表**：

- 业务表 11 张（`user` / `follow` / `note` / `category` / `tag` / `note_tag` / `article` / `article_tag` / `comment` / `article_like` / `favorite`）
- `message` 站内通知表
- `ai_conversation` AI 会话表
- `spring_ai_chat_memory` Spring AI 会话记忆表

脚本里同时**内置了索引优化**（依据代码中真实的 `WHERE` / `ORDER BY` 组合设计，每个索引都在文件末尾注明了用途）。

```bash
mysql -uroot -p < codemind建表语句.sql
```

> ⚠️ 该脚本开头会 `DROP TABLE`（破坏性）。在已有数据的库上执行前请先备份。

AI 会话记忆表由应用启动时也会自动创建（`spring.ai.chat.memory.repository.jdbc.initialize-schema: always`），Milvus 的 collection 同样自动初始化，无需手工建。

> 📌 本仓库**不含测试数据**。需要本地联调数据的话，自己用接口造一批，或另行准备种子脚本。

### 2. 注入环境变量

以下配置项通过环境变量注入，启动前必须设置：

| 变量 | 用途 |
|---|---|
| `JWT_SECRET` | JWT 签名密钥 |
| `MYSQL_USERNAME` / `MYSQL_PASSWORD` | MySQL 账号 |
| `REDIS_HOST` / `REDIS_PASSWORD` | Redis 地址与密码 |
| `RABBITMQ_HOST` | RabbitMQ 地址 |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | MinIO 连接与凭据 |
| `MILVUS_NAME` / `MILVUS_PASSWORD` | Milvus 账号（默认 `root` / `Milvus`） |
| `MILVUS_HOST` | Milvus 地址（虚拟机 `192.168.238.186`） |
| `ALI_API_KEY` | 通义千问 Embedding API Key（DashScope） |
| `DS_API_KEY` | DeepSeek 对话模型 API Key |

> ⚠️ 变量名以 `src/main/resources/application.yml` 里的 `${...}` 占位符为准。
> 少设任何一个都会**启动失败**（例如漏了 `MILVUS_NAME` 会报
> `UNAUTHENTICATED: auth check failure`）。
>
> 💡 **Windows 上改了环境变量后，必须完全退出并重开 IDE** ——
> 环境变量的变更不会传播到已在运行的进程（IDE 拉起的 JVM 读的是 IDE 自己的环境副本）。

外部组件的默认端口：MySQL `3306` / Redis `6379` / RabbitMQ `5672` / Milvus `19530`。

### 3. 启动

在 IDE 中直接运行主类 `com.codemind.CodeMindApplication`，或用命令行：

```bash
mvn spring-boot:run    # 首次执行会下载 spring-boot-maven-plugin
```

服务监听 **8080** 端口。启动后访问 `http://localhost:8080/doc.html` 查看在线接口文档。

其他常用命令（用自带的 Wrapper，不用管本机 Maven 版本；Windows 用 `mvnw.cmd`）：

```bash
./mvnw compile    # 编译
./mvnw test       # 运行测试
./mvnw clean      # 排查诡异问题前先清一遍
```

> ⚠️ **构建配置有个待补项**：`pom.xml` 未声明 `spring-boot-maven-plugin`（它只存在于 `spring-boot-starter-parent` 的 `pluginManagement` 中）。两个后果 ——
> 1. `mvn package` 产出的是**普通 jar，不能 `java -jar` 运行**，需要补上该插件并绑定 `repackage` goal；
> 2. 命令行 `mvn spring-boot:run` 依赖插件前缀解析，首次需联网下载插件；IDE 启动则不受影响。

---

## 项目结构

```
com.codemind
├── common/            Result<T> 与常量（RedisKey / User / Note / Article / Message / Rag）
├── config/            SpringMvcConfig(拦截器)、MybatisPlus、Redisson、Rabbit、Minio、
│                      SpringAi 配置与 properties/
│   └── interceptor/   CodeMindInterceptor(业务鉴权) + AdminInterceptor(管理端 role 校验)
├── context/           UserContext —— ThreadLocal 持有当前登录 userId
├── exceptionhandler/  BusinessException、GlobalExceptionHandler
├── utils/             JwtHelper、MD5Util、RegexUtils、FileUploadService
├── user/              用户域：注册登录、资料、密码、主页、关注 / 粉丝
├── knowledge/         知识库域：笔记、分类（树）、标签
├── community/         社区域：文章、标签、评论、点赞、收藏、热门 / 最新
├── message/           消息通知域：notification + NoticeConsumer
├── ai/                AI 域：会话、RAG、工具、提示词
└── admin/             管理端域：看板、用户治理、内容治理、死信队列（**独立于业务域的鉴权层**）
```

每个业务域内部结构一致：`entity / mapper / service / service.impl / controller / dto / vo`。分层约定：

- **Controller 只依赖 Service 接口**，为后续微服务拆分留出前置条件
- `dto/` 只作入参（带 `@Valid` 校验），`vo/` 只作出参
- Mapper 继承 `BaseMapper<T>`，**手写 SQL 统一放 `resources/mapper/*.xml`**

数据模型共性设计：

- **全表软删除**：`is_delete` + `@TableLogic`，MyBatis-Plus 自动拦截 delete / select
- **主键自增**：`IdType.AUTO`
- **不设外键**：引用完整性由应用层校验保证，便于后续分库分表

---

## 接口文档

| 形式 | 位置 |
|---|---|
| 在线调试 | 启动后访问 `http://localhost:8080/doc.html`（Knife4j） |
| Markdown 文档 | `API接口文档.md` —— **接口清单与必要约定**（**75 个接口**一览：方法 / 路径 / 认证 / 说明；含管理端 15 个） |
| 建表语句 | `codemind建表语句.sql`（14 张表 + 索引优化，每个索引都注明了依据的查询） |

约定：认证接口在请求头携带 `token`；分页参数 `page`（≥1）、`size`（≤50），响应中回显 `current` / `size` / `total` / `pages`。

---

## 已知限制

这些是清楚的边界，而不是未知的风险：

- **测试覆盖极低**：`src/test` 下仅有一个测试类，主要依赖手工接口测试
- **无多环境配置**：只有一份 `application.yml`，未拆分 dev / prod profile
- **无 Docker 编排**：MySQL、Redis、RabbitMQ、Milvus、MinIO 需自行准备，`docker-compose.yml` 待补
- **跨域尚未收紧**：`@CrossOrigin` 目前在各 Controller 上放开，上线前应限定具体来源
- **JWT 无刷新与黑名单**：固定 120 分钟过期，登出即失效依赖前端丢弃 token
- **文档与代码若有出入，以代码为准**：README 与 `AGENTS.md` 是说明性文档，接口定义以 `API接口文档.md` 为准

---

## 配套文档

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | 协作总纲：技术栈、关键机制、约定与踩坑记录 |
| `API接口文档.md` | **75 个接口**一览 + 通用约定（认证、分页、错误码） |
| `codemind建表语句.sql` | 14 张表的 DDL + 索引优化（每个索引都注明了依据的查询） |
| `管理端设计说明.md` | 管理端的产品目标、接口设计、权限模型与验收口径 |
| `管理端接口实测报告.md` | 管理端 15 个接口的真机实测报告（含每条结论的证据与现场还原记录） |
