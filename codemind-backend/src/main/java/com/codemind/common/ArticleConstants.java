package com.codemind.common;

public class ArticleConstants {
    public static final String ARTICLE_COVER = "article_cover";

    //文章状态（对应 article.status：1=公开可见，0=非公开/草稿）
    //注意：这个字段同时承担「作者存草稿」和「管理员下架」两种语义 ——
    //     因为现有所有读路径（列表/详情）都只认它，另起字段会导致读路径全都要改。
    public static final Integer ARTICLE_STATUS_DRAFT = 0;
    public static final Integer ARTICLE_STATUS_PUBLIC = 1;
}
