package com.codemind.ai.vo.recommend;

import lombok.Data;
import lombok.experimental.Accessors;

@Accessors(chain=true)
@Data
public class RecommendNoteData {
    private Long NoteId;
    private String title;
    private String content;
    private Double score;
}
