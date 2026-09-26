package com.codemind.config;

import com.codemind.ai.prompt.SystemPrompt;
import com.codemind.ai.tools.CommentTools;
import com.codemind.ai.tools.RecommendRelatedContentTools;
import com.codemind.ai.tools.SearchTools;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.client.advisor.SimpleLoggerAdvisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.chat.memory.repository.jdbc.JdbcChatMemoryRepository;
import org.springframework.ai.deepseek.DeepSeekChatModel;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class SpringAiConfiguration {
    @Autowired
    private SearchTools searchTools;
    @Autowired
    private CommentTools commentTools;
    @Autowired
    RecommendRelatedContentTools relatedContentTools;


    @Bean
    public ChatClient chatClient(DeepSeekChatModel model ,ChatMemory chatMemory) {
        return ChatClient.builder(model)//添加模型
                .defaultSystem(SystemPrompt.systemPrompt) //系统提示词
                .defaultAdvisors(SimpleLoggerAdvisor.builder().build()) //开启日志
                .defaultTools(searchTools,commentTools,relatedContentTools)//配置工具列表
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build()) //开启会话记忆
                .build();
    }

    @Bean //上下文ai
    public ChatClient contextClient(DeepSeekChatModel model){
        return  ChatClient.builder(model)
                .defaultAdvisors(SimpleLoggerAdvisor.builder().build()) //开启日志
                .build();
    }


    //配置消息
    @Bean
    public ChatMemory chatMemory(JdbcChatMemoryRepository repository){
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)
                .build();
    }
}
