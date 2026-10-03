package com.codemind.community.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.community.dto.CreateArticleDTO;
import com.codemind.community.dto.UpdateArticleDTO;
import com.codemind.community.service.ArticleService;
import com.codemind.community.vo.ArticleDetailVO;
import com.codemind.community.vo.ArticleListVO;
import com.codemind.community.vo.MyArticleVO;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.simpleframework.xml.Path;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

//文章相关controller
@RestController
@RequestMapping("/api/article")
@CrossOrigin
@Validated
public class ArticleController {
    @Autowired
    private ArticleService articleService;
    //发布文章
    @PostMapping
    public Result<Long> createArticle(@Valid CreateArticleDTO createArticleDTO, @RequestParam(value = "file", required = false) MultipartFile file) throws Exception {

        return articleService.createArticle(createArticleDTO,file);
    }
    //编辑文章
    @PutMapping("{articleId}")
    public Result<Void> updateArticle(@PathVariable Long articleId,@Valid UpdateArticleDTO updateArticleDTO ,@RequestParam(value = "file", required = false) MultipartFile file ) throws Exception {

        return articleService.updateArticle(articleId, updateArticleDTO  ,file);
    }
    //删除文章
    @DeleteMapping("{articleId}")
    public Result<Void> deleteArticle(@PathVariable Long articleId){

        return articleService.deleteArticle(articleId);
    }
    @GetMapping("{articleId}")
    //查看文章详情
    public Result<ArticleDetailVO> checkArticle(@PathVariable Long articleId){

        return articleService.checkArticle(articleId);

    }

    //文章列表
    @GetMapping("list")
    public Result<Page<ArticleListVO>> articleList(@RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                   @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size){

        return articleService.articleList(page,size);
    }

    //我的文章列表
    @GetMapping("my")
    public Result<Page<MyArticleVO>> myArticleList(@RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                   @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size,
                                                   @RequestParam(required = false)
                                                   @Min(value = 0, message = "文章状态只能是 0(草稿) 或 1(正常)")
                                                   @Max(value = 1, message = "文章状态只能是 0(草稿) 或 1(正常)")
                                                   Integer status){

        return articleService.myArticleList(page,size,status);
    }

    //3.17 热门文章（按浏览量倒序）
    @GetMapping("hot")
    public Result<Page<ArticleListVO>> hotArticleList(@RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                      @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size){

        return articleService.hotArticleList(page,size);
    }

    //3.18 最新文章（按发布时间倒序）
    @GetMapping("latest")
    public Result<Page<ArticleListVO>> latestArticleList(@RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                         @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size){

        return articleService.latestArticleList(page,size);
    }

    //3.19 标签下的文章
    @GetMapping("tag/{tagId}")
    public Result<Page<ArticleListVO>> articleListByTag(@PathVariable Long tagId,
                                                        @RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                        @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size){

        return articleService.articleListByTag(tagId,page,size);
    }
}
