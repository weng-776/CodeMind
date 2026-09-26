package com.codemind.community.entity;

import com.baomidou.mybatisplus.annotation.*;

import java.util.Date;
import lombok.Data;

/**
 * @TableName comment
 */
@TableName(value ="comment")
@Data
public class Comment {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long articleId;

    private Long userId;

    private Long parentId;

    private String content;

    private Date createTime;

    private Date updateTime;
    @TableLogic
    private Integer isDelete;

    private Long replyUserId; //被回复用户id，仅二级评论有值
    private Long replyCommentId; //被回复的那条评论id，仅二级评论有值
}