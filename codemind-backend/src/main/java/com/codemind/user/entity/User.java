package com.codemind.user.entity;

import com.baomidou.mybatisplus.annotation.*;

import java.util.Date;
import lombok.Data;

/**
 * @TableName user
 */
@TableName(value ="user")
@Data
public class User {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private String phone;

    private String password;

    private String userName;

    private String avatar;

    private String intro;

    private Integer status;

    private Date createTime;

    private Date updateTime;
    @TableLogic
    private Integer isDelete;
}