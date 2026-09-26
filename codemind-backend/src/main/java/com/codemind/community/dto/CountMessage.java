package com.codemind.community.dto;

import lombok.Data;

@Data
public class CountMessage {
    private Long articleId;
    private Integer delta;        // +1 或 -1
    private String messageId;     // UUID，幂等去重用
    // 无参构造 + 全参构造（Jackson 反序列化需要）


    public CountMessage() {
    }

    public CountMessage(Long articleId, Integer delta, String messageId) {
        this.articleId = articleId;
        this.delta = delta;
        this.messageId = messageId;
    }
}
