package com.codemind.community.vo;

import lombok.Data;

import java.time.LocalDateTime;
import java.util.Date;
import java.util.List;

/**
 * 笔记详情 VO
 */
@Data
public class ArticleDetailVO {

    /**
     * 文章id
     */
    private Long id;

    /**
     * 标题
     */
    private String title;

    /**
     * 摘要
     */
    private String summary;

    /**
     * 正文内容
     */
    private String content;

    /**
     * 封面
     */
    private String cover;

    /**
     * 作者信息
     */
    private UserSimpleVO user;

    /**
     * 浏览量
     */
    private Long viewCount;

    /**
     * 点赞数
     */
    private Long likeCount;

    /**
     * 收藏数
     */
    private Long favoriteCount;

    /**
     * 标签列表
     */
    private List<TagSimpleVO> tags;

    /**
     * 当前用户是否点赞
     */
    private Boolean isLiked;

    /**
     * 当前用户是否收藏
     */
    private Boolean isFavorited;

    /**
     * 创建时间
     */
    private Date createTime;

    /**
     * 更新时间
     */
    private Date updateTime;
}