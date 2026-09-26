package com.codemind.message.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.util.Date;
import lombok.Data;

/**
 * @TableName message
 */
@TableName(value ="message")
@Data
public class Notification {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long userId;

    private Long fromUserId;

    private Integer type;

    private Long articleId;

    private Long commentId;

    private String content;

    private Integer isRead;

    private Date createTime;
}
