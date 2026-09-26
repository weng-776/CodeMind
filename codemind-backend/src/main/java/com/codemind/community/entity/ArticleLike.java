package com.codemind.community.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.util.Date;
import lombok.Data;

/**
 * @TableName article_like
 */
@TableName(value ="article_like")
@Data
public class ArticleLike {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long articleId;

    private Long userId;

    private Date createTime;
}