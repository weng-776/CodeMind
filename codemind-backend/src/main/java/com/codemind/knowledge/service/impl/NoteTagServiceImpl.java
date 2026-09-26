package com.codemind.knowledge.service.impl;

import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.knowledge.entity.NoteTag;
import com.codemind.knowledge.service.NoteTagService;
import com.codemind.knowledge.mapper.NoteTagMapper;
import org.springframework.stereotype.Service;

/**
* @author wengjiaran
* @description 针对表【note_tag(笔记标签关联表)】的数据库操作Service实现
* @createDate 2026-08-07 20:20:54
*/
@Service
public class NoteTagServiceImpl extends ServiceImpl<NoteTagMapper, NoteTag>
    implements NoteTagService{

}




