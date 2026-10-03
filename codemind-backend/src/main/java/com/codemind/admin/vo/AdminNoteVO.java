package com.codemind.admin.vo;

import com.codemind.community.vo.UserSimpleVO;
import lombok.Data;

import java.util.Date;

/**
 * 管理端-笔记列表项（同样不含 content）。
 */
@Data
public class AdminNoteVO {

    private Long id;

    private Long userId;

    private UserSimpleVO author;

    private Long categoryId;

    private String title;

    private String summary;

    private String cover;

    /** 可见性：0=私密 1=公开（见 NoteConstants.NOTE_VISIBILITY_*） */
    private Integer visibility;

    /** 状态：0=草稿 1=正常（见 NoteConstants.NOTE_STATUS_*） */
    private Integer status;

    private Integer wordCount;

    private Long viewCount;

    private Date createTime;
}
