package com.codemind.ai.vo;

import com.codemind.community.vo.TagSimpleVO;
import com.codemind.community.vo.UserSimpleVO;
import lombok.Data;

import java.util.Date;
import java.util.List;
@Data
public class SearchArticleData {
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
     * 创建时间
     */
    private Date createTime;
    //作者
    private String author;

}
