package com.codemind.utils;

import com.codemind.config.properties.JwtProperties;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;

@Component
public class JwtHelper {

    @Autowired
    private JwtProperties jwtProperties;

    // 根据配置里的字符串生成 0.12.x 规范的 SecretKey
    private SecretKey getSecretKey() {
        byte[] keyBytes = jwtProperties.getTokenSignKey().getBytes(StandardCharsets.UTF_8);
        return Keys.hmacShaKeyFor(keyBytes);
    }

    // 生成 token 字符串
    public String createToken(Long userId) {
        // 建议加上 long 转型，防止数值溢出
        long expirationMillis = System.currentTimeMillis() + jwtProperties.getTokenExpiration() * 1000L * 60L;

        return Jwts.builder()
                .subject("YYGH-USER")
                .expiration(new Date(expirationMillis)) // 单位：分钟
                .claim("userId", userId)
                .signWith(getSecretKey(), Jwts.SIG.HS256) // 0.12.5 指定签名和算法的标准写法
                .compact();
    }

    // 从 token 字符串获取 userId
    public Long getUserId(String token) {
        if (!StringUtils.hasText(token)) {
            return null;
        }
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(getSecretKey()) // 0.12.5 使用 verifyWith 校验签名
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();

            // 安全获取 Long 类型，避免 ClassCastException
            Object userIdObj = claims.get("userId");
            if (userIdObj != null) {
                return Long.valueOf(userIdObj.toString());
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    // 判断 token 是否有效（未过期且签名正确）
    public boolean isExpiration(String token) {
        if (!StringUtils.hasText(token)) {
            return true; // 空 token 视作过期/无效
        }
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(getSecretKey())
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();

            // 如果能正常解析且过期时间在当前时间之前，返回 true
            return claims.getExpiration().before(new Date());
        } catch (Exception e) {
            // 解析失败（签名错、格式错、已过期抛出异常）统一算作已失效
            return true;
        }
    }
}