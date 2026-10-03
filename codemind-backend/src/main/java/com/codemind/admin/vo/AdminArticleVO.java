package com.codemind.admin.vo;

import com.codemind.community.vo.UserSimpleVO;
import lombok.Data;

import java.util.Date;

/**
 * 管理端-文章列表项。
 *
 * <p><b>刻意不含 content</b>：正文是 TEXT 且很长，列表页不需要；
 * 管理端看全文应当走文章详情接口，而不是让列表把几十篇正文全捞出来。
 */
@Data
public class AdminArticleVO {

    private Long id;

    private Long userId;

    /** 作者简要信息（批量查出来拼的，避免 N+1） */
    private UserSimpleVO author;

    private String title;

    private String summary;

    private String cover;

    private Long viewCount;

    private Long likeCount;

    private Long favoriteCount;

    /** 0=非公开/草稿 1=公开（见 ArticleConstants.ARTICLE_STATUS_*） */
    private Integer status;

    private Date createTime;
}
