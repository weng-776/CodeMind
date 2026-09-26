package com.codemind.community.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class ReleaseCommentDTO {
    @NotNull(message = "文章ID不能为空")
    private Long articleId;
    @NotNull(message = "评论内容不能为空")
    @Size(min = 1, max = 200, message = "评论内容为 1-200 个字符")
    private String content;
    /**
     * 被回复的评论id：0 或不传 = 一级评论；非0 = 回复该条评论（可任意层级，后端会压平到根）
     */
    private Long parentId = 0L;
}
