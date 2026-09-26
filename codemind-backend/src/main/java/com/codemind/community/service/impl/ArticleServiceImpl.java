package com.codemind.community.service.impl;

import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.ai.entity.search.SearchArticle;
import com.codemind.ai.rag.dto.RagMessageDTO;
import com.codemind.ai.vo.SearchArticleData;
import com.codemind.common.*;
import com.codemind.community.dto.CacheMessage;
import com.codemind.community.dto.CountMessage;
import com.codemind.community.dto.CreateArticleDTO;
import com.codemind.community.dto.UpdateArticleDTO;
import com.codemind.community.entity.*;
import com.codemind.community.service.*;
import com.codemind.community.mapper.ArticleMapper;
import com.codemind.community.vo.*;
import com.codemind.config.RabbitConfig;
import com.codemind.config.RedissonConfig;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.knowledge.entity.Tag;
import com.codemind.knowledge.service.TagService;
import com.codemind.message.entity.Notification;
import com.codemind.message.service.MessageService;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.UserMapper;
import com.codemind.utils.FileUploadService;
import com.codemind.utils.NoteWordCount;
import com.mysql.cj.x.protobuf.MysqlxExpr;
import lombok.extern.slf4j.Slf4j;
import org.redisson.api.RLock;
import org.redisson.api.RedissonClient;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.ObjectUtils;
import org.springframework.web.multipart.MultipartFile;

