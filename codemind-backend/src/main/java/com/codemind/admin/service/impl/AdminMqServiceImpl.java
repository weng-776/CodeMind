package com.codemind.admin.service.impl;

import com.codemind.admin.service.AdminMqService;
import com.codemind.admin.vo.AdminQueueVO;
import com.codemind.common.RabbitQueueConstants;
import com.codemind.common.Result;
import com.codemind.config.RabbitConfig;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.GetResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.amqp.core.QueueInformation;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Service
public class AdminMqServiceImpl implements AdminMqService {

    /**
     * 单次重投上限。
     * 死信积压可能很大，一次请求全量重投既慢又没法中断，分批更可控；
     * 没重投完的下一轮再来一次即可（响应里会告诉前端还剩多少）。
     */
    private static final int MAX_REPLAY_PER_REQUEST = 500;

    /**
     * 死信队列 → 原始去向 的<b>静态回退表</b>（与 {@link RabbitConfig} 的拓扑一一对应）。
     *
     * <p>正常情况下用不到它 —— 优先读消息自带的 {@code x-death} 头。
     * 但手工往死信队列里灌的消息（比如自测时）是没有 {@code x-death} 的，
     * 那时靠这张表兜底。表里的 key 集合与 {@link RabbitQueueConstants#QUEUE_NAMES} 完全一致。
     */
    private static final Map<String, Origin> ORIGIN_FALLBACK = Map.of(
            RabbitConfig.CACHE_DEAD_QUEUE, new Origin(RabbitConfig.EXCHANGE, "cache"),
            RabbitConfig.FOLLOW_NOTICE_DEAD_QUEUE, new Origin(RabbitConfig.NOTICE_EXCHANGE, "follow.notice"),
            RabbitConfig.LIKE_NOTICE_DEAD_QUEUE, new Origin(RabbitConfig.NOTICE_EXCHANGE, "like.notice"),
            RabbitConfig.COMMENT_NOTICE_DEAD_QUEUE, new Origin(RabbitConfig.NOTICE_EXCHANGE, "comment.notice"),
            RabbitConfig.RAG_DEAD_QUEUE, new Origin(RabbitConfig.RAG_EXCHANGE, "rag"),
            RabbitConfig.RAG_UPDATE_DEAD_QUEUE, new Origin(RabbitConfig.RAG_EXCHANGE, "rag.update.delete")
    );

    @Autowired
    private AmqpAdmin amqpAdmin;
    @Autowired
    private RabbitTemplate rabbitTemplate;

    /** 一条消息的「原始去向」：当初被发到哪个交换机、用什么 routingKey */
    private record Origin(String exchange, String routingKey) {
    }

    /**
     * 死信队列白名单校验 —— 三个接口共用。
     *
     * <p>不校验的话，这些接口就成了「读 / 清空 / 转发**任意队列**」的万能工具，
     * 一个管理端接口能碰到全部业务队列，风险太大。
     * 非法名字属于**入参错误**，统一返回 400（而不是让 broker 抛异常被兜成 500）。
     */
    private void requireDeadQueue(String queue) {
        if (!RabbitQueueConstants.QUEUE_NAMES.contains(queue)) {
            throw BusinessException.badRequest("不是死信队列：" + queue);
        }
    }

    //获取死信队列的元数据
    @Override
    public Result<List<AdminQueueVO>> getQueueMetadata() {
        //最后返回结果
        List<AdminQueueVO> adminQueueVOS = new ArrayList<>();
        //遍历死信列表
        for (String queueName : RabbitQueueConstants.QUEUE_NAMES) {
            AdminQueueVO adminQueueVO = new AdminQueueVO();
            QueueInformation queueInfo = amqpAdmin.getQueueInfo(queueName);
            if (queueInfo == null) {
                continue;
            }
            adminQueueVO.setQueueName(queueInfo.getName());
            adminQueueVO.setMessageCount(queueInfo.getMessageCount());
            adminQueueVO.setConsumerCount(queueInfo.getConsumerCount());
            adminQueueVOS.add(adminQueueVO);
        }
        //获取数据返回
        return Result.success(adminQueueVOS);
    }

    //获取指定队列消息
    @Override
    public List<String> getMessage(String queue) {
        requireDeadQueue(queue);
        return rabbitTemplate.execute(channel -> {
            List<String> messageList = new ArrayList<>();
            List<Long> tags = new ArrayList<>();
            //根据队列获取全部消息
            while (true) {
                GetResponse response = channel.basicGet(queue, false);
                if (response == null) {
                    break;
                }
                String message = new String(response.getBody(), StandardCharsets.UTF_8);
                messageList.add(message);
                //先标记全部读取完再重新入队
                tags.add(response.getEnvelope().getDeliveryTag());
            }
            for (Long tag : tags) {
                //不确认重新入队
                channel.basicNack(tag, false, true);
            }
            return messageList;
        });
    }

    //清空队列
    @Override
    public Result<Void> clearQueue(String queue) {
        requireDeadQueue(queue);
        Boolean execute = rabbitTemplate.execute(channel -> {
            boolean mark = false;
            while (true) {
                GetResponse response = channel.basicGet(queue, true);
                if (response == null) {
                    mark = true;
                    break;
                }
            }
            return mark;
        });
        if (!execute) {
            throw BusinessException.serverError("服务端异常请稍后重试");
        }
        return Result.success("操作成功");
    }

