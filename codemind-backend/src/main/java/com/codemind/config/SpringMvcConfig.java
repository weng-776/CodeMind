package com.codemind.config;

import com.codemind.config.interceptor.AdminInterceptor;
import com.codemind.config.interceptor.CodeMindInterceptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
@Configuration
public class SpringMvcConfig  implements WebMvcConfigurer {
    @Autowired
    private CodeMindInterceptor codeMindInterceptor;
    @Autowired
    private AdminInterceptor adminInterceptor;
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // order 必须显式指定：管理端拦截器依赖前者把 userId 放进 UserContext，
        // 只靠注册顺序在版本升级时不够稳。
        registry.addInterceptor(codeMindInterceptor).excludePathPatterns(
                "/api/user/login/code",
                "/api/user/sendCode",
                "/api/user/login/password",
                "/api/article/list",
                "/api/article/hot",
                "/api/article/latest",
                "/api/article/tag/**"
        ).order(0);

        // 管理端：先过登录态，再过管理员角色
        registry.addInterceptor(adminInterceptor)
                .addPathPatterns("/api/admin/**")
                .order(1);
    }
}
