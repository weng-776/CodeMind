package com.codemind.knowledge.service.impl;

import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.ai.entity.search.SearchNote;
import com.codemind.ai.entity.search.UserSearchNote;
import com.codemind.ai.rag.dto.RagMessageDTO;
import com.codemind.ai.vo.SearchNoteData;
import com.codemind.common.NoteConstants;
import com.codemind.common.RagConstants;
import com.codemind.common.Result;
import com.codemind.community.entity.Article;
import com.codemind.config.RabbitConfig;
import com.codemind.context.UserContext;

import com.codemind.exceptionhandler.BusinessException;
import com.codemind.knowledge.dto.NoteDTO;
import com.codemind.knowledge.dto.UpdateNoteVisibilityDTO;
import com.codemind.knowledge.entity.Category;
import com.codemind.knowledge.entity.Note;
import com.codemind.knowledge.entity.NoteTag;
import com.codemind.knowledge.entity.Tag;
import com.codemind.knowledge.mapper.CategoryMapper;
import com.codemind.knowledge.mapper.TagMapper;
import com.codemind.knowledge.service.NoteService;
import com.codemind.knowledge.mapper.NoteMapper;
import com.codemind.knowledge.service.NoteTagService;
import com.codemind.knowledge.vo.*;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.UserMapper;
import com.codemind.utils.FileUploadService;
import com.codemind.utils.NoteWordCount;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.CollectionUtils;
import org.springframework.util.ObjectUtils;
import org.springframework.web.multipart.MultipartFile;
import java.util.*;
import java.util.stream.Collectors;

