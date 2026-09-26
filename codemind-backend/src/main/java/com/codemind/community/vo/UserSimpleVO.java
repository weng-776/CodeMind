package com.codemind.community.vo;

import lombok.Data;

/**
 * 用户简要信息 VO
 */
@Data
public class UserSimpleVO {

    /**
     * 用户ID
     */
    private Long id;

    /**
     * 用户名
     */
    private String userName;

    /**
     * 头像
     */
    private String avatar;

    /**
     * 个人简介
     */
    private String intro;
}