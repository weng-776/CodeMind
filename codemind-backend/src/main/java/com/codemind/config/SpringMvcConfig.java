package com.codemind.config;

import com.codemind.config.interceptor.CodeMindInterceptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
@Configuration
public class SpringMvcConfig  implements WebMvcConfigurer {
    @Autowired
    private CodeMindInterceptor codeMindInterceptor;
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(codeMindInterceptor).excludePathPatterns(
                "/api/user/login/code",
                "/api/user/sendCode",
                "/api/user/login/password",
                "/api/article/list",
                "/api/article/hot",
                "/api/article/latest",
                "/api/article/tag/**"
        );
    }
}
