package com.codemind.user.controller;

import com.codemind.common.Result;
import com.codemind.user.dto.UserLoginCodeDTO;
import com.codemind.user.dto.UserPasswordLoginDTO;
import com.codemind.user.service.UserService;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

//登陆注册认证相关controller
//用户信息与主页控制层
@RequestMapping("/api/user")
@RestController //返回json数据
@CrossOrigin //允许跨域
public class AuthController {
    @Autowired
    UserService userService;

    //发送验证码
    @PostMapping("sendCode")
    public Result<Boolean> sendCode(@RequestBody Map<String, String> phone){
        return userService.sendCode(phone);
    }

    //验证码登陆/注册
    @PostMapping("/login/code")
    public Result<Map<String,String>> loginCode(@Valid @RequestBody UserLoginCodeDTO userLoginCodeDTO){
        return userService.loginCode(userLoginCodeDTO);
    }

    //密码登陆
    @PostMapping("/login/password")
    public Result<Map<String,String>> loginPassword(@Valid @RequestBody UserPasswordLoginDTO userPasswordLoginDTO){
        return userService.loginPassword(userPasswordLoginDTO);
    }
}
