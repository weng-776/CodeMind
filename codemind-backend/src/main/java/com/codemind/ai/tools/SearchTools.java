package com.codemind.ai.tools;
import com.codemind.ai.entity.search.SearchArticle;
import com.codemind.ai.entity.search.SearchNote;
import com.codemind.ai.entity.search.UserSearchNote;
import com.codemind.ai.service.AiConversationService;
import com.codemind.ai.vo.KnowledgeSearchResultData;
import com.codemind.ai.vo.SearchArticleData;
import com.codemind.ai.vo.SearchNoteData;
import com.codemind.common.Result;
import com.codemind.community.service.ArticleService;
import com.codemind.community.vo.ArticleDetailVO;
import com.codemind.context.UserContext;
import com.codemind.knowledge.service.NoteService;
import com.codemind.knowledge.vo.CheckNoteVO;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.model.ToolContext;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;
import java.util.List;
@Slf4j
@Component
public class SearchTools {

    @Autowired
    private ArticleService articleService;
    @Autowired
    private NoteService noteService;
    @Lazy
    @Autowired
    private AiConversationService aiConversationService;

    @Tool(description = """
            根据用户提供的信息搜索相关文章。
            当用户想查找某个知识点、文章作者、技术主题或标签相关的资料时使用。
            当用户想查找最新文章或最热门文章的资料时使用
            例如用户询问“找几篇 Redis 缓存相关的文章”。
            数据返回为空则代表社区现在没有相关文章
            """)
    public List<SearchArticleData> queryArticleList(@ToolParam(required = false,
            description = "文章查询条件") SearchArticle searchArticle) {
            return articleService.AiqueryArticleList(searchArticle);
    }
    @Tool(description = """
               根据文章ID获取社区文章的完整详细内容。
                 使用场景：
                 - 用户要求阅读某篇具体文章
                 - 用户要求总结、分析某篇文章
                 - 用户要求查看文章正文
                 - 用户在搜索结果中指定了某篇文章
            
                 重要：
                 - 必须先通过 queryArticleList 获取文章ID，或者调用其他工具获得文章ID 再调用本工具。
                 - 不要猜测或编造 articleId。
                 - 如果 queryArticleList 已返回匹配文章的 articleId，
                  且用户需要该文章的详细内容，应使用该 articleId 调用本工具。
            """)
    public ArticleDetailVO getArticle(@ToolParam(required = true
            ,description = "社区文章ID，用于指定需要获取详情的文章") Long articleId, ToolContext toolContext) {
        //把用户id注册到ThreadLocal 工具线程在下游执行的时候就能拿到id了 不然会报错
        UserContext.setUserId((Long) toolContext.getContext().get("userId"));
        try {
            Result<ArticleDetailVO> detailVOResult = articleService.checkArticle(articleId);
            return  detailVOResult.getData();
        }finally {
            UserContext.removeUserId();
        }



    }
    @Tool(description = """
            根据用户提供的信息搜索相关笔记。
            当用户想查找某个知识点、笔记作者、技术主题或标签相关的资料时使用。
            例如用户询问“找几篇 Redis 缓存相关的笔记”。
            数据返回为空则代表知识库里面没有公开的笔记
            """)
    public List<SearchNoteData> queryNoteList(@ToolParam(required = false,description = "笔记查询条件")SearchNote searchNote){

        return noteService.queryNoteList(searchNote);
    }
    @Tool(description = """
           根据笔记ID获取对应笔记的完整详细内容。 
           【使用场景】 当用户需要进一步阅读、查看、总结或分析某一篇已经确定的笔记时使用。 
           例如： - 用户要求查看某篇笔记的具体内容 
                 - 用户要求总结某篇笔记 
                 - 用户要求分析某篇笔记 
                 - 用户在笔记搜索结果中指定了某篇笔记 
                 - 用户要求继续了解刚才搜索到的某篇笔记 
                 【调用流程】 本工具用于获取已经确定的笔记详情，不负责搜索笔记。 
                 如果用户没有提供明确的笔记ID： 
                 1. 如果用户想查找公开知识库中的笔记，先调用 queryNoteList。 
                 2. 如果用户想查找自己以前创建的笔记，先调用 MyQueryNoteList。 
                 3. 从搜索结果中获取真实的 noteId。 
                 4. 使用真实的 noteId 调用本工具获取完整内容。 
                 【重要规则】 - 必须使用搜索工具返回的真实 noteId。 
                 - 不得猜测、编造、修改或推断 noteId。 
                 - 不要仅凭笔记标题、关键词或其他信息自行构造 noteId。 
                 - 如果没有找到对应笔记，不要调用本工具获取不存在或无法确定的笔记。 
                 - 已经获取到完整笔记内容后，不要为了同一篇笔记重复调用本工具。 
                 【笔记来源】 笔记可能来自： 
                 - 公开知识库搜索 queryNoteList 
                 - 当前用户自己的笔记搜索 MyQueryNoteList 对于当前用户自己的笔记，搜索结果可能包含公开笔记和私密笔记； 
                 对于公开知识库搜索，搜索结果仅包含公开笔记。 
                 【内容处理】 获取笔记详情后，应基于真实笔记内容回答用户的问题。 
                 可以对笔记进行总结、提炼、解释、分析和归纳， 但不得编造笔记中不存在的信息。 
                 如果用户要求总结或分析，应直接基于获取到的笔记正文进行处理， 不要把自己的总结描述成笔记原文。 
                 【内部信息】 noteId 是系统内部业务标识，仅用于工具之间定位和获取笔记。 
                 默认不要在最终回答中主动向用户展示 noteId、 工具调用过程或其他内部实现信息。
            """)
    public CheckNoteVO getNote(@ToolParam(description = "目标笔记的内部唯一标识。 " +
            "必须使用 queryNoteList 或 MyQueryNoteList 或其他工具 返回的真实 noteId。 不得猜测、编造或修改。") Long noteId , ToolContext toolContext) {
        UserContext.setUserId((Long) toolContext.getContext().get("userId"));
        try {
            Result<CheckNoteVO> note = noteService.getNote(noteId);
            return note.getData();
        } finally {
            UserContext.removeUserId();
        }
    }
    //tool用户自己的笔记列表
    @Tool(description = """
            查询当前登录用户自己创建的个人笔记. 
            【使用场景】 当用户想查找、回忆、浏览自己以前写过的笔记时使用此工具。 
            例如： 
            - “我之前写过 Redis 相关的笔记吗？” 
            - “我记得我写过一篇 Spring Boot 的笔记，帮我找一下” 
            - “看看我最近写了哪些 Java 笔记” 
            - “帮我找一下我关于 MySQL 的学习笔记” 
            当用户使用“我的、我写的、我之前记录的、我的笔记”等第一人称表达，并且需要查找其个人笔记时，优先使用本工具，
            而不是 queryNoteList。
            【查询范围】 本工具只查询当前用户自己的笔记，不查询其他用户的笔记。 
            用户不需要提供 userId，当前用户身份由系统自动确定。 
            【查询条件】 可以根据用户提供的信息进行查询，
            如果用户没有提供具体查询条件，可以查询当前用户的笔记列表， 
            再根据返回结果帮助用户进一步确认。 
            【使用原则】 1. 优先根据用户真实意图设置查询条件，不要无意义地传入条件。 
            2. 查询结果为空时，应如实告诉用户没有找到相关笔记。 
            3. 不得编造笔记标题、内容或其他笔记信息。 
            4. 查询到笔记后，如果用户还需要查看某篇笔记的完整内容， 可以继续调用笔记详情工具获取具体内容。 
            5. 工具返回的 noteId 等内部标识仅用于后续工具调用， 默认不要在最终回答中主动展示给用户。
            """)
    public List<SearchNoteData> MyQueryNoteList(@ToolParam(required = false,description = "用户个人笔记查询条件") UserSearchNote userSearchNote , ToolContext toolContext) {
        UserContext.setUserId((Long) toolContext.getContext().get("userId"));
        try {
            return noteService.MyQueryNoteList(userSearchNote);
        } finally {
            UserContext.removeUserId();
        }

    }

