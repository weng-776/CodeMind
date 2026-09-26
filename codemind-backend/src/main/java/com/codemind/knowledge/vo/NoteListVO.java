package com.codemind.knowledge.vo;

import lombok.Data;

import java.util.Date;
import java.util.List;
@Data
public class NoteListVO {
    private Long id;
    private String title;
    private String summary;
    private String cover;
    private String categoryName;
    private List<TagVO> tags;
    private Integer visibility;
    private Integer status;
    private Integer wordCount;
    private Date createTime;
    private Date updateTime;

}
