package com.codemind.common;

public abstract class RedisKeyConstants {
    //用户验证码key
    public static final String REDIS_CODE_KEY = "codemind:user:code:";
    //限制一分钟只能发一次验证码
    public static final String REDIS_SENT_CODE_KEY = "codemind:user:code:sent:";
    //验证码错误次数
    public static final String REDIS_CODE_fail = "login:code:fail:";
    //文章详情缓存
    public static final String ARTICLE_DETAIL_KEY = "codemind:article:detail:"; //缓存
    public static final String ARTICLE_VIEW_KEY    = "codemind:article:view:";   // 浏览量计数
    public static final String ARTICLE_HOT_KEY     = "codemind:article:hot";     // 热门 ZSet
    public static final Long ARTICLE_EMPTY_TTL   = 60L; //ttl
    //计数类 key 的 TTL（天）：点赞/收藏计数器不该永久驻留，过期后由库值兜底重建
    public static final Long COUNT_KEY_TTL   = 30L;
    //喜欢计数key
    public static final String ARTICLE_LIKE_KEY     = "codemind:article:like:";
    //收藏计数key
    public static final String ARTICLE_FAVORITE_KEY = "codemind:article:favorite:";
}
