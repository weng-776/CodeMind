package com.codemind.community.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.community.dto.ReleaseCommentDTO;
import com.codemind.community.service.CommentService;
import com.codemind.community.vo.CommentVO;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

//评论相关
@RestController
@RequestMapping("/api")
@CrossOrigin
@Validated
public class CommentController {
    @Autowired
    private CommentService commentService;
    //发布评论/回复评论
    @PostMapping("comment")
    public Result<Long> releaseComment(@Valid @RequestBody ReleaseCommentDTO releaseCommentDTO){
       return commentService.releaseComment(releaseCommentDTO);
    }
    //3.15 删除评论（逻辑删除自己的评论）
    @DeleteMapping("comment/{commentId}")
    public Result<Void> deleteComment(@PathVariable Long commentId){
        return commentService.deleteComment(commentId);
    }
    //3.16 查看评论列表（分页，一级评论带children嵌套，按时间正序）
    @GetMapping("article/{articleId}/comment")
    public Result<Page<CommentVO>> commentList(@PathVariable Long articleId,
                                               @RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                               @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size){
        return commentService.commentList(articleId, page, size);
    }
    @GetMapping("comment/{rootId}/replies")
    public Result<Page<CommentVO>> replyList(@PathVariable(value = "rootId") Long rootId,
                                             @RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                             @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size){

        return commentService.replyList(rootId,page,size);

    }
}
