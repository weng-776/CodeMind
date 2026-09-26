package com.codemind.knowledge.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

/**
 * 切换笔记可见性请求参数(2.6)
 */
@Data
public class UpdateNoteVisibilityDTO {
    //可见性 0私密 1公开
    @NotNull(message = "可见性不能为空")
    @Min(value = 0, message = "可见性只能是 0(私密) 或 1(公开)")
    @Max(value = 1, message = "可见性只能是 0(私密) 或 1(公开)")
    private Integer visibility;
}
