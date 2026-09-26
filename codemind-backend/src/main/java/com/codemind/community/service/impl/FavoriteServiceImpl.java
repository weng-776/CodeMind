package com.codemind.community.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.common.RedisKeyConstants;
import com.codemind.common.Result;
import com.codemind.community.entity.Article;
import com.codemind.community.entity.ArticleTag;
import com.codemind.community.entity.Comment;
import com.codemind.community.entity.Favorite;
import com.codemind.community.service.ArticleService;
import com.codemind.community.service.ArticleTagService;
import com.codemind.community.service.CommentService;
import com.codemind.community.service.FavoriteService;
import com.codemind.community.mapper.FavoriteMapper;
import com.codemind.community.vo.ArticleListVO;
import com.codemind.community.vo.TagSimpleVO;
import com.codemind.community.vo.UserSimpleVO;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.knowledge.entity.Tag;
import com.codemind.knowledge.service.TagService;
import com.codemind.user.entity.User;
import com.codemind.user.service.UserService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.ObjectUtils;

import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
* @author wengjiaran
* @description 针对表【favorite(文章收藏表)】的数据库操作Service实现
* @createDate 2026-08-07 20:22:27
*/
@Slf4j
@Service
public class FavoriteServiceImpl extends ServiceImpl<FavoriteMapper, Favorite>
    implements FavoriteService{
    @Lazy
    @Autowired
    private ArticleService articleService;
    @Autowired
    private ArticleTagService articleTagService;
    @Autowired
    private UserService userService;
    @Autowired
    private TagService tagService;
    @Autowired
    private CommentService commentService;
    @Autowired
    private StringRedisTemplate redisTemplate;


    //收藏文章
    @Transactional(rollbackFor =  Exception.class)
    @Override
    public Result<Void> favoriteArticle(Long articleId) {

        Long userId = UserContext.getUserId();

        Article article = articleService.getById(articleId);
        if (ObjectUtils.isEmpty(article)) {
            throw BusinessException.notFound("文章不存在");
        }

        Favorite favorite = new Favorite();
        favorite.setUserId(userId);
        favorite.setArticleId(articleId);
        try {
            save(favorite);
            articleService.update(new LambdaUpdateWrapper<Article>().eq(Article::getId,articleId).setSql("favorite_count = favorite_count+1"));
            //★ BUG-28：收藏原先只改库 —— 既不删详情缓存、也没有 Redis 计数器，
            //  而详情接口命中缓存时沿用写缓存那一刻的旧快照 → 收藏后详情长期（≤TTL 60 分钟）显示旧值，
            //  与列表/收藏夹（直查库）自相矛盾。这里与点赞对齐，维护 Redis 计数器。
            String favoriteKey = RedisKeyConstants.ARTICLE_FAVORITE_KEY + articleId;
            //计数器冷启动：先拿库里当前值兜底，再自增（同 BUG-32 的处理）
            redisTemplate.opsForValue().setIfAbsent(favoriteKey,
                    String.valueOf(ObjectUtils.isEmpty(article.getFavoriteCount()) ? 0L : article.getFavoriteCount()),
                    RedisKeyConstants.COUNT_KEY_TTL, TimeUnit.DAYS);
            redisTemplate.opsForValue().increment(favoriteKey, 1);
        }catch (DuplicateKeyException e){
            log.info("幂等重复收藏");
            return Result.success("操作成功");
        }
        return Result.success("操作成功");
    }

    //取消收藏
    @Transactional(rollbackFor =   Exception.class)
    @Override
    public Result<Void> cancelFavorite(Long articleId) {
        Long userId = UserContext.getUserId();
        LambdaQueryWrapper<Favorite> wrapper = new LambdaQueryWrapper<Favorite>().eq(Favorite::getArticleId, articleId).eq(Favorite::getUserId, userId);
        boolean removed = remove(wrapper);
        //只有确实删除成功（之前收藏过）才递减计数，避免未收藏也 -1 造成计数漂移/负数
        if (removed) {
            //★ BUG-29/28：同样要同步递减 Redis 计数器（详情接口读它），否则取消收藏后详情不降
            Article article = articleService.getById(articleId);   //取「减之前」的库值用于冷启动兜底
            articleService.update(new LambdaUpdateWrapper<Article>().eq(Article::getId,articleId).setSql("favorite_count = favorite_count-1"));
            String favoriteKey = RedisKeyConstants.ARTICLE_FAVORITE_KEY + articleId;
            if (!ObjectUtils.isEmpty(article)) {
                redisTemplate.opsForValue().setIfAbsent(favoriteKey,
                        String.valueOf(ObjectUtils.isEmpty(article.getFavoriteCount()) ? 0L : article.getFavoriteCount()),
                        RedisKeyConstants.COUNT_KEY_TTL, TimeUnit.DAYS);
            }
            redisTemplate.opsForValue().decrement(favoriteKey, 1);
        }

        return Result.success("操作成功");
    }

    //我的收藏列表
    @Override
    public Result<Page<ArticleListVO>> myFavorites(Integer page, Integer size) {
       //获取用户id
        Long userId = UserContext.getUserId();
        //查询收藏表获取文章id
        List<Long> articleIdList = list(new LambdaQueryWrapper<Favorite>().eq(Favorite::getUserId, userId))
                .stream().distinct().map(Favorite::getArticleId).collect(Collectors.toList());
        //最终返回的数据
        //分页元数据必须按真实请求回显：原来空结果时把 size/current/pages 全设成 0，前端分页控件直接失效
        Page<ArticleListVO> articleListVOPage = new Page<>(page, size);
        //校验是否为空
        if (ObjectUtils.isEmpty(articleIdList)) {
            articleListVOPage.setRecords(new ArrayList<>());
            return Result.success(articleListVOPage);
        }

        Page<Article> articlePage = new Page(page,size);
        //分页查询文章表
        articleService.page(articlePage,new LambdaQueryWrapper<Article>().in(Article::getId,articleIdList));
        //收藏的文章可能已被作者删除：这时查出来是空集，继续往下走会拼出 id IN () 非法 SQL 直接 500
        if (ObjectUtils.isEmpty(articlePage.getRecords())) {
            articleListVOPage.setRecords(new ArrayList<>());
            return Result.success(articleListVOPage);
        }
        //查询标签关联表
        //得到文章id,标签id
        //key/value 统一用 Long：tagMap 的 key 是 Long，用 Integer 取会恒为 null（Integer(1).equals(Long(1)) 永远 false），标签就会全空
        Map<Long, List<Long>> articleTagMap = articleTagService.listMaps(new QueryWrapper<ArticleTag>().select("article_id", "tag_id")
                        .in("article_id", articleIdList)).stream()
                .collect(Collectors.groupingBy(t -> ((Number) t.get("article_id")).longValue()
                        , Collectors.mapping(t -> ((Number) t.get("tag_id")).longValue(), Collectors.toList())));
        //同通过标签id查询标签表 转换成 id 标签对象列表
        //拿到tagid列表
        List<Long> tagIdList = articleTagMap.values().stream().flatMap(Collection::stream).distinct().collect(Collectors.toList());
        //标签数据最终结果 map key->articleId value-> TagSimpleVO
        Map<Long,List<TagSimpleVO>> lastArticleTagMap = new HashMap<>();
        if (!ObjectUtils.isEmpty(tagIdList)) {
            Map<Long, Tag> tagMap = tagService.list(new LambdaQueryWrapper<Tag>().in(Tag::getId, tagIdList)).stream()
                    .collect(Collectors.toMap(Tag::getId, t -> t));
            //迭代封装最后结果
            for (Map.Entry<Long, List<Long>> entry : articleTagMap.entrySet()) {
                List<Long> tagIds = entry.getValue();
                Long articleId = entry.getKey();
                List<TagSimpleVO> tagSimpleVOList = tagIds.stream().map(t -> {
                    //拿到标签
                    Tag tag = tagMap.get(t);
                    //封装数据
                    TagSimpleVO tagSimpleVO = new TagSimpleVO();
                    //标签可能已被删除，拷贝前判空
                    if (!ObjectUtils.isEmpty(tag)) {
                        BeanUtils.copyProperties(tag, tagSimpleVO);
                    }
                    return tagSimpleVO;
                }).collect(Collectors.toList());
                lastArticleTagMap.put(articleId,tagSimpleVOList);
            }
        }
        //根据文章id查询用户表
        List<Long> userIdList = articlePage.getRecords().stream().map(Article::getUserId).collect(Collectors.toList());
        //获取用户信息转换成 userid 用户对象列表
        Map<Long, UserSimpleVO> userMap = userService.list(new LambdaQueryWrapper<User>().in(User::getId, userIdList))
                .stream().collect(Collectors.
                        toMap(User::getId, t -> {
                            UserSimpleVO userSimpleVO = new UserSimpleVO();
                            BeanUtils.copyProperties(t, userSimpleVO);
                            return  userSimpleVO;
                        }));

        //根据笔记id查询评论表count统计每篇笔记有多少评论
        //一篇笔记可以有多个评论 key 笔记id value 对应的评论数量
        Map<Long, Long> commentMap = commentService.listMaps(new QueryWrapper<Comment>().select("article_id, COUNT(*) AS total_count")
                        .lambda().in(Comment::getArticleId, articleIdList)
                        .groupBy(Comment::getArticleId)).stream()
                .collect(Collectors.toMap(t -> (Long) t.get("article_id")
                        , t -> ((Number) t.get("total_count")).longValue()));

        //封装数据返回

        articleListVOPage.setSize(articlePage.getSize());
        articleListVOPage.setCurrent(articlePage.getCurrent());
        articleListVOPage.setTotal(articlePage.getTotal());
        articleListVOPage.setPages(articlePage.getPages());
        //封装列表数据
        //定义封装笔记列表vo
        List<ArticleListVO> articleListVOList = new ArrayList<>();
        for (Article record : articlePage.getRecords()) {
            //封装数据
            ArticleListVO articleListVO = new ArticleListVO();
            //封装笔记数据
            BeanUtils.copyProperties(record, articleListVO);
            //封装标签
            articleListVO.setTags(lastArticleTagMap.getOrDefault(record.getId(),new ArrayList<>()));
            //封装用户信息
            articleListVO.setUser(userMap.get(record.getUserId()));
            //封装评论
            articleListVO.setCommentCount(commentMap.get(record.getId()));
            //添加列表
            articleListVOList.add(articleListVO);
        }
        articleListVOPage.setRecords(articleListVOList);
        return Result.success(articleListVOPage);
    }
}




