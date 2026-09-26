package com.codemind.ai.vo;

import com.codemind.knowledge.vo.TagVO;
import lombok.Data;

import java.util.Date;
import java.util.List;
@Data
public class SearchNoteData {
    private Long id;
    private String title;
    private String author;
    private String summary;
    private String categoryName;
    private Integer wordCount;
    private Date createTime;
}
