package com.codemind.knowledge.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

/**
 * @TableName note_tag
 */
@TableName(value ="note_tag")
@Data
public class NoteTag {
    @TableId(value = "id",type =  IdType.AUTO)
    private Long id;

    private Long noteId;

    private Long tagId;
}