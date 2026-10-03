package com.codemind.admin.vo;

import com.codemind.community.vo.UserSimpleVO;
import lombok.Data;

import java.util.Date;

/**
 * 管理端-评论列表项。
 */
@Data
public class AdminCommentVO {

    private Long id;

    private Long articleId;

    private Long userId;

    private UserSimpleVO author;

    /** 所属根评论 id；为空或 0 表示这是一级评论 */
    private Long parentId;

    private String content;

    private Date createTime;
}
