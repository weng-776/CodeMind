package com.codemind.config;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan({"com.codemind.community.mapper",
             "com.codemind.knowledge.mapper",
             "com.codemind.user.mapper",
             "com.codemind.message.mapper",
             "com.codemind.ai.mapper"})
public class MybatisPlusConfiguration {

    //后续添加分页bean
    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor Interceptor = new MybatisPlusInterceptor();
        Interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.MYSQL));
        return  Interceptor;
    }

}
