package com.codemind.message.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.message.entity.Notification;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.message.vo.NotifyVO;

/**
* @author wengjiaran
* @description 针对表【message(站内通知表)】的数据库操作Service
* @createDate 2026-08-24 15:56:49
*/
public interface MessageService extends IService<Notification> {
    //我的消息列表（分页边界属入参校验，校验注解放 MessageController 层：接口方法参数上的约束注解不生效，留着会误导）
    Result<Page<NotifyVO>> myMessageList(Integer page, Integer size, Integer type);
    //未读数量
    Result<Long> unreadNumber();
    //标记已读
    Result<Void> markRead(Long notifyId);
    //全部已读
    Result<Void> ReadAll();
    //删除某一条消息
    Result<Void> deleteMessage(Long notifyId);
}
