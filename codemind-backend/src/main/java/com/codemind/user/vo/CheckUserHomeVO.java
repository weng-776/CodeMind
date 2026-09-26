package com.codemind.user.vo;

import lombok.Data;

@Data
public class CheckUserHomeVO {
    private Long id;
    private String userName;
    private String avatar;
    private String intro;
    private Integer fansCount;
    private Integer followCount;
    private Integer noteCount;
    private Integer articleCount;
    private Boolean isFollow;
}
