package com.codemind.knowledge.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.codemind.common.Result;
import com.codemind.knowledge.dto.AddNoteTagsDTO;

import com.codemind.knowledge.dto.NoteDTO;
import com.codemind.knowledge.dto.UpdateNoteVisibilityDTO;
import com.codemind.knowledge.service.NoteService;
import com.codemind.knowledge.vo.CheckNoteVO;
import com.codemind.knowledge.vo.NoteListVO;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.nio.file.Path;

//笔记相关controller
@RestController
@RequestMapping("/api/note")
@CrossOrigin
@Validated
public class NoteController {
    @Autowired
    private NoteService noteService;
    //创建笔记
    @PostMapping("createNote")
    public Result<Long> createNote(@Valid NoteDTO noteDTO
            , @RequestParam(value = "file", required = false) MultipartFile file) throws Exception {

        return noteService.createNote(noteDTO,file);

    }


    //编辑笔记
    @PutMapping("{noteId}")
    public Result<Boolean> updateNote(@PathVariable Long noteId , @Valid NoteDTO noteDTO
            , @RequestParam(value = "file", required = false) MultipartFile file) throws Exception {

        return noteService.updateNote(noteId,noteDTO,file);

    }
    //删除笔记
    @DeleteMapping("{noteId}")
    public  Result<Void> deleteNote(@PathVariable Long noteId)  {

        return noteService.deleteNote(noteId);
    }
    //获取笔记详情
    @GetMapping("{noteId}")
    public Result<CheckNoteVO> getNote(@PathVariable Long noteId){

        return noteService.getNote(noteId);
    }
    //获取笔记列表
    @GetMapping("/list")
    public Result<Page<NoteListVO>> getNoteList(@RequestParam(defaultValue = "1") @Min(value = 1, message = "页码不能小于 1") Integer page,
                                                @RequestParam(defaultValue = "10") @Max(value = 50, message = "每页条数不能超过 50") Integer size,
                                                @RequestParam(value = "categoryId",required = false) Long categoryId,
                                                @RequestParam(value = "visibility", required = false)  Integer visibility,
                                                @RequestParam(value = "status", required = false)Integer status,
                                                @RequestParam(value = "keyword", required = false)String keyword){

        return noteService.getNoteList(page,size,categoryId,visibility,status,keyword);

    }
    //更改笔记状态
    @PutMapping("{noteId}/visibility")
    public Result<Void> updateNoteVisibility(@Valid @RequestBody UpdateNoteVisibilityDTO updateNoteVisibilityDTO
            ,@PathVariable(value = "noteId") Long noteId ){

        return noteService.updateNoteVisibility(updateNoteVisibilityDTO,noteId);
    }
    //为笔记添加标签(会替换已有标签)
    @PostMapping("{noteId}/tag")
    public Result<Void> addNoteTags(@PathVariable(value = "noteId") Long noteId
            , @RequestBody AddNoteTagsDTO addNoteTagsDTO){

        return noteService.addNoteTags(noteId, addNoteTagsDTO.getTagIds());
    }
}
