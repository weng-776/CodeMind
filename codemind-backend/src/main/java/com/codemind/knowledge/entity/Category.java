package com.codemind.knowledge.entity;

import com.baomidou.mybatisplus.annotation.*;

import java.util.Date;
import lombok.Data;

/**
 * @TableName category
 */
@TableName(value ="category")
@Data
public class Category {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long userId;

    private String name;

    private Long parentId;

    private Integer sort;

    private Date createTime;

    private Date updateTime;
    @TableLogic
    private Integer isDelete;
}