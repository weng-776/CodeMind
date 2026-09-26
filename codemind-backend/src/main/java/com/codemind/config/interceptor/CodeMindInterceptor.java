package com.codemind.config.interceptor;

import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.codemind.common.Result;
import com.codemind.context.UserContext;
import com.codemind.utils.JwtHelper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.ModelAndView;
@Component
public class CodeMindInterceptor implements HandlerInterceptor {

    @Autowired
    private JwtHelper jwtHelper;

    //执行handler方法之前执行次方法
    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return  true;
        }
        response.setContentType("application/json;charset=UTF-8");
        //从请求头拿到token
        String token = request.getHeader("token");
        //校验是否过期
        if (StrUtil.isBlankIfStr(token) || jwtHelper.isExpiration(token)) {
            //过期拦截
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED); //401
            response.getWriter().write(
                    JSONUtil.toJsonStr(Result.error(401,"登陆过期请重新登陆"))
            );
            return false;
        }

        //将id存入上下文
        UserContext.setUserId(jwtHelper.getUserId(token));
        //没过期放行
        return true;
    }
    //执行完handler方法之后执行此方法
    @Override
    public void postHandle(HttpServletRequest request, HttpServletResponse response, Object handler, ModelAndView modelAndView) throws Exception {
        HandlerInterceptor.super.postHandle(request, response, handler, modelAndView);
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) throws Exception {
       UserContext.removeUserId();
    }
}
