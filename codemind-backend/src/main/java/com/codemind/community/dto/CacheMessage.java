package com.codemind.community.dto;

import lombok.Data;

@Data
public class CacheMessage {
    private Long articleId;
    private String messageId;

    public CacheMessage() {
    }

    public CacheMessage(Long articleId, String messageId) {
        this.articleId = articleId;
        this.messageId = messageId;
    }
}