/**
* @author wengjiaran
* @description 针对表【note(笔记表)】的数据库操作Service实现
* @createDate 2026-08-07 20:20:54
*/
@Service
@Slf4j
public class NoteServiceImpl extends ServiceImpl<NoteMapper, Note>
    implements NoteService{

    @Autowired
    private FileUploadService fileUploadService;
    @Autowired
   private NoteTagService noteTagService;
    @Autowired
   private CategoryMapper categoryMapper;
    @Autowired
   private UserMapper userMapper;
    @Autowired
   private TagMapper tagMapper;
    @Autowired
   private NoteMapper noteMapper;
    @Autowired
    private RabbitTemplate rabbitTemplate;
    //创建笔记
    @Transactional(rollbackFor = Exception.class)
    @Override
    public Result<Long> createNote(NoteDTO noteDTO, MultipartFile file) throws Exception {
        //判断标题跟内容是否为空 为空返回笔记不能为空
        // 2026-09-23 修正文案：原来三个字段共用一句「标题笔记分类内容不能为空」，
        // 既没有分隔符、读不通，也看不出到底缺哪个
        if (ObjectUtils.isEmpty(noteDTO.getTitle()) || ObjectUtils.isEmpty(noteDTO.getContent()) || ObjectUtils.isEmpty(noteDTO.getCategoryId())) {
            log.error("标题、内容与笔记分类都不能为空");
            throw BusinessException.badRequest("标题、内容与笔记分类都不能为空");
        }
        //拿到用户id
        Long userId = UserContext.getUserId();
        Note note = new Note();
        //根据带来的分类id与userid 查询分类表拿到该分类的父分类id
        //存在性(404)与归属(403)分开报：原来带 userId 一起查，两种情况共用一句「不存在或无权限访问」（BUG-06）
        Category category = categoryMapper.selectById(noteDTO.getCategoryId());
        if (category == null) {
            log.warn("分类不存在 categoryId={}", noteDTO.getCategoryId());
            throw BusinessException.notFound("选中的分类不存在");
        }
        if (!userId.equals(category.getUserId())) {
            log.warn("无权使用该分类 categoryId={}", noteDTO.getCategoryId());
            throw BusinessException.forbidden("无权使用该分类");
        }
        //根据父分类id获取它所有子分类id
        List<Integer> categoryListId = categoryMapper.selectMaps(new LambdaQueryWrapper<Category>()
                .select(Category::getId)
                .eq(Category::getParentId, category.getParentId()).eq(Category::getUserId, userId))
                .stream().map(t -> ((Number) t.get("id")).intValue()).collect(Collectors.toList());
        //子分类id查询出对应的笔记
        if (!ObjectUtils.isEmpty(categoryListId)) {
            // 5. 校验是否有同名笔记：同一同级分类下 + 相同标题 + 排除当前笔记自身+同一个用户
            long count = count(new LambdaQueryWrapper<Note>()
                    .in(Note::getCategoryId, categoryListId)
                    .eq(Note::getTitle, noteDTO.getTitle())
                    .eq(Note::getUserId, userId));

            if (count > 0) {
                throw BusinessException.conflict("相同分类下不能有同名的笔记");
            }

        }

        //判断封面图片类型
        //判断是否有封面
        String url = "";
        if (file != null && !file.isEmpty()) {
            if (ObjectUtils.isEmpty(file.getContentType()) || !file.getContentType().startsWith("image")) {

                throw BusinessException.badRequest("封面图只能上传图片文件");
            }
            url = fileUploadService.uploadFile(NoteConstants.NOTE_COVER, file);
        }
        note.setCover(url);
       //统计字数
        int wordCount = NoteWordCount.getWordCount(noteDTO.getContent());
        //插入笔记数据库
        BeanUtils.copyProperties(noteDTO,note);
        //copyProperties 会把源对象的 null 一并覆盖过来，上面 set 好的字段要重新兜底
        if (ObjectUtils.isEmpty(note.getCover())) {
            note.setCover(url);
        }
        //可见性与状态必须兜底，否则后续拆箱比较会 NPE；缺省视为私密 + 正常
        if (ObjectUtils.isEmpty(note.getVisibility())) {
            note.setVisibility(NoteConstants.NOTE_VISIBILITY_PRIVATE);
        }
        if (ObjectUtils.isEmpty(note.getStatus())) {
            note.setStatus(NoteConstants.NOTE_STATUS_NORMAL);
        }
        note.setUserId(userId);
        note.setWordCount(wordCount);
        note.setViewCount(0L); //创建默认0
        //判断是否写有摘要
        if (ObjectUtils.isEmpty(noteDTO.getSummary())) {
            String content = note.getContent();
            // 按 Unicode 码点截断前 20 个字符，避免切断 emoji 等代理对
            String summary = content.codePoints()
                    .limit(20)
                    .collect(
                            () -> new StringBuilder(),                          // 创建容器
                            (sb, codePoint) -> sb.appendCodePoint(codePoint),   // 把每个码点加进去
                            (sb1, sb2) -> sb1.append(sb2)                       // 合并容器（并行流时用）
                    )
                    .toString();
            note.setSummary(summary);
        }
        //拿到笔记id
        save(note);
        //公开笔记通过mq发送给rag向量化
        if (note.getVisibility() == 1 && note.getStatus() == 1){
            ragVectorNote(note);
        }
        //为空返回
        if (ObjectUtils.isEmpty(noteDTO.getTagIds())){
            return Result.success(note.getId());
        }
        //根据标签id跟笔记id插入标签关联表
        List<NoteTag> noteTagList = noteDTO.getTagIds().stream().distinct().map(t -> {
            NoteTag noteTag = new NoteTag();
            noteTag.setNoteId(note.getId());
            noteTag.setTagId(t);
            return noteTag;
        }).collect(Collectors.toList()); //需要去重否则重复数据库撞唯一索引DuplicateKeyException 500

        noteTagService.saveBatch(noteTagList);
        //响应返回
        return  Result.success(note.getId());
    }

    //把笔记通过mq发送到消息队列异步处理。文章向量化存入向量数据库方法
    private void ragVectorNote(Note note){
        RagMessageDTO messageDTO = new RagMessageDTO();
        //转json风封装数据发到mq
        String json = JSONUtil.toJsonStr(note);
        messageDTO.setJson(json);
        messageDTO.setType(RagConstants.VECTOR_NOTE_TYPE);
        messageDTO.setOperation(RagConstants.OPERATION_CREATE);
        messageDTO.setUuid(UUID.randomUUID().toString());
        rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE,"rag",messageDTO);
    }

    @Transactional(rollbackFor = Exception.class)
    @Override
    public Result<Boolean> updateNote(Long noteId, NoteDTO noteDTO, MultipartFile file) throws Exception {

        //判断标题跟内容是否为空 为空返回笔记不能为空
        // 2026-09-23 修正文案：条件里也判了 categoryId，原文案却只说「标题跟笔记内容」，与实际校验不符
        if (ObjectUtils.isEmpty(noteDTO.getTitle()) || ObjectUtils.isEmpty(noteDTO.getContent()) || ObjectUtils.isEmpty(noteDTO.getCategoryId())) {
            log.error("标题、内容与笔记分类都不能为空");
            throw BusinessException.badRequest("标题、内容与笔记分类都不能为空");
        }
        // 1. 拿到用户 id
        Long userId = UserContext.getUserId();

        // 2. 先查存在性(404)，再查归属(403)。
        //    原来合并成一次带 userId 的查询，「笔记不存在」和「不是自己的笔记」返回同一句话，
        //    前端既区分不了，也没法做不同的引导（BUG-06）
        Note note = getById(noteId);
        if (note == null) {
            log.warn("笔记不存在 noteId={}", noteId);
            throw BusinessException.notFound("笔记不存在");
        }
        if (!userId.equals(note.getUserId())) {
            log.warn("无权修改该笔记 noteId={}", noteId);
            throw BusinessException.forbidden("无权修改该笔记");
        }

        // 3. 查询当前笔记所属分类。存在性(404)与归属(403)分开报：
        //    原来用带 userId 的一次查询，「分类不存在」和「用了别人的分类」共用一句「不存在或无权操作」（BUG-06）
        Category category = categoryMapper.selectById(noteDTO.getCategoryId());
        if (category == null) {
            log.warn("分类不存在 categoryId={}", noteDTO.getCategoryId());
            throw BusinessException.notFound("分类不存在");
        }
        if (!userId.equals(category.getUserId())) {
            log.warn("无权使用该分类 categoryId={}", noteDTO.getCategoryId());
            throw BusinessException.forbidden("无权使用该分类");
        }

        // 4. 查询同级分类 ID 列表 (包含当前分类及其兄弟分类)
        List<Long> categoryIds = categoryMapper.selectObjs(new LambdaQueryWrapper<Category>()
                        .select(Category::getId)
                        .eq(Category::getParentId, category.getParentId())
                        .eq(Category::getUserId, userId))
                .stream()
                .map(obj -> (Long) obj)
                .collect(Collectors.toList());

        if (!CollectionUtils.isEmpty(categoryIds)) {
            // 5. 校验是否有同名笔记：同一同级分类下 + 相同标题 + 排除当前笔记自身
            long count = count(new LambdaQueryWrapper<Note>()
                    .in(Note::getCategoryId, categoryIds)
                    .eq(Note::getTitle, noteDTO.getTitle())
                    .eq(Note::getUserId, userId)
                    .ne(Note::getId, noteId)); //关键点：排除当前笔记自身！

            if (count > 0) {
                throw BusinessException.conflict("相同分类下不能有同名的笔记");
            }
        }

        //判断封面图片类型
        //判断是否有封面
        String url = note.getCover();

        if (file != null && !file.isEmpty()) {
            // 1. 文件大小校验，最大 2MB
            if (file.getSize() > 2 * 1024 * 1024) {
                throw BusinessException.badRequest("封面大小不能超过2MB");
            }
            // 2. 文件后缀校验
            String originalFilename = file.getOriginalFilename();
            if (ObjectUtils.isEmpty(originalFilename)) {
                throw BusinessException.badRequest("封面文件名不能为空");
            }

            String suffix = originalFilename.substring(
                    originalFilename.lastIndexOf(".") + 1
            ).toLowerCase();
            if (!Arrays.asList("jpg", "jpeg", "png", "webp").contains(suffix)) {
                throw BusinessException.badRequest("封面只支持 jpg、jpeg、png、webp 格式");
            }
            // 3. Content-Type 校验
            String contentType = file.getContentType();
            if (ObjectUtils.isEmpty(contentType)
                    || !Arrays.asList("image/jpeg", "image/png", "image/webp")
                    .contains(contentType)) {
                throw BusinessException.badRequest("封面格式不正确");
            }
            //删除旧图片
            if (url != null){
                fileUploadService.deleteFile(url);
            }
            // 4. 上传
            url = fileUploadService.uploadFile(NoteConstants.NOTE_COVER, file);
        }
        //复制数据
        BeanUtils.copyProperties(noteDTO,note);
        //可见性与状态必须兜底，否则后续拆箱比较会 NPE；缺省视为私密 + 正常
        note.setVisibility(noteDTO.getVisibility() == 1 ?
                NoteConstants.NOTE_VISIBILITY_PUBLIC : NoteConstants.NOTE_VISIBILITY_PRIVATE);

        note.setStatus(noteDTO.getStatus() == 1 ?
                NoteConstants.NOTE_STATUS_NORMAL : NoteConstants.NOTE_STATUS_DRAFT);
        note.setCover(url);
        //统计字数
        int wordCount = NoteWordCount.getWordCount(noteDTO.getContent());
        note.setWordCount(wordCount);
        //更新时间
        note.setUpdateTime(new Date());
        //判断是否写有摘要
        if (ObjectUtils.isEmpty(noteDTO.getSummary())) {
            String content = note.getContent();
            // 按 Unicode 码点截断前 20 个字符，避免切断 emoji 等代理对
            String summary = content.codePoints()
                    .limit(20)
                    .collect(
                            () -> new StringBuilder(),                          // 创建容器
                            (sb, codePoint) -> sb.appendCodePoint(codePoint),   // 把每个码点加进去
                            (sb1, sb2) -> sb1.append(sb2)                       // 合并容器（并行流时用）
                    )
                    .toString();
            note.setSummary(summary);
        }
        //更新笔记
        boolean update = update(note, new LambdaQueryWrapper<Note>().eq(Note::getUserId, userId).eq(Note::getId, noteId));
        if (!update){
            log.warn("更新失败");
            throw BusinessException.serverError("更新失败请重试");
        }
        //使用mq发送给rag向量化
        //获取更新内容
        Note argNote = getById(noteId);
        if (note.getVisibility() == 1){
            String jsonStr = JSONUtil.toJsonStr(argNote);
            argUpdateNode(jsonStr,RagConstants.OPERATION_UPDATE,noteId);
        }else {
            //隐私笔记直接发送mq异步删除向量数据库内容
            String jsonStr = JSONUtil.toJsonStr(argNote);
            argUpdateNode(jsonStr,RagConstants.OPERATION_DELETE,noteId);

        }

        //先删除笔记列表
        if (ObjectUtils.isEmpty(noteDTO.getTagIds())){
           //如果为空删除标签列表
            noteTagService.remove(new LambdaQueryWrapper<NoteTag>().eq(NoteTag::getNoteId, noteId));
            return  Result.success(true);
        }
        //先删除后更新
        noteTagService.remove(new LambdaQueryWrapper<NoteTag>().eq(NoteTag::getNoteId, noteId));
        List<NoteTag> noteTagList = noteDTO.getTagIds().stream().distinct().map(t -> {
            NoteTag noteTag = new NoteTag();
            noteTag.setNoteId(note.getId());
            noteTag.setTagId(t);
            return noteTag;
        }).collect(Collectors.toList());

        noteTagService.saveBatch(noteTagList);

        return  Result.success(true);
    }

    public void argUpdateNode(String json , String operation,Long noteId){
        RagMessageDTO messageDTO = new RagMessageDTO();
        messageDTO.setUuid(UUID.randomUUID().toString());
        messageDTO.setJson(json);
        messageDTO.setType(RagConstants.VECTOR_NOTE_TYPE);
        messageDTO.setOperation(operation);
        messageDTO.setNoteId(noteId);
        rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE,"rag.update.delete",messageDTO);

    }

    //删除笔记
    @Transactional(rollbackFor = Exception.class)
    @Override
    public Result<Void> deleteNote(Long noteId) {
        //先删除关联数据再删除本身数据
        //获取用户
        Long userId = UserContext.getUserId();
        //先查存在性再查归属：合并成一次查询的话，「笔记不存在」和「不是自己的笔记」会返回同一句话，前端无法区分
        Note note = getById(noteId);
        if (note == null) {
            log.warn("笔记不存在 noteId={}", noteId);
            throw BusinessException.notFound("笔记不存在");
        }
        if (!userId.equals(note.getUserId())) {
            log.warn("无权删除笔记 noteId={}", noteId);
            throw BusinessException.forbidden("无权删除该笔记");
        }

        noteTagService.remove(new LambdaQueryWrapper<NoteTag>().eq(NoteTag::getNoteId, noteId));

        //删除本身
        boolean removed = remove(new LambdaQueryWrapper<Note>().eq(Note::getUserId, userId).eq(Note::getId, noteId));
        if (!removed){
            log.warn("删除笔记失败");
            throw BusinessException.serverError("删除笔记失败，请重试");
        }

        //发送mq删除在向量数据库的笔记
        RagMessageDTO messageDTO = new RagMessageDTO();
        messageDTO.setType(RagConstants.VECTOR_NOTE_TYPE);
        messageDTO.setOperation(RagConstants.OPERATION_DELETE);
        messageDTO.setNoteId(noteId);
        messageDTO.setUuid(UUID.randomUUID().toString());
        rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE,"rag.update.delete",messageDTO);

        return Result.success("操作成功");
    }
    //查看笔记详情
    @Override
    public Result<CheckNoteVO> getNote(Long noteId) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //获取笔记表信息
        Note note = getById(noteId);
        if (ObjectUtils.isEmpty(note)){
            log.warn("没有相关笔记");
            throw BusinessException.notFound("未找到相关笔记");

        }
        //私密笔记只能作者自己看
        if (!note.getVisibility().equals(NoteConstants.NOTE_VISIBILITY_PUBLIC) && !Objects.equals(userId,note.getUserId())) {
            log.info("私密笔记只能作者自己看");
            throw BusinessException.forbidden("私密笔记只能作者自己看");
        }
        //草稿状态只能作者自己看
        if (!note.getStatus().equals(NoteConstants.NOTE_STATUS_NORMAL) && !Objects.equals(userId,note.getUserId())){
            log.info("草稿笔记只能作者自己看");
            throw BusinessException.forbidden("草稿笔记只能作者自己看");
        }
        //根据作者id查询作者信息
        User user = userMapper.selectById(note.getUserId());
        //响应信息复制到vo

        if (ObjectUtils.isEmpty(user)){
            throw BusinessException.notFound("没有找到相关作者的笔记");
        }
        UserVO userVO = new UserVO();
        BeanUtils.copyProperties(user,userVO);
        //根据笔记id查询标签关联表拿到标签id查询笔记相关id
        List<Long> tagIdList = noteTagService.listObjs(new LambdaQueryWrapper<NoteTag>()
                .select(NoteTag::getTagId).eq(NoteTag::getNoteId, noteId), obj -> (Long) obj);
        //如果不为封装数据
        List<TagVO> tagVOList = new ArrayList<>();
        if (!tagIdList.isEmpty()){
            List<Tag> tagList = tagMapper.selectList(new LambdaQueryWrapper<Tag>()
                     .select(Tag.class,info->!info.getColumn().equals("create_time")).in(Tag::getId, tagIdList));
            for (Tag tag : tagList) {
                TagVO tagVO = new TagVO();
                BeanUtils.copyProperties(tag,tagVO);
                tagVOList.add(tagVO);
            }
        }


        //根据分类id查询所属分类
        Category category = categoryMapper.selectOne(new LambdaQueryWrapper<Category>()
                .eq(Category::getId, note.getCategoryId()).eq(Category::getUserId, note.getUserId()));
        CategoryVO categoryVO = new CategoryVO();
        //分类可能已被删除（note.categoryId 为 null 或指向已删除分类），判空避免 copyProperties(null) NPE
        if (!ObjectUtils.isEmpty(category)) {
            BeanUtils.copyProperties(category, categoryVO);
        }
        //来一个用户需要增加一个访问量count的 后面做成缓存存入redis再异步更新数据库
        //先直接落库后面整合redis
        update(new LambdaUpdateWrapper<Note>()
                .eq(Note::getId, noteId)
                .setSql("view_count = view_count + 1"));
        //封装返回
        CheckNoteVO checkNoteVO = new CheckNoteVO();
        BeanUtils.copyProperties(note,checkNoteVO);
        checkNoteVO.setUser(userVO);
        checkNoteVO.setTags(tagVOList);
        checkNoteVO.setCategory(categoryVO);
        return Result.success(checkNoteVO);
    }
    //我的笔记列表
    @Override
    public Result<Page<NoteListVO>> getNoteList(Integer page, Integer size, Long categoryId, Integer visibility, Integer status, String keyword) {
        //获取当前用户id
        Long userId = UserContext.getUserId();
        //分页查询笔记表,根据条件查询
        LambdaQueryWrapper<Note> queryWrapper = new LambdaQueryWrapper<>();
        queryWrapper.eq(!ObjectUtils.isEmpty(categoryId), Note::getCategoryId, categoryId)
                .eq(!ObjectUtils.isEmpty(visibility), Note::getVisibility, visibility)
                .eq(!ObjectUtils.isEmpty(status), Note::getStatus, status)
                .eq(Note::getUserId, userId)
                .like(!ObjectUtils.isEmpty(keyword),Note::getTitle, keyword)
                .orderByDesc(Note::getCreateTime);
        //分页查询
        Page<Note> notePage = new Page<>(page,size);
        page(notePage,queryWrapper);
        //判断是否为空
        Page<NoteListVO> noteListVOPage = new Page<>(page,size);
        if (ObjectUtils.isEmpty(notePage.getRecords())){
            log.info("笔记列表为空");
            return  Result.success(noteListVOPage);
        }
        //根据分类id查询相关分类名称
        //分类id列表
        List<Long> categoryIdList = notePage.getRecords().stream().map(t -> t.getCategoryId()).collect(Collectors.toList());
        //根据id列表还有用户id查询分类表对应的名称
        //用stream流转换成map key id value name
        Map<Long, String> categoryNameMap = categoryMapper.selectMaps(new LambdaQueryWrapper<Category>()
                .select(Category::getId, Category::getName).in(Category::getId, categoryIdList)
                .eq(Category::getUserId, userId)
        ).stream().collect(Collectors.toMap(t -> (Long) t.get("id"), t -> t.get("name").toString()));

        //处理标签
        //通过stream流处理拿到笔记id key value 标签id
        //根据笔记id列表查询关联表
        List<Long> noteIdList = notePage.getRecords()
                .stream().map(t -> t.getId()).collect(Collectors.toList());
        //获取笔记id 跟标签id列表 1个笔记可以有多个标签所以用分组 map key->note vlaue->listTagd
        Map<Long, List<Integer>> noteTagMap = noteTagService.listMaps(
                new LambdaQueryWrapper<NoteTag>()
                        .select(NoteTag::getNoteId, NoteTag::getTagId)
                        .in(NoteTag::getNoteId, noteIdList)
        ).stream().collect(
                Collectors.groupingBy(
                        t -> ((Number) t.get("note_id")).longValue(), // 注意 key 名看坑2
                        Collectors.mapping(t -> ((Number) t.get("tag_id")).intValue(), Collectors.toList())
                )
        );
        //新建一个map<Long ,List<Tag>>
//
//        //迭代noteTagMap 在循环里面查询tag 得到的列表赋值到新map中
//      // 1. 收集所有笔记关联的 tag_id 并去重（展平成一个大的 List）
        List<Integer> allTagIds = noteTagMap.values().stream()
                .flatMap(Collection::stream).distinct().collect(Collectors.toList());
        //最终结果map
        Map<Long,List<Tag>> tagMap = new HashMap<>();
        // 判空处理：如果所有笔记都没有标签，直接返回空 map，连这 1 次 SQL 都省了
        if (!allTagIds.isEmpty()){
            // 2.【只查 1 次数据库】查出所有用到的 Tag 实体
            List<Tag> tagList = tagMapper.selectList(new LambdaQueryWrapper<Tag>().in(Tag::getId, allTagIds));
            // 3. 将 Tag 列表转成 Map<tag_id, Tag>，方便后面按 ID 快速查找
            Map<Long, Tag> idToTagMap = tagList.stream().collect(Collectors.toMap(Tag::getId, t -> t));
            // 4. 在内存中将 Tag 组合回每个笔记对应列表中
            for (Map.Entry<Long, List<Integer>> entry : noteTagMap.entrySet()) {
                Long noteId = entry.getKey();
                List<Integer> tagIds = entry.getValue();
                // 匹配对应的 Tag 对象
                List<Tag> tags = tagIds.stream().map(t -> idToTagMap.get(t.longValue()))
                        .filter(t->!ObjectUtils.isEmpty(t))
                        .collect(Collectors.toList());
                tagMap.put(noteId, tags);
            }
        }

        //塞数据
        noteListVOPage.setCurrent(notePage.getCurrent());
        noteListVOPage.setSize(notePage.getSize());
        noteListVOPage.setTotal(notePage.getTotal());
        noteListVOPage.setPages(notePage.getPages());
        //封装要塞入的数据

        List<NoteListVO> noteListVOList = new ArrayList<>();
        for (Note record : notePage.getRecords()) {
            NoteListVO noteListVO = new NoteListVO();
            BeanUtils.copyProperties(record,noteListVO);
            List<Tag> tagList = tagMap.get(record.getId());

            List<TagVO> tagVOList = new ArrayList<>();
            if (!ObjectUtils.isEmpty(tagList)){
                for (Tag tag : tagList) {
                    TagVO tagVO = new TagVO();
                    BeanUtils.copyProperties(tag,tagVO);
                    tagVOList.add(tagVO);
                }
            }
            noteListVO.setTags(tagVOList);
            noteListVO.setCategoryName(categoryNameMap.get(record.getCategoryId()));

            noteListVOList.add(noteListVO);
        }

        noteListVOPage.setRecords(noteListVOList);

        //返回
        return Result.success(noteListVOPage);
    }

    //切换笔记可见性
    @Override
    public Result<Void> updateNoteVisibility(UpdateNoteVisibilityDTO updateNoteVisibilityDTO, Long noteId) {
        Long userId = UserContext.getUserId();
        Integer visibility = updateNoteVisibilityDTO.getVisibility();
        //判断参数是否为空或越界
        if (ObjectUtils.isEmpty(visibility)
                || !(visibility.equals(NoteConstants.NOTE_VISIBILITY_PUBLIC) || visibility.equals(NoteConstants.NOTE_VISIBILITY_PRIVATE))){
            log.info("可见性参数不合法 visibility={}", visibility);
            throw BusinessException.badRequest("参数不合法");
        }
        //先查存在性与归属，再更新：
        //合并成「更新影响 0 行才报错」的话，「笔记不存在」和「不是自己的笔记」会返回同一句话，
        //给不出 404 / 403 的区分（BUG-06、BUG-07）
        Note note = getById(noteId);
        if (ObjectUtils.isEmpty(note)) {
            log.warn("笔记不存在 noteId={}", noteId);
            throw BusinessException.notFound("笔记不存在");
        }
        if (!userId.equals(note.getUserId())) {
            log.warn("无权修改该笔记 noteId={}", noteId);
            throw BusinessException.forbidden("无权修改该笔记");
        }
        //更改参数
        LambdaUpdateWrapper<Note> updateWrapper = new LambdaUpdateWrapper<Note>().set(Note::getVisibility, visibility)
                .eq(Note::getId, noteId).eq(Note::getUserId, userId);
        boolean update = update(updateWrapper);
        if (!update){
            log.warn("修改失败");
            throw BusinessException.serverError("更新笔记可见性失败请重试");
        }
        if (visibility == 0){
            //发送mq向量数据库删除公开的笔记
            RagMessageDTO messageDTO = new RagMessageDTO()
                    .setNoteId(noteId).setOperation(RagConstants.OPERATION_DELETE)
                    .setType(RagConstants.VECTOR_NOTE_TYPE).setUuid(UUID.randomUUID().toString());
            //mq传递
            rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE,"rag.update.delete",messageDTO);
        }else {
            //公开笔记了 重新向量化
            //必须重新查一次：上面那次 getById 发生在 update 之前，直接序列化 note 会把「旧可见性」发给向量库
            Note latest = getById(noteId);
            //json化
            String jsonStr = JSONUtil.toJsonStr(latest);
            RagMessageDTO messageDTO = new RagMessageDTO().setNoteId(noteId).setOperation(RagConstants.OPERATION_CREATE)
                    .setType(RagConstants.VECTOR_NOTE_TYPE)
                    .setJson(jsonStr).setUuid(UUID.randomUUID().toString());
            rabbitTemplate.convertAndSend(RabbitConfig.RAG_EXCHANGE,"rag",messageDTO);
        }
        return Result.success("操作成功");
    }

    //为笔记添加标签(会替换已有标签)
    @Transactional(rollbackFor = Exception.class)
    @Override
    public Result<Void> addNoteTags(Long noteId, List<Long> tagIds) {
        //获取用户id
        Long userId = UserContext.getUserId();
        //校验笔记是否存在且属于当前用户,防止操作别人的笔记
        //存在性(404)与归属(403)分开报，原来两者共用一句「笔记不存在或不属于当前用户」（BUG-06）
        Note note = getById(noteId);
        if (ObjectUtils.isEmpty(note)){
            log.warn("笔记不存在 noteId={}", noteId);
            throw BusinessException.notFound("笔记不存在");
        }
        if (!userId.equals(note.getUserId())){
            log.warn("无权操作该笔记 noteId={}", noteId);
            throw BusinessException.forbidden("无权操作该笔记");
        }
        //传相同标签直接返回
        List<Map<String, Object>> tagListMap = noteTagService.listMaps(new LambdaQueryWrapper<NoteTag>().select(NoteTag::getTagId, NoteTag::getNoteId)
                .eq(NoteTag::getNoteId, noteId));
        if (!ObjectUtils.isEmpty(tagListMap)){
            List<Long> ListTagId = tagListMap.stream().distinct().map(t ->((Number) t.get("tag_id")).longValue()).collect(Collectors.toList());
            //比较是否一样
            boolean ignoreOrder = isEqualIgnoreOrder(tagIds, ListTagId);
            if (ignoreOrder){
                log.info("传相同标签直接返回");
                return Result.success("操作成功");
            }

        }

        //先删除该笔记原有的标签关联(替换语义)
        noteTagService.remove(new LambdaQueryWrapper<NoteTag>().eq(NoteTag::getNoteId, noteId));
        //tagIds为空表示清空标签,直接返回
        if (ObjectUtils.isEmpty(tagIds)){
            return Result.success("操作成功");

        }
        //批量插入新的标签关联
        List<NoteTag> noteTagList = tagIds.stream().distinct().map(tagId -> {
            NoteTag noteTag = new NoteTag();
            noteTag.setNoteId(noteId);
            noteTag.setTagId(tagId);
            return noteTag;
        }).collect(Collectors.toList());
        noteTagService.saveBatch(noteTagList);
        //返回
        return Result.success("操作成功");
    }
    //tool根据用户信息查询笔记列表
    @Override
    public List<SearchNoteData> queryNoteList(SearchNote searchNote) {
        Integer limit;
        if (searchNote.getLimit() ==null){
            limit = 10;
        }else{
            limit = Math.min(searchNote.getLimit(),10);
        }
        searchNote.setLimit(limit);

        return noteMapper.queryNoteList(searchNote);
    }

    @Override
    public List<SearchNoteData> MyQueryNoteList(UserSearchNote userSearchNote) {
        Integer limit;
        if (userSearchNote.getLimit() ==null){
            limit = 10;
        }else{
            limit = Math.min(userSearchNote.getLimit(),10);
        }
        userSearchNote.setLimit(limit);
        Long userId = UserContext.getUserId();
        userSearchNote.setUserId(userId);

        return noteMapper.myQueryNoteList(userSearchNote);
    }


    //校验标签里面的元素是否一致
    private static <T> boolean isEqualIgnoreOrder(List<T> list1, List<T> list2) {
        if (list1 == null || list2 == null) {
            return list1 == list2;
        }

        if (list1.size() != list2.size()) {
            return false;
        }

        List<T> copy = new ArrayList<>(list2);

        for (T element : list1) {
            if (!copy.remove(element)) {
                return false;
            }
        }

        return copy.isEmpty();
    }


}




