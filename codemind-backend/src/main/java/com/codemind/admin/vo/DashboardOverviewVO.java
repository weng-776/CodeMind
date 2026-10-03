package com.codemind.admin.vo;

import lombok.Data;

/**
 * 管理端-数据看板总览。
 *
 * <p>分两组：{@code xxxCount} 是<b>总数</b>，{@code todayXxxCount} 是<b>今日新增</b>。
 * 命名刻意保持「后缀统一」，前端可以直接按前缀配对渲染，不用维护两套字段名映射。
 *
 * <p>点赞 / 收藏 / 关注这些表是<b>物理删除</b>（没有 is_delete 字段），
 * 而用户 / 文章 / 笔记 / 评论带 {@code @TableLogic} 逻辑删除 ——
 * 所以前者的 count 就是全表行数，后者的 count 会被 MyBatis-Plus 自动补上
 * {@code is_delete = 0}。这个差异不用手写，但要知道它存在，否则对不上数会以为是 bug。
 */
@Data
public class DashboardOverviewVO {

    // ---------------- 总数 ----------------

    private Long userCount;

    private Long articleCount;

    private Long noteCount;

    private Long commentCount;

    private Long likeCount;

    private Long favoriteCount;

    // ---------------- 今日新增 ----------------

    private Long todayUserCount;

    private Long todayArticleCount;

    private Long todayNoteCount;

    private Long todayCommentCount;

    private Long todayLikeCount;

    private Long todayFavoriteCount;
}
