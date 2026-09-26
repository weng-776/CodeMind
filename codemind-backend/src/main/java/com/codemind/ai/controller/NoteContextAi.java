package com.codemind.ai.controller;

import com.codemind.ai.prompt.AiTaskType;
import com.codemind.ai.prompt.PromptBuilder;
import com.codemind.knowledge.service.NoteService;
import com.codemind.knowledge.vo.CheckNoteVO;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RequestMapping("/api/ai")
@RestController
public class NoteContextAi {
    @Autowired
    private NoteService noteService;
    @Autowired
    private ChatClient contextClient;
    @Autowired
    PromptBuilder promptBuilder;
    //总结
    @PostMapping(value = "notes/{noteId}/summary",produces = "text/html;charset=UTF-8")
    public Flux<String> summaryNote(@PathVariable(value = "noteId") Long noteId) {
        CheckNoteVO note = noteService.getNote(noteId).getData();
        //提示词
        AiTaskType taskType = AiTaskType.SUMMARY;
        String prompt = promptBuilder.build(taskType, note.getTitle(), note.getContent());
        //配置模型 发送返回
       return contextClient.prompt(prompt)
                .stream().content();
    }
    //知识点提取
    @PostMapping(value = "notes/{noteId}/knowledge-points",produces = "text/html;charset=UTF-8")
    public Flux<String> knowledgePointsNote(@PathVariable(value = "noteId") Long noteId) {
        CheckNoteVO note = noteService.getNote(noteId).getData();
        //提示词
        AiTaskType taskType = AiTaskType.KNOWLEDGE_EXTRACT;
        String prompt = promptBuilder.build(taskType, note.getTitle(), note.getContent());
        //配置模型 发送返回
        return contextClient.prompt(prompt)
                .stream().content();
    }

    //生成面试题
    @PostMapping(value = "notes/{noteId}/interview-questions",produces = "text/html;charset=UTF-8")
    public Flux<String> interviewQuestionsNote(@PathVariable(value = "noteId") Long noteId) {
        CheckNoteVO note = noteService.getNote(noteId).getData();
        //提示词
        AiTaskType taskType = AiTaskType.INTERVIEW;
        String prompt = promptBuilder.build(taskType, note.getTitle(), note.getContent());
        //配置模型 发送返回
        return contextClient.prompt(prompt)
                .stream().content();
    }

}
