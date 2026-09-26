package com.codemind.community.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.ai.entity.search.SearchArticle;
import com.codemind.ai.vo.SearchArticleData;
import com.codemind.common.Result;
import com.codemind.community.dto.CreateArticleDTO;
import com.codemind.community.dto.UpdateArticleDTO;
import com.codemind.community.entity.Article;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.community.vo.ArticleDetailVO;
import com.codemind.community.vo.ArticleListVO;
import com.codemind.community.vo.MyArticleVO;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

/**
* @author wengjiaran
* @description 针对表【article(文章表)】的数据库操作Service
* @createDate 2026-08-07 20:22:26
*/
public interface ArticleService extends IService<Article> {
    //发布文章
    Result<Long> createArticle(CreateArticleDTO createArticleDTO, MultipartFile file) throws Exception;
    //编辑文章
    Result<Void> updateArticle(Long articleId, UpdateArticleDTO updateArticleDTO,MultipartFile file) throws Exception;
    //删除文章
    Result<Void> deleteArticle(Long articleId);
    //查看文章详情
    Result<ArticleDetailVO> checkArticle(Long articleId);
    //文章列表
    Result<Page<ArticleListVO>> articleList(Integer page, Integer size);
    //我的文章列表
    Result<Page<MyArticleVO>> myArticleList(Integer page, Integer size, Integer status);
    //3.17 热门文章（按浏览量倒序）
    Result<Page<ArticleListVO>> hotArticleList(Integer page, Integer size);
    //3.18 最新文章（按发布时间倒序）
    Result<Page<ArticleListVO>> latestArticleList(Integer page, Integer size);
    //3.19 标签下的文章
    Result<Page<ArticleListVO>> articleListByTag(Long tagId, Integer page, Integer size);
    //根据提示返回相关文章给ai
    List<SearchArticleData> AiqueryArticleList(SearchArticle searchArticle);
}
