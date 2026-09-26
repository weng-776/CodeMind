package com.codemind.knowledge.controller;

import com.codemind.common.Result;
import com.codemind.knowledge.dto.CreateCategoryDTO;
import com.codemind.knowledge.dto.UpdateCategoryDTO;
import com.codemind.knowledge.service.CategoryService;
import com.codemind.knowledge.vo.CategoryTreeVO;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.List;

//分类相关controller
@RequestMapping("/api/category")
@RestController
@CrossOrigin
public class CategoryController {
    @Autowired
    CategoryService categoryService;

    @PostMapping("createCategory")
    public Result<Long> createCategory(@Valid @RequestBody CreateCategoryDTO createCategoryDTO){
        return categoryService.createCategory(createCategoryDTO);
    }
    @PutMapping("{categoryId}")
    public Result<Void> updateCategory(@PathVariable(value = "categoryId") Long categoryId,
                                       @Valid @RequestBody UpdateCategoryDTO updateCategoryDTO){

        return categoryService.updateCategory(categoryId,updateCategoryDTO);
    }
    @DeleteMapping("{categoryId}")
    public Result<Void> deleteCategory(@PathVariable(value = "categoryId") Long categoryId){
        return categoryService.deleteCategory(categoryId);
    }
    //获取分类树
    @GetMapping("tree")
    public Result<List<CategoryTreeVO>> getCategoryTree(){
        return categoryService.getCategoryTree();
    }


}
