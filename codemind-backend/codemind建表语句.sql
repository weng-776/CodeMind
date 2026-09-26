-- ============================================================================
-- CodeMind 建表语句（完整版）
-- ----------------------------------------------------------------------------
-- 生成时间：2026-09-26
-- 覆盖范围：**全部 14 张表**
--   · 业务表 11 张（user / follow / note / category / tag / note_tag /
--                   article / article_tag / comment / article_like / favorite）
--   · v2 新增 message 表（原 DDL 只在《CodeMind_v2落地方案_Redis与RabbitMQ.md》里，
--                        这份脚本把它并入，不再需要翻文档）
--   · AI 相关 ai_conversation（业务表）
--   · spring_ai_chat_memory（Spring AI 框架表，应用启动时会自动建，
--                           这里一并列出，保证脚本自足）
--
-- 与旧版 codemind建表语句.sql 的差异：**只动了索引，没动任何字段定义**。
--   · 新增 10 个索引（依据代码里真实出现的 WHERE / ORDER BY 组合）
--   · 删除 3 个冗余索引（是别的索引的前缀，白占写成本）
--   详细依据见每张表上方的注释。
--
-- ⚠️ 本脚本开头会 DROP 所有表（破坏性）。在已有数据的库上执行前请先备份。
-- ============================================================================

CREATE DATABASE IF NOT EXISTS codemind
DEFAULT CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE codemind;

-- ⚠️ 破坏性：清掉旧表，保证脚本可重复执行
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS `user`;
DROP TABLE IF EXISTS `follow`;
DROP TABLE IF EXISTS `category`;
DROP TABLE IF EXISTS `tag`;
DROP TABLE IF EXISTS `note`;
DROP TABLE IF EXISTS `note_tag`;
DROP TABLE IF EXISTS `article`;
DROP TABLE IF EXISTS `article_tag`;
DROP TABLE IF EXISTS `comment`;
DROP TABLE IF EXISTS `article_like`;
DROP TABLE IF EXISTS `favorite`;
DROP TABLE IF EXISTS `message`;
DROP TABLE IF EXISTS `ai_conversation`;
DROP TABLE IF EXISTS `spring_ai_chat_memory`;
SET FOREIGN_KEY_CHECKS = 1;


-- =========================
-- 1. 用户表 user
-- =========================
-- 索引说明：
--   uk_phone —— 手机号唯一，登录与注册都用它查（UserServiceImpl 里
--               `eq(phone).ne(status, DISABLE)` / `eq(phone).eq(status, NORMAL)`）
--   不需要额外索引：其余查询都是按主键 id。

CREATE TABLE `user` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '用户ID',
    phone VARCHAR(11) NOT NULL COMMENT '手机号',
    password VARCHAR(255) NOT NULL COMMENT '密码',
    user_name VARCHAR(50) COMMENT '用户昵称',
    avatar VARCHAR(255) COMMENT '用户头像地址',
    intro VARCHAR(255) COMMENT '个人简介',
    status TINYINT DEFAULT 1 COMMENT '账号状态',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    is_delete TINYINT DEFAULT 0 COMMENT '逻辑删除',

    UNIQUE KEY uk_phone (phone)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='用户表';


-- =========================
-- 2. 关注关系表 follow
-- =========================
-- 索引说明：
--   uk_follow(user_id, follow_user_id) —— ① 「是否已关注」的判断正好是这两列
--                                          ② 「我的关注数」count(user_id) 走它的最左前缀
--   idx_follow_user(follow_user_id)    —— 「粉丝数」count(follow_user_id)
--   🆕 idx_follow_user_time(user_id, create_time) —— 「我的关注列表」是
--        `WHERE user_id=? ORDER BY create_time DESC`。旧索引第二列是 follow_user_id，
--        排不了序，会触发 filesort。
--        （注：ORDER BY create_time DESC 用 ASC 索引**反向扫描**即可，无需 DESC 索引）

CREATE TABLE `follow` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
    user_id BIGINT NOT NULL COMMENT '关注者ID',
    follow_user_id BIGINT NOT NULL COMMENT '被关注者ID',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '关注时间',

    UNIQUE KEY uk_follow (user_id, follow_user_id),
    KEY idx_follow_user (follow_user_id),
    KEY idx_follow_user_time (user_id, create_time)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='关注关系表';


-- =========================
-- 3. 分类表 category
-- =========================
-- 索引说明（旧版这张表**只有主键**，是最大的缺口）：
--   🆕 idx_category_user_sort(user_id, sort)
--        「分类列表」是 `WHERE user_id=? AND is_delete=0 ORDER BY sort`
--   🆕 idx_category_user_parent_name(user_id, parent_id, name)
--        两个用途：① 查子分类 `WHERE user_id=? AND parent_id=?`
--                  ② 同层重名校验 `WHERE user_id=? AND parent_id=? AND name=?`
--        （纯等值查询，三列顺序不敏感；放 name 在最后还能做覆盖索引）

