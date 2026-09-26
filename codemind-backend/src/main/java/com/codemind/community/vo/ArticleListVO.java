package com.codemind.community.vo;

import lombok.Data;

import java.time.LocalDateTime;
import java.util.Date;
import java.util.List;

/**
 * 笔记列表 VO
 */
@Data
public class ArticleListVO {

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
    //评论数
    private Long commentCount;

    /**
     * 标签列表
     */
    private List<TagSimpleVO> tags;


    /**
     * 创建时间
     */
    private Date createTime;

}