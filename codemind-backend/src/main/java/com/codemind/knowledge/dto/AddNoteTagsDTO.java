package com.codemind.knowledge.dto;

import lombok.Data;

import java.util.List;

/**
 * 为笔记添加标签的请求参数
 */
@Data
public class AddNoteTagsDTO {
    //标签id列表
    private List<Long> tagIds;
}