    /**
     * 把死信队列里的消息<b>重投回它原本的交换机</b>。
     *
     * <p>这是整个管理端最容易写错的一个接口，坑有两个：
     *
     * <ol>
     *   <li><b>绝不能投回死信交换机（DLX）。</b> DLX 会立刻把消息路由回死信队列
     *       → 又进死信 → 再投 → 死循环。所以必须投回<b>原始</b>交换机 + 原始 routingKey。</li>
     *   <li><b>「原始」从哪来？</b> 读消息的 {@code x-death} 头（RabbitMQ 死信时自动加的，
     *       记录了消息死在哪个队列、原本发到哪个交换机、用什么 routingKey）；
     *       读不到就回退静态表。两条都没有 → 拒绝重投（<b>宁可报错也不猜</b>，猜错=消息永久丢失）。</li>
     * </ol>
     *
     * <p>取消息用 {@code basicGet(queue, false)}（先不 ack）→ 重投成功后才 ack。
     * 万一重投抛异常，消息仍是 unacked，channel 关闭时会自动回到死信队列 —— <b>不丢消息</b>。
     * 若图省事用 autoAck 取出来再投，投失败那一刻消息就没了。
     */
    @Override
    public Result<Integer> replay(String queue) {
        // 1) 白名单：只允许重投已知的死信队列（见 requireDeadQueue）。
        //    不校验的话，这个接口就成了「把任意队列的消息发到任意地方」的万能工具。
        requireDeadQueue(queue);
        // 白名单就是静态表的 key 集合，所以这里一定拿得到兜底值
        Origin fallback = ORIGIN_FALLBACK.get(queue);

        QueueInformation queueInfo = amqpAdmin.getQueueInfo(queue);
        if (queueInfo == null) {
            throw BusinessException.notFound("队列不存在：" + queue);
        }
        int pending = queueInfo.getMessageCount();
        if (pending == 0) {
            return Result.success(0, "队列已空，无需重投");
        }

        // 2) 本轮处理条数上限取 min(积压, 单次上限)。
        //    用「积压数」当循环上界还顺带防了一个死循环：万一重投目标配错、
        //    消息又被立刻打回死信队列，本轮也只处理 pending 条就停，不会在同一个请求里转到天荒地老。
        int batch = Math.min(pending, MAX_REPLAY_PER_REQUEST);

        Integer replayed = rabbitTemplate.execute(channel -> {
            int count = 0;
            for (int i = 0; i < batch; i++) {
                GetResponse response = channel.basicGet(queue, false);   // 先不 ack
                if (response == null) {
                    break;                                              // 队列已空，收工
                }
                Map<String, Object> headers = response.getProps().getHeaders();
                Origin origin = resolveOrigin(headers, fallback);

                // 3) 删掉 x-death：不删的话，同一条消息反复死信会把数组越撑越大
                Map<String, Object> newHeaders = (headers == null)
                        ? new HashMap<>()
                        : new HashMap<>(headers);
                newHeaders.remove("x-death");
                AMQP.BasicProperties props = response.getProps().builder()
                        .headers(newHeaders)
                        .build();

                // 4) 投回「原始交换机 + 原始 routingKey」，投成功之后才 ack
                channel.basicPublish(origin.exchange(), origin.routingKey(), props, response.getBody());
                channel.basicAck(response.getEnvelope().getDeliveryTag(), false);
                count++;
            }
            return count;
        });

        int replayedCount = replayed == null ? 0 : replayed;
        int remaining = pending - replayedCount;
        log.info("管理员 {} 重投死信队列 {}：本次 {} 条，剩余 {} 条",
                UserContext.getUserId(), queue, replayedCount, remaining);

        return remaining > 0
                ? Result.success(replayedCount, "已重投 " + replayedCount + " 条，队列还剩 " + remaining + " 条，请再次执行")
                : Result.success(replayedCount, "已重投 " + replayedCount + " 条，队列已清空");
    }

    /**
     * 解析消息的原始去向。
     *
     * <p>{@code x-death} 的结构（RabbitMQ 自动维护）：
     * <pre>
     * x-death: [ { count: 1, reason: rejected,
     *              queue: codemind.cache.queue,      // 死在哪个队列
     *              exchange: codemind.exchange,      // ← 当初发布用的交换机（原始）
     *              routing-keys: [cache] } ]         // ← 当初的 routingKey（原始）
     * </pre>
     * 数组最新的在前，所以取 {@code [0]}。
     *
     * <p>防御：若 {@code x-death} 解析出来指向死信交换机（理论上不该发生），
     * 投回去会立刻又进死信 —— 这时改用静态表，而不是照着错的值投。
     */
    private Origin resolveOrigin(Map<String, Object> headers, Origin fallback) {
        if (headers != null
                && headers.get("x-death") instanceof List<?> deathList
                && !deathList.isEmpty()
                && deathList.get(0) instanceof Map<?, ?> first) {

            Object exchangeObj = first.get("exchange");
            Object routingKeysObj = first.get("routing-keys");

            if (exchangeObj instanceof String exchange && !exchange.isEmpty()
                    && routingKeysObj instanceof List<?> routingKeys && !routingKeys.isEmpty()) {

                String routingKey = String.valueOf(routingKeys.get(0));
                if (!RabbitConfig.DLX_EXCHANGE.equals(exchange) && !routingKey.isEmpty()) {
                    return new Origin(exchange, routingKey);
                }
                log.warn("x-death 指向死信交换机或 routingKey 为空，改用静态表：exchange={} routingKey={}",
                        exchange, routingKey);
            }
        }
        return fallback;
    }
}
