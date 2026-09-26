package com.codemind.knowledge.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.ai.entity.search.SearchNote;
import com.codemind.ai.entity.search.UserSearchNote;
import com.codemind.ai.vo.SearchNoteData;
import com.codemind.common.Result;
import com.codemind.knowledge.dto.NoteDTO;
import com.codemind.knowledge.dto.UpdateNoteVisibilityDTO;
import com.codemind.knowledge.entity.Note;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.knowledge.vo.CheckNoteVO;
import com.codemind.knowledge.vo.NoteListVO;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

/**
* @author wengjiaran
* @description 针对表【note(笔记表)】的数据库操作Service
* @createDate 2026-08-07 20:20:54
*/
public interface NoteService extends IService<Note> {
    //创建笔记
    Result<Long> createNote(NoteDTO noteDTO, MultipartFile file) throws Exception;
    //更新笔记
    Result<Boolean> updateNote(Long noteId, NoteDTO noteDTO, MultipartFile file) throws Exception;
    //删除笔记
    Result<Void> deleteNote(Long noteId);
    //获取笔记详情
    Result<CheckNoteVO> getNote(Long noteId);
    //笔记列表
    Result<Page<NoteListVO>> getNoteList(Integer page , Integer size,Long categoryId, Integer visibility, Integer status, String keyword);
    //切换笔记可见性
    Result<Void> updateNoteVisibility(UpdateNoteVisibilityDTO updateNoteVisibilityDTO, Long noteId);
    //为笔记添加标签
    Result<Void> addNoteTags(Long noteId, List<Long> tagIds);
    //tool根据用户信息查询笔记列表
    List<SearchNoteData> queryNoteList(SearchNote searchNote);
    //tool用户自己的笔记
    List<SearchNoteData> MyQueryNoteList(UserSearchNote userSearchNote);
}
