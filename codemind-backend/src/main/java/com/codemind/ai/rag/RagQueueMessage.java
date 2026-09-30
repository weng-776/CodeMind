package com.codemind.ai.rag;

import cn.hutool.json.JSONUtil;
import com.codemind.ai.rag.dto.RagMessageDTO;
import com.codemind.common.RagConstants;
import com.codemind.community.entity.Article;
import com.codemind.config.RabbitConfig;
import com.codemind.knowledge.entity.Note;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.document.Document;
import org.springframework.ai.reader.markdown.MarkdownDocumentReader;
import org.springframework.ai.reader.markdown.config.MarkdownDocumentReaderConfig;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
@Slf4j
@Component
public class RagQueueMessage {
    @Autowired
    StringRedisTemplate stringRedisTemplate;
    @Autowired
    VectorStore vectorStore;
    //md文档切分规则
    MarkdownDocumentReaderConfig config = MarkdownDocumentReaderConfig.builder()
            .withHorizontalRuleCreateDocument(true)
            .withIncludeCodeBlock(true)
            .withIncludeBlockquote(true).build();

    //创建笔记创建文章向量化
    @RabbitListener(queues = RabbitConfig.RAG_QUEUE,containerFactory = "rabbitListenerContainerFactory")
    public void ArticleNoteVector(RagMessageDTO ragMessageDTO)  {
        String key = "codemind:createArticleNote:rag:"+ragMessageDTO.getUuid();
        try {
            Boolean aBoolean = stringRedisTemplate.opsForValue().setIfAbsent(key, "1", 1, TimeUnit.MINUTES);

            if (Boolean.TRUE.equals(aBoolean)) {
                //判断类型
                if (Objects.equals(ragMessageDTO.getType(), RagConstants.VECTOR_ARTICLE_TYPE)){
                    Article article = JSONUtil.toBean(ragMessageDTO.getJson(), Article.class);
                    String type = ragMessageDTO.getType();

                    articleVectorStore(article,type);

                }else {
                    //笔记向量化
                    Note note = JSONUtil.toBean(ragMessageDTO.getJson(), Note.class);
                    String type = ragMessageDTO.getType();
                    noteVectorStore(note,type);
                }
            }
        }catch (Exception e){
            stringRedisTemplate.delete(key);
            log.error("向量话失败，messageId={}", ragMessageDTO.getUuid(),e);
            throw e;

        }

    }

