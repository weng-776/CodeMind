package com.codemind.ai.entity.recommend;

import lombok.Data;
import org.springframework.ai.tool.annotation.ToolParam;

//推荐内容实体
@Data
public class RecommendContent {

    @ToolParam(
            required = false,
            description = """
                    文章ID。
                    仅当 type = article 时填写。
                    当 type = note 时必须为空。
                    必须使用已有工具返回的真实文章ID，不得猜测或编造。
                    """
    )
    private Long articleId;

    @ToolParam(
            required = false,
            description = """
                    笔记ID。
                    仅当 type = note 时填写。
                    当 type = article 时必须为空。
                    必须使用已有工具返回的真实笔记ID，不得猜测或编造。
                    """
    )
    private Long noteId;

    @ToolParam(
            description = """
                    当前内容的类型，只能是 article 或 note。
                    article 表示社区文章，note 表示个人知识库笔记。
                    必须根据用户指定的内容类型填写。
                    type = article 时填写 articleId，noteId 为空；
                    type = note 时填写 noteId，articleId 为空。
                    """
    )
    private String type;
}
