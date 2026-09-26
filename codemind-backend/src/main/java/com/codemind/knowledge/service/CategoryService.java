package com.codemind.knowledge.service;

import com.codemind.common.Result;
import com.codemind.knowledge.dto.CreateCategoryDTO;
import com.codemind.knowledge.dto.UpdateCategoryDTO;
import com.codemind.knowledge.entity.Category;
import com.baomidou.mybatisplus.extension.service.IService;
import com.codemind.knowledge.vo.CategoryTreeVO;
import jakarta.validation.Valid;

import java.util.List;

/**
* @author wengjiaran
* @description 针对表【category(分类表)】的数据库操作Service
* @createDate 2026-08-07 20:20:54
*/
public interface CategoryService extends IService<Category> {
    //创建分类
    Result<Long> createCategory(@Valid CreateCategoryDTO createCategoryDTO);
    //修改分类
    Result<Void> updateCategory(Long categoryId, @Valid UpdateCategoryDTO updateCategoryDTO);
    //删除分类
    Result<Void> deleteCategory(Long categoryId);
    //获取分类树
    Result<List<CategoryTreeVO>> getCategoryTree();

}
