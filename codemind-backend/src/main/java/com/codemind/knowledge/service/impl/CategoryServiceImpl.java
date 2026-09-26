package com.codemind.knowledge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.common.Result;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.knowledge.dto.CreateCategoryDTO;
import com.codemind.knowledge.dto.UpdateCategoryDTO;
import com.codemind.knowledge.entity.Category;
import com.codemind.knowledge.entity.Note;
import com.codemind.knowledge.service.CategoryService;
import com.codemind.knowledge.mapper.CategoryMapper;
import com.codemind.knowledge.service.NoteService;
import com.codemind.knowledge.vo.CategoryTreeVO;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.ObjectUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
* @author wengjiaran
* @description 针对表【category(分类表)】的数据库操作Service实现
* @createDate 2026-08-07 20:20:54
*/
@Slf4j
@Service
public class CategoryServiceImpl extends ServiceImpl<CategoryMapper, Category>
    implements CategoryService{
    @Autowired
    private NoteService noteService;

    @Override
    public Result<Long> createCategory(CreateCategoryDTO createCategoryDTO) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //校验 parentId，为空视为顶级分类
        if (ObjectUtils.isEmpty(createCategoryDTO.getParentId())) {
            createCategoryDTO.setParentId(0L);
        }
        // 校验父分类归属：parentId 非 0 时，必须是自己拥有的分类
        // 之前完全不校验，传入别人的分类 id 也能创建成功，那条新分类会从自己的分类树里
        // 消失（建树按 user_id 过滤父节点），变成用户看不见也管不了的孤儿数据。
        // 注意这里要按「父分类自身的 id」查，而不是按 parent_id 查 —— 后者语义完全不同。
        Long parentId = createCategoryDTO.getParentId();
        if (parentId != 0L) {
            Category parentCategory = getById(parentId);
            if (parentCategory == null) {
                log.warn("父分类不存在 parentId={}", parentId);
                throw BusinessException.notFound("父分类不存在");
            }
            if (!userId.equals(parentCategory.getUserId())) {
                log.warn("无权使用该父分类 parentId={} userId={}", parentId, userId);
                throw BusinessException.forbidden("无权使用该父分类");
            }
        }
        //校验排序字段是否为空
        Integer sort = createCategoryDTO.getSort();
        if (ObjectUtils.isEmpty(sort)){
            //为空给默认值
            createCategoryDTO.setSort(0);
        }
        //相同分类不能重名
        //顶级分类也是

        long count = count(new LambdaQueryWrapper<Category>()
                .eq(Category::getParentId, createCategoryDTO.getParentId())
                .eq(Category::getUserId, userId)
                .eq(Category::getName, createCategoryDTO.getName()));
        if (count > 0){
            log.info("相同分类下不能有同名的分类");
            throw BusinessException.conflict("相同分类下不能有同名的分类");
        }

        //封装数据插入数据库
        Category category = new Category();
        BeanUtils.copyProperties(createCategoryDTO,category);
        category.setUserId(userId);
        //插入分类
        boolean save = save(category);
        if (!save) {
            log.error("创建分类失败");
            throw BusinessException.serverError("创建分类失败，请重试");
        }
        return Result.success(category.getId());
    }
    //修改分类接口
    @Override
    public Result<Void> updateCategory(Long categoryId, UpdateCategoryDTO updateCategoryDTO) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //获取相关分类校验用户id是否一致
        //存在性(404)与归属(403)分开报。原来用 Result.error 返回 404 并写成「笔记不存在」，
        //在分类接口里既串了文案，也没法把「不是自己的分类」表达成 403（BUG-06）
        Category category = getById(categoryId);
        if (category == null) {
            log.warn("分类不存在 categoryId={}", categoryId);
            throw BusinessException.notFound("分类不存在");
        }
        if (!userId.equals(category.getUserId())) {
            log.warn("无权修改该分类 categoryId={}", categoryId);
            throw BusinessException.forbidden("无权修改该分类");
        }
        //同一分类下不能有相同名字分类
        long count = count(new LambdaQueryWrapper<Category>()
                .eq(Category::getParentId, category.getParentId())
                .eq(Category::getUserId, userId)
                .eq(Category::getName, updateCategoryDTO.getName())
                .ne(Category::getId,categoryId));
        if (count > 0){
            log.info("相同分类下不能有同名的分类");
            throw BusinessException.conflict("相同分类下不能有同名的分类");
        }

        LambdaUpdateWrapper<Category> wrapper = new LambdaUpdateWrapper<Category>().eq(Category::getId, categoryId)
                .eq(Category::getUserId, userId)
                .set(Category::getName, updateCategoryDTO.getName());
        //校验sort是否为空如果不为空更新为空保持默认
        if (!ObjectUtils.isEmpty(updateCategoryDTO.getSort())){
            wrapper.set(Category::getSort, updateCategoryDTO.getSort());
        }
        update(wrapper);
        //返回
        return Result.success("操作成功");
    }

    @Transactional(rollbackFor = Exception.class)
    @Override
    public Result<Void> deleteCategory(Long categoryId) {
        Long userId = UserContext.getUserId();

        // ② 先校验分类是否存在，再校验归属。
        //    合并成一次查询的话，「分类不存在」和「删别人的分类」会返回同一句话，给不出 404 / 403 的区分（BUG-06）
        Category category = getById(categoryId);
        if (category == null) {
            log.warn("分类不存在 categoryId={}", categoryId);
            throw BusinessException.notFound("分类不存在");
        }
        if (!userId.equals(category.getUserId())) {
            log.warn("无权删除该分类 categoryId={}", categoryId);
            throw BusinessException.forbidden("无权删除该分类");
        }

        // ③ 处理该分类下的笔记：迁移到父分类（如果父分类存在且属于当前用户），否则置空
        Long targetCategoryId = category.getParentId();   // 父分类 id，可能为 null

        // 如果父分类不为 null，需要校验父分类是否存在且属于当前用户
        if (targetCategoryId != null) {
            Category parentCategory = getOne(new LambdaQueryWrapper<Category>()
                    .eq(Category::getId, targetCategoryId)
                    .eq(Category::getUserId, userId));
            if (parentCategory == null) {
                // 父分类不存在或不属于当前用户，保险起见置空
                targetCategoryId = null;
            }
        }

        // 更新笔记分类：将 category_id 改为 targetCategoryId（可能为 null）
        // 注意：不依赖 update 返回值判断是否成功，因为 0 行也是正常情况（该分类下没有笔记）
        noteService.update(new LambdaUpdateWrapper<Note>()
                .eq(Note::getCategoryId, categoryId)
                .eq(Note::getUserId, userId)          // 只操作当前用户的笔记，防止越权
                .set(Note::getCategoryId, targetCategoryId));

        // 方案 A：将子分类提升一级（挂到当前分类的父分类下）
        // 这样可以避免孤儿分类，且不需要递归删除
        if (targetCategoryId != null || category.getParentId() != null) {
            // 其实无论父分类是否存在，都可以把子分类的 parent_id 改为当前分类的 parent_id
            // 如果当前分类是根分类，parent_id 为 null，子分类也变成根分类
            update(new LambdaUpdateWrapper<Category>()
                    .eq(Category::getParentId, categoryId)
                    .eq(Category::getUserId, userId)
                    .set(Category::getParentId, category.getParentId()));
        }

        // ⑤ 最后删除分类本身
        boolean removed = remove(new LambdaQueryWrapper<Category>()
                .eq(Category::getId, categoryId)
                .eq(Category::getUserId, userId));
        if (!removed) {
            // 前面已经校验过归属，这里删除失败说明并发或系统问题，抛异常回滚
            throw BusinessException.serverError("删除分类失败，请重试");
        }
        return Result.success("操作成功");
    }

    @Override
    public Result<List<CategoryTreeVO>> getCategoryTree() {
        //查询该用户的所有分类用排序字段升序排列值越小越靠前
        Long userId = UserContext.getUserId();
        LambdaQueryWrapper<Category> queryWrapper = new LambdaQueryWrapper<Category>().eq(Category::getUserId, userId).orderByAsc(Category::getSort);
        List<Category> categoryList = list(queryWrapper);
        //搞一个map key是父id 值是list<category> 一个父id可以有多个子id
        Map<Long, List<Category>> categoryMap = categoryList.stream()
                .collect(Collectors.groupingBy(Category::getParentId, Collectors.toList()));
        //过滤出根目录列表
        List<Category> rootCategory = categoryMap.get(0L);
        //最终结果返回列表
        List<CategoryTreeVO> categoryTreeVOList = new ArrayList<>();
        //根据根目录迭代在循环里面递归子目录
        if (!ObjectUtils.isEmpty(rootCategory)){
            for (Category category : rootCategory) {
                //递归中完成赋值
                CategoryTreeVO categoryTreeVO = buildTree(category,categoryMap);
                categoryTreeVOList.add(categoryTreeVO);
            }
        }

        //返回
        return Result.success(categoryTreeVOList);
    }
    //分类树递归赋值子分类
    private CategoryTreeVO buildTree(Category category, Map<Long, List<Category>> categoryMap) {
        CategoryTreeVO treeVO = new CategoryTreeVO();
        treeVO.setId(category.getId());
        treeVO.setName(category.getName());
        treeVO.setSort(category.getSort());
        //通过id获取子分类列表
        List<Category> categoryList = categoryMap.get(category.getId());
        if (!ObjectUtils.isEmpty(categoryList)){
            for (Category category1 : categoryList){
                //迭代找自己的孩子
                CategoryTreeVO vo = buildTree(category1, categoryMap);
                treeVO.getChildren().add(vo);
            }
        }
        return treeVO;
    }
}




