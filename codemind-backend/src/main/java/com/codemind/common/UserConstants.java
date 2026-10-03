package com.codemind.common;

public abstract class UserConstants {
    //用户状态
    public static final Integer USER_STATUS_NORMAL = 1; //账号正常
    public static final  Integer USER_STATUS_DISABLE = 0; //禁用
    //用户角色
    public static final Integer USER_ROLE_NORMAL = 0; //普通用户
    public static final Integer USER_ROLE_ADMIN = 1; //管理员
    //默认名称
    public static final String USER_NAME = "codemind_";
    //默认密码
    public static final Integer USER_PASSWORD = 123456;
    //头像地址名称前缀
    public static final String USER_AVATAR_PREFIX = "codemind_user_avatar";

}
