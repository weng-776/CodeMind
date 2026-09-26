package com.codemind.exceptionhandler;

/**
 * 业务异常。
 *
 * <p>code 与 HTTP 状态码语义对齐，前端可以直接按 code 分支处理
 * （传输层仍是 HTTP 200 + Result 包装，不改动现有契约）：
 *
 * <ul>
 *     <li><b>400</b> 参数错误：缺参数、格式非法、枚举值越界、文件类型/大小不合规</li>
 *     <li><b>401</b> 未登录 / 凭证错误（验证码、密码）</li>
 *     <li><b>403</b> 已登录，但无权操作该资源（别人的资源）</li>
 *     <li><b>404</b> 资源不存在（文章 / 笔记 / 分类 / 评论 / 会话 / 通知）</li>
 *     <li><b>409</b> 状态冲突：重复提交、同名校验、唯一约束</li>
 *     <li><b>413</b> 上传体积超限</li>
 *     <li><b>429</b> 请求过于频繁（验证码间隔、错误次数超限）</li>
 *     <li><b>500</b> 服务端自身问题（默认值）</li>
 *     <li><b>503</b> 服务暂时不可用（并发锁未获取到，稍后重试即可）</li>
 * </ul>
 *
 * <p>「不存在」和「无权限」必须分开报：合并成一句话会同时给出 404 与 403 两种语义，
 * 前端既无法区分，也是越权探测的信息泄漏面。
 */
public class BusinessException extends RuntimeException{

    /** 400 参数错误 */
    public static final int CODE_BAD_REQUEST = 400;
    /** 401 未登录 / 凭证错误 */
    public static final int CODE_UNAUTHORIZED = 401;
    /** 403 无权限操作该资源 */
    public static final int CODE_FORBIDDEN = 403;
    /** 404 资源不存在 */
    public static final int CODE_NOT_FOUND = 404;
    /** 409 重复 / 状态冲突 */
    public static final int CODE_CONFLICT = 409;
    /** 413 上传体积超限 */
    public static final int CODE_PAYLOAD_TOO_LARGE = 413;
    /** 429 请求过于频繁 */
    public static final int CODE_TOO_MANY_REQUESTS = 429;
    /** 500 服务端错误 */
    public static final int CODE_SERVER_ERROR = 500;
    /** 503 服务暂时不可用 */
    public static final int CODE_SERVICE_UNAVAILABLE = 503;

    /**
     * 业务状态码。
     * 不传时默认 500，与历史行为保持一致；
     * 需要让前端区分语义时用下面的静态工厂，不要在调用点散落魔法数字。
     */
    private final Integer code;

    public BusinessException(String message){
        this(CODE_SERVER_ERROR, message);
    }

    public BusinessException(Integer code, String message){
        super(message);
        this.code = code;
    }

    public Integer getCode(){
        return code;
    }

    /** 400 参数错误 */
    public static BusinessException badRequest(String message){
        return new BusinessException(CODE_BAD_REQUEST, message);
    }

    /** 401 未登录 / 凭证错误 */
    public static BusinessException unauthorized(String message){
        return new BusinessException(CODE_UNAUTHORIZED, message);
    }

    /** 403 无权操作该资源 */
    public static BusinessException forbidden(String message){
        return new BusinessException(CODE_FORBIDDEN, message);
    }

    /** 404 资源不存在 */
    public static BusinessException notFound(String message){
        return new BusinessException(CODE_NOT_FOUND, message);
    }

    /** 409 重复提交 / 同名校验 / 唯一约束冲突 */
    public static BusinessException conflict(String message){
        return new BusinessException(CODE_CONFLICT, message);
    }

    /** 413 上传体积超限 */
    public static BusinessException payloadTooLarge(String message){
        return new BusinessException(CODE_PAYLOAD_TOO_LARGE, message);
    }

    /** 429 请求过于频繁 */
    public static BusinessException tooManyRequests(String message){
        return new BusinessException(CODE_TOO_MANY_REQUESTS, message);
    }

    /** 500 服务端错误（与无参构造同义，用于显式表达「这里确实是服务端的问题」） */
    public static BusinessException serverError(String message){
        return new BusinessException(CODE_SERVER_ERROR, message);
    }

    /** 503 服务暂时不可用（并发锁未获取到等可重试场景） */
    public static BusinessException serviceUnavailable(String message){
        return new BusinessException(CODE_SERVICE_UNAVAILABLE, message);
    }
}
