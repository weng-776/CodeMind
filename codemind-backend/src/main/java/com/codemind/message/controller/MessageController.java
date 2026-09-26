package com.codemind.message.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.message.service.MessageService;
import com.codemind.message.vo.NotifyVO;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

@CrossOrigin
@RequestMapping("/api/notify")
@RestController
public class MessageController {
    @Autowired
    private MessageService messageService;
    @GetMapping("/list")
    public Result<Page<NotifyVO>> myMessageList(@Validated @RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                @Validated @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50")
                                                @Min(value = 1, message = "每页条数不能小于 1") Integer size,
                                               @Validated @RequestParam(required = false) @Min(value = 1, message = "消息类型不合法") @Max(value = 3, message = "消息类型不合法") Integer type){

        //我的消息列表
        return messageService.myMessageList(page,size,type);
    }
    //未读数量
    @GetMapping("/unread")
    public Result<Long> unreadNumber(){
        return messageService.unreadNumber();
    }

    //标记某条消息已读
    @PutMapping("read/{notifyId}")
    public Result<Void> markRead(@PathVariable(value = "notifyId") Long notifyId){
        return messageService.markRead(notifyId);
    }

    //全部已读
    @PutMapping("readAll")
    public  Result<Void> ReadAll(){
        return messageService.ReadAll();
    }
    //删除某条消息
    @DeleteMapping("deleteMessage/{notifyId}")
    public  Result<Void> deleteMessage(@PathVariable(value = "notifyId") Long notifyId){
        return messageService.deleteMessage(notifyId);
    }
}
