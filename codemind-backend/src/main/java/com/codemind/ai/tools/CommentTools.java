package com.codemind.ai.tools;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.ai.entity.search.SearchComment;
import com.codemind.community.service.CommentService;
import com.codemind.community.vo.CommentVO;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

@Component
public class CommentTools {
    @Autowired
    private CommentService commentService;
    @Tool(description = "当用户想查看指定文章评论内容时，可调用本工具")
    public Page<CommentVO> queryCommentList(@ToolParam(description = "相关文章评论的查询条件")SearchComment comment){
       return commentService.queryCommentListTool(comment);
    }
}
