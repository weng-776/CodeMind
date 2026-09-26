package com.codemind.message.dto;

import lombok.Data;

@Data
public class MessageCommentDTO {
    private Long userId;
    private Long fromUserId;
    private Integer type;
    private Long articleId;
    private Long commentId;
    private String content;
    private Integer isRead;
    private String messageId;     // UUID，幂等去重用

}
