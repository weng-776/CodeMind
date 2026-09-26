package com.codemind.ai.vo.recommend;

import lombok.Data;
import lombok.experimental.Accessors;

@Accessors(chain=true)
@Data
public class RecommendArticleData {
    private Long ArticleId;
    private String title;
    private String content;
    private Double score;
}
