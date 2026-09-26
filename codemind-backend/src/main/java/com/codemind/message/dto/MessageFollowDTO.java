package com.codemind.message.dto;

import lombok.Data;

@Data
public class MessageFollowDTO {
    private Long userId;
    private Long fromUserId;
    private Integer type;
    private String content;
    private Integer isRead;
    private String messageId;     // UUID，幂等去重用
}
