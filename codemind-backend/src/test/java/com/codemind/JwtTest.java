package com.codemind;

import com.codemind.utils.JwtHelper;
import com.codemind.utils.MD5Util;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.HashMap;
import java.util.Map;

@SpringBootTest
public class JwtTest {
    @Autowired
    private JwtHelper jwtHelper;
//    @Autowired
//    private MD5Util md5Util;
    Map<String,String> map = new HashMap<>();

    @Test
    public void testJwt() {
//        String token = jwtHelper.createToken(1122L);
//        System.out.println(token);
//        Long userId = jwtHelper.getUserId(token);
//        System.out.println("userId = " + userId);
//        boolean expiration = jwtHelper.isExpiration(token);
//        System.out.println("expiration = " + expiration);

        String weng = MD5Util.encrypt("weng");
        System.out.println("weng = " + weng);

    }
}
