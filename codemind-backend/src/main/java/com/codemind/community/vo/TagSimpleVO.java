package com.codemind.community.vo;

import lombok.Data;

/**
 * 标签简要信息 VO
 */
@Data
public class TagSimpleVO {

    /**
     * 标签ID
     */
    private Long id;

    /**
     * 标签名称
     */
    private String name;
}