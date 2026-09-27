package com.codemind.user.controller;

import com.codemind.common.Result;
import com.codemind.user.dto.SetPasswordDTO;
import com.codemind.user.dto.UpdatePasswordDTO;
import com.codemind.user.dto.UpdateUserDataDTO;
import com.codemind.user.service.UserService;
import com.codemind.user.vo.CheckUserHomeVO;
import com.codemind.user.vo.UserDataVO;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;


//用户信息与主页控制层
@RequestMapping("/api/user")
@RestController //返回json数据
@CrossOrigin //允许跨域
public class UserController {
    @Autowired
    private UserService userService;
    //获取当前用户信息
    @GetMapping("info")
    public Result<UserDataVO> getUserInformation(){
      return userService.getUserInformation();
    }
    //修改个人资料
    @PutMapping("data")
    public Result<Void> updateUserData(@Valid UpdateUserDataDTO updateUserDataDTO
            ,@RequestParam(required = false,value = "file") MultipartFile file) throws Exception {
        return userService.updateUserData(updateUserDataDTO,file);
    }
    //修改密码
    @PutMapping("updatePassword")
    public Result<Boolean> updatePassword(@Valid @RequestBody UpdatePasswordDTO userPassword){
        return userService.updatePassword(userPassword);
    }
    //查看用户主页
    @GetMapping("/profile/{userId}")
    public Result<CheckUserHomeVO> checkUserHome(@PathVariable Long userId){
        return userService.checkUserHome(userId);
    }

    //设置密码 注册完以后调用此接口设置密码
    @PostMapping("setPassword")
    public Result<Void> setPassword(@Valid @RequestBody SetPasswordDTO setPasswordDTO){
        return userService.setPassword(setPasswordDTO);
    }

}
