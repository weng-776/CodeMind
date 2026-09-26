package com.codemind.community.dto;


import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.util.List;

/**
 * 编辑文章请求参数(3.2)
 */
@Data
public class UpdateArticleDTO {
    //文章标题
    @Size(max = 255, message = "文章标题不能超过 255 个字符")
    private String title;
    //文章摘要
    @Size(max = 300, message = "文章摘要不能超过 300 个字符")
    private String summary;
    //文章内容(Markdown)
    @Size(max = 10000, message = "文章内容不能超过 10000 个字符")
    private String content;
    //封面地址
    private String cover;
    //状态 0草稿 1发布
    @NotNull(message = "文章状态不能为空")
    @Min(value = 0, message = "文章状态只能是 0(草稿) 或 1(正常)")
    @Max(value = 1, message = "文章状态只能是 0(草稿) 或 1(正常)")
    private Integer status;
    //标签id列表(传空数组清空标签)
    private List<Long> tagIds;
}
