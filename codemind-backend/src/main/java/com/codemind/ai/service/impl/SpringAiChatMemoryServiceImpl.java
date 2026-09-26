package com.codemind.ai.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.ai.entity.AiConversation;
import com.codemind.ai.entity.SpringAiChatMemory;
import com.codemind.ai.mapper.AiConversationMapper;
import com.codemind.ai.mapper.SpringAiChatMemoryMapper;
import com.codemind.ai.service.SpringAiChatMemoryService;
import com.codemind.ai.vo.MessageVO;
import com.codemind.common.Result;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.util.ObjectUtils;

import java.util.List;

@Service
public class SpringAiChatMemoryServiceImpl 
        extends ServiceImpl<SpringAiChatMemoryMapper, SpringAiChatMemory>
        implements SpringAiChatMemoryService {



    // 基础的增删改查全部自动继承，无需手动写任何方法。
    // 如果你有自定义业务逻辑（比如删除前做校验），在这里重写父类方法即可。
}