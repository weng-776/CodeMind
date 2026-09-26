package com.codemind.ai.rag;

import cn.hutool.json.JSONUtil;
import com.codemind.ai.rag.dto.RagMessageDTO;
import com.codemind.common.RagConstants;
import com.codemind.community.entity.Article;
import com.codemind.config.RabbitConfig;
import com.codemind.knowledge.entity.Note;
import com.rabbitmq.client.Channel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.document.Document;
import org.springframework.ai.reader.markdown.MarkdownDocumentReader;
import org.springframework.ai.reader.markdown.config.MarkdownDocumentReaderConfig;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.amqp.support.AmqpHeaders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

import java.io.IOException;
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
    @RabbitListener(queues = RabbitConfig.RAG_QUEUE)
    public void ArticleNoteVector(RagMessageDTO ragMessageDTO, Channel channel,
                                  @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
        String key = "codemind:createArticleNote:rag:"+ragMessageDTO.getUuid();
        // 重试计数的 key
        String retryKey = "codemind:rag:retry:" + ragMessageDTO.getUuid();
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
            //手动返回ack
            channel.basicAck(tag,false);
            stringRedisTemplate.delete(retryKey);
        }catch (Exception e){
            stringRedisTemplate.delete(key);
            Long retryCount = stringRedisTemplate.opsForValue().increment(retryKey);
            if (retryCount != null && retryCount ==0){
                stringRedisTemplate.expire(retryKey, 10, TimeUnit.MINUTES);
            }
            // 2. 第一次失败时，给计数器设置一个过期时间（比如10分钟），防止 Redis 内存泄漏
            if (retryCount != null && retryCount == 1) {
                stringRedisTemplate.expire(retryKey, 10, TimeUnit.MINUTES);
            }

            log.error("向量化失败，当前第 {} 次重试，messageId={}", retryCount, ragMessageDTO.getUuid(), e);
            log.error(e.getMessage());
            log.error(e.getStackTrace()[0].toString());
            // 3. 判断次数
            if (retryCount != null && retryCount <= 3) {
                // 1~3次：重新入队，等待重试
                channel.basicNack(tag, false, true); // requeue = true
            } else {
                // 超过3次：直接丢弃（或进入DLX）
                log.error("重试已达3次，放弃重试并丢弃消息，messageId={}", ragMessageDTO.getUuid());
                channel.basicNack(tag, false, false); // requeue = false
                //  retryKey 清掉
                stringRedisTemplate.delete(retryKey);
            }

        }

    }

    //修改笔记文章更新数据库
    @RabbitListener(queues = RabbitConfig.RAG_UPDATE_QUEUE)
    public void updateRag(RagMessageDTO messageDTO ,Channel channel,@Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
        String key = "codemind:updateArticleNote:rag:"+messageDTO.getUuid();
        // 重试计数的 key
        String retryKey = "codemind:rag:retry:" + messageDTO.getUuid();
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


            channel.basicAck(tag,false);
            //处理成功删除重试次数
            stringRedisTemplate.delete(retryKey);

        }catch (Exception e){
            stringRedisTemplate.delete(key);
            //获取重试次数
            Long retryCount = stringRedisTemplate.opsForValue().increment(retryKey);
            if (retryCount != null && retryCount == 1) {
                stringRedisTemplate.expire(retryKey, 10, TimeUnit.MINUTES);
            }
            log.error("向量化更新失败，当前第 {} 次重试，messageId={}",
                    retryCount, messageDTO.getUuid(), e);
            log.error(e.getMessage());
            log.error(e.getStackTrace()[0].toString());
            if (retryCount != null && retryCount<=3){
                channel.basicNack(tag,false,true);
            }else {
                channel.basicNack(tag,false,false);
                log.error("重试已达3次，放弃重试并丢弃消息，messageId={}", messageDTO.getUuid());
                stringRedisTemplate.delete(retryKey);
            }


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
