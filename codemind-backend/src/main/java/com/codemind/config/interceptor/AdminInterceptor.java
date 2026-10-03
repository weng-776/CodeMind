package com.codemind.config.interceptor;

import cn.hutool.json.JSONUtil;
import com.codemind.common.Result;
import com.codemind.common.UserConstants;
import com.codemind.context.UserContext;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.UserMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * 管理端鉴权拦截器。
 *
 * <p>只拦 {@code /api/admin/**}，且必须注册在 {@link CodeMindInterceptor} <b>之后</b>
 * —— 后者负责校验 token 并把 userId 放进 {@link UserContext}，本拦截器依赖它。
 *
 * <p>这里刻意查一次库取 role（而不是把 role 塞进 JWT）：
 * 管理端流量极低，多一次主键查询无所谓，换来的是「改角色立即生效」——
 * 若把 role 写进 JWT，降权要等 token 过期才生效，管理端场景不可接受。
 */
@Component
public class AdminInterceptor implements HandlerInterceptor {

    @Autowired
    private UserMapper userMapper;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }
        response.setContentType("application/json;charset=UTF-8");

        // 走到这里说明 CodeMindInterceptor 已放行，正常情况 userId 必然非空；
        // 仍保留兜底，避免将来调整拦截器顺序时静默放行。
        Long userId = UserContext.getUserId();
        if (userId == null) {
            write(response, HttpServletResponse.SC_UNAUTHORIZED, 401, "登陆过期请重新登陆");
            return false;
        }

        User user = userMapper.selectById(userId);
        // 「用户不存在」与「不是管理员」分开返回：前者是凭证失效(401)，后者是无权限(403)
        if (user == null) {
            write(response, HttpServletResponse.SC_UNAUTHORIZED, 401, "登陆过期请重新登陆");
            return false;
        }
        if (!UserConstants.USER_ROLE_ADMIN.equals(user.getRole())) {
            write(response, HttpServletResponse.SC_FORBIDDEN, 403, "无管理员权限");
            return false;
        }
        return true;
    }

    private void write(HttpServletResponse response, int httpStatus, int code, String message) throws Exception {
        response.setStatus(httpStatus);
        response.getWriter().write(JSONUtil.toJsonStr(Result.error(code, message)));
    }
}
