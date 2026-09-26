package com.codemind.knowledge.mapper;

import com.codemind.ai.entity.search.SearchNote;
import com.codemind.ai.entity.search.UserSearchNote;
import com.codemind.ai.vo.SearchNoteData;
import com.codemind.knowledge.entity.Note;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;

import java.util.List;

/**
* @author wengjiaran
* @description 针对表【note(笔记表)】的数据库操作Mapper
* @createDate 2026-08-07 20:20:54
* @Entity com.codemind.knowledge.entity.Note
*/
public interface NoteMapper extends BaseMapper<Note> {

    List<SearchNoteData> queryNoteList(SearchNote searchNote);
    //用户自己的笔记
    List<SearchNoteData> myQueryNoteList(UserSearchNote userSearchNote);

    List<SearchNoteData> linkNote(List<String> listName, Integer limit);
}




