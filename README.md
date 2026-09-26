# CodeMind

> 面向开发者的智能知识管理与技术社区平台 —— 个人知识库、技术社区、消息通知与 RAG 智能助手。

一个前后端分离的全栈项目：**后端** Spring Boot 3 + Spring AI 单体服务，**前端** Vue 3 + TypeScript。
覆盖用户、个人知识库、技术社区、消息通知、AI 智能助手五个业务域，共 **59 个 REST 接口**，
全部为独立设计与实现。

```
codemind-backend/    后端 · Spring Boot 3.4.13 · Java 17 · 8080
codemind-web/        前端 · Vue 3 + TypeScript + Vite · 5173
```

---

## 功能

| 模块 | 能力 |
|---|---|
| 用户 | 验证码登录 / 注册、密码登录、个人资料、改密码、用户主页、关注与粉丝 |
| 个人知识库 | 笔记 CRUD、公开 / 私密切换、多级分类树、标签 |
| 社区 | 文章 CRUD、列表 / 热门 / 最新 / 按标签、点赞、收藏、两级评论 |
| 消息通知 | 通知列表、未读数、单条 / 全部已读、删除 |
| AI 智能助手 | 会话管理、流式对话、Tool Calling、文章与笔记的总结 / 知识点 / 面试题（RAG） |

---

## 技术栈

**后端**

| 层次 | 选型 |
|---|---|
| 语言 / 框架 | Java 17、Spring Boot 3.4.13 |
| 持久层 | MyBatis-Plus 3.5.7、MySQL 8、HikariCP |
| 缓存 / 分布式 | Redis、Redisson 3.24.3（分布式锁） |
| 消息队列 | RabbitMQ（消费端手动 ACK） |
| AI | Spring AI 1.1.8、DeepSeek（对话）、通义千问（Embedding 1024 维）、Milvus（向量库） |
| 对象存储 | MinIO |
| 认证 | JWT（jjwt 0.12.5） |
| API 文档 | Knife4j 4.4.0（OpenAPI 3） |

**前端**

Vue 3（`<script setup>`）+ TypeScript + Vite + Element Plus + Pinia + Vue Router + Axios。

---

## 架构

完整架构图与 AI 流程见 **[`codemind-backend/架构与AI流程.md`](codemind-backend/架构与AI流程.md)**
（项目架构、一次 AI 对话的完整链路、RAG 向量化的写入链路，另附 SVG / PNG）。

```
浏览器 → 后端（拦截器鉴权 + 五大业务域 + MQ 消费者）→ MySQL / Redis / RabbitMQ / MinIO / Milvus
                                                   → DeepSeek（对话）+ 通义千问（Embedding）
```

---

## 快速开始

**先起后端，再起前端。**

### 1. 后端

```bash
cd codemind-backend

# ① 建库（14 张表，含索引）
mysql -uroot -p < codemind建表语句.sql

# ② 设置环境变量（见下表），然后启动
./mvnw spring-boot:run        # Windows 用 mvnw.cmd，首次会自动下载 Maven 3.9.9
```

必须用环境变量注入的配置（少任何一个都会启动失败）：

| 变量 | 用途 |
|---|---|
| `JWT_SECRET` | JWT 签名密钥 |
| `MYSQL_USERNAME` / `MYSQL_PASSWORD` | MySQL 账号 |
| `REDIS_HOST` / `REDIS_PASSWORD` | Redis 地址与密码 |
| `RABBITMQ_HOST` | RabbitMQ 地址 |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | MinIO 连接与凭据 |
| `MILVUS_NAME` / `MILVUS_PASSWORD` | Milvus 账号（默认 `root` / `Milvus`） |
| `ALI_API_KEY` | 通义千问 Embedding API Key |
| `DS_API_KEY` | DeepSeek 对话模型 API Key |

还需要本地起好 **MySQL / Redis / RabbitMQ / Milvus / MinIO**（默认端口 3306 / 6379 / 5672 / 19530）。

启动后：
- 服务监听 **8080**
- 在线接口文档 <http://localhost:8080/doc.html>

