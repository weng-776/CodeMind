package com.codemind.knowledge.vo;

import lombok.Data;

// vo/UserVO.java —— 作者信息，文章详情也能复用
@Data
public class UserVO {
    private Long id;
    private String userName;
    private String avatar;
}