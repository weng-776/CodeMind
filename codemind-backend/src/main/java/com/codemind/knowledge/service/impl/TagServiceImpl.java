package com.codemind.knowledge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.common.Result;
import com.codemind.knowledge.entity.Tag;
import com.codemind.knowledge.service.TagService;
import com.codemind.knowledge.mapper.TagMapper;
import com.codemind.knowledge.vo.TagListVO;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;
import org.springframework.util.ObjectUtils;

import java.util.ArrayList;
import java.util.List;

/**
* @author wengjiaran
* @description 针对表【tag(标签表)】的数据库操作Service实现
* @createDate 2026-08-07 20:20:54
*/
@Service
public class TagServiceImpl extends ServiceImpl<TagMapper, Tag>
    implements TagService{

    @Override
    public Result<List<TagListVO>> tagList(String keyword) {
        LambdaQueryWrapper<Tag> wrapper = new LambdaQueryWrapper<Tag>()
                .like(!ObjectUtils.isEmpty(keyword), Tag::getName, keyword);
        List<Tag> tagList = list(wrapper);
        List<TagListVO> tagListVOList = new ArrayList<>();
        //封装返回
        if (!ObjectUtils.isEmpty(tagList)) {
            tagList.forEach(tag->{
                TagListVO tagListVO = new TagListVO();
                BeanUtils.copyProperties(tag,tagListVO);
                tagListVOList.add(tagListVO);
            });
        }

        return Result.success(tagListVOList);
    }
}




