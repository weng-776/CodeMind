package com.codemind.config;

import org.springframework.amqp.core.*;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.Stack;

@Configuration
public class RabbitConfig {
    public static final String EXCHANGE      = "codemind.exchange";
    public static final String COUNT_QUEUE   = "codemind.count.queue";
    public static final String CACHE_QUEUE   = "codemind.cache.queue";
    public static final String VIEW_QUEUE   = "codemind.view.queue";
    public static final String ARTICLE_QUEUE   = "codemind.article.queue";
    //消息通知模块的交换机队列
    public static final String NOTICE_EXCHANGE = "codemind.notice.exchange";
    public static final String FOLLOW_NOTICE_QUEUE   = "codemind.follow.notice.queue";
    public static final String LIKE_NOTICE_QUEUE   = "codemind.like.notice.queue";
    public static final String COMMENT_NOTICE_QUEUE   = "codemind.comment.notice.queue";

    //rag向量化的交换机队列
    public static final String RAG_EXCHANGE = "codemind.arg.article-note.exchange";
    public static final String RAG_QUEUE = "codemind.arg.article-note.queue";
    public static final String RAG_UPDATE_QUEUE = "codemind.arg.update.article-note.queue";
    public static final String RAG_NODE_VISIBILITY = "codemind.arg.node.visibility.queue";


    @Bean //指定交换机
    public DirectExchange directExchange() {
        return new DirectExchange(EXCHANGE,true,false);
    }
    @Bean
    public Queue Countqueue() {
        return  new Queue(COUNT_QUEUE,true);
    }

    //绑定
    @Bean
    public Binding countBinding(){
        return  BindingBuilder.bind(Countqueue()).to(directExchange()).with("count");
    }

    //浏览量队列
    @Bean
    public Queue viewQueue(){
        return  new Queue(VIEW_QUEUE,true);
    }

    //绑定交换机队列
    @Bean
    public  Binding viewBinding(){
        return   BindingBuilder.bind(viewQueue())
                .to(directExchange()).with("view.count");
    }

    //文章详情队列
    @Bean
    public  Queue cacheQueue(){
        return  new Queue(CACHE_QUEUE,true);
    }
    @Bean
    public Binding cacheBinding(){
        return  BindingBuilder.bind(cacheQueue()).to(directExchange()).with("cache");
    }

    //发布文章预热详情缓存 热门文章初始分数 队列
    @Bean
    public Queue articleQueue(){
        return   new Queue(ARTICLE_QUEUE,true);
    }
    @Bean
    public Binding articleBinding(){
        return   BindingBuilder.bind(articleQueue()).to(directExchange()).with("article");
    }

    //消息通知模块的交换机队列
    @Bean
    public  Queue followNoticeQueue(){
        return   new Queue(FOLLOW_NOTICE_QUEUE,true);
    }
    //指定消息模块交换机
    @Bean
    public DirectExchange noticeExchange() {
        return  new DirectExchange(NOTICE_EXCHANGE,true,false);
    }
    @Bean
    public  Binding noticeBinding(){
        return BindingBuilder.bind(followNoticeQueue()).to(noticeExchange()).with("follow.notice");
    }

    //喜欢队列
    @Bean
    public Queue likeNoticeQueue(){
        return   new Queue(LIKE_NOTICE_QUEUE,true);
    }
    //绑定交换机
    @Bean
    public  Binding likeNoticeBinding(){
        return BindingBuilder.bind(likeNoticeQueue()).to(noticeExchange()).with("like.notice");
    }

    //评论队列
    @Bean
    public Queue commentNoticeQueue(){
        return new Queue(COMMENT_NOTICE_QUEUE,true);
    }

    //绑定
    @Bean
    public   Binding commentNoticeBinding(){
        return BindingBuilder.bind(commentNoticeQueue()).to(noticeExchange()).with("comment.notice");
    }

    //rag的交换机与队列
    @Bean
    public DirectExchange RagExchange(){
//        交换机
        return new DirectExchange(RAG_EXCHANGE,true,false);
    }

    @Bean //rag发布文章发布笔记队列
    public Queue RagQueue(){
        return  new Queue(RAG_QUEUE,true);
    }
    //绑定rag发布文章发布笔记交换机与队列
    @Bean
    public  Binding RagBinding(){
        return  BindingBuilder.bind(RagQueue()).to(RagExchange()).with("rag");
    }

    @Bean
    public Queue RagUpdateQueue(){
        return  new Queue(RAG_UPDATE_QUEUE,true);
    }
    @Bean
    public   Binding RagUpdateBinding(){
        return BindingBuilder.bind(RagUpdateQueue()).to(RagExchange()).with("rag.update.delete");
    }

//    @Bean
//    public Queue nodeVisibilityQueue(){
//        return new Queue(RAG_NODE_VISIBILITY,true);
//    }
//    @Bean
//    public Binding nodeVisibilityBinding(){
//        return BindingBuilder.bind(nodeVisibilityQueue()).to(RagExchange()).with("node.visibility");
//    }


    //序列化
    @Bean
    public MessageConverter messageConverter(){
        // 1.定义消息转换器
        Jackson2JsonMessageConverter jackson2JsonMessageConverter = new Jackson2JsonMessageConverter();
        // 2.配置自动创建消息id，用于识别不同消息，也可以在业务中基于ID判断是否是重复消息
        jackson2JsonMessageConverter.setCreateMessageIds(true);
        return jackson2JsonMessageConverter;
    }
}
