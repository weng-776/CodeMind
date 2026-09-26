package com.codemind.community.consumer;

import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.codemind.common.RedisKeyConstants;
import com.codemind.community.dto.CacheMessage;
import com.codemind.community.dto.CountMessage;
import com.codemind.community.entity.Article;
import com.codemind.community.service.ArticleService;
import com.codemind.community.vo.ArticleDetailVO;
import com.codemind.config.RabbitConfig;
import com.rabbitmq.client.Channel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.support.AmqpHeaders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.concurrent.TimeUnit;
@Slf4j
@Component
public class CountConsumer {
    //处理发过来的消息
    @Autowired
    private ArticleService articleService;
    @Autowired
    private StringRedisTemplate redisTemplate;

    @RabbitListener(queues = RabbitConfig.COUNT_QUEUE)
    public void onMessage(CountMessage message , Channel channel, @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws Exception {
        String idemKey = "codemind:msg:count:" + message.getMessageId();
        //获取消息并存入redis 做幂等判断
        try {
            Boolean first = redisTemplate.opsForValue().setIfAbsent(idemKey
                    , "1", 2, TimeUnit.SECONDS);

            if (Boolean.TRUE.equals(first)) {
                //更新数据库
                LambdaUpdateWrapper<Article> wrapper = new LambdaUpdateWrapper<Article>().eq(Article::getId, message.getArticleId())
                        .setSql("like_count = like_count + " + message.getDelta());
                boolean updated = articleService.update(wrapper);
                if (!updated){
                    throw new RuntimeException("计数失败");
                }
            }
            //手动返回ack
            channel.basicAck(tag,false);

        } catch (Exception e) {
            //删除标记
            redisTemplate.delete(idemKey);
            log.error("计数消费失败，messageId={}",
                    message.getMessageId(), e);
           channel.basicNack(tag,false,true);
        }
    }


    @RabbitListener(queues = RabbitConfig.VIEW_QUEUE)
    public void ViewMessage(CountMessage message , Channel channel, @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws Exception {
        //获取消息并存入redis 做幂等判断
        String idemKey = "codemind:msg:viewMsg:" + message.getMessageId();
        try {
            Boolean first = redisTemplate.opsForValue().setIfAbsent(idemKey

                    , "1", 2, TimeUnit.SECONDS);

            if (Boolean.TRUE.equals(first)) {
                //更新数据库
                LambdaUpdateWrapper<Article> wrapper = new LambdaUpdateWrapper<Article>().eq(Article::getId, message.getArticleId())
                        .setSql("view_count = view_count + " + message.getDelta());
                boolean updated = articleService.update(wrapper);
                if (!updated){
                    throw new RuntimeException("计数失败");
                }
            }
            //手动返回ack
            channel.basicAck(tag,false);
        } catch (Exception e) {
            redisTemplate.delete(idemKey);
            log.error("计数消费失败，messageId={}",
                    message.getMessageId(), e);
            channel.basicNack(tag,false,true);
        }
    }
    @RabbitListener(queues = RabbitConfig.CACHE_QUEUE)
    public void cacheMessages(CacheMessage message,Channel channel, @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws Exception {
        //删除缓存 有三次重试机制删除
        //手动确认ack
        try {
            redisTemplate.delete(RedisKeyConstants.ARTICLE_DETAIL_KEY+message.getArticleId());
            channel.basicAck(tag,false);
        } catch (Exception e) {
            channel.basicNack(tag,false,true);
            log.error("计数消费失败，messageId={}",
                    message.getMessageId(), e);
            throw e;
        }
    }

    //发布文章初始到详情缓存 以及 热门文章缓存
    @RabbitListener(queues = RabbitConfig.ARTICLE_QUEUE)
    public void articleMessages(Long articleId, Channel channel,
                                @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
        try {
            //★ BUG-34：本方法原先的方法签名里既没有 Channel/tag，也没有 basicAck。
            //  全局配置 acknowledge-mode=manual，没有 ack 的消息会永久停留在 unacked 状态，
            //  broker 每次应用重启都会把它重新投递 —— 于是已删除 / 已转草稿的文章 id
            //  被反复塞回热榜 ZSet，任何对热榜的手工清理都不持久（重启即复活）。
            //  修复分两步：① 补上 basicAck；② 入池前查库校验，只有「存在且 status=1」的公开文章才允许入池。
            Article article = articleService.getById(articleId);
            if (article == null) {
                // 查不到有两种可能：a) 历史脏消息（该文章已被删除）；
                // b) createArticle 的事务尚未提交（消息在事务内发出，存在正常竞态窗口）。
                // 两种情况都不应写池；且此处刻意不做 remove，避免误删池里的合法成员
                // —— 从池里移除由 updateArticle / deleteArticle 的同步路径负责。
                log.warn("文章入热榜时查不到该文章，跳过。articleId={}", articleId);
            } else if (article.getStatus() != null && article.getStatus() == 1) {
                //缓存热门文章分数
                redisTemplate.opsForZSet().add(RedisKeyConstants.ARTICLE_HOT_KEY, String.valueOf(articleId), 0);
            } else {
                // 文章存在但非公开（草稿）：确保它不在热榜池中（幂等兜底，主清理在 updateArticle）
                redisTemplate.opsForZSet().remove(RedisKeyConstants.ARTICLE_HOT_KEY, String.valueOf(articleId));
            }
            //手动返回ack
            channel.basicAck(tag, false);
        } catch (Exception e) {
            log.error("文章入热榜消费失败，articleId={}", articleId, e);
            channel.basicNack(tag, false, true);
        }
    }
}
