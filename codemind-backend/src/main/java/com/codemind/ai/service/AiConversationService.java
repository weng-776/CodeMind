package com.codemind.ai.service;

import com.codemind.ai.dto.ChatDTO;
import com.codemind.ai.entity.AiConversation;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.ai.entity.recommend.RecommendContent;
import com.codemind.ai.vo.*;

import com.codemind.ai.vo.recommend.RecommendContentData;
import com.codemind.common.Result;
import reactor.core.publisher.Flux;

import java.util.List;

/**
* @author wengjiaran
* @description 针对表【ai_conversation】的数据库操作Service
* @createDate 2026-09-07 20:11:06
*/
public interface AiConversationService extends IService<AiConversation> {
    //创建ai会话
    Result<AiConversationVO> CreateAiConversation();
    //查看当前用户会话列表
    Result<List<AiConversationVO>> getUserAiConversation();

    Result<List<MessageVO>> conversationMessages(String conversationId);
    //统一聊天窗口
    Flux<String> chat(ChatDTO chatDTO);
    //知识库+社区统一搜索向量数据库检索
    List<KnowledgeSearchResultData> searchKnowledge(String prompt);
    //根据文章或者知识库推荐相关内容
    RecommendContentData findRelatedContent(RecommendContent recommendContent);
    //删除某一个会话
    Result<Void> deleteConversation(String conversationId);
}
