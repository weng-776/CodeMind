package com.codemind.admin.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.admin.vo.AdminArticleVO;
import com.codemind.admin.vo.AdminCommentVO;
import com.codemind.admin.vo.AdminNoteVO;
import com.codemind.common.Result;

/**
 * 管理端-内容治理（文章 / 笔记 / 评论）。
 */
public interface AdminContentService {

    // ---------------- 文章 ----------------

    /** 全量文章（**含草稿**，管理员视角不做 status 过滤） */
    Result<Page<AdminArticleVO>> articleList(Integer page, Integer size, String keyword, Integer status);

    /** 下架 / 恢复：status 取 ArticleConstants.ARTICLE_STATUS_* */
    Result<Void> updateArticleStatus(Long articleId, Integer status);

    Result<Void> deleteArticle(Long articleId);

    // ---------------- 笔记 ----------------

    Result<Page<AdminNoteVO>> noteList(Integer page, Integer size, String keyword, Integer status, Integer visibility);

    /** status 取 NoteConstants.NOTE_STATUS_* */
    Result<Void> updateNoteStatus(Long noteId, Integer status);

    Result<Void> deleteNote(Long noteId);

    // ---------------- 评论 ----------------

    Result<Page<AdminCommentVO>> commentList(Integer page, Integer size, Long articleId, String keyword);

    Result<Void> deleteComment(Long commentId);
}