    @Tool(description = """
        搜索 CodeMind 知识库中的相关内容。
        本工具会同时搜索 CodeMind 社区公开文章和当前用户自己的个人笔记，
        通过语义相似度查找与用户问题相关的知识内容。

        【使用场景】
        当用户希望从 CodeMind 已有知识中查找内容时使用本工具，例如：
        - 查找某个技术知识点相关的文章或笔记
        - 查找某个问题的解决方案
        - 想了解 CodeMind 中是否存在某方面的相关知识
        - 要求根据 CodeMind 的文章或个人笔记进行解释、总结或补充
        - 用户明确要求“从知识库中找”“从 CodeMind 中找”相关资料

        【不要使用本工具的情况】
        - 用户只是要求查询最新文章、热门文章、指定作者文章等结构化文章列表，
          应使用文章查询工具。
        - 用户已经明确指定某篇文章并要求查看文章详细内容，
          应使用文章详情工具。
        - 用户询问与 CodeMind 知识库无关的通用知识时，可以直接回答，
          不需要调用本工具。

        【搜索范围】
        本工具会同时搜索：
        1. CodeMind 社区公开文章
        2. 当前用户自己的个人笔记

        【搜索方式】
        使用用户的问题或关键词作为语义搜索内容。
        工具内部会将搜索内容与知识库中的文章和笔记进行相似度匹配，
        返回最相关的知识内容。

        【返回结果】
        返回内容可能包含社区文章和个人笔记。
        - articleId 不为空：表示该结果来自社区文章
        - noteId 不为空：表示该结果来自个人笔记
        - articleId 和 noteId 不会同时存在
        - 返回结果可能为空，表示知识库中没有找到足够相关的内容

        【重要规则】
        - 只能根据工具返回的真实内容回答，不得编造不存在的文章、笔记或知识。
        - 如果没有找到足够相关的内容，应明确告诉用户当前知识库中没有找到相关内容，
          不要将模型自身的知识伪装成 CodeMind 知识库内容。
        - articleId 和 noteId 是系统内部标识，不要直接展示给用户，
          除非用户明确要求查看 ID。
        """)
    public List<KnowledgeSearchResultData> searchKnowledge(
            @ToolParam(
                    description = "用户希望从 CodeMind 知识库中搜索的具体问题、知识点或关键词。直接使用用户的原始问题作为搜索内容。"
            )
            String prompt) {
        /*
         * ★ 必须兜底：本工具是 6 个工具里**唯一会发起外部网络请求**的 ——
         *   searchKnowledge 内部要把用户提问送去 DashScope 做 embedding，再去 Milvus 检索，
         *   因此它也是最容易被瞬时网络抖动打中的一个。
         *   实测 2026-09-24 22:16 报过：
         *     java.net.SocketException: Connection reset
         *       at MilvusVectorStore.doSimilaritySearch
         *       at AiConversationServiceImpl.searchKnowledge
         *       at SearchTools.searchKnowledge
         *
         * 不兜底的后果：embedding 抖一下，异常就穿透到 Spring AI 的工具调用管理器，
         * **整轮对话直接失败**（用户连一句回答都拿不到），而不是「这次没检索到」。
         *
         * 而本工具自己的提示词就写着「如果没有找到足够相关的内容，应明确告诉用户
         * 当前知识库中没有找到相关内容」—— **设计意图本来就是「返回空」而不是「抛异常」**。
         * 所以这里捕获后返回空列表：模型会据此走「知识库没检索到」的分支，
         * 用自身知识继续回答。用户体验是**降级**，不是**报错**。
         */
        try {
            return aiConversationService.searchKnowledge(prompt);
        } catch (Exception e) {
            log.warn("知识库检索失败，降级为「未检索到内容」继续对话。prompt={}", prompt, e);
            return List.of();
        }
    }




}
