package com.codemind.ai.service;

import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.ai.entity.SpringAiChatMemory;
import com.codemind.ai.vo.MessageVO;
import com.codemind.common.Result;

import java.util.List;


public interface SpringAiChatMemoryService extends IService<SpringAiChatMemory> {

    // 这里不需要写 save, remove, get, list 这些了，IService 里全都有。
    // 如果有特殊业务逻辑（比如批量带校验的），再在这里定义。
}