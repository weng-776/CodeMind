package com.codemind.knowledge.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.util.Date;
import lombok.Data;

/**
 * @TableName tag
 */
@TableName(value ="tag")
@Data
public class Tag {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private String name;

    private Date createTime;
}