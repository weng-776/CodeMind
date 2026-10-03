package com.codemind.admin.vo;

import lombok.Data;

import java.util.Date;

/**
 * 管理端-用户列表项。
 *
 * <p><b>刻意不含 password</b>：即使服务层用 BeanUtils 拷贝，也要求本 VO 里没有该字段 ——
 * 少一个同名字段，就少一次"将来手滑拷进去"的泄漏面。
 */
@Data
public class AdminUserVO {

    private Long id;

    private String phone;

    private String userName;

    private String avatar;

    private String intro;

    /** 账号状态：0=禁用 1=正常（见 UserConstants.USER_STATUS_*） */
    private Integer status;

    /** 角色：0=普通用户 1=管理员（见 UserConstants.USER_ROLE_*） */
    private Integer role;

    private Date createTime;
}
