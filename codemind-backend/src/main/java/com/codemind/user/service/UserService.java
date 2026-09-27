package com.codemind.user.service;

import com.codemind.common.Result;
import com.codemind.user.dto.*;
import com.codemind.user.entity.User;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.user.vo.CheckUserHomeVO;
import com.codemind.user.vo.UserDataVO;
import jakarta.validation.Valid;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

/**
* @author wengjiaran
* @description 针对表【user(用户表)】的数据库操作Service
* @createDate 2026-08-07 20:18:26
*/
public interface UserService extends IService<User> {

    //手机验证码登陆
    Result<Map<String, String>> loginCode(@Valid UserLoginCodeDTO userLoginCodeDTO);

    //用户通过手机号发送验证码
    Result<Boolean> sendCode(Map<String,String> phone);
    //密码登陆
    Result<Map<String, String>> loginPassword(@Valid UserPasswordLoginDTO userPasswordLoginDTO);
    //获取当前用户信息
    Result<UserDataVO> getUserInformation();
    //修改个人信息
    Result<Void> updateUserData(UpdateUserDataDTO updateUserDataDTO , MultipartFile file) throws Exception;
    //修改密码
    Result<Boolean> updatePassword(UpdatePasswordDTO userPassword);
    //查看他人主页
    Result<CheckUserHomeVO> checkUserHome(Long userId);
    //设置密码 注册完以后调用此接口设置密码
    Result<Void> setPassword(SetPasswordDTO setPasswordDTO);
}
