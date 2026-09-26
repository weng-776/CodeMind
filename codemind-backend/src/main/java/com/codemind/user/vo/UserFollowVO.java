package com.codemind.user.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.Date;

/**
 * 用户关注列表VO
 * 用于返回当前用户关注的人信息
 */
@Data
@Schema(description = "用户关注列表返回对象")
public class UserFollowVO {


    @Schema(description = "用户ID")
    private Long id;


    @Schema(description = "用户名")
    private String userName;


    @Schema(description = "用户头像")
    private String avatar;


    @Schema(description = "个人简介")
    private String intro;


    @Schema(description = "粉丝数量")
    private Integer fansCount;


    @Schema(description = "关注数量")
    private Integer followCount;


    @Schema(description = "文章数量")
    private Integer articleCount;


    @Schema(description = "创建时间")
    private Date createTime;

}