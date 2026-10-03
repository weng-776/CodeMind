package com.codemind.admin.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.admin.service.AdminContentService;
import com.codemind.admin.vo.AdminArticleVO;
import com.codemind.admin.vo.AdminCommentVO;
import com.codemind.admin.vo.AdminNoteVO;
import com.codemind.common.Result;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

/**
 * 管理端-内容治理（文章 / 笔记 / 评论）。
 *
 * <p>列表一律是「全量视角」：不过滤作者的草稿/私密，这正是管理端和前台接口的核心区别 ——
 * 前台只该看到公开内容，管理端必须能看到并处置一切。
 *
 * <p>列表 VO 都不含正文 {@code content}：正文是长文本，列表页不需要，
 * 要看全文走各自详情接口即可，避免一次把几十篇正文全捞出来。
 */
@RestController
@RequestMapping("/api/admin")
@CrossOrigin
@Validated
public class AdminContentController {

    @Autowired
    private AdminContentService adminContentService;

    // ================================ 文章 ================================

    /**
     * 文章列表（含草稿）。
     *
     * @param status 可选，0=非公开/草稿 1=公开；不传则不过滤
     */
    @GetMapping("articles")
    public Result<Page<AdminArticleVO>> articleList(
            @RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
            @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false)
            @Min(value = 0, message = "文章状态只能是 0(草稿) 或 1(公开)")
            @Max(value = 1, message = "文章状态只能是 0(草稿) 或 1(公开)")
            Integer status) {

        return adminContentService.articleList(page, size, keyword, status);
    }

    /**
     * 下架 / 恢复文章：status 取 {@code ArticleConstants.ARTICLE_STATUS_*}（0=下架 1=公开）。
     *
     * <p>注意这个字段同时承担「作者存草稿」和「管理员下架」两种语义 —— 详见
     * {@link com.codemind.common.ArticleConstants} 里的说明。
     */
    @PutMapping("articles/{articleId}/status")
    public Result<Void> updateArticleStatus(
            @PathVariable Long articleId,
            @RequestParam
            @Min(value = 0, message = "文章状态只能是 0(下架) 或 1(公开)")
            @Max(value = 1, message = "文章状态只能是 0(下架) 或 1(公开)")
            Integer status) {

        return adminContentService.updateArticleStatus(articleId, status);
    }

    /** 删除文章（连带删标签/评论/点赞/收藏，并清理缓存、热门榜与向量库） */
    @DeleteMapping("articles/{articleId}")
    public Result<Void> deleteArticle(@PathVariable Long articleId) {
        return adminContentService.deleteArticle(articleId);
    }

    // ================================ 笔记 ================================

    /**
     * 笔记列表（含草稿 / 私密）。
     *
     * @param status     可选，0=草稿 1=正常
     * @param visibility 可选，0=私密 1=公开
     */
    @GetMapping("notes")
    public Result<Page<AdminNoteVO>> noteList(
            @RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
            @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false)
            @Min(value = 0, message = "笔记状态只能是 0(草稿) 或 1(正常)")
            @Max(value = 1, message = "笔记状态只能是 0(草稿) 或 1(正常)")
            Integer status,
            @RequestParam(required = false)
            @Min(value = 0, message = "可见性只能是 0(私密) 或 1(公开)")
            @Max(value = 1, message = "可见性只能是 0(私密) 或 1(公开)")
            Integer visibility) {

        return adminContentService.noteList(page, size, keyword, status, visibility);
    }

    /** 下架 / 恢复笔记：status 取 {@code NoteConstants.NOTE_STATUS_*}（0=草稿 1=正常） */
    @PutMapping("notes/{noteId}/status")
    public Result<Void> updateNoteStatus(
            @PathVariable Long noteId,
            @RequestParam
            @Min(value = 0, message = "笔记状态只能是 0(下架) 或 1(正常)")
            @Max(value = 1, message = "笔记状态只能是 0(下架) 或 1(正常)")
            Integer status) {

        return adminContentService.updateNoteStatus(noteId, status);
    }

    /** 删除笔记（连带删标签，并清理向量库） */
    @DeleteMapping("notes/{noteId}")
    public Result<Void> deleteNote(@PathVariable Long noteId) {
        return adminContentService.deleteNote(noteId);
    }

    // ================================ 评论 ================================

    /**
     * 评论列表（全站视角，可按文章筛选 + 内容模糊搜）。
     *
     * @param articleId 可选，只看某篇文章下的评论
     */
    @GetMapping("comments")
    public Result<Page<AdminCommentVO>> commentList(
            @RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
            @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size,
            @RequestParam(required = false) Long articleId,
            @RequestParam(required = false) String keyword) {

        return adminContentService.commentList(page, size, articleId, keyword);
    }

    /** 删除评论：删一级评论时会连带删掉它的全部回复（与业务删除规则一致） */
    @DeleteMapping("comments/{commentId}")
    public Result<Void> deleteComment(@PathVariable Long commentId) {
        return adminContentService.deleteComment(commentId);
    }
}
