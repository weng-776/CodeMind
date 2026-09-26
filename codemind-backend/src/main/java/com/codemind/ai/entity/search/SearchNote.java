package com.codemind.ai.entity.search;

import lombok.Data;
import org.springframework.ai.tool.annotation.ToolParam;

//搜索文章tool实体
@Data
public class SearchNote {
    @ToolParam(required = false,
            description = "搜索关键词，例如 Redis 缓存、Spring AI、AQS")
    private String keyWord;
    @ToolParam(required = false ,description = "笔记标签名称，例如 Redis、Java、Spring Boot")
    private String tagName;
    @ToolParam(required = false,description = "笔记的分类名称，如 Java spring框架")
    private String categoryName;
    @ToolParam(required = false,description = "排序方式，可选 latest、hot，分别表示最新和热门")
    private String sort;
    @ToolParam(required = false,description = "笔记作者名称")
    private String author;
    @ToolParam(required = false,description = "返回结果数目，最大返回20条")
    private Integer limit;


}
