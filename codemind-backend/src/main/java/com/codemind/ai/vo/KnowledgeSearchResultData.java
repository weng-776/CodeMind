package com.codemind.ai.vo;

import lombok.Data;
import lombok.experimental.Accessors;

@Accessors(chain=true)
@Data
public class KnowledgeSearchResultData {
    private Long ArticleId;
    private String title;
    private String content;
    private Double score;
    private Long noteId;

}
