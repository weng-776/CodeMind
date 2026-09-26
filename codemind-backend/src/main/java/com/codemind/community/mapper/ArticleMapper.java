package com.codemind.community.mapper;

import com.codemind.ai.entity.search.SearchArticle;
import com.codemind.ai.vo.SearchArticleData;
import com.codemind.community.entity.Article;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;

import java.util.List;

/**
* @author wengjiaran
* @description 针对表【article(文章表)】的数据库操作Mapper
* @createDate 2026-08-07 20:22:26
* @Entity com.codemind.community.entity.Article
*/
public interface ArticleMapper extends BaseMapper<Article> {

    List<SearchArticleData> AiqueryArticleList(SearchArticle searchArticle);

    List<SearchArticleData> linkArticle(List<String> listName, Integer limit);
}




