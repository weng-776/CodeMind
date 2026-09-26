package com.codemind.ai.tools;

import com.codemind.ai.entity.recommend.RecommendContent;
import com.codemind.ai.service.AiConversationService;
import com.codemind.ai.vo.recommend.RecommendContentData;
import com.codemind.context.UserContext;
import org.springframework.ai.chat.model.ToolContext;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

@Component
public class RecommendRelatedContentTools {
    @Lazy
    @Autowired
    AiConversationService aiConversationService;

    @Tool(description = """
        根据指定的 CodeMind 文章或笔记，查找与当前内容相关的其他社区文章和知识库笔记。

        【使用场景】
        当用户正在阅读、讨论或分析某一篇具体文章/笔记，并希望：
        - 查找相关内容
        - 获取相似或延伸知识
        - 推荐后续学习内容
        - 查看与当前内容关联的其他文章或笔记
        时使用本工具。

        【调用前提】
        1. 必须已经确定一篇具体的文章或笔记。
        2. 如果用户明确提供了文章/笔记的名称但没有ID，
           必须先调用对应的搜索工具获取真实ID，不得猜测或编造ID。
        3. 如果用户没有指定具体文章或笔记，而只是提出“搜索某个知识点”、
           “查找Redis相关资料”等关键词搜索需求，应优先使用知识搜索工具，
           不要调用本工具。
        4. 本工具会根据当前文章/笔记的内容分析相关知识点，
           再从 CodeMind 知识库中检索真实存在的相关内容。

        【参数规则】
        - type 只能是 article 或 note。
        - type = article 时，只填写 articleId，noteId 必须为空。
        - type = note 时，只填写 noteId，articleId 必须为空。
        - articleId 和 noteId 不能同时填写。
        - ID 必须来自已有工具返回的真实数据，不得自行生成。

        【返回内容】
        返回当前内容分析出的相关知识点，以及检索到的相关社区文章和知识库笔记。
        检索结果可能为空，表示当前知识库中没有找到足够相关的内容。

        【注意事项】
        - 不要向用户展示 articleId、noteId 等内部ID，除非用户明确要求。
        - 不要编造不存在的文章、笔记或推荐内容。
        - 推荐结果应以工具实际返回的数据为准。
        """)
    public RecommendContentData findRelatedContent(
            @ToolParam(description = """
                当前需要进行关联推荐的具体内容。
                必须先确定内容类型，再填写对应ID：
                - article：填写 articleId，noteId 必须为空
                - note：填写 noteId，articleId 必须为空
                ID必须来自已有工具返回的真实数据，不得猜测或编造。
                """)
            RecommendContent recommendContent, ToolContext toolContext) {
        UserContext.setUserId((Long) toolContext.getContext().get("userId"));
        try {
            return aiConversationService.findRelatedContent(recommendContent);
        } finally {
            UserContext.removeUserId();
        }
    }
}
