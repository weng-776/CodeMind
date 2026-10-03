package com.codemind.admin.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.codemind.admin.service.AdminDashboardService;
import com.codemind.admin.vo.DashboardOverviewVO;
import com.codemind.common.Result;
import com.codemind.community.entity.Article;
import com.codemind.community.entity.ArticleLike;
import com.codemind.community.entity.Comment;
import com.codemind.community.entity.Favorite;
import com.codemind.community.service.ArticleLikeService;
import com.codemind.community.service.ArticleService;
import com.codemind.community.service.CommentService;
import com.codemind.community.service.FavoriteService;
import com.codemind.knowledge.entity.Note;
import com.codemind.knowledge.service.NoteService;
import com.codemind.user.entity.User;
import com.codemind.user.service.UserService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Date;

@Service
public class AdminDashboardServiceImpl implements AdminDashboardService {

    /**
     * 业务时区钉死 GMT+8。
     *
     * <p>为什么不用 {@code ZoneId.systemDefault()}：本项目的时区是<b>写死在配置里的</b> ——
     * {@code application.yml} 的 {@code spring.jackson.time-zone: GMT+8}、
     * JDBC 串的 {@code serverTimezone=GMT+8}。如果这里跟着 JVM 走，
     * 一旦部署机器的默认时区不是东八区（容器里很常见是 UTC），
     * 「今日新增」就会整体偏移 8 小时 —— 而库里存的时间仍然是 GMT+8，两边对不上。
     * 所以这里跟配置保持一致，而不是跟 JVM 保持一致。
     */
    private static final ZoneId BIZ_ZONE = ZoneId.of("GMT+8");

    @Autowired
    private UserService userService;
    @Autowired
    private ArticleService articleService;
    @Autowired
    private NoteService noteService;
    @Autowired
    private CommentService commentService;
    @Autowired
    private ArticleLikeService articleLikeService;
    @Autowired
    private FavoriteService favoriteService;

    @Override
    public Result<DashboardOverviewVO> overview() {
        // 今天 00:00（东八区）
        Date todayStart = Date.from(LocalDate.now(BIZ_ZONE).atStartOfDay(BIZ_ZONE).toInstant());

        DashboardOverviewVO vo = new DashboardOverviewVO();

        // ---- 总数 ----
        // count() 不带条件；带 @TableLogic 的实体会被自动补上 is_delete = 0
        vo.setUserCount(userService.count());
        vo.setArticleCount(articleService.count());
        vo.setNoteCount(noteService.count());
        vo.setCommentCount(commentService.count());
        vo.setLikeCount(articleLikeService.count());
        vo.setFavoriteCount(favoriteService.count());

        // ---- 今日新增 ----
        // 用 ge(createTime, todayStart) 而不是 DATE(create_time) = CURDATE()：
        // 后者对列套函数会让索引失效，且时区由数据库决定、和上面的口径可能不一致
        vo.setTodayUserCount(userService.count(
                new LambdaQueryWrapper<User>().ge(User::getCreateTime, todayStart)));
        vo.setTodayArticleCount(articleService.count(
                new LambdaQueryWrapper<Article>().ge(Article::getCreateTime, todayStart)));
        vo.setTodayNoteCount(noteService.count(
                new LambdaQueryWrapper<Note>().ge(Note::getCreateTime, todayStart)));
        vo.setTodayCommentCount(commentService.count(
                new LambdaQueryWrapper<Comment>().ge(Comment::getCreateTime, todayStart)));
        vo.setTodayLikeCount(articleLikeService.count(
                new LambdaQueryWrapper<ArticleLike>().ge(ArticleLike::getCreateTime, todayStart)));
        vo.setTodayFavoriteCount(favoriteService.count(
                new LambdaQueryWrapper<Favorite>().ge(Favorite::getCreateTime, todayStart)));

        return Result.success(vo);
    }
}
