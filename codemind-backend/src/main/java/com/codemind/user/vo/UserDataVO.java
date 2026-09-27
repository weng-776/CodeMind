package com.codemind.user.vo;

import io.swagger.v3.oas.models.security.SecurityScheme;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class UserDataVO {

    private String phone;

    private String userName;

    private String avatar;
    private String intro;

    private Integer fansCount;
    private Integer followCount;
    private Integer noteCount;
    private Integer articleCount;

    /**
     * 是否已设置过密码。
     * 手机验证码注册的新用户 password 为空字符串，据此为 false，
     * 前端收到 false 时强制跳转到设置密码页（注册后必须设置密码）。
     */
    private Boolean hasPassword;

}
