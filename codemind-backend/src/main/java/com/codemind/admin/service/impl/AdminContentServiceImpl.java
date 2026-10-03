package com.codemind.admin.service.impl;

import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.admin.service.AdminContentService;
import com.codemind.admin.vo.AdminArticleVO;
import com.codemind.admin.vo.AdminCommentVO;
import com.codemind.admin.vo.AdminNoteVO;
import com.codemind.ai.rag.dto.RagMessageDTO;
import com.codemind.common.ArticleConstants;
import com.codemind.common.NoteConstants;
import com.codemind.common.RagConstants;
import com.codemind.common.RedisKeyConstants;
import com.codemind.common.Result;
import com.codemind.community.dto.CacheMessage;
import com.codemind.community.entity.Article;
import com.codemind.community.entity.Comment;
import com.codemind.community.service.ArticleService;
import com.codemind.community.service.CommentService;
import com.codemind.community.vo.UserSimpleVO;
import com.codemind.config.RabbitConfig;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.knowledge.entity.Note;
import com.codemind.knowledge.service.NoteService;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.UserMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Collectors;

@Slf4j
@Service
public class AdminContentServiceImpl implements AdminContentService {

    @Autowired
    private ArticleService articleService;
    @Autowired
    private NoteService noteService;
    @Autowired
    private CommentService commentService;
    @Autowired
    private UserMapper userMapper;
    @Autowired
    private StringRedisTemplate redisTemplate;
    @Autowired
    private RabbitTemplate rabbitTemplate;

    // ================================ 文章 ================================

    @Override
    public Result<Page<AdminArticleVO>> articleList(Integer page, Integer size, String keyword, Integer status) {
        Page<Article> articlePage = new Page<>(page, size);
        articleService.page(articlePage, new LambdaQueryWrapper<Article>()
                .like(StrUtil.isNotBlank(keyword), Article::getTitle, keyword)
                .eq(status != null, Article::getStatus, status)
                .orderByDesc(Article::getCreateTime));

        List<Article> records = articlePage.getRecords();
        Map<Long, UserSimpleVO> authorMap = loadAuthors(
                records.stream().map(Article::getUserId).toList());

        Page<AdminArticleVO> voPage = new Page<>();
        voPage.setRecords(records.stream().map(article -> {
            AdminArticleVO vo = new AdminArticleVO();
            // Article 的 content 在 VO 里没有同名字段，不会被拷过来 —— 这正是我们要的
            BeanUtils.copyProperties(article, vo);
            vo.setAuthor(authorMap.get(article.getUserId()));
            return vo;
        }).toList());
        fillPageMeta(voPage, articlePage);
        return Result.success(voPage);
    }

    @Override
    public Result<Void> updateArticleStatus(Long articleId, Integer status) {
        if (!ArticleConstants.ARTICLE_STATUS_PUBLIC.equals(status)
                && !ArticleConstants.ARTICLE_STATUS_DRAFT.equals(status)) {
            throw BusinessException.badRequest("文章状态不合法");
        }
        Article article = articleService.getById(articleId);
        if (article == null) {
            throw BusinessException.notFound("文章不存在");
        }
        if (status.equals(article.getStatus())) {
            return Result.success("操作成功");
        }
        articleService.update(new LambdaUpdateWrapper<Article>()
                .eq(Article::getId, articleId)
                .set(Article::getStatus, status));

        // ↓ 这三步与 ArticleServiceImpl.updateArticle 的状态分支保持一致。
        //   少做任何一步都会出现「库里已下架，但缓存/热门榜/向量库还当它是公开的」这种不一致 ——
        //   尤其 RAG：不删向量的话，下架的文章依然会被 AI 检索到并引用。
        redisTemplate.delete(RedisKeyConstants.ARTICLE_DETAIL_KEY + articleId);
        rabbitTemplate.convertAndSend(RabbitConfig.EXCHANGE, "cache",
                new CacheMessage(articleId, UUID.randomUUID().toString()));

        RagMessageDTO rag = new RagMessageDTO();
        rag.setType(RagConstants.VECTOR_ARTICLE_TYPE);
        rag.setArticleId(articleId);
        rag.setUuid(UUID.randomUUID().toString());
        if (ArticleConstants.ARTICLE_STATUS_PUBLIC.equals(status)) {
            rag.setOperation(RagConstants.OPERATION_UPDATE);
            rag.setJson(JSONUtil.toJsonStr(articleService.getById(articleId)));
        } else {
            rag.setOperation(RagConstants.OPERATION_DELETE);
            redisTemplate.opsForZSet().remove(RedisKeyConstants.ARTICLE_HOT_KEY, String.valueOf(articleId));
        }
        rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE, "rag.update.delete", rag);

