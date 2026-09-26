package com.codemind.community.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.ai.entity.search.SearchComment;
import com.codemind.common.Result;
import com.codemind.community.dto.ReleaseCommentDTO;
import com.codemind.community.entity.Comment;
import com.codemind.community.vo.CommentVO;
import com.baomidou.mybatisplus.extension.service.IService;
import jakarta.validation.Valid;

/**
* @author wengjiaran
* @description 针对表【comment(评论表)】的数据库操作Service
* @createDate 2026-08-07 20:22:27
*/
public interface CommentService extends IService<Comment> {
    //发布回复评论
    Result<Long> releaseComment(@Valid ReleaseCommentDTO releaseCommentDTO);
    //3.15 删除评论（逻辑删除自己的评论）
    Result<Void> deleteComment(Long commentId);
    //3.16 查看评论列表（分页，一级评论带children嵌套）
    Result<Page<CommentVO>> commentList(Long articleId, Integer page, Integer size);
    //大模型查看指定文章接口
    Page<CommentVO> queryCommentListTool(SearchComment comment);
    //查看回复列表
    Result<Page<CommentVO>> replyList(Long rootId, Integer page, Integer size);
}
