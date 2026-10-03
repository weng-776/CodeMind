package com.codemind.admin.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.admin.service.AdminUserService;
import com.codemind.admin.vo.AdminUserVO;
import com.codemind.common.Result;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

/**
 * 管理端-用户治理。
 *
 * <p>整条 {@code /api/admin/**} 由 {@link com.codemind.config.interceptor.AdminInterceptor} 兜底鉴权，
 * 所以这里不再写任何「是不是管理员」的判断 —— 权限只在一个地方收口，
 * 避免每个接口各写一遍、将来漏掉一个就破防。
 */
@RestController
@RequestMapping("/api/admin/users")
@CrossOrigin
@Validated
public class AdminUserController {

    @Autowired
    private AdminUserService adminUserService;

    /**
     * 用户列表（分页 + 手机号/昵称模糊搜）。
     *
     * <p>{@code keyword} 不传即全量；传了则同时匹配手机号与昵称。
     */
    @GetMapping
    public Result<Page<AdminUserVO>> userList(
            @RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
            @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size,
            @RequestParam(required = false) String keyword) {

        return adminUserService.userList(page, size, keyword);
    }

    /**
     * 封禁 / 解封：status 取 {@code UserConstants.USER_STATUS_*}（0=禁用 1=正常）。
     *
     * <p>用 {@code @RequestParam} 而不是请求体，是为了让这个「只有一个开关」的操作
     * 在前端和 curl 里都足够顺手：{@code PUT /api/admin/users/5/status?status=0}。
     * 越界值由注解挡在进入业务之前（400），不合法但越界的组合再由服务层兜一层。
     */
    @PutMapping("{userId}/status")
    public Result<Void> updateStatus(
            @PathVariable Long userId,
            @RequestParam
            @Min(value = 0, message = "账号状态只能是 0(禁用) 或 1(正常)")
            @Max(value = 1, message = "账号状态只能是 0(禁用) 或 1(正常)")
            Integer status) {

        return adminUserService.updateStatus(userId, status);
    }
}
