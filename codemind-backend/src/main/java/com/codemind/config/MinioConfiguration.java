package com.codemind.config;

import com.codemind.config.properties.MinioProperties;
import io.minio.MinioClient;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class MinioConfiguration {
    @Autowired
    private MinioProperties minioProperties;

    @Bean
    public MinioClient minioClient() {
        return MinioClient.builder().endpoint(minioProperties.getEndpoint()).
                credentials(minioProperties.getAccessKey(),
                        minioProperties.getSecretKey()).build();
    }
}
