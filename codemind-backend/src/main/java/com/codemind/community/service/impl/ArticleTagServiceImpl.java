package com.codemind.community.service.impl;

import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.community.entity.ArticleTag;
import com.codemind.community.service.ArticleTagService;
import com.codemind.community.mapper.ArticleTagMapper;
import org.springframework.stereotype.Service;

/**
* @author wengjiaran
* @description 针对表【article_tag(文章标签关联表)】的数据库操作Service实现
* @createDate 2026-08-07 20:22:27
*/
@Service
public class ArticleTagServiceImpl extends ServiceImpl<ArticleTagMapper, ArticleTag>
    implements ArticleTagService{

}




