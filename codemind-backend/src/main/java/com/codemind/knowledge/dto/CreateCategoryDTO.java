package com.codemind.knowledge.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class CreateCategoryDTO {
    @NotBlank(message = "分类名称不能为空")
    private String name;
    private Long parentId;
    private Integer sort;
}
