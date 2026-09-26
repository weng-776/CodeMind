package com.codemind.ai.service.impl;

import cn.hutool.core.util.RandomUtil;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.ai.dto.ChatDTO;
import com.codemind.ai.entity.AiConversation;
import com.codemind.ai.entity.recommend.RecommendContent;
import com.codemind.ai.entity.recommend.RelatedTopic;
import com.codemind.ai.entity.recommend.RelatedTopics;
import com.codemind.ai.service.AiConversationService;
import com.codemind.ai.mapper.AiConversationMapper;
import com.codemind.ai.vo.*;
import com.codemind.ai.vo.recommend.RecommendArticleData;
import com.codemind.ai.vo.recommend.RecommendContentData;
import com.codemind.ai.vo.recommend.RecommendNoteData;
import com.codemind.common.RagConstants;
import com.codemind.common.Result;
import com.codemind.community.mapper.ArticleMapper;
import com.codemind.community.service.ArticleService;
import com.codemind.community.vo.ArticleDetailVO;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.knowledge.mapper.NoteMapper;
import com.codemind.knowledge.service.NoteService;
import com.codemind.knowledge.vo.CheckNoteVO;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.ChatMemoryRepository;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.util.ObjectUtils;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
* @author wengjiaran
* @description 针对表【ai_conversation】的数据库操作Service实现
* @createDate 2026-09-07 20:11:06
*/
@Slf4j
@Service
public class AiConversationServiceImpl extends ServiceImpl<AiConversationMapper, AiConversation>
    implements AiConversationService{
    @Autowired
    private AiConversationMapper aiConversationMapper;

    @Autowired
    private ChatMemoryRepository chatMemoryRepository;

    @Autowired
    private ChatClient chatClient;

    @Autowired
    private NoteService noteService;
    @Autowired
    private ArticleService articleService;
    @Autowired
    private VectorStore vectorStore;

    @Autowired
    private ChatClient contextClient;
    @Autowired
    private StringRedisTemplate redisTemplate;
    //创建ai会话
    @Override
    public Result<AiConversationVO> CreateAiConversation() {
        //标题先使用默认标题用户回答以后根据第一次回答总结 生成标题更新数据库标题
        //获取用户id
        Long userId = UserContext.getUserId();
        if (userId == null) {
            throw BusinessException.unauthorized("请先登陆再使用ai助手");
        }
        //先随机生成三位数字拼凑新会话三个字
        String title = "新会话" + RandomUtil.randomNumbers(3);
        AiConversation conversation = new AiConversation();
        conversation.setUserId(userId);
        conversation.setTitle(title);
        save(conversation);
        AiConversationVO aiConversationVO = new AiConversationVO();
        BeanUtils.copyProperties(conversation,aiConversationVO);
        log.info("创建会话成功id:{}",conversation.getId());
        //保存数据库
        return Result.success(aiConversationVO);
    }
    //获取用户ai会话历史列表
    @Override
    public Result<List<AiConversationVO>> getUserAiConversation() {
        Long userId = UserContext.getUserId();
        if (userId == null) {
            throw BusinessException.unauthorized("请先登陆再使用ai助手");
        }
        //根据id查询数据库
        List<AiConversation> aiConversations = aiConversationMapper
                .selectList(new LambdaQueryWrapper<AiConversation>()
                        .eq(AiConversation::getUserId, userId));
        //没有数据就返回空
        if (ObjectUtils.isEmpty(aiConversations)) {

            return Result.success(new ArrayList<AiConversationVO>());
        }

        List<AiConversationVO> conversationVOS = new ArrayList<>();
        aiConversations.forEach(conversation -> {
            AiConversationVO aiConversationVO = new AiConversationVO();
            BeanUtils.copyProperties(conversation,aiConversationVO);
            conversationVOS.add(aiConversationVO);
        });

        return Result.success(conversationVOS);
    }
    /**
     * conversationId 用 String 接收是有意设计：会话 ID 是雪花算法生成的 19 位 Long，
     * 超出 JS 的 Number.MAX_SAFE_INTEGER（16 位），前端按数字解析会丢精度 —— 不要改成 Long 入参。
     * 这里只负责把外部字符串转成 Long；非数字、超出 Long 范围一律给 400，
     * 避免漏成 500「系统繁忙」（BUG-AI3）。
     */
    private Long parseConversationId(String conversationId) {
        try {
            return Long.valueOf(conversationId);
        } catch (NumberFormatException e) {
            log.warn("conversationId 格式不正确 conversationId={}", conversationId);
            throw BusinessException.badRequest("conversationId 格式不正确");
        }
    }

    /**
     * 把向量库 metadata 里的 id 转成 Long。
     * Milvus 的 metadata 是 JSON，Spring AI 用 Gson 反序列化后，JSON 数字一律变成 java.lang.Double，
     * 所以「Long.valueOf(String.valueOf(19.0))」会抛 NumberFormatException: For input string: "19.0"，
     * 导致只要有检索命中就整体失败（BUG-AI5）。这里统一按 Number 父类取整数值。
     */
    private Long toLongId(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Number number) {
            return number.longValue();
        }
        try {
            return Long.valueOf(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            log.warn("向量库 metadata 中的 id 无法解析 value={}", value);
            return null;
        }
    }

    //获取某一个会话的内容
    @Override
    public Result<List<MessageVO>> conversationMessages(String conversationId) {
        //根据上下文获取用户id
        Long userId = UserContext.getUserId();
        //把会话id转成long 结合查询业务表（非数字/超出 Long 范围给 400，见 parseConversationId）
        Long chatId = parseConversationId(conversationId);

        AiConversation conversation = getById(chatId);
        //存在性(404)与归属(403)分开报，原来带 userId 一起查、共用「当前会话不存在」一句（BUG-06）
        if (ObjectUtils.isEmpty(conversation)) {
            log.warn("会话不存在 conversationId={}", chatId);
            throw BusinessException.notFound("当前会话不存在");
        }
        if (!userId.equals(conversation.getUserId())) {
            log.warn("无权访问该会话 conversationId={}", chatId);
            throw BusinessException.forbidden("无权访问该会话");
        }
        //查到了 再根据会话id查询消息表
        List<MessageVO> messageVOList = chatMemoryRepository
                .findByConversationId(conversationId)
                .stream().map(MessageVO::new).toList();
        //封装数据返回
        return Result.success(messageVOList);
    }

    @Override
    public Flux<String> chat(ChatDTO chatDTO) {
        //先校验参数：缺字段时过去会走到 Long.valueOf(null) 抛 NumberFormatException，被兜底成 500「系统繁忙」，
        //前端以为服务端崩了，实际只是字段名写错（例如传了 message 而不是 prompt）
        if (ObjectUtils.isEmpty(chatDTO)
                || ObjectUtils.isEmpty(chatDTO.getConversationId())
                || ObjectUtils.isEmpty(chatDTO.getPrompt())) {
            log.warn("chat 参数缺失 conversationId={}, prompt={}",
                    chatDTO == null ? null : chatDTO.getConversationId(),
                    chatDTO == null ? null : chatDTO.getPrompt());
            throw BusinessException.badRequest("conversationId 与 prompt 不能为空");
        }
        //校验是否为同一个用户
        Long userId = UserContext.getUserId();
        Long chatId = parseConversationId(chatDTO.getConversationId());
        StringBuilder fullResponse = new StringBuilder();
        //存在性(404)与归属(403)分开报，原来带 userId 一起查、共用「会话不存在或无权访问」
        AiConversation conversation = getById(chatId);
        if (ObjectUtils.isEmpty(conversation)) {
            log.warn("会话不存在 conversationId={}", chatId);
            throw BusinessException.notFound("会话不存在");
        }
        if (!userId.equals(conversation.getUserId())) {
            log.warn("无权访问该会话 conversationId={}", chatId);
            throw BusinessException.forbidden("无权访问该会话");
        }

        //生成专门会话标题校验 改字段
        boolean status = update(new LambdaUpdateWrapper<AiConversation>().eq(AiConversation::getId, chatId)
                .eq(AiConversation::getTitleGenerated, 0)
                .set(AiConversation::getTitleGenerated, 1));

        Flux<String> content = chatClient.prompt()
                .user(chatDTO.getPrompt())
                .toolContext(Map.of("userId",userId))
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, chatDTO.getConversationId()))
                .stream().content()
                //流响应的消息装到stringbuffer
                .doOnNext(fullResponse::append)
        // 3. 流正常完成时触发
                .doOnComplete(()->{
                    if (!status) {
                        return;
                    }
                    Mono.fromRunnable(()->{
                        try {
                            String fullText = fullResponse.toString();
                            String prompt = chatDTO.getPrompt();
                            //调用一个子模型生成标题
                            String title = generateSessionTitle(fullText,prompt);
                            //更新名称
                            updateSessionTitle(chatId, title, userId);
                        } catch (Exception e) {
                            // 3. 失败回滚标记，允许重试
                            update(new LambdaUpdateWrapper<AiConversation>()
                                    .eq(AiConversation::getId, chatId)
                                    .set(AiConversation::getTitleGenerated, 0));
                            log.error("生成标题失败, chatId={}", chatId, e);
                        }
                    }).subscribeOn(Schedulers.boundedElastic()).subscribe();
                });

        return content;
    }
    //更新会话名称
    private void updateSessionTitle(Long chatId, String title, Long userId) {
        update(new LambdaUpdateWrapper<AiConversation>().eq(AiConversation::getId, chatId)
                .eq(AiConversation::getUserId, userId)
                .set(AiConversation::getTitle, title));
    }

    private String generateSessionTitle(String fullText, String userPrompt) {
        //封装提示词
        String prompt = """
        你是一个专业的会话标题生成助手。你的任务是根据用户的问题和AI助手的回复，提炼出一个简洁、准确的会话标题。

        要求：
        1. 标题长度不超过 10 个汉字。
        2. 标题要能概括本次对话的核心主题。
        3. 优先参考用户问题，AI回复作为辅助理解。
        4. 直接返回标题文本，不要添加任何解释、标点符号、引号、前缀或后缀。
        5. 如果无法提炼，则返回“未命名会话”。

        用户问题：
        %s

        AI助手回复：
        %s

        请直接输出标题：
        """.formatted(userPrompt, fullText);

        //调用模型接口
        //数据返回
        String title = contextClient.prompt()
                .user(prompt)
                .call()
                .content()
                .trim();
        //校验长度
        // 兜底：去空白 + 去首尾引号，超长才截
        title = title == null ? "未命名会话" : title.trim().replaceAll("^[\"'“”]+|[\"'“”]+$", "");
        if (title.codePointCount(0, title.length()) > 15) {
            title = title.substring(0, title.offsetByCodePoints(0, 14)) + "…";
        }
        //返回
        return title;
    }

    @Override
    public List<KnowledgeSearchResultData> searchKnowledge(String prompt) {
        //导入操作向量接口
        SearchRequest request = SearchRequest.builder()
                .topK(5)
                .query(prompt)
                .similarityThreshold(0.6)
                .filterExpression("type == 'article' || type == 'note'")
                .build();
        //提示词向量化/向量知识库检索
        List<Document> documents = vectorStore.similaritySearch(request);
        //封装
        List<KnowledgeSearchResultData> knowledgeSearchResultDataList = new ArrayList<>();
        documents.forEach(t->{
            //根据类型判断返回的documents是文章还是笔记
            //然后再赋值
            if (t.getMetadata().get("type").equals(RagConstants.VECTOR_ARTICLE_TYPE)){
                Object objectId = t.getMetadata().get("articleId");
                Object objTitle = t.getMetadata().get("title");
                if (objectId == null || objTitle == null) {
                    return;
                }
                //文章id（metadata 里是 JSON 数字，Gson 解析成 Double，须走 Number 转换）
                Long articleId = toLongId(objectId);
                if (articleId == null) {
                    return;
                }
                String title = String.valueOf(objTitle);
                KnowledgeSearchResultData searchResultData = new KnowledgeSearchResultData();
                searchResultData.setArticleId(articleId).setTitle(title)
                        .setScore(t.getScore()).setContent(t.getText());
                knowledgeSearchResultDataList.add(searchResultData);
            }else if (t.getMetadata().get("type").equals(RagConstants.VECTOR_NOTE_TYPE)){
                Object objectId = t.getMetadata().get("noteId");
                Object objTitle = t.getMetadata().get("title");
                if (objectId == null || objTitle == null) {
                    return;
                }
                //笔记id（metadata 里是 JSON 数字，Gson 解析成 Double，须走 Number 转换）
                Long noteId = toLongId(objectId);
                if (noteId == null) {
                    return;
                }
                String title = String.valueOf(objTitle);
                KnowledgeSearchResultData searchResultData = new KnowledgeSearchResultData();
                searchResultData.setNoteId(noteId).setTitle(title)
                        .setScore(t.getScore()).setContent(t.getText());
                knowledgeSearchResultDataList.add(searchResultData);
            }
        });
        //返回
        return knowledgeSearchResultDataList;
    }

    @Override
    public RecommendContentData findRelatedContent(RecommendContent recommendContent) {
        //通过类型判断是否文章或者笔记
        if (ObjectUtils.isEmpty(recommendContent)) {
            throw BusinessException.badRequest("recommendContent 内容为空");
        }
        String contentJson = getContentJson(recommendContent);
            //发给大模型
            RelatedTopics topics = contextClient.prompt()
                    .user("""
                             你是 CodeMind 的知识关联分析器。
                                            请阅读下面的文章内容，分析这篇文章涉及的核心技术知识，
                                            提取 3~8 个适合继续检索的相关知识点。
                                            要求：
                                            1. 知识点必须与当前文章直接或间接相关。
                                            2. 优先提取技术概念、技术场景、解决方案、关联知识。
                                            3. 不要生成文章中不存在且完全无关的知识点。
                                            4. 不需要总结文章。
                                            5. 每个知识点需要包含 name、reason、type。
                                            6. type 只能是 concept、scenario、solution、technology。
                                            7. 必须按照结构化输出格式返回。
                                            8. topics 数量控制在 3~8 个。
                            
                                            文章内容：
                                            %s
                            """.formatted(contentJson))
                    .call()
                    //获取推荐内容 结构化输出
                    .entity(RelatedTopics.class);
            //获取推荐内容 结构化输出
            //取出所有name
            if (ObjectUtils.isEmpty(topics)) {
                throw BusinessException.serverError("系统请求模型异常，请重试");
            }
            //获取推荐内容
        String query = topics.getTopics().stream()
                .limit(8)
                .map(t -> t.getName() + "：" + t.getReason())
                .distinct()
                .collect(Collectors.joining("\n"));
        //调用方法返回
        RecommendContentData contentData = getContentData(query,recommendContent);

        contentData.setTopics(topics);
        //返回
        return  contentData;

    }
    //删除某一个会话
    @Override
    public Result<Void> deleteConversation(String conversationId) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //转换id
        Long chaId = parseConversationId(conversationId);
        //校验会话是否存在
        AiConversation aiConversation = getById(chaId);
        if (ObjectUtils.isEmpty(aiConversation)) {
            throw BusinessException.notFound("会话不存在");
        }
        //校验是否为同一个用户
        if (!Objects.equals(userId, aiConversation.getUserId())) {
            throw BusinessException.forbidden("无权操作");
        }
        //删除ai会话信息
        chatMemoryRepository.deleteByConversationId(conversationId);
        //删除
        remove(new LambdaQueryWrapper<AiConversation>().eq(AiConversation::getUserId, userId)
                .eq(AiConversation::getId,chaId));

        return Result.success("操作成功");
    }

    private RecommendContentData getContentData(String query,RecommendContent content) {
        if (ObjectUtils.isEmpty(query)) {
            throw BusinessException.serverError("query 异常，请重试");
        }
        String filter = "";
        //根据类型排除当前文章或者笔记
        if (Objects.equals(content.getType(), "article")) {
            //文章
            filter = "articleId !="+content.getArticleId();
        }
        if (Objects.equals(content.getType(), "note")) {
            //笔记
            filter = "noteId !="+content.getNoteId();
        }
        // 向量搜索
        SearchRequest request = SearchRequest.builder()
                .topK(10)
                .similarityThreshold(0.6)
                .query(query)
                .filterExpression(filter).build();
        List<Document> documents = vectorStore.similaritySearch(request);
        //封装document返回
        List<RecommendArticleData> recommendArticleDataList = new ArrayList<>();
        List<RecommendNoteData> recommendNoteDataList = new ArrayList<>();
        documents.forEach(document -> {
            if (document.getMetadata().get("type").equals(RagConstants.VECTOR_ARTICLE_TYPE)){
                Object objectId = document.getMetadata().get("articleId");
                Object objTitle = document.getMetadata().get("title");
                if (objectId == null || objTitle == null) {
                    return;
                }
                //文章id（metadata 里是 JSON 数字，Gson 解析成 Double，须走 Number 转换）
                Long articleId = toLongId(objectId);
                if (articleId == null) {
                    return;
                }
                String title = String.valueOf(objTitle);
                //封装数据
                RecommendArticleData articleData = new RecommendArticleData();
                articleData.setTitle(title)
                        .setArticleId(articleId).setContent(document.getText())
                        .setScore(document.getScore());
                recommendArticleDataList.add(articleData);
            }
            if (document.getMetadata().get("type").equals(RagConstants.VECTOR_NOTE_TYPE)){
                Object objectId = document.getMetadata().get("noteId");
                Object objTitle = document.getMetadata().get("title");
                if (objectId == null || objTitle == null) {
                    return;
                }
                //笔记id（metadata 里是 JSON 数字，Gson 解析成 Double，须走 Number 转换）
                Long noteId = toLongId(objectId);
                if (noteId == null) {
                    return;
                }
                String title = String.valueOf(objTitle);
                RecommendNoteData noteData = new RecommendNoteData();
                noteData.setTitle(title).setNoteId(noteId).setContent(document.getText())
                        .setScore(document.getScore());
                recommendNoteDataList.add(noteData);
            }
        });

        //返回数据
        RecommendContentData contentData = new RecommendContentData();
        contentData.setArticleDataList(recommendArticleDataList);
        contentData.setNoteDataList(recommendNoteDataList);
        return contentData;

    }

    private String getContentJson(RecommendContent content) {

        if (Objects.equals(content.getType(), "article")) {

            Result<ArticleDetailVO> result =
                    articleService.checkArticle(content.getArticleId());

            return JSONUtil.toJsonStr(result.getData());
        }

        if (Objects.equals(content.getType(), "note")) {

            Result<CheckNoteVO> result =
                    noteService.getNote(content.getNoteId());

            return JSONUtil.toJsonStr(result.getData());
        }

        throw BusinessException.badRequest("不支持的内容类型");
    }
}