> 💡 Windows 上**改完环境变量要完全退出再重开终端 / IDE** —— 变更不会传播到已在运行的进程。

### 2. 前端

```bash
cd codemind-web
npm install
npm run dev        # http://localhost:5173
```

前端所有请求走 `/api`，由 Vite dev server 代理转发到 8080，**不需要处理跨域**。
后端未启动时页面会进入错误态（不会用 mock 兜底），这是预期行为。

---

## 目录结构

```
codemind-backend/
├── src/main/java/com/codemind/
│   ├── common/              Result<T> 与各域常量
│   ├── config/              拦截器、MybatisPlus、Redisson、Rabbit、Minio、SpringAi
│   ├── context/             UserContext（ThreadLocal 持有当前 userId）
│   ├── exceptionhandler/    BusinessException + 全局异常处理
│   ├── user/                用户域
│   ├── knowledge/           知识库域（笔记 / 分类 / 标签）
│   ├── community/           社区域（文章 / 评论 / 点赞 / 收藏）
│   ├── message/             消息通知域
│   └── ai/                  AI 域（会话 / RAG / 工具 / 提示词）
├── src/main/resources/      application.yml、mapper/*.xml
├── codemind建表语句.sql       14 张表 DDL + 索引优化
├── 架构与AI流程.md            架构图与 AI 流程图
└── API接口文档.md             59 个接口一览

codemind-web/
├── src/
│   ├── api/                 请求层（axios 封装 + aiStream 流式）
│   ├── composables/         useAiChat / useAiStream / useAiContext
│   ├── views/               auth / home / article / note / user / notify / ai
│   ├── components/  stores/  router/  types/  utils/  styles/
├── scripts/                 验证脚本（离线套件 + 端到端）
└── API接口文档.md             接口清单与通用约定
```

---

## 文档索引

| 文档 | 内容 |
|---|---|
| `codemind-backend/API接口文档.md` | 59 个接口一览 + 通用约定（认证、分页、错误码） |
| `codemind-backend/架构与AI流程.md` | 架构图、AI Agent / Tool / RAG 流程图 |
| `codemind-backend/codemind建表语句.sql` | 14 张表 DDL，每个索引都注明依据的查询 |
| `codemind-backend/AGENTS.md` | 后端协作总纲：关键机制、约定与踩坑记录 |
| `codemind-web/README.md` | 前端说明：环境变量、硬约束、命令 |

---

## 几个有真实取舍的设计

- **评论**：展示像无限嵌套，存储只有两级 —— 写入时上浮压平，读取「查根 + 一次 IN 查回复」，全程无递归
- **计数链路**：点赞 / 收藏 / 浏览量写 Redis，经 RabbitMQ 异步刷回 MySQL（最终一致）；详情走 Cache Aside，配空值缓存防穿透、TTL 抖动防雪崩
- **RAG 权限收口在写入侧**：只向量化「公开且已发布」的内容，私密内容永不入库 —— 检索侧因此无需再做权限过滤
- **AI 流式响应是裸文本流**（`text/html;charset=UTF-8`），不是 JSON 也不是 SSE，前端用 `fetch` + `ReadableStream` 并做流式 UTF-8 解码

---

## 已知限制

这些是清楚的边界，而不是未知的风险：

- **测试覆盖低**：后端 `src/test` 仅一个测试类；前端有一套离线验证脚本（解码 / 流式 / Markdown / 布局 / 渲染）
- **无多环境配置**：后端只有一份 `application.yml`，未拆分 dev / prod profile
- **无 Docker 编排**：MySQL、Redis、RabbitMQ、Milvus、MinIO 需自行准备
- **跨域尚未收紧**：`@CrossOrigin` 在各 Controller 上放开，上线前应限定来源
- **JWT 无刷新与黑名单**：固定 120 分钟过期，登出依赖前端丢弃 token
- **`mvn package` 产出普通 jar**：`pom.xml` 未声明 `spring-boot-maven-plugin`，不能 `java -jar` 直接运行
- **仓库不含测试数据**：需要联调数据请自行造，或另外准备种子脚本
- **文档与代码若有出入，以代码为准**
