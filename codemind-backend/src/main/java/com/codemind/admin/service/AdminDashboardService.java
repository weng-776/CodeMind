package com.codemind.admin.service;

import com.codemind.admin.vo.DashboardOverviewVO;
import com.codemind.common.Result;

/**
 * 管理端-数据看板。
 */
public interface AdminDashboardService {

    /** 总量 + 今日新增 的汇总 */
    Result<DashboardOverviewVO> overview();
}
