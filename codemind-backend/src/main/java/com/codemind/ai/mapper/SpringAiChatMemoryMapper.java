package com.codemind.ai.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;

import com.codemind.ai.entity.SpringAiChatMemory;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface SpringAiChatMemoryMapper extends BaseMapper<SpringAiChatMemory> {
    // 基础的 CRUD 全有了，不需要手写任何方法。
    // 如果后面有复杂查询，在这里写自定义方法，配 XML 即可。
}