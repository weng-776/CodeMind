package com.codemind.ai.controller;

import com.codemind.ai.dto.ChatDTO;
import com.codemind.ai.service.AiConversationService;
import com.codemind.ai.vo.AiConversationVO;
import com.codemind.ai.vo.MessageVO;
import com.codemind.common.Result;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;

import java.util.List;
import java.util.Map;

//ai会话相关
@CrossOrigin
@RequestMapping("/api/ai")
@RestController
public class AiConversationController {
    @Autowired
    private AiConversationService aiConversationService;
    //创建会话
    @PostMapping("conversations")
    public Result<AiConversationVO> CreateAiConversation(){
        //需要登陆的用户才能访问ai窗口
        //直接从上下文获取userid 所以前端传递一个userid过来即可
       return aiConversationService.CreateAiConversation();
    }


    //查询当前用户会话列表
    @GetMapping("conversations")
    public Result<List<AiConversationVO>> getUserAiConversation(){
        //返回
        return aiConversationService.getUserAiConversation();
    }
    //查询某个会话历史消息
    @GetMapping("conversations/{conversationId}/messages")
    public Result<List<MessageVO>> conversationMessages(@PathVariable(value = "conversationId") String conversationId){
       return aiConversationService.conversationMessages(conversationId);

    }
    //统一聊天窗口
    @PostMapping(value = "chat",produces = "text/html;charset=UTF-8")
    public Flux<String> chat(@RequestBody ChatDTO chatDTO)  {

        //调用大模型响应回去数据

        return aiConversationService.chat(chatDTO);

    }

    //删除某一个会话
    @DeleteMapping("DeleteConversation/{conversationId}")
    public Result<Void> deleteConversation(@PathVariable(value = "conversationId") String conversationId){
        return aiConversationService.deleteConversation(conversationId);
    }
}
