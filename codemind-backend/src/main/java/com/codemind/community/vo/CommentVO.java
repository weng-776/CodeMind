package com.codemind.community.vo;

import lombok.Data;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * 评论 VO（3.16 查看评论列表 / 3.20 查看回复列表）
 * <p>
 * 一级评论（parentId=0）通过 {@code replies} 内联展示**前 2 条**回复，
 * 该根的回复总数看 {@code replyCount}，完整列表走 **3.20** 按需分页；
 * {@code replies} 的元素仍是本类，其 {@code replyCount}/{@code replies} 恒为 {@code null}。
 * <p>
 * 注：本项目只支持两层嵌套（不做无限级嵌套）。
 * <p>
 * ⚠️ 历史坑：本注释曾写「通过 {@code children} 嵌套展示回复」，但本类**从来没有 children 字段**
 * （前端 types/comment.ts 曾按旧文档 v1.2 的设计稿实现成 children，导致 3.16 渲染不出来，
 * 已于 2026-09-23 更正）。真实出参见 API 文档 v1.9 第 3.16 / 3.20 节。
 */
@Data
public class CommentVO {

    /**
     * 评论id
     */
    private Long id;

    /**
     * 文章id
     */
    private Long articleId;

    /**
     * 评论用户信息
     */
    private UserSimpleVO user;

    /**
     * 父评论id：0=一级评论，非0=回复该评论
     */
    private Long parentId;

    /**
     * 评论内容
     */
    private String content;

    /**
     * 创建时间
     */
    private Date createTime;

    private UserSimpleVO replyUser;       // null = 直接回楼主，前端不渲染「回复 @」
    private Integer replyCount;           // 该根下的回复总数 → 按钮上的「查看全部 N 条回复」
    private List<CommentVO> replies;      // 只装前 2 条，元素还是 CommentVO

}
