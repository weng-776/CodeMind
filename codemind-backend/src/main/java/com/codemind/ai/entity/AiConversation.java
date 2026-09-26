package com.codemind.ai.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.util.Date;
import lombok.Data;

/**
 * @TableName ai_conversation
 */
@TableName(value ="ai_conversation")
@Data
public class AiConversation {
    @TableId(type = IdType.ASSIGN_ID)
    private Long id;

    private Long userId;

    private String title;

    private Date createdAt;

    private Date updatedAt;
    //标记会话名称是否更新
    private Integer titleGenerated;
}