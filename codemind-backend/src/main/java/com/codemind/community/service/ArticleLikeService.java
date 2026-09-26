package com.codemind.community.service;

import com.codemind.common.Result;
import com.codemind.community.entity.ArticleLike;
import com.baomidou.mybatisplus.extension.service.IService;

/**
* @author wengjiaran
* @description 针对表【article_like(文章点赞表)】的数据库操作Service
* @createDate 2026-08-07 20:22:27
*/
public interface ArticleLikeService extends IService<ArticleLike> {
    //点赞文章
    Result<Void> likeArticle(Long articleId);
    //取消点赞
    Result<Void> cancelLike(Long articleId);
    //判断点赞状态
    Result<Boolean> checkLikeStatus(Long articleId);
}
