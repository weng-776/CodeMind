package com.codemind.community.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.community.service.ArticleLikeService;
import com.codemind.community.service.FavoriteService;
import com.codemind.community.vo.ArticleListVO;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

//文章点赞/收藏互动controller
@RestController
@RequestMapping("/api")
@CrossOrigin
@Validated
public class ArticleInteractionController {

    @Autowired
    private ArticleLikeService articleLikeService;

    @Autowired
    private FavoriteService favoriteService;

    //点赞文章
    @PostMapping("/article/{articleId}/like")
    public Result<Void> likeArticle(@PathVariable Long articleId) {
        return articleLikeService.likeArticle(articleId);
    }

    //取消点赞
    @DeleteMapping("/article/{articleId}/like")
    public Result<Void> cancelLike(@PathVariable Long articleId) {
        return articleLikeService.cancelLike(articleId);
    }

    //判断点赞状态
    @GetMapping("/article/{articleId}/like/status")
    public Result<Boolean> checkLikeStatus(@PathVariable Long articleId) {
        return articleLikeService.checkLikeStatus(articleId);
    }

    //收藏文章
    @PostMapping("/article/{articleId}/favorite")
    public Result<Void> favoriteArticle(@PathVariable Long articleId) {
        return favoriteService.favoriteArticle(articleId);
    }

    //取消收藏
    @DeleteMapping("/article/{articleId}/favorite")
    public Result<Void> cancelFavorite(@PathVariable Long articleId) {
        return favoriteService.cancelFavorite(articleId);
    }

    //我的收藏列表
    @GetMapping("/user/favorites")
    public Result<Page<ArticleListVO>> myFavorites(@RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                   @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size) {
        return favoriteService.myFavorites(page, size);
    }
}
