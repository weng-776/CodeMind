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

    /**
     * 用户角色，取 {@link com.codemind.common.UserConstants#USER_ROLE_NORMAL}（0，普通用户）
     * 或 {@link com.codemind.common.UserConstants#USER_ROLE_ADMIN}（1，管理员）。
     *
     * <p>暴露它只有一个目的：**让前端知道当前用户是不是管理员** ——
     * 管理端（`/api/admin/**`）需要一个路由守卫与入口按钮的判据，
     * 而 JWT 的 payload 里只有 `sub / exp / userId`，拿不到角色。
     *
     * <p>无需在 {@code UserServiceImpl.getUserInformation} 里手动赋值：
     * 那里用的是 `BeanUtils.copyProperties(user, userDataVO)`，字段名一致即自动带出。
     *
     * <p>⚠️ 与 `AdminInterceptor` 的分工：拦截器**每次请求都查库**取 role
     * （所以「改角色立即生效」）；这个字段只是给前端做**界面门控**用的，
     * **不能当作权限依据** —— 真正的权限判定始终在后端。
     */
    private Integer role;

}