    //修改笔记文章更新数据库
    @RabbitListener(queues = RabbitConfig.RAG_UPDATE_QUEUE,containerFactory = "rabbitListenerContainerFactory")
    public void updateRag(RagMessageDTO messageDTO) {
        String key = "codemind:updateArticleNote:rag:"+messageDTO.getUuid();

        try {
            Boolean aBoolean = stringRedisTemplate.opsForValue().setIfAbsent(key, "1", 1, TimeUnit.MINUTES);

            if (Boolean.TRUE.equals(aBoolean)) {
                //判断类型
                if (Objects.equals(messageDTO.getType(), RagConstants.VECTOR_ARTICLE_TYPE) &&
                        Objects.equals(messageDTO.getOperation(),RagConstants.OPERATION_UPDATE)){
                    //转化
                    Article article = JSONUtil.toBean(messageDTO.getJson(), Article.class);
                    System.out.println(article.toString());

                    //拿到id
                    //删除对应向量
                    vectorStore.delete("type == 'article'&& articleId=="+article.getId());
                    //更新向量
                    articleVectorStore(article,messageDTO.getType());
                }else if (Objects.equals(messageDTO.getType(), RagConstants.VECTOR_NOTE_TYPE) &&
                        Objects.equals(messageDTO.getOperation(),RagConstants.OPERATION_UPDATE)){
                    Note note = JSONUtil.toBean(messageDTO.getJson(), Note.class);
                    //删除
                    vectorStore.delete("type == 'note'&& noteId=="+note.getId());
                    //更新
                    noteVectorStore(note,messageDTO.getType());
                }
                //删除向量库
                if (Objects.equals(messageDTO.getType(), RagConstants.VECTOR_ARTICLE_TYPE) &&
                        Objects.equals(messageDTO.getOperation(),RagConstants.OPERATION_DELETE)){
                    // 兜底：构造点若漏设顶层 id，就从 json 里补取（json 是我们自己序列化的实体，一定含 id）。
                    // 原实现直接把 id 拼进表达式，id 为 null 时会拼出「articleId==null」，
                    // 触发 FilterExpressionParseException 并被无限重投（BUG-R3/R4 的最后一道防线）。
                    Long articleId = messageDTO.getArticleId();
                    if (articleId == null && messageDTO.getJson() != null && !messageDTO.getJson().isEmpty()) {
                        articleId = JSONUtil.toBean(messageDTO.getJson(), Article.class).getId();
                    }
                    if (articleId != null) {
                        vectorStore.delete("type == 'article'&& articleId=="+articleId);
                    } else {
                        log.warn("删除文章向量时缺少 articleId，已跳过，messageId={}", messageDTO.getUuid());
                    }
                } else if (Objects.equals(messageDTO.getType(), RagConstants.VECTOR_NOTE_TYPE) &&
                        Objects.equals(messageDTO.getOperation(),RagConstants.OPERATION_DELETE)) {
                    Long noteId = messageDTO.getNoteId();
                    if (noteId == null && messageDTO.getJson() != null && !messageDTO.getJson().isEmpty()) {
                        noteId = JSONUtil.toBean(messageDTO.getJson(), Note.class).getId();
                    }
                    if (noteId != null) {
                        vectorStore.delete("type == 'note'&& noteId=="+noteId);
                    } else {
                        log.warn("删除笔记向量时缺少 noteId，已跳过，messageId={}", messageDTO.getUuid());
                    }
                }
            }

        }catch (Exception e){
            stringRedisTemplate.delete(key);
            log.error("向量化更新失败，messageId={}",
                    messageDTO.getUuid(), e);
            log.error(e.getMessage());
            log.error(e.getStackTrace()[0].toString());
            throw e;
        }

    }



    private void articleVectorStore(Article article,String type){


        // 1. 数据清洗
        String rawContent = article.getContent();

        // 修复字面量 /n 和转义 \n
        rawContent = rawContent.replace("/n", "\n").replace("\\n", "\n");

        // 可选：如果文章只有一段并且带 #，手动修复一下换行让 Reader 能识别标题
        // 注意：不要盲目全局替换，最好是根据你的实际数据规律调整。
        log.info("开始解析文章，清洗后的文本预览：\n{}", rawContent);
        // 2. 转换为 Resource
        ByteArrayResource resource = new ByteArrayResource(rawContent.getBytes(StandardCharsets.UTF_8));
        MarkdownDocumentReader reader = new MarkdownDocumentReader(resource,config);
        List<Document> documents = reader.get();

        documents.forEach(t->{
            t.getMetadata().put("articleId",article.getId());
            t.getMetadata().put("title",article.getTitle());
            t.getMetadata().put("type",type);
        });
        log.warn("向量化之前");
        vectorStore.add(documents);
        log.warn("向量化以后");
    }
    private void noteVectorStore(Note note,String type){

        // 1. 数据清洗
        String rawContent = note.getContent();

        // 修复字面量 /n 和转义 \n
        rawContent = rawContent.replace("/n", "\n").replace("\\n", "\n");

        // 可选：如果文章只有一段并且带 #，手动修复一下换行让 Reader 能识别标题
        // 注意：不要盲目全局替换，最好是根据你的实际数据规律调整。
        log.info("开始解析笔记，清洗后的文本预览：\n{}", rawContent);
        ByteArrayResource resource = new ByteArrayResource(rawContent.getBytes(StandardCharsets.UTF_8));

        MarkdownDocumentReader reader = new MarkdownDocumentReader(resource,config);
        List<Document> documents = reader.read();
        documents.forEach(t->{
            t.getMetadata().put("noteId",note.getId());
            t.getMetadata().put("title",note.getTitle());
            t.getMetadata().put("type",type);
        });

        vectorStore.add(documents);
    }

}
