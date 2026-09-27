package com.codemind.user.service.impl;

import cn.hutool.core.util.RandomUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.codemind.common.RedisKeyConstants;
import com.codemind.common.Result;
import com.codemind.common.UserConstants;
import com.codemind.community.entity.Article;
import com.codemind.community.mapper.ArticleMapper;
import com.codemind.config.properties.MinioProperties;
import com.codemind.context.UserContext;
import com.codemind.exceptionhandler.BusinessException;
import com.codemind.knowledge.entity.Note;
import com.codemind.knowledge.mapper.NoteMapper;
import com.codemind.user.dto.*;
import com.codemind.user.entity.Follow;
import com.codemind.user.entity.User;
import com.codemind.user.mapper.FollowMapper;
import com.codemind.user.service.UserService;
import com.codemind.user.mapper.UserMapper;
import com.codemind.user.vo.CheckUserHomeVO;
import com.codemind.user.vo.UserDataVO;
import com.codemind.utils.FileUploadService;
import com.codemind.utils.JwtHelper;
import com.codemind.utils.MD5Util;
import com.codemind.utils.RegexUtils;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.util.ObjectUtils;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;

import java.util.*;
import java.util.concurrent.TimeUnit;

/**
* @author wengjiaran
* @description 针对表【user(用户表)】的数据库操作Service实现
* @createDate 2026-08-07 20:18:26
*/
@Service
@Slf4j
public class UserServiceImpl extends ServiceImpl<UserMapper, User>
    implements UserService{

    @Autowired
    private StringRedisTemplate stringRedisTemplate;
    @Autowired
    private JwtHelper jwtHelper;
    @Autowired //关注关系mapper
    private FollowMapper followMapper;
    @Autowired //笔记mapper
    private NoteMapper noteMapper;
    @Autowired //文章mapper
    private ArticleMapper articleMapper;
    @Autowired
    private FileUploadService fileUploadService;
    @Autowired
    private MinioProperties minioProperties;

    private static final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    //手机验证码登陆
    @Override
    public Result<Map<String, String>> loginCode(UserLoginCodeDTO userLoginCodeDTO) {
        //查询手机号是否匹配
        String code = stringRedisTemplate.opsForValue().get(RedisKeyConstants.REDIS_CODE_KEY + userLoginCodeDTO.getPhone());
        if (!StringUtils.hasText(code)) {
            log.info("验证码已过期");
            throw BusinessException.badRequest("验证码已过期");
        }

        //是否匹配验证码
        if (!code.equals(userLoginCodeDTO.getCode())) {
            //创建失败次数
            Long count = stringRedisTemplate.opsForValue().increment(RedisKeyConstants.REDIS_CODE_fail+userLoginCodeDTO.getPhone());
            if (count !=null && count==1){
                stringRedisTemplate.expire(RedisKeyConstants.REDIS_CODE_fail+userLoginCodeDTO.getPhone(),3L,TimeUnit.MINUTES);
            }
            //超过5次错误删除验证码让用户重新尝试获取
            if (count !=null && count>=5){
                stringRedisTemplate.delete(RedisKeyConstants.REDIS_CODE_KEY + userLoginCodeDTO.getPhone());
                stringRedisTemplate.delete(RedisKeyConstants.REDIS_CODE_fail+userLoginCodeDTO.getPhone());
                log.info("用户超过5次验证码错误");
                throw BusinessException.tooManyRequests("多次错误请重新获取验证码");
            }
            log.info("验证码不一致");
            throw BusinessException.badRequest("验证码不一致请重试");
        }
        //返回的token
        Map<String, String> mapToken = new HashMap<>();
        //查询用户
        LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<User>();
        wrapper.eq(User::getPhone, userLoginCodeDTO.getPhone()).ne(User::getStatus,UserConstants.USER_STATUS_DISABLE);
        User users = getOne(wrapper);
        if (!ObjectUtils.isEmpty(users)) {
            //证明是注册过的 使用的是手机号验证码登陆
            //生成token
            String token = jwtHelper.createToken(users.getId());
            mapToken.put("token", token);
            //登陆成功删除验证码
            stringRedisTemplate.delete(RedisKeyConstants.REDIS_CODE_KEY + userLoginCodeDTO.getPhone());
            return  Result.success(mapToken);
        }
        //注册用户
        //提供基础信息
        User user = new User();
        user.setPhone(userLoginCodeDTO.getPhone());
        //默认密码
        user.setPassword("");
        //状态
        user.setStatus(UserConstants.USER_STATUS_NORMAL);
        user.setIntro("");
        //整合mino 设置头像
        user.setAvatar(minioProperties.getEndpoint()+"/codemind/Default_avatar.jpg");
        //随机名字
        String userName = randomUserName(UserConstants.USER_NAME);
        user.setUserName(userName);
        try{
            save(user);
        } catch (DuplicateKeyException e) {
            //并发注册兜底：另一请求已插入该手机号，直接查询该用户登录，避免返回 500
            User exists = getOne(new LambdaQueryWrapper<User>()
                    .eq(User::getPhone, user.getPhone())
                    .ne(User::getStatus, UserConstants.USER_STATUS_DISABLE));
            if (exists == null) {
                throw BusinessException.serverError("注册失败，请重试");
            }
            String token = jwtHelper.createToken(exists.getId());
            mapToken.put("token", token);
            //删除验证码
            stringRedisTemplate.delete(RedisKeyConstants.REDIS_CODE_KEY + user.getPhone());
            return Result.success(mapToken);
        }

        //生成token
        String token = jwtHelper.createToken(user.getId());

        //删除验证码
        stringRedisTemplate.delete(RedisKeyConstants.REDIS_CODE_KEY + userLoginCodeDTO.getPhone());

        //返回token
        mapToken.put("token", token);
        return  Result.success(mapToken);
    }
    //发送验证码
    @Override
    public Result<Boolean> sendCode(Map<String,String> phoneMap) {
        //校验手机号手机号是否为空
        if (ObjectUtils.isEmpty(phoneMap.get("phone"))) {
            log.info("手机号不能为空");
            throw BusinessException.badRequest("手机号不能为空");
        }
        String phone = phoneMap.get("phone");
        //校验是否为无效手机号
        if (RegexUtils.isPhoneInvalid(phone)) {
            log.info("手机号{}不标准",phone);
            throw BusinessException.badRequest("手机号"+phone+"不标准请重新输入");
        }
        //限制1分钟间隔不能重复发送验证码
        String sentKey = RedisKeyConstants.REDIS_SENT_CODE_KEY + phone;
        Boolean hassed = stringRedisTemplate.hasKey(sentKey);
        if (Boolean.TRUE.equals(hassed)) {
            log.warn("用户已经一分钟内发送过一次验证码");
            throw BusinessException.tooManyRequests("请稍后再试");
        }


        //生成验证码
        String code = RandomUtil.randomNumbers(6);
        //打印在控制台
        log.info("code = " + code);
        //把code保存在redis
        stringRedisTemplate.opsForValue()
                .set(RedisKeyConstants.REDIS_CODE_KEY + phone, code,3L, TimeUnit.MINUTES);
        //保存sentKey
        stringRedisTemplate.opsForValue().set(sentKey,"1",60L, TimeUnit.SECONDS);

        //返回ok
        return Result.success(true);
    }

    //密码登陆
    @Override
    public Result<Map<String, String>> loginPassword(UserPasswordLoginDTO userPasswordLoginDTO) {
        //校验手机号是否合格
        if (RegexUtils.isPhoneInvalid(userPasswordLoginDTO.getPhone())) {
            log.info("手机号不符合");
            throw BusinessException.badRequest("手机号不符合");
        }
        //通过手机号查询密码比较
        LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<User>()
                .eq(User::getPhone, userPasswordLoginDTO.getPhone())
                .eq(User::getStatus,UserConstants.USER_STATUS_NORMAL);
        User user = getOne(wrapper);
        if (ObjectUtils.isEmpty(user)) {
            log.info("手机号不存在");
            throw BusinessException.unauthorized("手机号或密码错误");
        }
        //灰度转移
        if (user.getPassword().startsWith("$2a$") || user.getPassword().startsWith("$2b$")) {
            //注册时候使用的是BCrypt加密的
            //密码不相等
            if (!encoder.matches(userPasswordLoginDTO.getPassword(), user.getPassword())) {
                log.info("密码错误");
                throw BusinessException.unauthorized("手机号或密码错误");
            }
            //生成token
            String token = jwtHelper.createToken(user.getId());
            Map<String, String> mapToken = new HashMap<>();
            mapToken.put("token", token);
            //返回
            return Result.success(mapToken);
        }else{
            //之前使用的md五加密的密码
            if (!MD5Util.encrypt(userPasswordLoginDTO.getPassword()).equals(user.getPassword())) {
                log.info("密码错误");
                throw BusinessException.unauthorized("手机号或密码错误");
            }
            //更新使用BCrypt加密
            String encode = encoder.encode(userPasswordLoginDTO.getPassword());
            update(new LambdaUpdateWrapper<User>().eq(User::getId, user.getId()).set(User::getPassword, encode));
            //生成token
            String token = jwtHelper.createToken(user.getId());
            Map<String, String> mapToken = new HashMap<>();
            mapToken.put("token", token);
            //返回
            return Result.success(mapToken);

        }



    }
    //获取用户当前信息
    @Override
    public Result<UserDataVO> getUserInformation() {
        //从token拿到用户id
        Long userId = UserContext.getUserId();
        if (ObjectUtils.isEmpty(userId)) {
            log.info("查询用户主页id为空");
            throw BusinessException.unauthorized("获取不到用户信息请稍后尝试");
        }
        //查询用户信息
        User user = getById(userId);
        if (ObjectUtils.isEmpty(user)) {
            throw BusinessException.notFound("用户不存在");
        }
        //分开查（）单表
        //关注粉丝表
        Long followCount = followMapper.selectCount(new LambdaQueryWrapper<Follow>().eq(Follow::getUserId, userId));
        //粉丝数目
        Long fansCount = followMapper.selectCount(new LambdaQueryWrapper<Follow>().eq(Follow::getFollowUserId, userId));
        //笔记数目
        Long noteCount = noteMapper.selectCount(new LambdaQueryWrapper<Note>().eq(Note::getUserId, userId));
        //文章数目
        Long articleCount = articleMapper.selectCount(new LambdaQueryWrapper<Article>().eq(Article::getUserId, userId));
        //封装数据
        UserDataVO userDataVO = new UserDataVO();
        BeanUtils.copyProperties(user,userDataVO);
        userDataVO.setFollowCount(followCount.intValue());
        userDataVO.setFansCount(fansCount.intValue());
        userDataVO.setNoteCount(noteCount.intValue());
        userDataVO.setArticleCount(articleCount.intValue());
        //是否已设置过密码：注册时密码存为空字符串，据此判断新用户是否需要强制设置密码
        userDataVO.setHasPassword(StringUtils.hasText(user.getPassword()));
        //返回 第一版先这样查数据库
        return Result.success(userDataVO);
    }
    //修改个人信息
    @Override
    public Result<Void> updateUserData(UpdateUserDataDTO updateUserDataDTO,MultipartFile file) throws Exception {
        if (updateUserDataDTO == null) {
            throw BusinessException.badRequest("请至少提交一个要修改的信息");
        }
        Long userId = UserContext.getUserId();
        // 处理头像
        User user = getById(userId);
        if (ObjectUtils.isEmpty(user)) {
            throw BusinessException.notFound("用户不存在");
        }
        String avatarUrl = user.getAvatar();
        if (file != null && !file.isEmpty()) {
            // 1. 文件大小校验，最大 2MB
            if (file.getSize() > 2 * 1024 * 1024) {
                throw BusinessException.badRequest("头像大小不能超过2MB");
            }
            // 2. 文件后缀校验
            String originalFilename = file.getOriginalFilename();
            if (ObjectUtils.isEmpty(originalFilename)) {
                throw BusinessException.badRequest("头像文件名不能为空");
            }

            String suffix = originalFilename.substring(
                    originalFilename.lastIndexOf(".") + 1
            ).toLowerCase();
            if (!Arrays.asList("jpg", "jpeg", "png", "webp").contains(suffix)) {
                throw BusinessException.badRequest("头像只支持 jpg、jpeg、png、webp 格式");
            }
            // 3. Content-Type 校验
            String contentType = file.getContentType();
            if (ObjectUtils.isEmpty(contentType)
                    || !Arrays.asList("image/jpeg", "image/png", "image/webp")
                    .contains(contentType)) {
                throw BusinessException.badRequest("头像格式不正确");
            }
            // 4. 上传
            avatarUrl = fileUploadService.uploadFile(
                    UserConstants.USER_AVATAR_PREFIX,
                    file
            );
        }
        //
        updateUserDataDTO.setAvatar(avatarUrl);
        LambdaUpdateWrapper<User> updateWrapper = new LambdaUpdateWrapper<>();
        updateWrapper.set(!ObjectUtils.isEmpty(updateUserDataDTO.getUserName()),User::getUserName,updateUserDataDTO.getUserName())
                .set(!ObjectUtils.isEmpty(updateUserDataDTO.getIntro()),User::getIntro,updateUserDataDTO.getIntro())
                .set(!ObjectUtils.isEmpty(updateUserDataDTO.getAvatar()),User::getAvatar,updateUserDataDTO.getAvatar()).eq(User::getId, userId);
        boolean update = update(updateWrapper);
        if (!update) {
            log.info("更新失败");
            return Result.success("更新失败");
        }
        return Result.success("更新成功");
    }
    //修改密码
    @Override
    public Result<Boolean> updatePassword(UpdatePasswordDTO userPassword) {
        //判断跟原来密码是否相同
        Long userId = UserContext.getUserId();
        User user = getById(userId);
        if (!encoder.matches(userPassword.getOldPassword(), user.getPassword())) {
            log.info("旧密码错误");
            throw BusinessException.badRequest("旧密码错误");
        }

        String newPassword = userPassword.getNewPassword();
        if (encoder.matches(newPassword, user.getPassword())) {
            log.info("新密码不能与旧密码重复");
            throw BusinessException.badRequest("新密码不能与旧密码重复");
        }
        //更新密码
        user.setPassword(encoder.encode(newPassword));
        updateById(user);
        return Result.success(true);
    }
    //查看他人主页
    @Override
    public Result<CheckUserHomeVO> checkUserHome(Long userId) {
        //不需要校验因为是路径传参
        //查询相关用户信息
        User user = getById(userId);
        //看看用户是否存在
        if (ObjectUtils.isEmpty(user)) {
            log.info("用户不存在");
            throw BusinessException.notFound("用户不存在");
        }
        //分开查（）单表
        //关注粉丝表
        Long followCount = followMapper.selectCount(new LambdaQueryWrapper<Follow>().eq(Follow::getUserId, userId));
        //粉丝数目
        Long fansCount = followMapper.selectCount(new LambdaQueryWrapper<Follow>().eq(Follow::getFollowUserId, userId));
        //笔记数目
        Long noteCount = noteMapper.selectCount(new LambdaQueryWrapper<Note>().eq(Note::getUserId, userId));
        //文章数目
        Long articleCount = articleMapper.selectCount(new LambdaQueryWrapper<Article>().eq(Article::getUserId, userId));
        //当前用户是否关注了查看用户
        Long currentUser = UserContext.getUserId();
        LambdaQueryWrapper<Follow> wrapper = new LambdaQueryWrapper<Follow>().eq(Follow::getFollowUserId, userId).eq(Follow::getUserId, currentUser);
        Long count = followMapper.selectCount(wrapper);
        //封装数据
        CheckUserHomeVO checkUserHomeVO = new CheckUserHomeVO();
        BeanUtils.copyProperties(user,checkUserHomeVO);
        checkUserHomeVO.setFollowCount(followCount.intValue());
        checkUserHomeVO.setFansCount(fansCount.intValue());
        checkUserHomeVO.setNoteCount(noteCount.intValue());
        checkUserHomeVO.setArticleCount(articleCount.intValue());
        checkUserHomeVO.setIsFollow(count>0 ? true : false);

        //返回
        return Result.success(checkUserHomeVO);
    }

    //手机号注册以后进入此接口设置密码
    @Override
    public Result<Void> setPassword(SetPasswordDTO setPasswordDTO) {
        Long userId = UserContext.getUserId();
        User user = getById(userId);
        if (ObjectUtils.isEmpty(user)) {
            throw BusinessException.notFound("未找到相关用户");
        }
        if (!user.getPhone().equals(setPasswordDTO.getPhone())) {
            throw BusinessException.badRequest("手机号不匹配");
        }
        //该接口只用于注册后首次设置密码；已设置过的必须走 /user/updatePassword（校验旧密码）
        //否则任何登录用户都能借此绕过旧密码直接重置密码
        if (StringUtils.hasText(user.getPassword())) {
            throw BusinessException.badRequest("密码已设置，请使用修改密码");
        }
        String password = encoder.encode(setPasswordDTO.getPassword());
        //更新
        update(new LambdaUpdateWrapper<User>().eq(User::getId, userId)
                .eq(User::getPhone, setPasswordDTO.getPhone())
                .set(User::getPassword, password));
        return Result.success("操作成功");
    }

    private String randomUserName(String userName) {

       return userName + RandomUtil.randomNumbers(3);

    }
}




