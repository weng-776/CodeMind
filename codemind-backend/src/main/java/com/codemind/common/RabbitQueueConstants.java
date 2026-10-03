package com.codemind.common;

import java.util.List;

import static com.codemind.config.RabbitConfig.*;
//死信队列列表
public class RabbitQueueConstants {
    public static final List<String> QUEUE_NAMES = List.of(
            CACHE_DEAD_QUEUE,FOLLOW_NOTICE_DEAD_QUEUE,
            LIKE_NOTICE_DEAD_QUEUE,COMMENT_NOTICE_DEAD_QUEUE,
            RAG_DEAD_QUEUE, RAG_UPDATE_DEAD_QUEUE
    );
}
