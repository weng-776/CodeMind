package com.codemind.knowledge.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.util.List;

@Data
public class NoteDTO {
    private String title;
    private String content;
    private Long categoryId;
    private String summary;
    // 0-私密 1-公开；必传，不传按私密兜底
    @NotNull(message = "可见性不能为空")
    @Min(value = 0, message = "可见性只能是 0(私密) 或 1(公开)")
    @Max(value = 1, message = "可见性只能是 0(私密) 或 1(公开)")
    private Integer visibility;
    // 0-草稿 1-正常；必传，不传按正常兜底
    @NotNull(message = "笔记状态不能为空")
    @Min(value = 0, message = "笔记状态只能是 0(草稿) 或 1(正常)")
    @Max(value = 1, message = "笔记状态只能是 0(草稿) 或 1(正常)")
    private Integer status;
    private List<Long> tagIds;
}