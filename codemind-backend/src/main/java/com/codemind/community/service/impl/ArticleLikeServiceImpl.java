package com.codemind.community.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.common.MessageConstants;
import com.codemind.common.RedisKeyConstants;
import com.codemind.common.Result;
import com.codemind.community.dto.CountMessage;
import com.codemind.community.entity.Article;
import com.codemind.community.entity.ArticleLike;
import com.codemind.community.service.ArticleLikeService;
import com.codemind.community.mapper.ArticleLikeMapper;
import com.codemind.community.service.ArticleService;
import com.codemind.config.RabbitConfig;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.message.dto.MessageLikeDTO;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.UserMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.ObjectUtils;

import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
* @author wengjiaran
* @description 针对表【article_like(文章点赞表)】的数据库操作Service实现
* @createDate 2026-08-07 20:22:27
*/
@Slf4j
@Service
public class ArticleLikeServiceImpl extends ServiceImpl<ArticleLikeMapper, ArticleLike>
    implements ArticleLikeService{
    @Lazy
    @Autowired
    private ArticleService articleService;
    @Autowired
    private StringRedisTemplate redisTemplate;
    @Autowired
    private RabbitTemplate rabbitTemplate;
    @Autowired
    private UserMapper userMapper;
    //点赞文章
    @Transactional(rollbackFor =    Exception.class)
    @Override
    public Result<Void> likeArticle(Long articleId) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //查询文章
        Article article = articleService.getById(articleId);
        if (ObjectUtils.isEmpty(article)) {
            throw BusinessException.notFound("文章不存在");
        }
        //new 点赞对象
        ArticleLike articleLike = new ArticleLike();
        articleLike.setArticleId(articleId);
        articleLike.setUserId(userId);
        //保存信息
        try {
            save(articleLike);
            //没报错使用redis实时拿到数据
            String likeKey = RedisKeyConstants.ARTICLE_LIKE_KEY + articleId;
            //★ BUG-32：计数器冷启动。Redis 计数器若不存在（首次点赞 / 被清理 / key 过期），
            //  直接 INCR 会从 0 起算，而详情接口以它为准 → 库里的历史点赞数会被抹成 1。
            //  所以先拿「库里当前值」兜底初始化，再自增。setIfAbsent 保证只在 key 缺失时写入。
            redisTemplate.opsForValue().setIfAbsent(likeKey,
                    String.valueOf(ObjectUtils.isEmpty(article.getLikeCount()) ? 0L : article.getLikeCount()),
                    RedisKeyConstants.COUNT_KEY_TTL, TimeUnit.DAYS);
            redisTemplate.opsForValue().increment(likeKey, 1);
            //通过mq异步落库
            CountMessage mse = new CountMessage(articleId, 1, UUID.randomUUID().toString());
            rabbitTemplate.convertAndSend(RabbitConfig.EXCHANGE,"count",mse);
            //异步发送消息给通知模块通知作者有人喜欢该文章
            //获取作者信息
            //获取点赞人信息
            User user = userMapper.selectById(userId);
            //封装数据发送
            MessageLikeDTO messageLikeDTO = new MessageLikeDTO();
            messageLikeDTO.setUserId(article.getUserId());
            messageLikeDTO.setArticleId(articleId);
            messageLikeDTO.setMessageId(UUID.randomUUID().toString());
            messageLikeDTO.setFromUserId(userId);
            messageLikeDTO.setType(MessageConstants.MESSAGE_TYPE_LIKE);
            messageLikeDTO.setIsRead(0);
            messageLikeDTO.setContent("用户:"+user.getUserName()+"点赞了你的文章!");
            //发送数据
            rabbitTemplate.convertAndSend(RabbitConfig.NOTICE_EXCHANGE,"like.notice",messageLikeDTO);
        }catch (DuplicateKeyException e){
            //唯一索引 uk_follow(uarticle_id,user_id) 冲突,说明已点赞,幂等返回成功
            log.info("幂等重复点赞"); //
           return Result.success("不可重复点击");
        }
        //返回
        return Result.success("操作成功");
    }

    //取消点赞
    @Transactional(rollbackFor =   Exception.class)
    @Override
    public Result<Void> cancelLike(Long articleId) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //删除条件
        LambdaQueryWrapper<ArticleLike> wrapper = new LambdaQueryWrapper<ArticleLike>().eq(ArticleLike::getArticleId, articleId).eq(ArticleLike::getUserId, userId);
        //删除
        boolean removed = remove(wrapper);
        //只有确实删除成功（之前点过赞）才递减计数，避免未点赞也 -1 造成计数漂移/负数
        if (removed) {
//            articleService.update(new LambdaUpdateWrapper<Article>()
//                    .eq(Article::getId,articleId).setSql("like_count = like_count-1"));
            //★ BUG-29：原来只发 MQ 减库、漏了 Redis 计数器 —— 而详情接口读的正是 Redis 计数器，
            //  导致取消点赞后详情永远显示旧的高值（该 key 无 TTL，不会自愈）。
            String likeKey = RedisKeyConstants.ARTICLE_LIKE_KEY + articleId;
            //同样先兜底初始化：用「减之前」的库值，再 DECR 才等于真实值；
            //否则 key 不存在时 DECR 会得到 -1（Redis 从 0 起减）。
            Article article = articleService.getById(articleId);
            if (!ObjectUtils.isEmpty(article)) {
                redisTemplate.opsForValue().setIfAbsent(likeKey,
                        String.valueOf(ObjectUtils.isEmpty(article.getLikeCount()) ? 0L : article.getLikeCount()),
                        RedisKeyConstants.COUNT_KEY_TTL, TimeUnit.DAYS);
            }
            redisTemplate.opsForValue().decrement(likeKey, 1);
            CountMessage message = new CountMessage(articleId, -1, UUID.randomUUID().toString());
            rabbitTemplate.convertAndSend(RabbitConfig.EXCHANGE,"count",message);
        }

        return Result.success("操作成功");
    }

    //判断点赞状态
    @Override
    public Result<Boolean> checkLikeStatus(Long articleId) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //构造条件查询count 如果等于0没点赞
        LambdaQueryWrapper<ArticleLike> wrapper = new LambdaQueryWrapper<ArticleLike>().eq(ArticleLike::getArticleId, articleId).eq(ArticleLike::getUserId, userId);
        Boolean flag = true;
        long count = count(wrapper);
        if (count ==0){
            flag = false;
        }
        //返回
        return Result.success(flag);
    }
}




