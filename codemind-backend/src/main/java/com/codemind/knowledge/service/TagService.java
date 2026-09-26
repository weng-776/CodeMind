package com.codemind.knowledge.service;

import com.codemind.common.Result;
import com.codemind.knowledge.entity.Tag;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.knowledge.vo.TagListVO;

import java.util.List;

/**
* @author wengjiaran
* @description 针对表【tag(标签表)】的数据库操作Service
* @createDate 2026-08-07 20:20:54
*/
public interface TagService extends IService<Tag> {

    Result<List<TagListVO>> tagList(String keyword);
}
