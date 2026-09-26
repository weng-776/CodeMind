package com.codemind.knowledge.controller;

import com.codemind.common.Result;
import com.codemind.knowledge.service.TagService;
import com.codemind.knowledge.vo.TagListVO;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RequestMapping("/api/tag")
@RestController
@CrossOrigin
public class TagController {

    @Autowired
    private TagService tagService;
    @GetMapping("list")
    public Result<List<TagListVO>> tagList(@RequestParam(value = "keyword",required = false) String keyword){
       return tagService.tagList(keyword);

    }
}
