package com.codemind.ai.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Data
@NoArgsConstructor
@AllArgsConstructor
@TableName(value = "SPRING_AI_CHAT_MEMORY")
public class SpringAiChatMemory {

    @TableId(value = "id", type = IdType.AUTO)
    private Long id;

    @TableField(value = "conversation_id")
    private String conversationId;

    @TableField(value = "content")
    private String content;

    @TableField(value = "type")
    private String type;

    @TableField(value = "timestamp")
    private LocalDateTime timestamp;
}