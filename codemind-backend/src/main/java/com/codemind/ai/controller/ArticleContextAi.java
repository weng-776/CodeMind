package com.codemind.ai.controller;

import cn.hutool.json.JSONUtil;
import com.codemind.ai.prompt.AiTaskType;
import com.codemind.ai.prompt.PromptBuilder;
import com.codemind.community.service.ArticleService;
import com.codemind.community.vo.ArticleDetailVO;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import reactor.core.publisher.Flux;

@RequestMapping("/api/ai")
@RestController
public class ArticleContextAi {
    @Autowired
    private ArticleService articleService;
    @Autowired
    private ChatClient contextClient;
    @Autowired
    PromptBuilder promptBuilder;
    //总结
    @PostMapping(value = "articles/{articleId}/summary",produces = "text/html;charset=UTF-8")
    public Flux<String> summaryArticle(@PathVariable(value = "articleId") Long articleId) {
        ArticleDetailVO data = articleService.checkArticle(articleId).getData();
        //提示词
        AiTaskType taskType = AiTaskType.SUMMARY;
        String prompt = promptBuilder.build(taskType, data.getTitle(), data.getContent());
        //配置模型 发送返回
       return contextClient.prompt(prompt)
                .stream().content();
    }
    //知识点提取
    @PostMapping(value = "articles/{articleId}/knowledge-points",produces = "text/html;charset=UTF-8")
    public Flux<String> knowledgePointsArticle(@PathVariable(value = "articleId") Long articleId) {
        ArticleDetailVO article = articleService.checkArticle(articleId).getData();
        //提示词
        AiTaskType taskType = AiTaskType.KNOWLEDGE_EXTRACT;
        String prompt = promptBuilder.build(taskType, article.getTitle(), article.getContent());
        //配置模型 发送返回
        return contextClient.prompt(prompt)
                .stream().content();
    }

    //生成面试题
    @PostMapping(value = "articles/{articleId}/interview-questions",produces = "text/html;charset=UTF-8")
    public Flux<String> interviewQuestionsArticle(@PathVariable(value = "articleId") Long articleId) {
        ArticleDetailVO article = articleService.checkArticle(articleId).getData();
        //提示词
        AiTaskType taskType = AiTaskType.INTERVIEW;
        String prompt = promptBuilder.build(taskType, article.getTitle(), article.getContent());
        //配置模型 发送返回
        return contextClient.prompt(prompt)
                .stream().content();
    }

}
