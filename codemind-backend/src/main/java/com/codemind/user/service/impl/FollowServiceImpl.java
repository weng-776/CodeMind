package com.codemind.user.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.common.MessageConstants;
import com.codemind.common.Result;
import com.codemind.community.entity.Article;
import com.codemind.community.mapper.ArticleMapper;
import com.codemind.config.RabbitConfig;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.message.dto.MessageFollowDTO;
import com.codemind.user.entity.Follow;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.UserMapper;
import com.codemind.user.service.FollowService;
import com.codemind.user.mapper.FollowMapper;
import com.codemind.user.vo.UserFollowVO;
import io.swagger.v3.oas.models.security.SecurityScheme;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.util.ObjectUtils;

import java.util.*;
import java.util.stream.Collectors;

/**
* @author wengjiaran
* @description 针对表【follow(关注关系表)】的数据库操作Service实现
* @createDate 2026-08-07 20:18:26
*/
@Slf4j
@Service
public class FollowServiceImpl extends ServiceImpl<FollowMapper, Follow>
    implements FollowService{

    @Autowired
    private  FollowMapper followMapper;
    @Autowired
    private UserMapper userMapper;
    @Autowired
    private ArticleMapper articleMapper;
    @Autowired
    private RabbitTemplate rabbitTemplate;
    //关注用户
    @Override
    public Result<Void> followUser(Long followUserId) {
        //路径参数是不为空的
        //拿到关注者id
        Long userId = UserContext.getUserId();
        //不能关注自己
        if (userId.equals(followUserId)){
            log.info("不能关注自己");
            throw BusinessException.badRequest("不能自己关注自己");
        }
        //不能关注不存在的人
        User user = userMapper.selectById(followUserId);
        if (user == null){
            log.info("该用户不存在");
            throw BusinessException.notFound("该用户不存在");
        }
        //封装数据插入
        Follow follow = new Follow();
        follow.setUserId(userId);
        follow.setFollowUserId(followUserId);
        try {
            save(follow);
            //发送消息到mq做通知消息处理
            //new 发送消息的实体
            User users = userMapper.selectById(userId);
            MessageFollowDTO messageFollowDTO = new MessageFollowDTO();
            messageFollowDTO.setUserId(followUserId);
            messageFollowDTO.setFromUserId(userId);
            messageFollowDTO.setType(MessageConstants.MESSAGE_TYPE_FOLLOW);
            messageFollowDTO.setContent(users.getUserName()+"关注了你！");
            //0未读
            messageFollowDTO.setIsRead(0);
            messageFollowDTO.setMessageId(UUID.randomUUID().toString());
            //发送消息
            rabbitTemplate.convertAndSend(RabbitConfig.NOTICE_EXCHANGE,"follow.notice",messageFollowDTO);

        }catch (DuplicateKeyException e){
            //唯一索引 uk_follow(user_id, follow_user_id) 冲突,说明已关注,幂等返回成功
            log.info("重复关注 userId={}, followUserId={}", userId, followUserId);
            return Result.success("已关注");
        }

        //返回
        return Result.success("关注成功");
    }
    //取消关注
    @Override
    public Result<Void> cancelFollow(Long followUserId) {
        //拿到取消关注的用户id
        Long userId = UserContext.getUserId();
        LambdaQueryWrapper<Follow> wrapper = new LambdaQueryWrapper<Follow>().eq(Follow::getFollowUserId, followUserId).eq(Follow::getUserId, userId);

        //取消关注做成幂等：没关注过也返回成功，不当作错误（与 cancelLike 取消点赞的行为保持一致）。
        //原来的 catch(DuplicateKeyException) 是死分支——DELETE 不可能撞唯一索引，
        //所以「未关注该用户」这句报错从来没生效过，意图和实际行为不一致，这里改成显式判断
        boolean removed = remove(wrapper);
        if (!removed) {
            log.info("未关注该用户，取消关注幂等返回 userId={}, followUserId={}", userId, followUserId);
        }
        return Result.success("取消关注成功");
    }
    // 我的关注列表
    @Override
    public Result<Page<UserFollowVO>> myFollowList(Integer page, Integer size) {
        // 1. 从上下文获取用户id
        Long userId = UserContext.getUserId();
        // 2. 在 Follow 表上进行分页
        //    按关注时间倒序，最近关注的排前面
        Page<Follow> followPage = new Page<>(page, size);
        LambdaQueryWrapper<Follow> wrapper =
                new LambdaQueryWrapper<Follow>()
                        .eq(Follow::getUserId, userId)
                        .orderByDesc(Follow::getCreateTime);

        Page<Follow> selectPage = page(followPage, wrapper);
        // 3. 获取当前页的 Follow 记录
        List<Follow> followList = selectPage.getRecords();
        // 4. 获取当前页关注用户的 id
        List<Long> followsId = followList.stream()
                .map(Follow::getFollowUserId)
                .toList();
        // 5. 创建返回分页对象
        Page<UserFollowVO> userFollowVOPage = new Page<>();
        // 当前页没有关注用户，直接返回分页信息
        if (ObjectUtils.isEmpty(followList)) {
            userFollowVOPage.setPages(selectPage.getPages());
            userFollowVOPage.setTotal(selectPage.getTotal());
            userFollowVOPage.setSize(selectPage.getSize());
            userFollowVOPage.setCurrent(selectPage.getCurrent());
            return Result.success(userFollowVOPage);
        }
        // 6. 根据当前页的用户id，批量查询用户信息
        Map<Long, User> userMap = userMapper.selectList(
                new LambdaQueryWrapper<User>()
                        .in(User::getId, followsId)
        ).stream().collect(
                Collectors.toMap(
                        User::getId,
                        user -> user
                )
        );
        // 7. 查询这些用户的关注数
        Map<Long, Integer> followMap = followMapper.selectMaps(
                new QueryWrapper<Follow>()
                        .select("user_id", "count(*) as cnt")
                        .in("user_id", followsId)
                        .groupBy("user_id")
        ).stream().collect(
                Collectors.toMap(
                        t -> ((Number) t.get("user_id")).longValue(),
                        t -> ((Number) t.get("cnt")).intValue()
                )
        );
        // 8. 查询这些用户的粉丝数
        Map<Long, Integer> fansMap = followMapper.selectMaps(
                new QueryWrapper<Follow>()
                        .select("follow_user_id", "count(*) as follow_count")
                        .in("follow_user_id", followsId)
                        .groupBy("follow_user_id")
        ).stream().collect(
                Collectors.toMap(
                        t -> ((Number) t.get("follow_user_id")).longValue(),
                        t -> ((Number) t.get("follow_count")).intValue()
                )
        );
        // 9. 查询这些用户的文章数
        Map<Long, Integer> articleMap = articleMapper.selectMaps(
                new QueryWrapper<Article>()
                        .select("user_id", "count(*) as article_count")
                        .in("user_id", followsId)
                        .groupBy("user_id")
        ).stream().collect(
                Collectors.toMap(
                        t -> ((Number) t.get("user_id")).longValue(),
                        t -> ((Number) t.get("article_count")).intValue()
                )
        );

        // 10. 设置分页信息
        userFollowVOPage.setPages(selectPage.getPages());
        userFollowVOPage.setTotal(selectPage.getTotal());
        userFollowVOPage.setSize(selectPage.getSize());
        userFollowVOPage.setCurrent(selectPage.getCurrent());
        // 11. 组装 VO
        List<UserFollowVO> userFollowVOList = new ArrayList<>();

        // 注意：这里直接遍历 followList
        // followList 的顺序就是 create_time DESC 的顺序
        for (Follow follow : followList) {

            // 被关注用户id
            Long followId = follow.getFollowUserId();
            // 关注时间
            Date createTime = follow.getCreateTime();
            UserFollowVO userFollowVO = new UserFollowVO();
            // 12. 获取用户基本信息
            User user = userMap.get(followId);
            if (user == null) {
                continue;
            }
            BeanUtils.copyProperties(user, userFollowVO);
            // 13. 设置关注数
            userFollowVO.setFollowCount(
                    followMap.getOrDefault(followId, 0)
            );
            // 14. 设置粉丝数
            userFollowVO.setFansCount(
                    fansMap.getOrDefault(followId, 0)
            );
            // 15. 设置文章数
            userFollowVO.setArticleCount(
                    articleMap.getOrDefault(followId, 0)
            );
            // 16. 设置关注时间
            // 注意：这里使用 Follow 的 createTime
            // 而不是 User 的 createTime
            userFollowVO.setCreateTime(createTime);
            userFollowVOList.add(userFollowVO);
        }
        // 17. 设置 records
        userFollowVOPage.setRecords(userFollowVOList);

        return Result.success(userFollowVOPage);
    }
    //粉丝列表
    @Override
    public Result<Page<UserFollowVO>> myFansList(Integer page, Integer size) {
        //根据上下文拿到用户id
        Long userId = UserContext.getUserId();
        //根据id查询用户粉丝数拿到粉丝id列表
        Page<Follow> followPage = new Page<>(page, size);
        LambdaQueryWrapper<Follow> wrapper =
                new LambdaQueryWrapper<Follow>()
                        .eq(Follow::getFollowUserId, userId)
                        .orderByDesc(Follow::getCreateTime);
        Page<Follow> selectPage = page(followPage, wrapper);
        // 3. 获取当前页的 Follow 记录
        List<Follow> followList = selectPage.getRecords();
        //获取粉丝id
        List<Long> userFansList = followList.stream().map(t -> t.getUserId())
                .collect(Collectors.toList());
        //返回数据模型
        Page<UserFollowVO> userFollowVOPage = new Page<>();
        //如果为空直接返回
        //分页元数据仍要按真实请求回显：直接返回 new Page<>() 会带出默认值 size=10 / current=1，和传入的 size 对不上
        if (ObjectUtils.isEmpty(userFansList)) {
            userFollowVOPage.setPages(selectPage.getPages());
            userFollowVOPage.setTotal(selectPage.getTotal());
            userFollowVOPage.setSize(selectPage.getSize());
            userFollowVOPage.setCurrent(selectPage.getCurrent());
            return  Result.success(userFollowVOPage);
        }
        //查询粉丝基本信息
        Map<Long, User> userMap = userMapper.selectList(
                new LambdaQueryWrapper<User>()
                        .in(User::getId, userFansList)
        ).stream().collect(
                Collectors.toMap(
                        User::getId,
                        user -> user
                )
        );
        //根据粉丝id查询粉丝的关注数目 //粉丝数目 笔记数目
        //粉丝关注数目
        Map<Long, Integer> followCount = followMapper.selectMaps(new QueryWrapper<Follow>().select("user_id", "count(*) as cot")
                        .in("user_id", userFansList)
                        .groupBy("user_id")).stream()
                .collect(Collectors.toMap(t -> (Long) t.get("user_id"), t -> ((Number) t.get("cot")).intValue()));
        //粉丝数目
        Map<Long, Integer> fansCount = followMapper.selectMaps(new QueryWrapper<Follow>().select("follow_user_id", "count(*) as cot")
                        .in("follow_user_id", userFansList)
                        .groupBy("follow_user_id")).stream()
                .collect(Collectors.toMap(t -> (Long) t.get("follow_user_id"), t -> ((Number) t.get("cot")).intValue()));
        //封装数据返回

        //文章数目
        Map<Long, Integer> articleCount = articleMapper.selectMaps(new QueryWrapper<Article>().select("user_id", "count(*) as article_count")
                .in("user_id", userFansList)
                .groupBy("user_id")).stream().collect(Collectors.toMap(t -> (Long) t.get("user_id"), t -> ((Number) t.get("article_count")).intValue()));

        //封装数据返回
        userFollowVOPage.setCurrent(selectPage.getCurrent());
        userFollowVOPage.setPages(selectPage.getPages());
        userFollowVOPage.setTotal(selectPage.getTotal());
        userFollowVOPage.setSize(selectPage.getSize());
        List<UserFollowVO> userFollowVOList = new ArrayList<>();

        for (Follow record : followList) {
            UserFollowVO userFollowVO = new UserFollowVO();
            //获取粉丝id
            Long fensUserId = record.getUserId();
            //获取粉丝基本信息
            User user = userMap.get(fensUserId);
            //拷贝信息
            BeanUtils.copyProperties(user, userFollowVO);
            userFollowVO.setFollowCount(followCount.getOrDefault(fensUserId,0));
            userFollowVO.setFansCount(fansCount.getOrDefault(fensUserId,0));
            userFollowVO.setArticleCount(articleCount.getOrDefault(fensUserId,0));
            userFollowVO.setCreateTime(record.getCreateTime());
            userFollowVOList.add(userFollowVO);
        }
        userFollowVOPage.setRecords(userFollowVOList);
        return Result.success(userFollowVOPage);
    }
    //判断关注状态
    @Override
    public Result<Boolean> isFollowStatus(Long userId) {
        //从上下文拿到用户id
        Long userId1 = UserContext.getUserId();
        //根据俩个id去表查
        long count = count(new LambdaQueryWrapper<Follow>().eq(Follow::getFollowUserId, userId).eq(Follow::getUserId, userId1));
        //无数据表示没关注
        if (count == 0) {
            log.info("没关注");
           return Result.success(false,"没有关注该用户");
        }

        //有数据表示关注
        //返回
        return Result.success(true);
    }
}




