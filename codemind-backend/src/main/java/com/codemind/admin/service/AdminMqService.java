package com.codemind.admin.service;

import com.codemind.admin.vo.AdminQueueVO;
import com.codemind.common.Result;

import java.util.List;

public interface AdminMqService {
    //获取死信队列的元数据
    Result<List<AdminQueueVO>> getQueueMetadata();
    //获取指定队列的全部消息（不分页，前端自行分页）
    List<String> getMessage(String queue);
    //清空队列
    Result<Void> clearQueue(String queue);
    //把死信消息重投回它原本的交换机（返回本次重投成功的条数）
    Result<Integer> replay(String queue);
}
