package com.codemind.admin.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.admin.vo.AdminUserVO;
import com.codemind.common.Result;
import com.codemind.user.entity.User;

/**
 * 管理端-用户治理。
 */
public interface AdminUserService extends IService<User> {

    /** 用户列表（分页 + 手机号/昵称模糊搜） */
    Result<Page<AdminUserVO>> userList(Integer page, Integer size, String keyword);

    /** 封禁 / 解封：status 取 UserConstants.USER_STATUS_* */
    Result<Void> updateStatus(Long userId, Integer status);
}
