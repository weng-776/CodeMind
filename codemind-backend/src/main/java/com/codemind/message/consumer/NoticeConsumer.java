package com.codemind.message.consumer;

import com.codemind.config.RabbitConfig;
import com.codemind.message.dto.MessageCommentDTO;
import com.codemind.message.dto.MessageFollowDTO;
import com.codemind.message.dto.MessageLikeDTO;
import com.codemind.message.entity.Notification;
import com.codemind.message.service.MessageService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.util.ObjectUtils;

import java.util.concurrent.TimeUnit;
@Slf4j
@Component
public class NoticeConsumer {
    @Autowired
    private StringRedisTemplate stringRedisTemplate;
    @Autowired
    private MessageService messageService;
    @RabbitListener(queues = RabbitConfig.FOLLOW_NOTICE_QUEUE,containerFactory = "rabbitListenerContainerFactory")
    public void followMessage(MessageFollowDTO messageFollowDTO) {
        //幂等key
        String key = "codemind:message:follow:notice:"+messageFollowDTO.getMessageId();
        try {
            //确认数据不为空
            if (ObjectUtils.isEmpty(messageFollowDTO)){
                throw new RuntimeException("数据为空");
            }
            //redis确认幂等
            Boolean aBoolean = stringRedisTemplate.opsForValue().setIfAbsent(key, "1", 2, TimeUnit.MINUTES);
            //复制过去
            if (Boolean.TRUE.equals(aBoolean)){
                Notification message = new Notification();
                BeanUtils.copyProperties(messageFollowDTO,message);
                //保存
                messageService.save(message);
            }

        } catch (Exception e) {
            //删除标记
            stringRedisTemplate.delete(key);
            log.error("消息通知消费失败，messageId={}",
                    messageFollowDTO.getMessageId(), e);
            throw e;
        }

    }
    //点赞文章消息
    @RabbitListener(queues = RabbitConfig.LIKE_NOTICE_QUEUE,containerFactory = "rabbitListenerContainerFactory")
    public void likeMessage(MessageLikeDTO messageLikeDTO) {
        //幂等key
        String key = "codemind:message:like:notice:"+messageLikeDTO.getMessageId();
        try {
            //确认数据不为空
            if (ObjectUtils.isEmpty(messageLikeDTO)){
                throw new RuntimeException("数据为空");
            }
            //redis确认幂等
            Boolean aBoolean = stringRedisTemplate.opsForValue().setIfAbsent(key, "1", 2, TimeUnit.MINUTES);

            //复制过去
            if (Boolean.TRUE.equals(aBoolean)){
                Notification message = new Notification();
                BeanUtils.copyProperties(messageLikeDTO,message);
                // 消费端 save 前：
                if (ObjectUtils.isEmpty(message.getUserId()) || message.getUserId().equals(message.getFromUserId())) {
                    // 自嗨通知直接丢弃
                    return;
                }
                //保存
                messageService.save(message);
            }

        } catch (Exception e) {
            //删除标记
            stringRedisTemplate.delete(key);
            log.error("消息通知消费失败，messageId={}",
                    messageLikeDTO.getMessageId(), e);
           throw e;
        }

    }

    //评论文章消息
    @RabbitListener(queues = RabbitConfig.COMMENT_NOTICE_QUEUE,containerFactory = "rabbitListenerContainerFactory")
    public void commentMessage(MessageCommentDTO messageCommentDTO) {
        //幂等key
        String key = "codemind:message:comment:notice:"+messageCommentDTO.getMessageId();
        try {
            //确认数据不为空
            if (ObjectUtils.isEmpty(messageCommentDTO)){
                throw new RuntimeException("数据为空");
            }
            //redis确认幂等
            Boolean aBoolean = stringRedisTemplate.opsForValue().setIfAbsent(key, "1", 2, TimeUnit.MINUTES);
            //复制过去
            if (Boolean.TRUE.equals(aBoolean)){
                Notification message = new Notification();
                BeanUtils.copyProperties(messageCommentDTO,message);
                // 消费端 save 前：
                if (ObjectUtils.isEmpty(message.getUserId()) || message.getUserId().equals(message.getFromUserId())) {
                    // 自嗨通知直接丢弃
                    return;
                }
                //保存
                messageService.save(message);
            }


        } catch (Exception e) {
            //删除标记
            log.error("消息通知消费失败，messageId={}",
                    messageCommentDTO.getMessageId(), e);
            stringRedisTemplate.delete(key);
          throw e;
        }

    }
}
