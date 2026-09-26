package com.codemind.knowledge.vo;

import lombok.Data;

import java.time.LocalDateTime;
import java.util.Date;
import java.util.List;
@Data
public class CheckNoteVO {
   private Long id;
   private UserVO user;
   private String title;
   private String content;
   private String summary;
   private String cover;
   private CategoryVO category;
   private List<TagVO> tags;
   private Integer visibility;
   private Integer status;
   private Integer wordCount;
   private Date createTime;
   private Date updateTime;
}