import java.sql.Time;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
* @author wengjiaran
* @description 针对表【article(文章表)】的数据库操作Service实现
* @createDate 2026-08-07 20:22:26
*/
@Slf4j
@Service
public class ArticleServiceImpl extends ServiceImpl<ArticleMapper, Article>
    implements ArticleService {
    @Autowired
    private ArticleTagService articleTagService;
    @Autowired
    private FileUploadService fileUploadService;
    @Autowired
    private UserMapper userMapper;
    @Autowired
    private TagService tagService;
    @Autowired
    private ArticleLikeService articleLikeService;
    @Autowired
    private FavoriteService favoriteService;
    @Autowired
    private CommentService commentService;
    @Autowired
    private StringRedisTemplate redisTemplate;
    @Autowired
    private RedissonClient redissonClient;
    @Autowired
    private RabbitTemplate rabbitTemplate;
    @Autowired
    private ArticleMapper articleMapper;

    //发布文章
    @Transactional(rollbackFor = Exception.class)
    @Override
    public Result<Long> createArticle(CreateArticleDTO createArticleDTO, MultipartFile file) throws Exception {

        //获取用户id
        Long userId = UserContext.getUserId();
        //引入redisson防止重复提交
        //指定锁
        RLock lock = redissonClient.getLock("codemind:lock:article:" + userId);
        //尝试获取锁
        boolean isLock = lock.tryLock(1, 10, TimeUnit.SECONDS);
        if (!isLock) {
            throw BusinessException.conflict("不能重复提交");
        }
        Long articleId;

        try {
            //校验标题跟正文是否为空
            if (ObjectUtils.isEmpty(createArticleDTO.getContent()) || ObjectUtils.isEmpty(createArticleDTO.getTitle())) {
                log.error("正文或标题不能为空");
                throw BusinessException.badRequest("正文或标题不能为空");
            }
            //看看有没有传递封面
            //没有传递不理会
            //传递了赋值
            //没有传递图片证明依旧用旧的图片保持默认
            //如果不为空保存更新
            //初始值给 null 而不是 ""：没传封面时落库应该是「没有封面」，空串会让前端和详情页都要额外判空
            String url = null;
            if (file != null && !file.isEmpty()) {
                // 1. 文件大小校验，最大 2MB
                if (file.getSize() > 2 * 1024 * 1024) {
                    throw BusinessException.badRequest("封面大小不能超过2MB");
                }
                // 2. 文件后缀校验
                String originalFilename = file.getOriginalFilename();
                if (ObjectUtils.isEmpty(originalFilename)) {
                    throw BusinessException.badRequest("封面文件名不能为空");
                }

                String suffix = originalFilename.substring(
                        originalFilename.lastIndexOf(".") + 1
                ).toLowerCase();
                if (!Arrays.asList("jpg", "jpeg", "png", "webp").contains(suffix)) {
                    throw BusinessException.badRequest("封面只支持 jpg、jpeg、png、webp 格式");
                }
                // 3. Content-Type 校验
                String contentType = file.getContentType();
                if (ObjectUtils.isEmpty(contentType)
                        || !Arrays.asList("image/jpeg", "image/png", "image/webp")
                        .contains(contentType)) {
                    throw BusinessException.badRequest("封面格式不正确");
                }
                // 4. 上传
                url = fileUploadService.uploadFile(ArticleConstants.ARTICLE_COVER, file);
            }

            //校验是否传递了文章摘要如果没有截取正文20个字符当作摘要
            //判断是否写有摘要
            if (ObjectUtils.isEmpty(createArticleDTO.getSummary())) {
                String content = createArticleDTO.getContent();
                // 按 Unicode 码点截断前 20 个字符，避免切断 emoji 等代理对
                String summary = content.codePoints()
                        .limit(20)
                        .collect(
                                () -> new StringBuilder(),                          // 创建容器
                                (sb, codePoint) -> sb.appendCodePoint(codePoint),   // 把每个码点加进去
                                (sb1, sb2) -> sb1.append(sb2)                       // 合并容器（并行流时用）
                        )
                        .toString();
                createArticleDTO.setSummary(summary);
            }
            //统计文章字数
//        int wordCount = NoteWordCount.getWordCount(createArticleDTO.getContent());
            //封装数据
            Article article = new Article();
            BeanUtils.copyProperties(createArticleDTO, article);
            article.setUserId(userId);
            article.setCover(url);
            article.setViewCount(0L);
            article.setLikeCount(0L);
            article.setFavoriteCount(0L);
            //保存
            save(article);
            articleId = article.getId();
            //使用mq异步缓存详情 还有热门文章初始化
            //★ BUG-30：该消息的消费者会**无条件**执行 `ZSet.add(hot, id, 0)`（不判 status），
            //  于是每建一篇草稿就多一个 0 分僵尸成员，只增不减
            //  → hot 的 total（ZSet size）虚高、与 records 对不上（前端按 total 算页数会多出空白页）。
            //  草稿本就不该上热榜，这里直接不发。
            if (article.getStatus() != null && article.getStatus() == 1) {
                rabbitTemplate.convertAndSend(RabbitConfig.EXCHANGE, "article", articleId);
            }
            if (ObjectUtils.isEmpty(createArticleDTO.getTagIds())) {
                //把文章通过mq发送到消息队列异步处理。文章向量化存入向量数据库
                if (article.getStatus()==1){
                    ragVectorArticle(article);
                }
                return Result.success(articleId);
            }
            //标签不为空的文章也向量化
            if (article.getStatus()==1){
                ragVectorArticle(article);
            }
            //批量存入文章标签表
            //操作标签列表用stream流 迭代都可以实现
            List<ArticleTag> articleTagList = createArticleDTO.getTagIds().stream().distinct().map(t -> {
                ArticleTag articleTag = new ArticleTag();
                articleTag.setArticleId(articleId);
                articleTag.setTagId(t);
                return articleTag;
            }).collect(Collectors.toList());

            articleTagService.saveBatch(articleTagList);
        } finally {
            //释放锁
            if (lock.isHeldByCurrentThread()) lock.unlock();
        }

        return Result.success(articleId);
    }

    //把文章通过mq发送到消息队列异步处理。文章向量化存入向量数据库方法
    private void ragVectorArticle(Article article){
        RagMessageDTO messageDTO = new RagMessageDTO();
        //转json风封装数据发到mq
        String json = JSONUtil.toJsonStr(article);
        messageDTO.setJson(json);
        messageDTO.setUuid(UUID.randomUUID().toString());
        messageDTO.setType(RagConstants.VECTOR_ARTICLE_TYPE);
        messageDTO.setOperation(RagConstants.OPERATION_CREATE);

        rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE,"rag",messageDTO);
    }

    //编辑文章
    @Transactional(rollbackFor = Exception.class)
    @Override
    public Result<Void> updateArticle(Long articleId, UpdateArticleDTO updateArticleDTO, MultipartFile file) throws Exception {
        //获取用户id
        Long userId = UserContext.getUserId();
        // 先查存在性(404)再查归属(403)。原先把两种情况合并成一句「笔记不存在或无权编辑」，
        // 既是错误的文案（这里是文章不是笔记），也给不出可区分状态码（BUG-06）
        Article articles = getById(articleId);
        if (ObjectUtils.isEmpty(articles)) {
            log.warn("文章不存在 articleId={}", articleId);
            throw BusinessException.notFound("文章不存在");
        }
        if (!userId.equals(articles.getUserId())) {
            log.warn("无权编辑该文章 articleId={}", articleId);
            throw BusinessException.forbidden("无权编辑该文章");
        }
        //校验标题跟正文是否为空
        if (ObjectUtils.isEmpty(updateArticleDTO.getContent()) || ObjectUtils.isEmpty(updateArticleDTO.getTitle())) {
            log.error("正文或标题不能为空");
            throw BusinessException.badRequest("正文或标题不能为空");
        }
        //没有传递图片证明依旧用旧的图片保持默认
        //如果不为空保存更新
        String url = articles.getCover();
        if (file != null && !file.isEmpty()) {
            // 1. 文件大小校验，最大 2MB
            if (file.getSize() > 2 * 1024 * 1024) {
                throw BusinessException.badRequest("封面大小不能超过2MB");
            }
            // 2. 文件后缀校验
            String originalFilename = file.getOriginalFilename();
            if (ObjectUtils.isEmpty(originalFilename)) {
                throw BusinessException.badRequest("封面文件名不能为空");
            }

            String suffix = originalFilename.substring(
                    originalFilename.lastIndexOf(".") + 1
            ).toLowerCase();
            if (!Arrays.asList("jpg", "jpeg", "png", "webp").contains(suffix)) {
                throw BusinessException.badRequest("封面只支持 jpg、jpeg、png、webp 格式");
            }
            // 3. Content-Type 校验
            String contentType = file.getContentType();
            if (ObjectUtils.isEmpty(contentType)
                    || !Arrays.asList("image/jpeg", "image/png", "image/webp")
                    .contains(contentType)) {
                throw BusinessException.badRequest("封面格式不正确");
            }
            //删除旧图片
            if (url != null){
                fileUploadService.deleteFile(url);
            }
            // 4. 上传
            url = fileUploadService.uploadFile(ArticleConstants.ARTICLE_COVER, file);
            updateArticleDTO.setCover(url);
        }
        //判断是否写有摘要
        if (ObjectUtils.isEmpty(updateArticleDTO.getSummary())) {
            String content = updateArticleDTO.getContent();
            // 按 Unicode 码点截断前 20 个字符，避免切断 emoji 等代理对
            String summary = content.codePoints()
                    .limit(20)
                    .collect(
                            () -> new StringBuilder(),                          // 创建容器
                            (sb, codePoint) -> sb.appendCodePoint(codePoint),   // 把每个码点加进去
                            (sb1, sb2) -> sb1.append(sb2)                       // 合并容器（并行流时用）
                    )
                    .toString();
            updateArticleDTO.setSummary(summary);
        }
        Article article = new Article();
        BeanUtils.copyProperties(updateArticleDTO, article);

        //更新数据库只能修改自己的文章
        LambdaQueryWrapper<Article> wrapper = new LambdaQueryWrapper<Article>().eq(Article::getId, articleId).eq(Article::getUserId, userId);
       update(article, wrapper);
        //每次更新完数据把redis缓存里面的内容删除保证一致性
        redisTemplate.delete(RedisKeyConstants.ARTICLE_DETAIL_KEY+articleId);
        //使用mq异步删除缓存
        CacheMessage message = new CacheMessage(articleId, UUID.randomUUID().toString());
        rabbitTemplate.convertAndSend(RabbitConfig.EXCHANGE,"cache",message);
        //更新rag知识库异步处理
        Article argArticle = getById(articleId);
        if (updateArticleDTO.getStatus()==1){
            String jsonStr = JSONUtil.toJsonStr(argArticle);
            updateRagArticle(jsonStr,RagConstants.OPERATION_UPDATE,articleId);
        }else {
            String jsonStr = JSONUtil.toJsonStr(argArticle);
            updateRagArticle(jsonStr,RagConstants.OPERATION_DELETE,articleId);
            //转为草稿也把redis内容删除
            redisTemplate.opsForZSet().remove(RedisKeyConstants.ARTICLE_HOT_KEY,String.valueOf(articleId));
        }

        //处理标签
        if (ObjectUtils.isEmpty(updateArticleDTO.getTagIds())) {
            //空 清空标签
            articleTagService.remove(new LambdaQueryWrapper<ArticleTag>().eq(ArticleTag::getArticleId, articleId));
            return Result.success("操作成功");
        }
        //不为空先删除后更新
        articleTagService.remove(new LambdaQueryWrapper<ArticleTag>().eq(ArticleTag::getArticleId, articleId));
        //批量存入文章标签表
        //操作标签列表用stream流 迭代都可以实现
        List<ArticleTag> articleTagList = updateArticleDTO.getTagIds().stream().distinct().map(t -> {
            ArticleTag articleTag = new ArticleTag();
            articleTag.setArticleId(articleId);
            articleTag.setTagId(t);
            return articleTag;
        }).collect(Collectors.toList());
        //更新
        articleTagService.saveBatch(articleTagList);

        return Result.success("操作成功");
    }
    //更新rag知识库
    private void updateRagArticle(String json , String operation,Long articleId){
        RagMessageDTO messageDTO = new RagMessageDTO();
        messageDTO.setJson(json);
        messageDTO.setType(RagConstants.VECTOR_ARTICLE_TYPE);
        messageDTO.setOperation(operation);
        messageDTO.setUuid(UUID.randomUUID().toString());
        messageDTO.setArticleId(articleId);
        rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE,"rag.update.delete",messageDTO);
    }

    //删除文章
    @Transactional(rollbackFor = Exception.class)
    @Override
    public Result<Void> deleteArticle(Long articleId) {
        //获取用户id
        Long userId = UserContext.getUserId();
        Article articles = getById(articleId);
        if (ObjectUtils.isEmpty(articles)) {
            log.warn("文章不存在 articleId={}", articleId);
            throw BusinessException.notFound("文章不存在");
        }
        if (!userId.equals(articles.getUserId())) {
            log.warn("无权删除该文章 articleId={}", articleId);
            throw BusinessException.forbidden("无权删除该文章");
        }
        //根据笔记id删除 笔记标签关联表数据
        articleTagService.remove(new LambdaQueryWrapper<ArticleTag>().eq(ArticleTag::getArticleId, articleId));
        //删除评论
        commentService.remove(new LambdaQueryWrapper<Comment>().eq(Comment::getArticleId, articleId));
        //删除喜欢
        articleLikeService.remove(new LambdaQueryWrapper<ArticleLike>().eq(ArticleLike::getArticleId, articleId));
        //删除收藏
        favoriteService.remove(new LambdaQueryWrapper<Favorite>().eq(Favorite::getArticleId, articleId));
        //再删除本身
        boolean removed = remove(new LambdaQueryWrapper<Article>().eq(Article::getId, articleId).eq(Article::getUserId, userId));


        if (!removed){
            log.warn("删除失败，请重试");
            throw BusinessException.serverError("删除失败，请重试");
        }
        //删除文章redis相关
        redisTemplate.delete(RedisKeyConstants.ARTICLE_DETAIL_KEY+articleId);
        redisTemplate.delete(RedisKeyConstants.ARTICLE_VIEW_KEY+articleId);
        //★ BUG-29：原来漏了点赞/收藏计数器 —— 文章都删了 key 还在（计数 key 只设了 30 天 TTL），
        //  属于纯内存泄漏，且一旦 id 复用会读到别人的旧计数。
        redisTemplate.delete(RedisKeyConstants.ARTICLE_LIKE_KEY + articleId);
        redisTemplate.delete(RedisKeyConstants.ARTICLE_FAVORITE_KEY + articleId);
        redisTemplate.opsForZSet().remove(RedisKeyConstants.ARTICLE_HOT_KEY,String.valueOf(articleId));

        //发送mq删除在向量数据库的文章
        RagMessageDTO messageDTO = new RagMessageDTO();
        messageDTO.setType(RagConstants.VECTOR_ARTICLE_TYPE);
        messageDTO.setOperation(RagConstants.OPERATION_DELETE);
        messageDTO.setArticleId(articleId);
        messageDTO.setUuid(UUID.randomUUID().toString());
        rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE,"rag.update.delete",messageDTO);

        return Result.success("操作成功");
    }

    //查看文章详情
    @Override
    public Result<ArticleDetailVO> checkArticle(Long articleId) {
        //通过上下文获取用户id
        Long userId = UserContext.getUserId();
        //redis缓存有缓存直接返回没有缓存往下面走
        String articleDetail = redisTemplate.opsForValue().get(RedisKeyConstants.ARTICLE_DETAIL_KEY + articleId);

        if (!ObjectUtils.isEmpty(articleDetail)) {
            ArticleDetailVO articleDetailVO = JSONUtil.toBean(articleDetail, ArticleDetailVO.class);

            //★ BUG-26：缓存里的 isLiked/isFavorited 是「写缓存那一刻的用户」算出来的，
            //  命中缓存时必须按当前用户重算，否则会跨用户串号。
            //  注意这两个值是「按用户」的，不能跟着公共缓存走。
            fillUserInteractionState(articleDetailVO, articleId, userId);

            //浏览量缓存到redis后面异步更新
            Long viewCount = redisTemplate.opsForValue().increment(RedisKeyConstants.ARTICLE_VIEW_KEY+articleId, 1);
            articleDetailVO.setViewCount(viewCount);
            //浏览量发送到mq
            CountMessage message = new CountMessage(articleId, 1, UUID.randomUUID().toString());
            rabbitTemplate.convertAndSend(RabbitConfig.EXCHANGE,"view.count",message);
            //点赞数量也从redis拿
            String likeCount = redisTemplate.opsForValue().get(RedisKeyConstants.ARTICLE_LIKE_KEY + articleId);
           if (!ObjectUtils.isEmpty(likeCount)){
               articleDetailVO.setLikeCount(Long.valueOf(likeCount));
           }
            //★ BUG-28：收藏数同样要从 redis 计数器拿。原来这里缺这一行，
            //  命中缓存时 favoriteCount 一直是「写缓存那一刻」的旧快照
            //  → 收藏后详情不涨、取消收藏后不降，与列表/收藏夹（直查库）自相矛盾。
            String favoriteCount = redisTemplate.opsForValue().get(RedisKeyConstants.ARTICLE_FAVORITE_KEY + articleId);
            if (!ObjectUtils.isEmpty(favoriteCount)) {
                articleDetailVO.setFavoriteCount(Long.valueOf(favoriteCount));
            }
            //缓存热门文章 浏览一次分数+1
            redisTemplate.opsForZSet().incrementScore(RedisKeyConstants.ARTICLE_HOT_KEY
                    ,String.valueOf(articleId),1);
            return Result.success(articleDetailVO);
        }
        //穿透问题:上面如果没进去if 证明就是 "" 或者null
        // 如果不是null那就是缓存里面缓存了空对象，为的是防止穿透直接进入下面的逻辑返回
        if (articleDetail !=null){
            throw BusinessException.notFound("文章不存在");
        }
        //引入redisson解决击穿问题 使用的互斥锁机制
        RLock lock = redissonClient.getLock("codemind:lock:articleDetails:" + articleId);
        ArticleDetailVO articleDetailVO = null;
        try {
            boolean isLock = lock.tryLock(1, 10, TimeUnit.SECONDS);
            //使用互斥锁
            if (!isLock) {
                throw BusinessException.serviceUnavailable("系统繁忙请稍后尝试");
            }
            //根据id查询文章信息
            Article article = getById(articleId);
            //缓存空对象
            if (article == null) {
                redisTemplate.opsForValue().set(RedisKeyConstants.ARTICLE_DETAIL_KEY+articleId,
                        "",3,TimeUnit.MINUTES);
                throw BusinessException.notFound("文章不存在");
            }
            if (!Objects.equals(userId, article.getUserId()) && article.getStatus() !=1){
                throw BusinessException.forbidden("无权访问");
            }
            //拿到作者id查询作者信息 封装
            User user = userMapper.selectById(article.getUserId());
            if (ObjectUtils.isEmpty(user)) {
                log.warn("没有相关作者");
                throw BusinessException.notFound("没有找到相关作者");
            }

            UserSimpleVO userSimpleVO = new UserSimpleVO();
            BeanUtils.copyProperties(user, userSimpleVO);
            //根据笔记id查询标签关联表拿到标签id查询对应的标签名字
            List<ArticleTag> articleTagList = articleTagService.list(new LambdaQueryWrapper<ArticleTag>().eq(ArticleTag::getArticleId, articleId));
            List<TagSimpleVO> tagSimpleVOList = new ArrayList<>();
            if (!ObjectUtils.isEmpty(articleTagList)) {
                //取标签id
                //查询标签表
                List<Long> tagsIdList = articleTagList.stream().distinct().map(ArticleTag::getTagId).collect(Collectors.toList());
                //循环赋值封装
                List<Tag> tagList = tagService.list(new LambdaQueryWrapper<Tag>().in(Tag::getId, tagsIdList));
                for (Tag tag : tagList) {
                    TagSimpleVO tagSimpleVO = new TagSimpleVO();
                    BeanUtils.copyProperties(tag, tagSimpleVO);
                    tagSimpleVOList.add(tagSimpleVO);
                }

            }
            //最终结果返回
            articleDetailVO = new ArticleDetailVO();

            //按当前用户填充点赞/收藏状态（未登录时均为 false）
            fillUserInteractionState(articleDetailVO, articleId, userId);

            //封装返回
            BeanUtils.copyProperties(article,articleDetailVO);
            articleDetailVO.setUser(userSimpleVO);
            articleDetailVO.setTags(tagSimpleVOList);

            //★ BUG-25：草稿不进公共缓存 —— 直接落库返回。
            //  只有 status=1（公开）的文章才写缓存，从而保证一条不变量：
            //  「详情缓存里存在的内容 ⇒ 该文章当前一定是公开的」，
            //  因此缓存命中分支无需再查库判权（判权只在缓存未命中、读到 DB 时做）。
            //  顺带：草稿预览不计浏览量、不发 MQ、不进热榜 ZSet（否则 hot 只查 status=1，会造出 total ≠ records）。
            if (article.getStatus() == null || article.getStatus() != 1) {
                return Result.success(articleDetailVO);
            }

            //如果缓存没命中查完db缓存到redis下次用户访问直接访问redis
            String articleJsonStr = JSONUtil.toJsonStr(articleDetailVO);
            //缓存到redis 设置ttl 60分钟
            redisTemplate.opsForValue().set(RedisKeyConstants.ARTICLE_DETAIL_KEY+articleId,
                    articleJsonStr,RedisKeyConstants.ARTICLE_EMPTY_TTL, TimeUnit.MINUTES);
            //redis异步更新浏览量
            //实时同步浏览量数量使用redis同步
            //★ BUG-33：浏览量计数器冷启动 —— 原来直接 INCR，若 Redis 里没有该 key 会从 0 起算，
            //  于是库里有 20 多次阅读量的文章，详情页会显示成 1，且要等 Redis 慢慢追上才一致。
            //  这里先用库里的值兜底初始化，再自增。
            String viewKey = RedisKeyConstants.ARTICLE_VIEW_KEY + articleId;
            redisTemplate.opsForValue().setIfAbsent(viewKey,
                    String.valueOf(ObjectUtils.isEmpty(article.getViewCount()) ? 0L : article.getViewCount()),
                    RedisKeyConstants.COUNT_KEY_TTL, TimeUnit.DAYS);
            Long viewCount = redisTemplate.opsForValue().increment(viewKey, 1);
            articleDetailVO.setViewCount(viewCount);
            //浏览量发送到mq
            CountMessage message = new CountMessage(articleId, 1, UUID.randomUUID().toString());
            rabbitTemplate.convertAndSend(RabbitConfig.EXCHANGE,"view.count",message);
            //点赞数量也从redis拿
            //★ BUG-32：必须「取到才覆盖」。原来写的是 `likeCount == null ? 0L : Long.parseLong(likeCount)`，
            //  只要该 Redis 计数器不在（首次上线 / 被清理 / 30 天 TTL 过期），
            //  就会把上面 BeanUtils 刚拷进来的库值（真实点赞数）冲成 0
            //  → 前端出现「明明有人点过赞，点赞数却是 0」。
            String likeCount = redisTemplate.opsForValue().get(RedisKeyConstants.ARTICLE_LIKE_KEY + articleId);
            if (!ObjectUtils.isEmpty(likeCount)) {
                articleDetailVO.setLikeCount(Long.parseLong(likeCount));
            }
            //★ BUG-28：收藏数同理，从 redis 计数器刷新
            String favoriteCount = redisTemplate.opsForValue().get(RedisKeyConstants.ARTICLE_FAVORITE_KEY + articleId);
            if (!ObjectUtils.isEmpty(favoriteCount)) {
                articleDetailVO.setFavoriteCount(Long.parseLong(favoriteCount));
            }
            //缓存热门文章 浏览一次分数+1
            redisTemplate.opsForZSet().incrementScore(RedisKeyConstants.ARTICLE_HOT_KEY
                    ,String.valueOf(articleId),1);
        } catch (InterruptedException e) {
            throw new RuntimeException(e);
        } finally {
            //关闭锁
            if (lock.isHeldByCurrentThread()) lock.unlock();
        }
//        update(new LambdaUpdateWrapper<Article>().eq(Article::getId,articleId).setSql("view_count = view_count+1"));
        return Result.success(articleDetailVO);

    }

    /**
     * 按「当前用户」填充点赞 / 收藏状态。
     * <p>
     * 详情缓存的 key 不带 userId，缓存的 VO 是全体用户共享的；而 isLiked / isFavorited
     * 是「按用户」算出来的。所以无论命中缓存还是回库组装，都必须用当前 userId 重算一遍，
     * 否则会拿到写缓存那个用户的状态，造成跨用户串号（BUG-26）。
     * 未登录用户两者恒为 false。
     */
    private void fillUserInteractionState(ArticleDetailVO articleDetailVO, Long articleId, Long userId) {
        boolean isLiked = false;
        boolean isFavorited = false;
        if (!ObjectUtils.isEmpty(userId)) {
            isLiked = articleLikeService.count(new LambdaQueryWrapper<ArticleLike>()
                    .eq(ArticleLike::getArticleId, articleId)
                    .eq(ArticleLike::getUserId, userId)) > 0;
            isFavorited = favoriteService.count(new LambdaQueryWrapper<Favorite>()
                    .eq(Favorite::getArticleId, articleId)
                    .eq(Favorite::getUserId, userId)) > 0;
        }
        articleDetailVO.setIsLiked(isLiked);
        articleDetailVO.setIsFavorited(isFavorited);
    }

    @Override
    public Result<Page<ArticleListVO>> articleList(Integer page, Integer size) {
        //new 分页对象 //把page size放进去
        Page<Article> articlePage = new Page<>(page, size);
        //分页查笔记表
        page(articlePage,new LambdaQueryWrapper<Article>().eq(Article::getStatus,1).orderByDesc(Article::getCreateTime));
        //返回的vo
        Page<ArticleListVO> articleListVOPage = new Page<>();
        //校验是否为空
        if (ObjectUtils.isEmpty(articlePage.getRecords())) {
            log.warn("文章为空");
            articleListVOPage.setSize(articlePage.getSize());
            articleListVOPage.setCurrent(articlePage.getCurrent());
            articleListVOPage.setTotal(articlePage.getTotal());
            articleListVOPage.setPages(articlePage.getPages());
            articleListVOPage.setRecords(new ArrayList<>());
            return Result.success(articleListVOPage);
        }
        //调用方法获取最后结果
        List<ArticleListVO> articleListVOList = articleListFun(articlePage);
        //封装数据返回
        //最终返回结果

        articleListVOPage.setSize(articlePage.getSize());
        articleListVOPage.setCurrent(articlePage.getCurrent());
        articleListVOPage.setTotal(articlePage.getTotal());
        articleListVOPage.setPages(articlePage.getPages());
        articleListVOPage.setRecords(articleListVOList);

        return Result.success(articleListVOPage);
    }

    @Override
    public Result<Page<MyArticleVO>> myArticleList(Integer page, Integer size, Integer status) {
        //获取当前用户id
        Long userId = UserContext.getUserId();
        //获取分页对象
        Page<Article> MyarticlePage = new Page<>(page, size);
        //根据用户id查询文章//根据条件查询
        page(MyarticlePage,new LambdaQueryWrapper<Article>().eq(Article::getUserId, userId)
                .eq(!ObjectUtils.isEmpty(status),Article::getStatus, status));
        //空页提前返回，避免空集合 in() 生成 IN () 非法 SQL
        if (ObjectUtils.isEmpty(MyarticlePage.getRecords())) {
            Page<MyArticleVO> emptyPage = new Page<>();
            emptyPage.setSize(MyarticlePage.getSize());
            emptyPage.setCurrent(MyarticlePage.getCurrent());
            emptyPage.setTotal(MyarticlePage.getTotal());
            emptyPage.setPages(MyarticlePage.getPages());
            emptyPage.setRecords(new ArrayList<>());
            return Result.success(emptyPage);
        }
        //获取文章id
        List<Long> articleIdList = MyarticlePage.getRecords().stream().map(Article::getId).collect(Collectors.toList());
        //根据文章id查询标签关联表  //多对多关系需要分组 聚合
        Map<Integer, List<Long>> articleTagMap = articleTagService.listMaps(new LambdaQueryWrapper<ArticleTag>().select(ArticleTag::getArticleId, ArticleTag::getTagId)
                .in(ArticleTag::getArticleId, articleIdList)).stream().collect(Collectors.groupingBy(
                t -> ((Number) t.get("article_id")).intValue(), Collectors.mapping(t -> ((Number) t.get("tag_id")).longValue(), Collectors.toList())));


        List<Long> tagIdList = articleTagMap.values().stream()
                .flatMap(Collection::stream).distinct().collect(Collectors.toList());
        //根据标签id查询标签表 转成map key 标签id value tag
        //最终返回map
        Map<Long , List<TagSimpleVO>> lashTagMap = new HashMap<>();
        //★ BUG-31：标签查询必须放进下面的判空分支里！原来它在 if 外面，
        //  当 tagIdList 为空时会拼出 `IN ()` 非法 SQL → MySQL 语法错 →
        //  被全局异常处理器兜成 `500 系统繁忙`。触发条件极常见：
        //  该用户在该 status 下的文章全都没标签（例如新写的草稿不打标签）。
        if (!ObjectUtils.isEmpty(tagIdList)) {
            //根据标签id查询标签表 转成list<map<long,tagvo>>
            Map<Long, TagSimpleVO> tagMap = tagService.list(new LambdaQueryWrapper<Tag>().in(Tag::getId, tagIdList))
                    .stream().collect(Collectors.toMap(Tag::getId, t -> {
                        TagSimpleVO tagSimpleVO = new TagSimpleVO();
                        BeanUtils.copyProperties(t, tagSimpleVO);
                        return tagSimpleVO;
                    }));
            for (Map.Entry<Integer, List<Long>> entry : articleTagMap.entrySet()) {
                //获取标签id列表
                List<Long> tagIds = entry.getValue();
                //获取标签对应的笔记id
                Integer articleId = entry.getKey();
                //通过流遍历标签id在map里面拿到对应tag对象
                List<TagSimpleVO> TagSimpleList = tagIds.stream().map(t -> {
                    return tagMap.getOrDefault(t,new TagSimpleVO()); //需要把t转成long类型不然取不到值
                }).collect(Collectors.toList());
                lashTagMap.put(articleId.longValue(), TagSimpleList);
            }
        }
        //根据笔记id查询评论表count统计每篇笔记有多少评论
        //一篇笔记可以有多个评论 key 笔记id value 对应的评论数量
        Map<Long, Long> commentMap = commentService.listMaps(new QueryWrapper<Comment>().select("article_id, COUNT(*) AS total_count")
                        .lambda().in(Comment::getArticleId, articleIdList)
                        .groupBy(Comment::getArticleId)).stream()
                .collect(Collectors.toMap(t -> (Long) t.get("article_id")
                        , t -> ((Number) t.get("total_count")).longValue()));


        //封装数据返回
        //最终返回结果
        Page<MyArticleVO> articleListVOPage = new Page<>();
        articleListVOPage.setSize(MyarticlePage.getSize());
        articleListVOPage.setCurrent(MyarticlePage.getCurrent());
        articleListVOPage.setTotal(MyarticlePage.getTotal());
        articleListVOPage.setPages(MyarticlePage.getPages());
        //封装列表数据
        //定义封装笔记列表vo
        List<MyArticleVO> MyArticleListVOList = new ArrayList<>();
        for (Article record : MyarticlePage.getRecords()) {
            //封装数据
            MyArticleVO myArticleVO = new MyArticleVO();
            BeanUtils.copyProperties(record, myArticleVO);
            myArticleVO.setTags(lashTagMap.get(record.getId()));
            myArticleVO.setCommentCount(commentMap.get(record.getId()));
            MyArticleListVOList.add(myArticleVO);
        }
        articleListVOPage.setRecords(MyArticleListVOList);

        return Result.success(articleListVOPage);
    }

    //3.17 热门文章（按浏览量倒序）
    @Override
    public Result<Page<ArticleListVO>> hotArticleList(Integer page, Integer size) {
        // 从 ZSet 按分数倒序取本页 id
        long start = (page -1L) * size;
        Set<String> idSet = redisTemplate.opsForZSet().reverseRange(RedisKeyConstants.ARTICLE_HOT_KEY, start, start + size - 1);
        //空页提前返回，避免空集合 in() 生成 IN () 非法 SQL
        //分页元数据必须按真实请求回显：用 new Page<>() 的默认值会返回 size=10 / current=1，和传入值对不上
        Page<ArticleListVO> articleListVOPage = new Page<>(page, size);
        if (ObjectUtils.isEmpty(idSet)) {
            Long emptyTotal = redisTemplate.opsForZSet().size(RedisKeyConstants.ARTICLE_HOT_KEY);
            articleListVOPage.setTotal(emptyTotal == null ? 0L : emptyTotal);
            articleListVOPage.setPages(emptyTotal == null ? 0L : (emptyTotal + size - 1) / size);
            articleListVOPage.setRecords(new ArrayList<>());
            return Result.success(articleListVOPage);
        }
        
        //把热门文章id转成long 根据id查询
        List<Long> Ids = idSet.stream().map(Long::valueOf).collect(Collectors.toList());
        //分页查笔记表（只查已发布，避免草稿泄露到公开列表）
        List<Article> articleList = list(new LambdaQueryWrapper<Article>()
                .eq(Article::getStatus, 1)
                .in(Article::getId, Ids));
        //转成id ->笔记
        Map<Long, Article> articleMap = articleList.stream().collect(Collectors.toMap(Article::getId, t -> t));
        //根据redis id重新排序 因为redis已经拍好顺序了
        List<Article> orderedArticles = Ids.stream().map(t -> articleMap.get(t))
                .filter(Objects::nonNull)
                .collect(Collectors.toList());

        //根据笔记id查询user信息
        List<Long> userIdList = orderedArticles.stream().map(Article::getUserId).collect(Collectors.toList());
        Map<Long, UserSimpleVO> userMap = userMapper.selectList(new LambdaQueryWrapper<User>().in(User::getId, userIdList))
                .stream().distinct().collect(Collectors.
                        toMap(User::getId, t -> {
                            UserSimpleVO userSimpleVO = new UserSimpleVO();
                            BeanUtils.copyProperties(t, userSimpleVO);
                            return  userSimpleVO;
                        }));
        //添加进分页笔记列表
        //根据笔记id查询标签表
        List<Long> articleIdList = orderedArticles.
                stream().map(Article::getId)
                .collect(Collectors.toList());
        //一个文章可以对应多个标签要分组
        Map<Integer, List<Long>> articleTagMap = articleTagService.listMaps(new LambdaQueryWrapper<ArticleTag>()
                .select(ArticleTag::getArticleId, ArticleTag::getTagId)
                .in(ArticleTag::getArticleId, articleIdList)).stream().collect(Collectors.groupingBy(
                t -> ((Number) t.get("article_id")).intValue(), Collectors.mapping(t -> ((Number) t.get("tag_id")).longValue(), Collectors.toList())
        ));
        //拿到tagid列表
        List<Long> tagIdList = articleTagMap.values().stream()
                .flatMap(Collection::stream).distinct().collect(Collectors.toList());
        //标签数据最终结果 map key->articleId value-> TagSimpleVO
        Map<Long,List<TagSimpleVO>> lastArticleTagMap = new HashMap<>();
        if (!ObjectUtils.isEmpty(tagIdList)) {
            Map<Long, Tag> tagMap = tagService.list(new LambdaQueryWrapper<Tag>().in(Tag::getId, tagIdList)).stream()
                    .collect(Collectors.toMap(Tag::getId, t -> t));
            //迭代封装最后结果
            for (Map.Entry<Integer, List<Long>> entry : articleTagMap.entrySet()) {
                List<Long> tagIds = entry.getValue();
                Integer articleId = entry.getKey();
                List<TagSimpleVO> TagSimpleVOList = tagIds.stream().map(t -> {
                    //拿到标签
                    Tag tag = tagMap.get(t);
                    //封装数据
                    TagSimpleVO tagSimpleVO = new TagSimpleVO();
                    if (!ObjectUtils.isEmpty(tag)){
                        BeanUtils.copyProperties(tag, tagSimpleVO);
                    }
                    return tagSimpleVO;
                }).collect(Collectors.toList());
                lastArticleTagMap.put(articleId.longValue(),TagSimpleVOList);
            }
        }
        //添加进笔记列表
        //根据笔记id查询评论表count统计每篇笔记有多少评论
        //一篇笔记可以有多个评论 key 笔记id value 对应的评论数量
        Map<Long, Long> commentMap = commentService.listMaps(new QueryWrapper<Comment>().select("article_id, COUNT(*) AS total_count")
                        .lambda().in(Comment::getArticleId, articleIdList)
                        .groupBy(Comment::getArticleId)).stream()
                .collect(Collectors.toMap(t -> (Long) t.get("article_id")
                        , t -> ((Number) t.get("total_count")).longValue()));

        //封装列表数据
        //定义封装笔记列表vo
        List<ArticleListVO> articleListVOList = new ArrayList<>();
        for (Article record : orderedArticles) {
            //封装数据
            ArticleListVO articleListVO = new ArticleListVO();
            BeanUtils.copyProperties(record, articleListVO);
            articleListVO.setTags(lastArticleTagMap.getOrDefault(record.getId(),new ArrayList<>()));
            articleListVO.setUser(userMap.get(record.getUserId()));
            articleListVO.setCommentCount(commentMap.get(record.getId()));
            articleListVOList.add(articleListVO);
        }

        //封装数据返回
        //最终返回结果
        articleListVOPage.setSize(size);
        articleListVOPage.setCurrent(page);
        //包装total
        Long total = redisTemplate.opsForZSet().size(RedisKeyConstants.ARTICLE_HOT_KEY);
        articleListVOPage.setTotal(total.longValue());
        articleListVOPage.setPages((total +size -1)/size);
        articleListVOPage.setRecords(articleListVOList);

        return Result.success(articleListVOPage);
    }

    //3.18 最新文章（按发布时间倒序）
    @Override
    public Result<Page<ArticleListVO>> latestArticleList(Integer page, Integer size) {
        //new 分页对象 //把page size放进去
        Page<Article> latestarticlePage = new Page<>(page, size);
        //分页查笔记表（只查已发布，避免草稿泄露到公开列表）
        page(latestarticlePage,new LambdaQueryWrapper<Article>()
                .eq(Article::getStatus, 1)
                .orderByDesc(Article::getCreateTime));
        Page<ArticleListVO> articleListVOPage = new Page<>();
        //空页提前返回，避免空集合 in() 生成 IN () 非法 SQL
        if (ObjectUtils.isEmpty(latestarticlePage.getRecords())) {
            articleListVOPage.setSize(latestarticlePage.getSize());
            articleListVOPage.setCurrent(latestarticlePage.getCurrent());
            articleListVOPage.setTotal(latestarticlePage.getTotal());
            articleListVOPage.setPages(latestarticlePage.getPages());
            articleListVOPage.setRecords(new ArrayList<>());
            return Result.success(articleListVOPage);
        }
        //调用方法获取最后结果
        List<ArticleListVO> articleListVOList = articleListFun(latestarticlePage);
        //封装数据返回
        //最终返回结果
        articleListVOPage.setSize(latestarticlePage.getSize());
        articleListVOPage.setCurrent(latestarticlePage.getCurrent());
        articleListVOPage.setTotal(latestarticlePage.getTotal());
        articleListVOPage.setPages(latestarticlePage.getPages());
        articleListVOPage.setRecords(articleListVOList);

        return Result.success(articleListVOPage);
    }

    //3.19 标签下的文章
    @Override
    public Result<Page<ArticleListVO>> articleListByTag(Long tagId, Integer page, Integer size) {

        //  2. 分页查询：new Page<>(page, size)，条件 in(Article::getId, 文章id集合)
        Page<Article> articlePage = new Page<>(page, size);
        page(articlePage,new LambdaQueryWrapper<Article>()
                .inSql(Article::getId,  "SELECT article_id FROM article_tag WHERE tag_id = " + tagId)
                .eq(Article::getStatus, 1)
                .orderByDesc(Article::getCreateTime));
        Page<ArticleListVO> articleListVOPage = new Page<>();
        //空页提前返回，避免空集合 in() 生成 IN () 非法 SQL
        if (ObjectUtils.isEmpty(articlePage.getRecords())) {
            articleListVOPage.setSize(articlePage.getSize());
            articleListVOPage.setCurrent(articlePage.getCurrent());
            articleListVOPage.setTotal(articlePage.getTotal());
            articleListVOPage.setPages(articlePage.getPages());
            articleListVOPage.setRecords(new ArrayList<>());
            return Result.success(articleListVOPage);
        }
        //调用方法获取最后结果
        List<ArticleListVO> articleListVOList = articleListFun(articlePage);
        //封装数据返回
        //最终返回结果
        articleListVOPage.setSize(articlePage.getSize());
        articleListVOPage.setCurrent(articlePage.getCurrent());
        articleListVOPage.setTotal(articlePage.getTotal());
        articleListVOPage.setPages(articlePage.getPages());
        articleListVOPage.setRecords(articleListVOList);

        return Result.success(articleListVOPage);
    }
    //tool工具调用返回
    @Override
    public List<SearchArticleData> AiqueryArticleList(SearchArticle searchArticle) {
        Integer orElse = Optional.ofNullable(searchArticle.getLimit())
                .map(i -> Math.min(i, 20))
                .orElse(10);

        searchArticle.setLimit(orElse);
        List<SearchArticleData> searchArticleDataList = articleMapper.AiqueryArticleList(searchArticle);

        return searchArticleDataList;
    }

    //封装公共方法
    private List<ArticleListVO> articleListFun(Page<Article> articlePage){
        //根据笔记id查询user信息
        List<Long> userIdList = articlePage.getRecords().stream().map(Article::getUserId).collect(Collectors.toList());
        Map<Long, UserSimpleVO> userMap = userMapper.selectList(new LambdaQueryWrapper<User>().in(User::getId, userIdList))
                .stream().collect(Collectors.
                        toMap(User::getId, t -> {
                            UserSimpleVO userSimpleVO = new UserSimpleVO();
                            BeanUtils.copyProperties(t, userSimpleVO);
                            return  userSimpleVO;
                        }));
        //添加进分页笔记列表
        //根据笔记id查询标签表
        List<Long> articleIdList = articlePage.getRecords().
                stream().map(Article::getId)
                .collect(Collectors.toList());
        //一个文章可以对应多个标签要分组
        Map<Integer, List<Long>> articleTagMap = articleTagService.listMaps(new LambdaQueryWrapper<ArticleTag>()
                .select(ArticleTag::getArticleId, ArticleTag::getTagId)
                .in(ArticleTag::getArticleId, articleIdList)).stream().collect(Collectors.groupingBy(
                t -> ((Number) t.get("article_id")).intValue(), Collectors.mapping(t -> ((Number) t.get("tag_id")).longValue(), Collectors.toList())
        ));
        //拿到tagid列表
        List<Long> tagIdList = articleTagMap.values().stream()
                .flatMap(Collection::stream).distinct().collect(Collectors.toList());
        //标签数据最终结果 map key->articleId value-> TagSimpleVO
        Map<Long,List<TagSimpleVO>> lastArticleTagMap = new HashMap<>();
        if (!ObjectUtils.isEmpty(tagIdList)) {
            Map<Long, Tag> tagMap = tagService.list(new LambdaQueryWrapper<Tag>().in(Tag::getId, tagIdList)).stream()
                    .collect(Collectors.toMap(Tag::getId, t -> t));
            //迭代封装最后结果
            for (Map.Entry<Integer, List<Long>> entry : articleTagMap.entrySet()) {
                List<Long> tagIds = entry.getValue();
                Integer articleId = entry.getKey();
                List<TagSimpleVO> TagSimpleVOList = tagIds.stream().map(t -> {
                    //拿到标签
                    Tag tag = tagMap.get(t);
                    //封装数据
                    TagSimpleVO tagSimpleVO = new TagSimpleVO();
                    if (!ObjectUtils.isEmpty(tag)) {
                        BeanUtils.copyProperties(tag, tagSimpleVO);
                    }

                    return tagSimpleVO;
                }).collect(Collectors.toList());
                lastArticleTagMap.put(articleId.longValue(),TagSimpleVOList);
            }
        }
        //添加进笔记列表
        //根据笔记id查询评论表count统计每篇笔记有多少评论
        //一篇笔记可以有多个评论 key 笔记id value 对应的评论数量
        Map<Long, Long> commentMap = commentService.listMaps(new QueryWrapper<Comment>().select("article_id, COUNT(*) AS total_count")
                        .lambda().in(Comment::getArticleId, articleIdList)
                        .groupBy(Comment::getArticleId)).stream()
                .collect(Collectors.toMap(t -> (Long) t.get("article_id")
                        , t -> ((Number) t.get("total_count")).longValue()));

        //封装列表数据
        //定义封装笔记列表vo
        List<ArticleListVO> articleListVOList = new ArrayList<>();
        new ArrayList<>(3);
        for (Article record : articlePage.getRecords()) {
            //封装数据
            ArticleListVO articleListVO = new ArticleListVO();
            BeanUtils.copyProperties(record, articleListVO);
            articleListVO.setTags(lastArticleTagMap.getOrDefault(record.getId(),new ArrayList<>()));
            articleListVO.setUser(userMap.get(record.getUserId()));
            articleListVO.setCommentCount(commentMap.get(record.getId()));
            articleListVOList.add(articleListVO);
        }
        return articleListVOList;

    }
}