CREATE TABLE `category` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '分类ID',
    user_id BIGINT NOT NULL COMMENT '所属用户ID',
    name VARCHAR(100) NOT NULL COMMENT '分类名称',
    parent_id BIGINT DEFAULT 0 COMMENT '父分类ID',
    sort INT DEFAULT 0 COMMENT '排序',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    is_delete TINYINT DEFAULT 0 COMMENT '逻辑删除',

    KEY idx_category_user_sort (user_id, sort),
    KEY idx_category_user_parent_name (user_id, parent_id, name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='分类表';


-- =========================
-- 4. 标签表 tag
-- =========================
-- 索引说明：uk_tag_name 保证标签名唯一；其余按主键查。

CREATE TABLE `tag` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '标签ID',
    name VARCHAR(50) NOT NULL COMMENT '标签名称',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',

    UNIQUE KEY uk_tag_name (name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='标签表';


-- =========================
-- 5. 笔记表 note
-- =========================
-- 索引说明：
--   🆕 idx_note_vis_status_time(visibility, status, is_delete, create_time)
--        「公开笔记列表」是
--          `WHERE is_delete=0 AND visibility=1 AND status=1 ORDER BY create_time DESC`
--        前三个都是等值条件，最后一列 create_time 直接吃下排序 → 消除 filesort。
--   🆕 idx_note_user_time(user_id, is_delete, create_time)
--        「我的笔记」有两条路径，都靠它：
--          · 数据库分页：`WHERE user_id=? AND is_delete=0 [AND visibility/status/category_id]
--                         ORDER BY create_time DESC`
--          · AI 工具检索（NoteMapper.xml myQueryNoteList）：同上
--        可选条件放在 is_delete 之后不影响排序可用性，代价是它们只能做回表后过滤。
--   ❌ 删掉旧的 idx_note_user(user_id) —— 它是上面这个新索引的最左前缀，纯冗余。

CREATE TABLE `note` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '笔记ID',
    user_id BIGINT NOT NULL COMMENT '所属用户ID',
    category_id BIGINT DEFAULT NULL COMMENT '分类ID',
    title VARCHAR(255) NOT NULL COMMENT '笔记标题',
    content TEXT COMMENT 'Markdown笔记内容',
    summary TEXT COMMENT '笔记摘要',
    cover VARCHAR(255) DEFAULT NULL COMMENT '封面地址',
    visibility TINYINT DEFAULT 0 COMMENT '可见性 0私密 1公开',
    status TINYINT DEFAULT 1 COMMENT '状态 0草稿 1正常',
    word_count INT DEFAULT 0 COMMENT '字数统计',
    view_count BIGINT DEFAULT 0 COMMENT '浏览数量',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    is_delete TINYINT DEFAULT 0 COMMENT '逻辑删除',

    KEY idx_note_vis_status_time (visibility, status, is_delete, create_time),
    KEY idx_note_user_time (user_id, is_delete, create_time)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='笔记表';


-- =========================
-- 6. 笔记-标签关联表 note_tag
-- =========================
-- 索引说明：uk_note_tag 供「按笔记查标签」+ 去重；idx_note_tag_tag 供「按标签查笔记」。

CREATE TABLE `note_tag` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
    note_id BIGINT NOT NULL COMMENT '笔记ID',
    tag_id BIGINT NOT NULL COMMENT '标签ID',

    UNIQUE KEY uk_note_tag (note_id, tag_id),
    KEY idx_note_tag_tag (tag_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='笔记标签关联表';


-- =========================
-- 7. 文章表 article
-- =========================
-- 索引说明：
--   idx_article_user(user_id) —— 「我的文章」`WHERE user_id=? [AND status=?]`（无 ORDER BY）
--                                以及个人主页的文章计数
--   🆕 idx_article_status_time(status, is_delete, create_time)
--        覆盖四条主查询路径，它们都是
--          `WHERE is_delete=0 AND status=1 ORDER BY create_time DESC`
--        · 文章列表（ArticleServiceImpl.articleList）
--        · 最新文章（latestArticleList）
--        · 标签下文章（articleListByTag）
--        · AI 工具检索（ArticleMapper.xml AiqueryArticleList / linkArticle）
--        等值条件在前、排序列在后 → 消除 filesort。
--        （热门榜走 Redis ZSet，**不需要**为 view_count 建索引）

CREATE TABLE `article` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '文章ID',
    user_id BIGINT NOT NULL COMMENT '作者ID',
    title VARCHAR(255) NOT NULL COMMENT '文章标题',
    content TEXT COMMENT '文章内容',
    summary TEXT COMMENT '文章摘要',
    cover VARCHAR(255) DEFAULT NULL COMMENT '封面',
    view_count BIGINT DEFAULT 0 COMMENT '浏览量',
    like_count BIGINT DEFAULT 0 COMMENT '点赞数量',
    favorite_count BIGINT DEFAULT 0 COMMENT '收藏数量',
    status TINYINT DEFAULT 1 COMMENT '状态',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    is_delete TINYINT DEFAULT 0 COMMENT '逻辑删除',

    KEY idx_article_user (user_id),
    KEY idx_article_status_time (status, is_delete, create_time)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='文章表';


-- =========================
-- 8. 文章-标签关联表 article_tag
-- =========================
-- 索引说明：同 note_tag。

CREATE TABLE `article_tag` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
    article_id BIGINT NOT NULL COMMENT '文章ID',
    tag_id BIGINT NOT NULL COMMENT '标签ID',

    UNIQUE KEY uk_article_tag (article_id, tag_id),
    KEY idx_article_tag_tag (tag_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='文章标签关联表';


-- =========================
-- 9. 评论表 comment
-- =========================
-- 索引说明：
--   idx_article_parent_time(article_id, parent_id, create_time)
--        · 一级评论：`WHERE article_id=? AND parent_id=0 ORDER BY create_time ASC`
--        · 二级回复：`WHERE article_id=? AND parent_id IN (...) ORDER BY create_time ASC`
--        三列顺序与查询完全吻合 → 无 filesort。
--   ❌ 删掉旧的 idx_comment_article(article_id) —— 它是上面这个索引的最左前缀，纯冗余。
--   🆕 idx_comment_parent(parent_id)
--        删父评论时连带删子评论：`WHERE parent_id=?`。
--        旧索引以 article_id 打头，**单查 parent_id 用不上它**，只能全表扫。
--        （这是写路径上的查询，价值中等；表很大时才明显）

CREATE TABLE `comment` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '评论ID',
    article_id BIGINT NOT NULL COMMENT '文章ID',
    user_id BIGINT NOT NULL COMMENT '评论用户ID',
    parent_id BIGINT DEFAULT 0 COMMENT '父评论ID',
    content TEXT NOT NULL COMMENT '评论内容',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    is_delete TINYINT DEFAULT 0 COMMENT '逻辑删除',
    reply_user_id BIGINT DEFAULT NULL COMMENT '被回复用户id，仅二级评论有值',
    reply_comment_id BIGINT DEFAULT NULL COMMENT '被回复的那条评论id，仅二级评论有值',

    KEY idx_article_parent_time (article_id, parent_id, create_time),
    KEY idx_comment_parent (parent_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='评论表';


-- =========================
-- 10. 文章点赞表 article_like
-- =========================
-- 索引说明：uk_article_like(article_id, user_id) 正好是全部查询的形态
--           （点赞/取消/是否已赞），不需要额外索引。

CREATE TABLE `article_like` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '点赞ID',
    article_id BIGINT NOT NULL COMMENT '文章ID',
    user_id BIGINT NOT NULL COMMENT '用户ID',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '点赞时间',

    UNIQUE KEY uk_article_like (article_id, user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='文章点赞表';


-- =========================
-- 11. 文章收藏表 favorite
-- =========================
-- 索引说明：
--   uk_favorite(article_id, user_id) —— 收藏/取消/是否已收藏（正好这两列）
--   🆕 idx_favorite_user(user_id)    —— 「我的收藏」是 `WHERE user_id=?`。
--        旧唯一索引**以 article_id 打头，按 user_id 单独查用不上**，会全表扫。

CREATE TABLE `favorite` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '收藏ID',
    article_id BIGINT NOT NULL COMMENT '文章ID',
    user_id BIGINT NOT NULL COMMENT '用户ID',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '收藏时间',

    UNIQUE KEY uk_favorite (article_id, user_id),
    KEY idx_favorite_user (user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='文章收藏表';


-- =========================
-- 12. 站内通知表 message（v2 新增）
-- =========================
-- 索引说明：
--   通知列表：`WHERE user_id=? [AND type=?] ORDER BY is_read ASC, create_time DESC`
--   🆕 idx_message_user_read_time(user_id, is_read, create_time DESC)
--        ⚠️ 这里**必须带 DESC**：排序方向是「is_read 升序 + create_time 降序」这种
--        **混合方向**，普通的全 ASC 索引吃不下，会退化成 filesort。
--        MySQL 8.0 支持降序索引，正好对上。
--        （对比：article/note 那种单一方向的 `ORDER BY create_time DESC`，
--          用 ASC 索引反向扫描就够了，不需要 DESC）
--   未读数：`WHERE user_id=? AND is_read=0` → 走新索引的最左前缀 (user_id, is_read) ✓
--   ❌ 删掉旧的 idx_message_user_read(user_id, is_read) —— 被新索引的最左前缀覆盖。
--   ⚠️ 旧的 idx_message_user_time(user_id, create_time) **保留**：
--      目前没找到只按 (user_id, create_time) 查询的地方，疑似已无用；
--      但「没找到」不等于「不存在」，先留着观察，确认后再删。

CREATE TABLE `message` (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL COMMENT '接收通知的用户ID',
    from_user_id BIGINT NOT NULL COMMENT '触发通知的用户ID',
    type TINYINT NOT NULL COMMENT '1=被点赞 2=被评论 3=被关注',
    article_id BIGINT DEFAULT NULL COMMENT '关联文章ID',
    comment_id BIGINT DEFAULT NULL COMMENT '关联评论ID',
    content VARCHAR(255) DEFAULT NULL COMMENT '通知内容',
    is_read TINYINT DEFAULT 0 COMMENT '0=未读 1=已读',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,

    KEY idx_message_user_time (user_id, create_time),
    KEY idx_message_user_read_time (user_id, is_read, create_time DESC)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='站内通知表';


-- =========================
-- 13. AI 会话表 ai_conversation
-- =========================
-- 索引说明（旧版这张表**只有主键**）：
--   🆕 idx_ai_conversation_user(user_id, id)
--        「会话列表」是 `WHERE user_id=?`（AiConversationServiceImpl）。
--        带上 id 是为了让返回顺序**确定**（旧版只靠主键扫描顺序，属于实现细节，不可依赖）。
--        删除/改标题是 `WHERE id=? AND user_id=?`，走主键 + 回表即可。

CREATE TABLE `ai_conversation` (
    id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    title VARCHAR(250) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    title_generated TINYINT NOT NULL DEFAULT 0,

    PRIMARY KEY (id),
    KEY idx_ai_conversation_user (user_id, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT ='AI 会话表';


-- =========================
-- 14. Spring AI 会话记忆表 spring_ai_chat_memory（框架表）
-- =========================
-- 说明：这张表由 Spring AI 在应用启动时按
--       `spring.ai.chat.memory.repository.jdbc.schema`（initialize-schema: always）
--       自动创建，**正常不需要手工建**。这里列出来只是为了让脚本自足。
-- 索引说明：conversation_id + timestamp 是框架自己定义的，保持原样。

CREATE TABLE IF NOT EXISTS `spring_ai_chat_memory` (
    id BIGINT NOT NULL AUTO_INCREMENT,
    conversation_id VARCHAR(36) NOT NULL,
    content TEXT NOT NULL,
    type VARCHAR(10) NOT NULL,
    timestamp TIMESTAMP NOT NULL,

    PRIMARY KEY (id) USING BTREE,
    KEY SPRING_AI_CHAT_MEMORY_CONVERSATION_ID_TIMESTAMP_IDX (conversation_id, timestamp) USING BTREE,
    CONSTRAINT TYPE_CHECK CHECK (type IN ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;


-- ============================================================================
-- 索引调整一览
-- ----------------------------------------------------------------------------
-- 🆕 新增 10 个（都有代码里的真实查询作为依据）
--   1. article          idx_article_status_time (status, is_delete, create_time)
--   2. note             idx_note_vis_status_time (visibility, status, is_delete, create_time)
--   3. note             idx_note_user_time (user_id, is_delete, create_time)
--   4. category         idx_category_user_sort (user_id, sort)
--   5. category         idx_category_user_parent_name (user_id, parent_id, name)
--   6. ai_conversation  idx_ai_conversation_user (user_id, id)
--   7. favorite         idx_favorite_user (user_id)
--   8. message          idx_message_user_read_time (user_id, is_read, create_time DESC)
--   9. follow           idx_follow_user_time (user_id, create_time)
--  10. comment          idx_comment_parent (parent_id)
--
-- ❌ 删除 3 个冗余索引（都是别的索引的最左前缀，只增加写成本、不提供查询价值）
--   1. note.idx_note_user (user_id)                     → 被 idx_note_user_time 覆盖
--   2. comment.idx_comment_article (article_id)         → 被 idx_article_parent_time 覆盖
--   3. message.idx_message_user_read (user_id, is_read) → 被 idx_message_user_read_time 覆盖
--
-- 📌 两条通用经验
--   · 软删除字段 is_delete：MyBatis-Plus 的 @TableLogic 会给每条 wrapper 查询都拼上
--     `is_delete = 0`（XML 手写 SQL 里也是显式写的）。把它放在
--     「等值条件之后、排序列之前」当等值列用，既能过滤又不破坏索引的有序性。
--   · 排序方向：单一方向的 ORDER BY（如 create_time DESC）用普通 ASC 索引
--     **反向扫描**即可；只有**混合方向**（如 is_read ASC, create_time DESC）
--     才需要真正的 DESC 索引。
-- ============================================================================
