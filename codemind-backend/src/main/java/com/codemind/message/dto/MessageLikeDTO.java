package com.codemind.message.dto;

import lombok.Data;

import java.util.Date;
@Data
public class MessageLikeDTO {
    private Long userId;
    private Long fromUserId;
    private Integer type;
    private Long articleId;
    private String content;
    private Integer isRead;
    private String messageId;     // UUID，幂等去重用

}
