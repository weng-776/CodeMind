package com.codemind.ai.rag.dto;

import lombok.Data;
import lombok.experimental.Accessors;

@Accessors(chain=true)
@Data
public class RagMessageDTO {
    private String uuid;
    /**
     * ARTICLE / NOTE
     */
    private String type;

    /**
     * CREATE / UPDATE / DELETE
     */
    private String operation;

    private String json;

    private Long articleId;
    private Long noteId;
}
