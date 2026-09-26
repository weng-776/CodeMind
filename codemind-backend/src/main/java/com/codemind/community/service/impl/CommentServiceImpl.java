package com.codemind.community.service.impl;

import cn.hutool.core.util.StrUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.ai.entity.search.SearchComment;
import com.codemind.common.MessageConstants;
import com.codemind.common.Result;
import com.codemind.community.dto.ReleaseCommentDTO;
import com.codemind.community.entity.Article;
import com.codemind.community.entity.Comment;
import com.codemind.community.service.ArticleService;
import com.codemind.community.service.CommentService;
import com.codemind.community.mapper.CommentMapper;
import com.codemind.community.vo.CommentVO;
import com.codemind.community.vo.UserSimpleVO;
import com.codemind.config.RabbitConfig;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.message.dto.MessageCommentDTO;
import com.codemind.message.service.MessageService;
import com.codemind.user.entity.User;
import com.codemind.user.service.UserService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.ObjectUtils;

import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
* @author wengjiaran
* @description 针对表【comment(评论表)】的数据库操作Service实现
* @createDate 2026-08-07 20:22:27
*/
@Slf4j
@Service
public class CommentServiceImpl extends ServiceImpl<CommentMapper, Comment>
    implements CommentService{
    @Autowired
    private UserService userService;
    @Lazy
    @Autowired
    private ArticleService articleService;
    @Autowired
    private RabbitTemplate rabbitTemplate;
    @Autowired
    private MessageService messageService;
    //评论分页上限：对外接口和 AI 工具共用同一套规则，避免两处各写一个 Math.min 导致行为不一致
    private static final int DEFAULT_PAGE_SIZE = 10;
    private static final int MAX_PAGE_SIZE = 50;
    //发布/回复评论
    @Override
    public Result<Long> releaseComment(ReleaseCommentDTO releaseCommentDTO) {
        //获取评论用户id
        Long userId = UserContext.getUserId();
        //校验文章是否存在
        Article article = articleService.getById(releaseCommentDTO.getArticleId());
        if (ObjectUtils.isEmpty(article)) {
            throw BusinessException.notFound("文章不存在");
        }
        Comment comment = new Comment();
        //校验评论内容
        BeanUtils.copyProperties(releaseCommentDTO,comment);
        //兜底：未传 / 显式传 null 时按一级评论处理（避免 Long 拆箱 NPE）
        if (ObjectUtils.isEmpty(comment.getParentId())) {
            comment.setParentId(0L);
        }
        //是否一级评论：必须在 parentId 上浮之前判定
        boolean isRootComment = comment.getParentId() == 0;
        //被回复的那条评论（仅回复场景有值）
        Comment fatherComment = null;
        if (!isRootComment){
            //记录「回复的是哪一条」：上浮会丢掉这个信息，必须在改动前留副本
            comment.setReplyCommentId(comment.getParentId());
            //查被回复的那条评论：id 不存在 / 已被逻辑删除 / 属于其他文章，都会查不到
            fatherComment = getOne(new LambdaQueryWrapper<Comment>().eq(Comment::getArticleId, comment.getArticleId())
                    .eq(Comment::getId, comment.getParentId()));
            if (ObjectUtils.isEmpty(fatherComment)) {
                throw BusinessException.notFound("被回复的评论不存在或已被删除");
            }
            //父评论的 parentId 为 0 说明它本身就是根，否则上浮到它所属的根
            Long fatherParentId = fatherComment.getParentId();
            comment.setParentId(ObjectUtils.isEmpty(fatherParentId) || fatherParentId == 0L
                    ? fatherComment.getId()
                    : fatherParentId);
            comment.setReplyUserId(fatherComment.getUserId());
        }

        //保存信息
        comment.setUserId(userId);
        save(comment);
        //发送消息模块
        //被通知人：一级评论通知文章作者，回复通知被回复那条的作者
        Long toUserId = isRootComment ? article.getUserId() : fatherComment.getUserId();
        //自己评论自己的文章 / 自己回复自己，都不发通知
        if (ObjectUtils.isEmpty(toUserId) || toUserId.equals(userId)) {
            return Result.success(comment.getId());
        }
        //获取用户信息
        User user = userService.getById(userId);
        //通知文案：toUserId 已在上面确定，这里只按场景组装文案
        String content;
        if (isRootComment){
            //一级评论：通知文章作者
            content = String.format("%s评论了你的文章:%s", user.getUserName(),
                    StrUtil.maxLength(comment.getContent(), 50));
        }else {
            //回复评论：通知被回复那条的作者（即 fatherComment 的作者）
            content = String.format("%s回复了你的评论:%s", user.getUserName(),
                    StrUtil.maxLength(comment.getContent(), 50));
        }
        //数据封装返回
        MessageCommentDTO messageComment = new MessageCommentDTO();
        messageComment.setUserId(toUserId);
        messageComment.setArticleId(comment.getArticleId());
        messageComment.setCommentId(comment.getId());
        messageComment.setIsRead(0);
        messageComment.setType(MessageConstants.MESSAGE_TYPE_COMMENT);
        messageComment.setFromUserId(userId);
        messageComment.setContent(content);
        messageComment.setMessageId(UUID.randomUUID().toString());
        //发送消息：通知失败不能让评论本身失败，否则用户重发会产生重复评论
        try {
            rabbitTemplate.convertAndSend(RabbitConfig.NOTICE_EXCHANGE,"comment.notice",messageComment);
        } catch (Exception e) {
            log.error("评论通知发送失败, commentId={}", comment.getId(), e);
        }
        //返回id
        return Result.success(comment.getId());
    }

    //3.15 删除评论（逻辑删除自己的评论；删一级评论时连带删除其下全部回复）
    @Override
    @Transactional(rollbackFor = Exception.class)
    public Result<Void> deleteComment(Long commentId) {

         Long userId = UserContext.getUserId();
        if (ObjectUtils.isEmpty(commentId)) {
            throw BusinessException.badRequest("评论ID不能为空");
        }
        //先查出来判权限：否则删别人的评论影响 0 行，却依然返回"操作成功"（静默成功）
        //存在性(404)与归属(403)分开报，替代原先两处都用同一句「评论不存在或无权删除」的写法（BUG-06）
        Comment comment = getById(commentId);
        if (ObjectUtils.isEmpty(comment)) {
            log.warn("评论不存在或已被删除 commentId={}", commentId);
            throw BusinessException.notFound("评论不存在或已被删除");
        }
        if (!userId.equals(comment.getUserId())) {
            log.warn("无权删除该评论 commentId={}", commentId);
            throw BusinessException.forbidden("无权删除该评论");
        }
        //删的是一级评论时，连带逻辑删除它下面的全部回复
        //压平后回复的 parentId 恒等于所属根的 id，所以一条条件即可覆盖所有回复（不再需要递归）
        Long parentId = comment.getParentId();
        if (ObjectUtils.isEmpty(parentId) || parentId == 0L) {
            remove(new LambdaQueryWrapper<Comment>()
                    .eq(Comment::getParentId, commentId));  // 逻辑删除，@TableLogic 自动改写为 UPDATE
        }
        removeById(commentId);// 逻辑删除
        return Result.success("操作成功");
    }

    //3.16 查看评论列表（分页，按时间正序）
    @Override
    public Result<Page<CommentVO>> commentList(Long articleId, Integer page, Integer size) {
        //根据文章id查询该文章下面的顶级评论
        Page<Comment> commentPage = new Page<>(page, size);
        page(commentPage,new LambdaQueryWrapper<Comment>()
                .eq(Comment::getArticleId,articleId)
                .eq(Comment::getParentId,0L).orderByAsc(Comment::getCreateTime));
        //校验是否为空
        List<Comment> rootCommentList = commentPage.getRecords();
        if (ObjectUtils.isEmpty(rootCommentList)){
            log.info("评论为空");
            return Result.success(toVOPage(commentPage, List.of()));
        }
        //一级评论 id
        List<Long> rootCommentIdList = rootCommentList.stream()
                .map(Comment::getId)
                .toList();

        // 查询这些一级评论下面的所有回复
        List<Comment> childCommentList = list(
                new LambdaQueryWrapper<Comment>()
                        .eq(Comment::getArticleId, articleId)
                        .in(Comment::getParentId, rootCommentIdList)
                        .orderByAsc(Comment::getCreateTime)
        );
        //按 parentId 分组
        Map<Long, List<Comment>> commentMap = childCommentList.stream()
                .collect(Collectors.groupingBy(Comment::getParentId));

        //批量查用户：作者与被回复人都要并进集合，否则「回复 @某某」会空白
        Map<Long, UserSimpleVO> userSimpleVOMap = buildUserMap(
                collectUserIds(Stream.concat(childCommentList.stream(), rootCommentList.stream()).toList()));
        //组装：每条根带前 2 条回复 + 回复总数
        List<CommentVO> commentVOList = rootCommentList.stream().map(rootcomment -> {
            //实体转 VO（user / replyUser 由公共方法统一填充）
            CommentVO commentVO = toCommentVO(rootcomment, userSimpleVOMap);
            //回复已一次 IN 全量查回，size 即总数，不需要再查库 count
            List<Comment> rootReplies = commentMap.getOrDefault(rootcomment.getId(), List.of());
            commentVO.setReplyCount(rootReplies.size());
            //只带前 2 条给前端预览，其余走 GET /api/comment/{rootId}/replies 分页拉
            commentVO.setReplies(rootReplies.stream().limit(2)
                    .map(t -> toCommentVO(t, userSimpleVOMap))
                    .toList());
            return commentVO;
        }).toList();
        //返回
        return Result.success(toVOPage(commentPage, commentVOList));
    }

    @Override
    public Page<CommentVO> queryCommentListTool(SearchComment comment) {
        //分页规则与对外接口完全一致：这里不再自己 Math.min，统一交给 commentList → buildPage 处理
        Result<Page<CommentVO>> commentList = this.commentList(comment.getArticleId(), comment.getPage(), comment.getSize());
        return commentList.getData();
    }
    //查看回复列表
    @Override
    public Result<Page<CommentVO>> replyList(Long rootId, Integer page, Integer size) {
        //查询这个评论信息
        Comment rootComment = getById(rootId);
        if (ObjectUtils.isEmpty(rootComment)){
            throw BusinessException.notFound("未找到相关评论");
        }
        Page<Comment> commentPage = new Page<>(page, size);
        //根据父id校验是不是一级评论：不是则返回空页
        if (!ObjectUtils.isEmpty(rootComment.getParentId()) && rootComment.getParentId() !=0L){
            return Result.success(toVOPage(commentPage, List.of()));
        }
        //分页查询该根下面的全部回复（正序）
        page(commentPage, new LambdaQueryWrapper<Comment>()
                .eq(Comment::getArticleId, rootComment.getArticleId())
                .eq(Comment::getParentId, rootId)
                .orderByAsc(Comment::getCreateTime));
        List<Comment> commentList = commentPage.getRecords();
        //没回复直接返回空页，不去查用户表（空集合会让 MyBatis-Plus 生成 id IN ()）
        if (ObjectUtils.isEmpty(commentList)){
            return Result.success(toVOPage(commentPage, List.of()));
        }
        //扁平列表：填 user / replyUser，replies 与 replyCount 留 null（层级到此为止）
        Map<Long, UserSimpleVO> userSimpleVOMap = buildUserMap(collectUserIds(commentList));
        List<CommentVO> commentVOList = commentList.stream()
                .map(comment -> toCommentVO(comment, userSimpleVOMap))
                .toList();
        return Result.success(toVOPage(commentPage, commentVOList));
    }

    // =========================
    // 评论模块公共方法
    // =========================

    /**
     * 统一分页参数：page 最小 1，size 落在 [1, MAX_PAGE_SIZE]。
     * 对外接口（绕过校验直接调 Service 的场景，例如 AI 工具）和正常请求走同一套规则，
     * 保证「分页上限」只有一个定义。
     */
    private Page<Comment> buildPage(Integer page, Integer size) {
        int safePage = (ObjectUtils.isEmpty(page) || page < 1) ? 1 : page;
        int safeSize = (ObjectUtils.isEmpty(size) || size < 1) ? DEFAULT_PAGE_SIZE : Math.min(size, MAX_PAGE_SIZE);
        return new Page<>(safePage, safeSize);
    }

    /**
     * 实体转 VO：拷贝字段并填充评论人 / 被回复人。
     * 一级评论的 replyUser 天然为 null（reply_user_id 为空），前端据此不渲染「回复 @」。
     */
    private CommentVO toCommentVO(Comment comment, Map<Long, UserSimpleVO> userMap) {
        CommentVO commentVO = new CommentVO();
        BeanUtils.copyProperties(comment, commentVO);
        commentVO.setUser(userMap.get(comment.getUserId()));
        commentVO.setReplyUser(userMap.get(comment.getReplyUserId()));
        return commentVO;
    }

    /**
     * 收集评论涉及的全部用户 id：作者 + 被回复人。
     * 被回复人必须一起收：他可能不在本批数据里（例如他只在根评论位置出现，或他那条已被删除），
     * 漏掉不会报错，只会让前端「回复 @某某」偶尔空白，属于最难查的那类问题。
     */
    private List<Long> collectUserIds(Collection<Comment> commentList) {
        return commentList.stream()
                .flatMap(c -> Stream.of(c.getUserId(), c.getReplyUserId()))
                .filter(Objects::nonNull)
                .distinct()
                .toList();
    }

    /**
     * 批量查用户并转成 id → UserSimpleVO。
     * 空集合直接返回空 Map：否则 MyBatis-Plus 会生成 id IN ()，MySQL 直接报语法错误。
     */
    private Map<Long, UserSimpleVO> buildUserMap(Collection<Long> userIdList) {
        if (ObjectUtils.isEmpty(userIdList)) {
            return Collections.emptyMap();
        }
        return userService.list(new LambdaQueryWrapper<User>().in(User::getId, userIdList)).stream()
                .map(user -> {
                    UserSimpleVO userSimpleVO = new UserSimpleVO();
                    BeanUtils.copyProperties(user, userSimpleVO);
                    return userSimpleVO;
                })
                .collect(Collectors.toMap(UserSimpleVO::getId, t -> t));
    }

    /**
     * 用实体分页对象的分页信息构造 VO 分页壳（current / size / total 一次带全），
     * 省掉每个接口手工 set 四个字段。records 由调用方传入。
     */
    private Page<CommentVO> toVOPage(Page<Comment> commentPage, List<CommentVO> records) {
        Page<CommentVO> commentVOPage = new Page<>(
                commentPage.getCurrent(), commentPage.getSize(), commentPage.getTotal());
        commentVOPage.setRecords(records);
        return commentVOPage;
    }

}




