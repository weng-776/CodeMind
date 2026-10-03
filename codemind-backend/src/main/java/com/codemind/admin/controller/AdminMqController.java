package com.codemind.admin.controller;


import com.codemind.admin.service.AdminMqService;
import com.codemind.admin.vo.AdminQueueVO;
import com.codemind.common.Result;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/admin/mq")
@CrossOrigin
@Slf4j
public class AdminMqController {

    @Autowired
    AdminMqService adminMqService;

    @GetMapping("queues")
    public Result<List<AdminQueueVO>> getQueueMetadata(){
       return adminMqService.getQueueMetadata();
    }
    /**
     * 预览队列里的全部消息（**不分页**）。
     *
     * <p>返回的就是消息正文数组，前端要分页自己切 —— 死信队列的消息量本就很小，
     * 直接给全量最直观，也免了「Page 是 0 基、接口 page 是 1 基」那套语义纠缠。
     */
    @GetMapping("queues/{queue}/messages")
    public Result<List<String>> getMessage(@PathVariable("queue") String queue) {
        return Result.success(adminMqService.getMessage(queue));
    }

    @DeleteMapping("queues/{queue}/messages")
    public Result<Void> clearQueue(@PathVariable("queue") String queue){
        return adminMqService.clearQueue(queue);
    }

    //重投：把死信消息送回它原本的交换机（不是死信交换机！投 DLX 会死循环）
    @PostMapping("queues/{queue}/replay")
    public Result<Integer> replay(@PathVariable("queue") String queue){
        return adminMqService.replay(queue);
    }

}
