package com.codemind.user.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.user.service.FollowService;
import com.codemind.user.vo.UserFollowVO;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

//关注与社交关系控制层controller
@RequestMapping("/api/user")
@RestController
@CrossOrigin
public class UserFollowController {
    @Autowired
    private FollowService followService;
    //关注用户
    @PostMapping("/follow/{followUserId}")
    public Result<Void> followUser(@PathVariable Long followUserId){
        return followService.followUser(followUserId);
    }
    //取消关注
    @DeleteMapping("/cancelFollow/{followUserId}")
    public Result<Void> cancelFollow(@PathVariable Long followUserId){

        return followService.cancelFollow(followUserId);

    }
    //我的关注列表
    @GetMapping("follows")
    public Result<Page<UserFollowVO>> myFollowList(@RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                   @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") @Min(value = 1, message = "每页条数不能小于 1") Integer size) {

       return followService.myFollowList(page,size);
    }

    //我的粉丝列表
    @GetMapping("fans")
    public Result<Page<UserFollowVO>> myFansList(@RequestParam(defaultValue = "1")  @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                   @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") @Min(value = 1, message = "每页条数不能小于 1") Integer size) {
        return followService.myFansList(page,size);
    }

    //判断关注状态
    @GetMapping("/follow/status/{userId}")
    public Result<Boolean> isFollowStatus(@PathVariable Long userId){

        return followService.isFollowStatus(userId);
    }




}
