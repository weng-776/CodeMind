package com.codemind.message.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.common.Result;
import com.codemind.community.entity.Article;
import com.codemind.community.entity.Comment;
import com.codemind.community.mapper.ArticleMapper;
import com.codemind.community.mapper.CommentMapper;
import com.codemind.community.vo.UserSimpleVO;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.message.entity.Notification;
import com.codemind.message.service.MessageService;
import com.codemind.message.mapper.MessageMapper;
import com.codemind.message.vo.NotifyVO;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.UserMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.util.ObjectUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
* @author wengjiaran
* @description 针对表【message(站内通知表)】的数据库操作Service实现
* @createDate 2026-08-24 15:56:49
*/
@Slf4j
@Service
public class MessageServiceImpl extends ServiceImpl<MessageMapper, Notification>
    implements MessageService{
    @Autowired
    private UserMapper userMapper;
    @Autowired
    private ArticleMapper articleMapper;
    @Autowired
    private CommentMapper commentMapper;

    @Override
    public Result<Page<NotifyVO>> myMessageList(Integer page, Integer size, Integer type) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //查询message表分页查eq为用户id
        Page<Notification> messagePage = new Page<>(page,size);

        page(messagePage,new LambdaQueryWrapper<Notification>()
                .eq(Notification::getUserId,userId)
                .eq(!ObjectUtils.isEmpty(type),Notification::getType,type)
                .orderByAsc(Notification::getIsRead)
                .orderByDesc(Notification::getCreateTime));
        Page<NotifyVO> notifyPage = new Page<>();
        if (ObjectUtils.isEmpty(messagePage.getRecords())) {
            //分页元数据按真实请求回显：只设 total=0 会让 size/current 停在 new Page<>() 的默认值 10 / 1
            notifyPage.setSize(messagePage.getSize());
            notifyPage.setCurrent(messagePage.getCurrent());
            notifyPage.setTotal(messagePage.getTotal());
            notifyPage.setPages(messagePage.getPages());
            notifyPage.setRecords(new ArrayList<>());
            return Result.success(notifyPage);
        }
        //获取触发人的id
        List<Long> fromUserIdList = messagePage.getRecords().stream().distinct().map(Notification::getFromUserId).toList();
        //根据id批量查用户表
        List<User> userList = userMapper.selectList(new LambdaQueryWrapper<User>().in(User::getId, fromUserIdList));
        //变成map  id  UserSimpleVO
        Map<Long, UserSimpleVO> userMap = userList.stream().collect(Collectors.toMap(
                User::getId, t -> {
                    UserSimpleVO userSimpleVO = new UserSimpleVO();
                    BeanUtils.copyProperties(t, userSimpleVO);
                    return userSimpleVO;
                }
        ));
        //★ 目标存活校验：通知是「事件流水」，不随文章/评论删除而清理（社区模块删文章/删评论时并不碰 message 表），
        //  所以失效判定放在读侧做 —— 否则前端只能点进去撞 404，且分不清是「文章没了」还是「评论没了」。
        //  Article / Comment 都是 @TableLogic 逻辑删除，MP 的 selectList 会自动带 is_delete=0，
        //  因此「查不到存活记录」等价于「已删除或不存在」。只取 id 列，按页批量查，最多各 1 次。
        List<Long> articleIdList = messagePage.getRecords().stream()
                .map(Notification::getArticleId).filter(Objects::nonNull).distinct().toList();
        List<Long> commentIdList = messagePage.getRecords().stream()
                .map(Notification::getCommentId).filter(Objects::nonNull).distinct().toList();

        Set<Long> aliveArticleIds = articleIdList.isEmpty() ? Set.<Long>of()
                : articleMapper.selectList(new LambdaQueryWrapper<Article>()
                        .select(Article::getId).in(Article::getId, articleIdList))
                .stream().map(Article::getId).collect(Collectors.toSet());
        Set<Long> aliveCommentIds = commentIdList.isEmpty() ? Set.<Long>of()
                : commentMapper.selectList(new LambdaQueryWrapper<Comment>()
                        .select(Comment::getId).in(Comment::getId, commentIdList))
                .stream().map(Comment::getId).collect(Collectors.toSet());

        //封装数据
        List<NotifyVO> notifyVOList = new ArrayList<>();
        for (Notification message : messagePage.getRecords()) {
            NotifyVO notifyVO = new NotifyVO();
            BeanUtils.copyProperties(message, notifyVO);
            notifyVO.setFromUser(userMap.get(message.getFromUserId()));
            //目标为 null（type3 关注通知）时不算失效；非 null 且不在存活集合里 → 已删除
            notifyVO.setArticleDeleted(message.getArticleId() != null && !aliveArticleIds.contains(message.getArticleId()));
            notifyVO.setCommentDeleted(message.getCommentId() != null && !aliveCommentIds.contains(message.getCommentId()));
            notifyVOList.add(notifyVO);
        }
        notifyPage.setRecords(notifyVOList);
        notifyPage.setTotal(messagePage.getTotal());
        notifyPage.setSize(messagePage.getSize());
        notifyPage.setCurrent(messagePage.getCurrent());
        notifyPage.setPages(messagePage.getPages());
        //返回
        return Result.success(notifyPage);
    }
    //未读数量
    @Override
    public Result<Long> unreadNumber() {
        Long userId = UserContext.getUserId();
        long count = count(new LambdaQueryWrapper<Notification>()
                .eq(Notification::getUserId, userId).eq(Notification::getIsRead, 0));
        return Result.success(count);
    }
    //标记某条已读
    @Override
    public Result<Void> markRead(Long notifyId) {
        Long userId = UserContext.getUserId();
        //先查存在性与归属。原来只看「更新影响行数」，会把两种正常情况误判成错误：
        //  ① 通知不存在 / 是别人的 —— 该报 404 / 403，却统一报「不存在，或无权操作」
        Notification notification = getById(notifyId);
        if (notification == null) {
            log.warn("通知不存在 notifyId={}", notifyId);
            throw BusinessException.notFound("通知不存在");
        }
        if (!userId.equals(notification.getUserId())) {
            log.warn("无权操作他人通知 notifyId={}", notifyId);
            throw BusinessException.forbidden("无权操作该通知");
        }
        //已经是已读状态就不再重复更新，直接返回成功
        if (Integer.valueOf(1).equals(notification.getIsRead())) {
            return Result.success("操作成功");
        }
        update(new LambdaUpdateWrapper<Notification>()
                .eq(Notification::getId, notifyId)
                .eq(Notification::getUserId, userId)
                .set(Notification::getIsRead, 1));
        return Result.success("操作成功");
    }
    //全部已读
    @Override
    public Result<Void> ReadAll() {
        Long userId = UserContext.getUserId();
        LambdaUpdateWrapper<Notification> wrapper = new LambdaUpdateWrapper<Notification>()
                .eq(Notification::getUserId, userId)
                .set(Notification::getIsRead, 1);

        int affected = baseMapper.update(null, wrapper);

        log.info("全部已读 userId={}, 影响行数={}", userId, affected);
        return Result.success("操作成功");
    }
    //删除某一条消息
    @Override
    public Result<Void> deleteMessage(Long notifyId) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //获取消息校验是否是一个用户
        Notification notification = getById(notifyId);
        if (ObjectUtils.isEmpty(notification)) {
            throw BusinessException.notFound("消息不存在");
        }
        if (!userId.equals(notification.getUserId())) {
            throw BusinessException.forbidden("无权操作");
        }
        //删除操作
        remove(new LambdaQueryWrapper<Notification>().eq(Notification::getUserId, userId)
                .eq(Notification::getId,notifyId));
        return Result.success("删除成功");
    }

}




