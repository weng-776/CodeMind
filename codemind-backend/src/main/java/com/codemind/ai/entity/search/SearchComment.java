package com.codemind.ai.entity.search;

import lombok.Data;
import org.springframework.ai.tool.annotation.ToolParam;

@Data
public class SearchComment {
    @ToolParam(description = "查看评论的文章id")
    private Long articleId;
    @ToolParam(required = false,description = "评论页码，默认1，用户没有提供需要看多少评论默认只提供第一页,提供的页码最大不能超过10")
    private Integer page;
    @ToolParam(required = false,description = "评论条数，若用户没有提供默认大小为查看20条相关文章的评论，提供的条数最大不能超过50条")
    private Integer size;
}
