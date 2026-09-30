package com.codemind.config;

import org.springframework.amqp.core.*;
import org.springframework.amqp.rabbit.config.RetryInterceptorBuilder;
import org.springframework.amqp.rabbit.config.SimpleRabbitListenerContainerFactory;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.retry.RejectAndDontRequeueRecoverer;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.boot.autoconfigure.amqp.SimpleRabbitListenerContainerFactoryConfigurer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.retry.backoff.FixedBackOffPolicy;

@Configuration
public class RabbitConfig {
    public static final String EXCHANGE      = "codemind.exchange";//文章相关交换机：喜欢计数  删除缓存 //发布文章缓存到热门文章里面
    public static final String COUNT_QUEUE   = "codemind.count.queue";//喜欢计数
    public static final String CACHE_QUEUE   = "codemind.cache.queue"; // 删除缓存队列(需要死信)
    public static final String VIEW_QUEUE   = "codemind.view.queue"; //浏览量计数
    public static final String ARTICLE_QUEUE   = "codemind.article.queue";//发布文章缓存到热门文章里面(不需要当用户查看文章也会加入到reids)
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
     //死信交换机与队列
    public static final String DLX_EXCHANGE = "codemind.dlx";
    //死信队列
    public static final String CACHE_DEAD_QUEUE = "codemind.cache.queue.dead";
    //消息模块死信队列
    public static final String FOLLOW_NOTICE_DEAD_QUEUE = "codemind.follow.notice.queue.dead";
    public static final String LIKE_NOTICE_DEAD_QUEUE   = "codemind.like.notice.queue.dead";
    public static final String COMMENT_NOTICE_DEAD_QUEUE   = "codemind.comment.notice.queue.dead";
    //rag死信队列
    public static final String RAG_DEAD_QUEUE = "codemind.arg.article-note.queue.dead";
    public static final String RAG_UPDATE_DEAD_QUEUE = "codemind.arg.update.article-note.queue.dead";

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
        return  QueueBuilder.durable(CACHE_QUEUE)
                .deadLetterExchange(DLX_EXCHANGE)
                .deadLetterRoutingKey("cache")
                .build();
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
        return QueueBuilder.durable(FOLLOW_NOTICE_QUEUE)
                .deadLetterExchange(DLX_EXCHANGE)
                .deadLetterRoutingKey("follow.notice").build();
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
        return  QueueBuilder.durable(LIKE_NOTICE_QUEUE)
                .deadLetterExchange(DLX_EXCHANGE)
                .deadLetterRoutingKey("like.notice").build();
    }
    //绑定交换机
    @Bean
    public  Binding likeNoticeBinding(){
        return BindingBuilder.bind(likeNoticeQueue()).to(noticeExchange()).with("like.notice");
    }

    //评论队列
    @Bean
    public Queue commentNoticeQueue(){
        return QueueBuilder.durable(COMMENT_NOTICE_QUEUE)
                .deadLetterExchange(DLX_EXCHANGE)
                .deadLetterRoutingKey("comment.notice").build();
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
        return QueueBuilder.durable(RAG_QUEUE)
                .deadLetterExchange(DLX_EXCHANGE)
                .deadLetterRoutingKey("rag").build();
    }
    //绑定rag发布文章发布笔记交换机与队列
    @Bean
    public  Binding RagBinding(){
        return  BindingBuilder.bind(RagQueue()).to(RagExchange()).with("rag");
    }

    @Bean
    public Queue RagUpdateQueue(){
        return QueueBuilder.durable(RAG_UPDATE_QUEUE)
                .deadLetterExchange(DLX_EXCHANGE)
                .deadLetterRoutingKey("rag.update.delete").build();
    }
    @Bean
    public   Binding RagUpdateBinding(){
        return BindingBuilder.bind(RagUpdateQueue()).to(RagExchange()).with("rag.update.delete");
    }
    //死信交换机与队列
    @Bean
    public DirectExchange dlxExchange() {
        return  new DirectExchange(DLX_EXCHANGE,true,false);
    }
    //死信队列文章
    @Bean
    public  Queue dlxArticleQueue() {
        return new Queue(CACHE_DEAD_QUEUE,true);
    }
    //消息死信队列
    @Bean
    public Queue dlxFollowQueue() {
        return new Queue(FOLLOW_NOTICE_DEAD_QUEUE,true);
    }
    @Bean
    public Queue dlxCommentQueue() {
        return new Queue(COMMENT_NOTICE_DEAD_QUEUE,true);
    }
    @Bean
    public Queue dlxLikeQueue() {
        return new Queue(LIKE_NOTICE_DEAD_QUEUE,true);
    }
    //rag死信队列
    @Bean
    public Queue dlxRagQueue() {
        return new Queue(RAG_DEAD_QUEUE,true);
    }
    @Bean
    public  Queue dlxRagUpdateQueue() {
        return new Queue(RAG_UPDATE_DEAD_QUEUE,true);
    }
    //绑定死信交换机与队列

    @Bean
    public   Binding dlxArticleBinding(){
        return BindingBuilder.bind(dlxArticleQueue()).to(dlxExchange()).with("cache");
    }
    //消息相关绑定
    @Bean
    public   Binding dlxFollowBinding(){
        return BindingBuilder.bind(dlxFollowQueue()).to(dlxExchange()).with("follow.notice");
    }
    @Bean
    public  Binding dlxLikeBinding(){
        return BindingBuilder.bind(dlxLikeQueue()).to(dlxExchange()).with("like.notice");
    }
    @Bean
    public   Binding dlxCommentBinding(){
        return BindingBuilder.bind(dlxCommentQueue()).to(dlxExchange()).with("comment.notice");
    }
    //rag死信绑定
    @Bean
    public Binding dlxRagBinding(){
        return BindingBuilder.bind(dlxRagQueue()).to(dlxExchange()).with("rag");
    }
    @Bean
    public  Binding dlxRagUpdateBinding(){
        return BindingBuilder.bind(dlxRagUpdateQueue()).to(dlxExchange()).with("rag.update.delete");
    }

    //消费者自动ack自动重试
    @Bean
    public SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
            SimpleRabbitListenerContainerFactoryConfigurer configurer,
            ConnectionFactory connectionFactory) {

        SimpleRabbitListenerContainerFactory factory =
                new SimpleRabbitListenerContainerFactory();

        // 必须先走 Boot 的 configurer（顺带把 connectionFactory 也设上）：
        //   只有它会注入 Jackson2Json 消息转换器，并套用 spring.rabbitmq.listener.simple.*
        //   （ack 模式 / prefetch / defaultRequeueRejected 等）。
        //   自定义工厂一旦跳过这一步，容器会退回默认的 SimpleMessageConverter，
        //   而生产端 RabbitTemplate 发的是 JSON → 每条消息反序列化即失败 → 全进死信。
        configurer.configure(factory, connectionFactory);

        // 固定 1 秒间隔重试。
        // 用 FixedBackOffPolicy
        FixedBackOffPolicy backOffPolicy = new FixedBackOffPolicy();
        backOffPolicy.setBackOffPeriod(1000);

        factory.setAdviceChain(
                RetryInterceptorBuilder.stateless()
                        .maxAttempts(3)                  // 共 3 次尝试（1 次初始 + 2 次重试）
                        .backOffPolicy(backOffPolicy)    // 每次失败后等 1 秒
                        .recoverer(new RejectAndDontRequeueRecoverer())
                        .build()
        );

        return factory;
    }


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
