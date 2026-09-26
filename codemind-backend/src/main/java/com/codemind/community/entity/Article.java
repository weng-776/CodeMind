package com.codemind.community.entity;

import com.baomidou.mybatisplus.annotation.*;

import java.util.Date;
import lombok.Data;
import lombok.ToString;

/**
 * @TableName article
 */
@TableName(value ="article")
@Data
@ToString
public class Article {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long userId;

    private String title;

    private String content;

    private String summary;

    private String cover;

    private Long viewCount;

    private Long likeCount;

    private Long favoriteCount;

    private Integer status;

    private Date createTime;

    private Date updateTime;
    @TableLogic
    private Integer isDelete;


}