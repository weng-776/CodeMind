package com.codemind.config.properties;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@ConfigurationProperties(prefix = "jwt.token")
@Component
@Data
public class JwtProperties {
    Long tokenExpiration;
    String tokenSignKey;

}
