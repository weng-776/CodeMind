package com.codemind.message.vo;

import com.codemind.community.vo.UserSimpleVO;
import lombok.Data;

import java.util.Date;

@Data
public class NotifyVO {
    /**
     * 通知id
     */
    private Long id;

    /**
     * 类型：1=被点赞 2=被评论 3=被关注
     */
    private Integer type;

    /**
     * 触发人信息（谁点的赞/评论/关注）
     */
    private UserSimpleVO fromUser;

    /**
     * 关联文章id（前端点击跳转文章详情）
     */
    private Long articleId;

    /**
     * 关联评论id（跳转后定位到那条回复）
     */
    private Long commentId;

    /**
     * 关联文章是否已被删除。
     * 通知是「事件流水」，不随目标删除而清理，所以由列表接口标记目标存活情况，
     * 前端据此决定是跳转还是提示「相关文章已被删除」——避免点进去才撞 404。
     * true=已删除/不存在；type3 关注通知无关联文章，恒为 false。
     */
    private Boolean articleDeleted;

    /**
     * 关联评论是否已被删除。
     * true=已删除/不存在；type1 点赞通知无关联评论，恒为 false。
     * 注意 type2 评论通知要同时看两个标记：文章删了也会连带删评论。
     */
    private Boolean commentDeleted;

    /**
     * 通知文案（写入时后端拼好，如"zhangsan 点赞了你的文章《Redisson 实践》"）
     */
    private String content;

    /**
     * 0=未读 1=已读
     */
    private Integer isRead;

    /**
     * 创建时间
     */
    private Date createTime;
}