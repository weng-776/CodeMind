package com.codemind.admin.controller;

import com.codemind.admin.service.AdminDashboardService;
import com.codemind.admin.vo.DashboardOverviewVO;
import com.codemind.common.Result;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 管理端-数据看板。
 */
@RestController
@RequestMapping("/api/admin/dashboard")
@CrossOrigin
public class AdminDashboardController {

    @Autowired
    private AdminDashboardService adminDashboardService;

    /** 总量 + 今日新增 的汇总 */
    @GetMapping("overview")
    public Result<DashboardOverviewVO> overview() {
        return adminDashboardService.overview();
    }
}
