package com.codemind.knowledge.entity;

import com.baomidou.mybatisplus.annotation.*;

import java.util.Date;
import lombok.Data;

/**
 * @TableName note
 */
@TableName(value ="note")
@Data
public class Note {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long userId;

    private Long categoryId;

    private String title;

    private String content;

    private String summary;

    private String cover;

    private Integer visibility;

    private Integer status;

    private Integer wordCount;

    private Long viewCount;

    private Date createTime;

    private Date updateTime;

    @TableLogic
    private Integer isDelete;
}