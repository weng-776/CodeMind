package com.codemind.user.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.util.Date;
import lombok.Data;

/**
 * @TableName follow
 */
@TableName(value ="follow")
@Data
public class Follow {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long userId;

    private Long followUserId;

    private Date createTime;
}