        log.info("管理员 {} 将文章 {} 的状态改为 {}", UserContext.getUserId(), articleId, status);
        return Result.success(ArticleConstants.ARTICLE_STATUS_PUBLIC.equals(status) ? "已恢复" : "已下架");
    }

    @Override
    public Result<Void> deleteArticle(Long articleId) {
        Article article = articleService.getById(articleId);
        if (article == null) {
            throw BusinessException.notFound("文章不存在");
        }
        log.info("管理员 {} 删除文章 {}（作者 {}）", UserContext.getUserId(), articleId, article.getUserId());
        return runAs(article.getUserId(), () -> articleService.deleteArticle(articleId));
    }

    // ================================ 笔记 ================================

    @Override
    public Result<Page<AdminNoteVO>> noteList(Integer page, Integer size, String keyword, Integer status, Integer visibility) {
        Page<Note> notePage = new Page<>(page, size);
        noteService.page(notePage, new LambdaQueryWrapper<Note>()
                .like(StrUtil.isNotBlank(keyword), Note::getTitle, keyword)
                .eq(status != null, Note::getStatus, status)
                .eq(visibility != null, Note::getVisibility, visibility)
                .orderByDesc(Note::getCreateTime));

        List<Note> records = notePage.getRecords();
        Map<Long, UserSimpleVO> authorMap = loadAuthors(
                records.stream().map(Note::getUserId).toList());

        Page<AdminNoteVO> voPage = new Page<>();
        voPage.setRecords(records.stream().map(note -> {
            AdminNoteVO vo = new AdminNoteVO();
            BeanUtils.copyProperties(note, vo);
            vo.setAuthor(authorMap.get(note.getUserId()));
            return vo;
        }).toList());
        fillPageMeta(voPage, notePage);
        return Result.success(voPage);
    }

    @Override
    public Result<Void> updateNoteStatus(Long noteId, Integer status) {
        if (!NoteConstants.NOTE_STATUS_NORMAL.equals(status)
                && !NoteConstants.NOTE_STATUS_DRAFT.equals(status)) {
            throw BusinessException.badRequest("笔记状态不合法");
        }
        Note note = noteService.getById(noteId);
        if (note == null) {
            throw BusinessException.notFound("笔记不存在");
        }
        if (status.equals(note.getStatus())) {
            return Result.success("操作成功");
        }
        noteService.update(new LambdaUpdateWrapper<Note>()
                .eq(Note::getId, noteId)
                .set(Note::getStatus, status));

        // 「这条笔记该不该进向量库」的完整条件是 visibility=1 且 status=1
        // —— 见 NoteServiceImpl.createNote 的向量化条件，以及 getNote 里
        // 「私密笔记」和「草稿笔记」两道只能作者本人看的校验。
        //
        // 只看 status 会踩一个隐私坑：私密笔记(visibility=0)被置为 status=1 时，
        // 会被误判成「已恢复」而送进向量库 —— 私密内容就此进了 AI 知识库、可被检索引用。
        // 管理员改的是 status，但要不要向量化必须把 visibility 一起算进来。
        boolean shouldBeVectorized = NoteConstants.NOTE_STATUS_NORMAL.equals(status)
                && NoteConstants.NOTE_VISIBILITY_PUBLIC.equals(note.getVisibility());

        // 笔记没有 Redis 详情缓存（RedisKeyConstants 里没有 note 相关 key），
        // 所以只需同步向量库，不用像文章那样删缓存 + 清热门榜
        RagMessageDTO rag = new RagMessageDTO();
        rag.setType(RagConstants.VECTOR_NOTE_TYPE);
        rag.setNoteId(noteId);
        rag.setUuid(UUID.randomUUID().toString());
        if (shouldBeVectorized) {
            rag.setOperation(RagConstants.OPERATION_UPDATE);
            // 重新查一次拿改后的 status，直接序列化上面那个 note 会把旧 status 发给向量库
            rag.setJson(JSONUtil.toJsonStr(noteService.getById(noteId)));
        } else {
            rag.setOperation(RagConstants.OPERATION_DELETE);
        }
        rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE, "rag.update.delete", rag);

        log.info("管理员 {} 将笔记 {} 的状态改为 {}", UserContext.getUserId(), noteId, status);
        return Result.success(NoteConstants.NOTE_STATUS_NORMAL.equals(status) ? "已恢复" : "已下架");
    }

    @Override
    public Result<Void> deleteNote(Long noteId) {
        Note note = noteService.getById(noteId);
        if (note == null) {
            throw BusinessException.notFound("笔记不存在");
        }
        log.info("管理员 {} 删除笔记 {}（作者 {}）", UserContext.getUserId(), noteId, note.getUserId());
        return runAs(note.getUserId(), () -> noteService.deleteNote(noteId));
    }

    // ================================ 评论 ================================

    @Override
    public Result<Page<AdminCommentVO>> commentList(Integer page, Integer size, Long articleId, String keyword) {
        Page<Comment> commentPage = new Page<>(page, size);
        commentService.page(commentPage, new LambdaQueryWrapper<Comment>()
                .eq(articleId != null, Comment::getArticleId, articleId)
                .like(StrUtil.isNotBlank(keyword), Comment::getContent, keyword)
                .orderByDesc(Comment::getCreateTime));

        List<Comment> records = commentPage.getRecords();
        Map<Long, UserSimpleVO> authorMap = loadAuthors(
                records.stream().map(Comment::getUserId).toList());

        Page<AdminCommentVO> voPage = new Page<>();
        voPage.setRecords(records.stream().map(comment -> {
            AdminCommentVO vo = new AdminCommentVO();
            BeanUtils.copyProperties(comment, vo);
            vo.setAuthor(authorMap.get(comment.getUserId()));
            return vo;
        }).toList());
        fillPageMeta(voPage, commentPage);
        return Result.success(voPage);
    }

    @Override
    public Result<Void> deleteComment(Long commentId) {
        Comment comment = commentService.getById(commentId);
        if (comment == null) {
            throw BusinessException.notFound("评论不存在");
        }
        log.info("管理员 {} 删除评论 {}（作者 {}）", UserContext.getUserId(), commentId, comment.getUserId());
        // 复用业务删除：删一级评论时会连带删掉它的全部回复，这条规则必须保持一致
        return runAs(comment.getUserId(), () -> commentService.deleteComment(commentId));
    }

    // ================================ 私有工具 ================================

    /**
     * 以「资源属主」的身份执行一次调用。
     *
     * <p>业务层的删除方法都带归属校验（不是作者就直接 403），管理员天然不满足；
     * 但删除的<b>副作用</b>（清关联表 / Redis 缓存 / 热门榜 / 发 RAG 删向量消息）
     * 必须与作者自己删除时<b>完全一致</b> —— 直接 removeById 会留下孤儿向量和脏缓存。
     *
     * <p>所以这里临时把 UserContext 换成属主再调用，用完恢复：
     * 既不重复业务逻辑（不会随业务改动而漂移），也不去改已经验证过的业务代码。
     */
    private <T> T runAs(Long userId, Supplier<T> action) {
        Long original = UserContext.getUserId();
        try {
            UserContext.setUserId(userId);
            return action.get();
        } finally {
            UserContext.setUserId(original);
        }
    }

    /** 按页批量查作者，避免逐行查库（N+1） */
    private Map<Long, UserSimpleVO> loadAuthors(List<Long> userIds) {
        List<Long> ids = userIds.stream().filter(Objects::nonNull).distinct().toList();
        if (ids.isEmpty()) {
            return Map.of();
        }
        return userMapper.selectList(new LambdaQueryWrapper<User>()
                        .select(User::getId, User::getUserName, User::getAvatar, User::getIntro)
                        .in(User::getId, ids))
                .stream()
                .collect(Collectors.toMap(User::getId, user -> {
                    UserSimpleVO vo = new UserSimpleVO();
                    BeanUtils.copyProperties(user, vo);
                    return vo;
                }));
    }

    /** 分页元数据搬运。不搬的话 new Page<>() 的 size/current 会停在默认值 10/1 */
    private void fillPageMeta(Page<?> target, Page<?> source) {
        target.setTotal(source.getTotal());
        target.setSize(source.getSize());
        target.setCurrent(source.getCurrent());
        target.setPages(source.getPages());
    }
}
