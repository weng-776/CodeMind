package com.codemind.admin.service.impl;

import cn.hutool.core.util.StrUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.admin.service.AdminUserService;
import com.codemind.admin.vo.AdminUserVO;
import com.codemind.common.Result;
import com.codemind.common.UserConstants;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.UserMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

@Slf4j
@Service
public class AdminUserServiceImpl extends ServiceImpl<UserMapper, User> implements AdminUserService {

    @Override
    public Result<Page<AdminUserVO>> userList(Integer page, Integer size, String keyword) {
        Page<User> userPage = new Page<>(page, size);
        page(userPage, new LambdaQueryWrapper<User>()
                // 关键词命中「手机号 或 昵称」。必须用 and(...) 把 or 包起来，
                // 否则条件会摊平成 (phone like ? or user_name like ?)，把后面的排序/过滤带歪
                .and(StrUtil.isNotBlank(keyword), w -> w
                        .like(User::getPhone, keyword)
                        .or()
                        .like(User::getUserName, keyword))
                .orderByDesc(User::getCreateTime));

        Page<AdminUserVO> voPage = new Page<>();
        voPage.setRecords(userPage.getRecords().stream().map(this::toVO).toList());
        // 分页元数据必须逐项搬过来：new Page<>() 的 size/current 是默认值 10/1，
        // 不搬的话空结果集时前端会拿到错误的分页信息
        voPage.setTotal(userPage.getTotal());
        voPage.setSize(userPage.getSize());
        voPage.setCurrent(userPage.getCurrent());
        voPage.setPages(userPage.getPages());
        return Result.success(voPage);
    }

    /**
     * 逐字段赋值，<b>刻意不用 BeanUtils.copyProperties</b>：
     * password 是敏感字段，逐字段写能让「不小心把密码拷进响应」在编译期就不可能发生；
     * 用 copyProperties 的话，将来谁给 VO 加个同名字段就静默泄漏了。
     */
    private AdminUserVO toVO(User user) {
        AdminUserVO vo = new AdminUserVO();
        vo.setId(user.getId());
        vo.setPhone(user.getPhone());
        vo.setUserName(user.getUserName());
        vo.setAvatar(user.getAvatar());
        vo.setIntro(user.getIntro());
        vo.setStatus(user.getStatus());
        vo.setRole(user.getRole());
        vo.setCreateTime(user.getCreateTime());
        return vo;
    }

    @Override
    public Result<Void> updateStatus(Long userId, Integer status) {
        if (!UserConstants.USER_STATUS_NORMAL.equals(status)
                && !UserConstants.USER_STATUS_DISABLE.equals(status)) {
            throw BusinessException.badRequest("账号状态不合法");
        }
        User user = getById(userId);
        if (user == null) {
            throw BusinessException.notFound("用户不存在");
        }
        // 不能改自己的状态：一旦把自己封了，本人就再也登不进管理端 —— 等于把门反锁了。
        // 这是管理端最经典的自锁场景，必须在服务端拦；前端把按钮置灰不算数。
        if (userId.equals(UserContext.getUserId())) {
            log.warn("管理员试图修改自己的状态 userId={}", userId);
            throw BusinessException.badRequest("不能修改自己的账号状态");
        }
        boolean normal = UserConstants.USER_STATUS_NORMAL.equals(status);
        if (status.equals(user.getStatus())) {
            return Result.success(normal ? "账号已是正常状态" : "账号已是禁用状态");
        }
        update(new LambdaUpdateWrapper<User>()
                .eq(User::getId, userId)
                .set(User::getStatus, status));
        log.info("管理员 {} 将用户 {} 的状态改为 {}", UserContext.getUserId(), userId, status);
        return Result.success(normal ? "已解封" : "已封禁");
    }
}
