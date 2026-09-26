package com.codemind.community.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.community.entity.Favorite;
import com.codemind.community.vo.ArticleListVO;
import com.baomidou.mybatisplus.extension.service.IService;

/**
* @author wengjiaran
* @description 针对表【favorite(文章收藏表)】的数据库操作Service
* @createDate 2026-08-07 20:22:27
*/
public interface FavoriteService extends IService<Favorite> {
    //收藏文章
    Result<Void> favoriteArticle(Long articleId);
    //取消收藏
    Result<Void> cancelFavorite(Long articleId);
    //我的收藏列表
    Result<Page<ArticleListVO>> myFavorites(Integer page, Integer size);
}
