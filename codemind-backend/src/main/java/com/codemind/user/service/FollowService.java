package com.codemind.user.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.user.entity.Follow;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.user.vo.UserFollowVO;

/**
* @author wengjiaran
* @description 针对表【follow(关注关系表)】的数据库操作Service
* @createDate 2026-08-07 20:18:26
*/
public interface FollowService extends IService<Follow> {
    //关注用户
    Result<Void> followUser(Long followUserId);
    //取消关注
    Result<Void> cancelFollow(Long followUserId);
    //关注列表
    Result<Page<UserFollowVO>> myFollowList(Integer page, Integer size);
    //粉丝列表
    Result<Page<UserFollowVO>> myFansList(Integer page, Integer size);
    //判断关注状态
    Result<Boolean> isFollowStatus(Long userId);
}
