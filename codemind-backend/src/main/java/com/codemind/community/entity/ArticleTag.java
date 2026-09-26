package com.codemind.community.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

/**
 * @TableName article_tag
 */
@TableName(value ="article_tag")
@Data
public class ArticleTag {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long articleId;

    private Long tagId;
}