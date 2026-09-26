package com.codemind.exceptionhandler;

import com.codemind.common.Result;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.ConstraintViolationException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.MessageSourceResolvable;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.util.ObjectUtils;
import org.springframework.validation.BindException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.stream.Collectors;

//全局异常类
@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {

    /**
     * 请求参数类异常：都是客户端问题，统一返回 400。
     * 此前这些异常没有单独的处理器，全部落进下面的 Exception 兜底分支返回 500，
     * 导致前端无法区分「参数写错」和「服务端崩了」。
     *
     * message 透出策略：只把「校验注解里我们自己写的中文 message」拼出来给前端，
     * 其余（类型转换失败、JSON 结构错误等）一律回落到统一的兜底文案——
     * 那些异常的 message 是面向开发者的英文长句（含类名、嵌套异常），
     * 直接透给前端既没法展示，也泄露内部实现。
     */
    @ExceptionHandler({
            MissingServletRequestParameterException.class,   // 缺少必填的 @RequestParam
            MissingServletRequestPartException.class,       // 缺少必填的 multipart 部分（例如没带上文件）
            MethodArgumentTypeMismatchException.class,      // 路径/查询参数类型不匹配
            HttpMessageNotReadableException.class,          // 请求体缺失或 JSON 结构错误
            BindException.class,                            // @Valid @RequestBody 校验失败（其子类 MethodArgumentNotValidException 也走这里）
            HandlerMethodValidationException.class,         // Spring 6.1+ 方法级参数校验失败（@Validated + @Min/@Max）
            ConstraintViolationException.class              // 其他 Bean Validation 校验失败
    })
    public Result<Void> handlerParamException(Exception e) {

        // 详情日志照旧保留，方便排查
        String detail = describeDetail(e);
        log.warn("参数异常：{}", detail);

        // 只有拿到「明确的自定义校验消息」才透出，否则用泛化文案兜底
        String userMessage = extractUserFriendlyMessage(e);
        return Result.error(BusinessException.CODE_BAD_REQUEST,
                ObjectUtils.isEmpty(userMessage) ? "请求参数错误" : userMessage);
    }

    /**
     * 只提取「校验注解上我们自己写的中文 message」。
     * 判断依据是消息里含中日韩字符——Spring 内置的默认消息（must not be null /
     * size must be between ... / must match ...）全是纯英文，据此可稳定区分。
     * 多个字段同时失败时用「；」拼接，让前端一次展示全部问题。
     *
     * @return 拼接后的中文提示；没有可用的自定义消息时返回 null
     */
    private String extractUserFriendlyMessage(Exception e) {

        java.util.List<String> messages = new java.util.ArrayList<>();

        if (e instanceof BindException bindException) {
            // @Valid @RequestBody / @Valid @ModelAttribute 上字段级校验失败
            bindException.getFieldErrors().stream()
                    .map(org.springframework.validation.FieldError::getDefaultMessage)
                    .filter(this::isCustomMessage)
                    .forEach(messages::add);
        } else if (e instanceof HandlerMethodValidationException methodValidationException) {
            // @Validated + @RequestParam 上的 @Min/@Max 等，Spring 6.1+ 走这里
            methodValidationException.getParameterValidationResults().stream()
                    .flatMap(result -> result.getResolvableErrors().stream())
                    .map(MessageSourceResolvable::getDefaultMessage)
                    .filter(this::isCustomMessage)
                    .forEach(messages::add);
        } else if (e instanceof ConstraintViolationException violationException) {
            violationException.getConstraintViolations().stream()
                    .map(ConstraintViolation::getMessage)
                    .filter(this::isCustomMessage)
                    .forEach(messages::add);
        }

        // 去重后拼接（同一个 message 可能挂在多个注解上，例如 visibility 的 @Min/@Max）
        String joined = messages.stream().distinct().collect(Collectors.joining("；"));
        return ObjectUtils.isEmpty(joined) ? null : joined;
    }

    /**
     * 判断是不是「我们自己写的」校验消息。
     * Spring 内置默认消息都是纯英文，含中文即可认为是自定义 message。
     */
    private boolean isCustomMessage(String message) {

        if (ObjectUtils.isEmpty(message)) {
            return false;
        }
        return message.codePoints().anyMatch(cp ->
                Character.UnicodeScript.of(cp) == Character.UnicodeScript.HAN);
    }

    /**
     * 路径未匹配到任何处理器：Spring Boot 3.2+ 抛 NoResourceFoundException。
     * 这类请求是客户端把地址拼错了，属于 404；此前会落进下面的 Exception 兜底返回 500。
     */
    @ExceptionHandler(NoResourceFoundException.class)
    public Result<Void> handlerNoResourceFound(NoResourceFoundException e) {

        log.warn("请求地址不存在：{}", e.getMessage());
        return Result.error(BusinessException.CODE_NOT_FOUND, "请求的资源不存在");
    }

    /** 请求方法不支持（例如该用 POST 却发 GET）→ 405 */
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public Result<Void> handlerMethodNotSupported(HttpRequestMethodNotSupportedException e) {

        log.warn("请求方法不支持：{}", e.getMessage());
        return Result.error(405, "请求方法不支持");
    }

    /** 请求体 Content-Type 不支持（例如没带 application/json）→ 415 */
    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public Result<Void> handlerMediaTypeNotSupported(HttpMediaTypeNotSupportedException e) {

        log.warn("Content-Type 不支持：{}", e.getContentType());
        return Result.error(415, "请求格式不支持");
    }

    /** 上传文件超过 max-file-size 限制 → 413；此前会被包装成 500「系统繁忙」 */
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public Result<Void> handlerMaxUploadSizeExceeded(MaxUploadSizeExceededException e) {

        log.warn("上传文件超过大小限制：{}", e.getMessage());
        return Result.error(BusinessException.CODE_PAYLOAD_TOO_LARGE, "上传文件过大");
    }

    // 空指针异常
    @ExceptionHandler(NullPointerException.class)
    public Result<Void> handlerNullException(NullPointerException e) {

        log.error("程序发生空指针异常", e);
        return Result.error("系统异常，请稍后重试");
    }

    // 其他系统异常
    @ExceptionHandler(Exception.class)
    public Result<Void> exceptionHandler(Exception e) {

        log.error("服务器发生运行时异常", e);
        return Result.error("系统繁忙，请稍后尝试");
    }

    // 业务异常
    @ExceptionHandler(BusinessException.class)
    public Result<Void> handleBusinessException(BusinessException e) {

        // 5xx 说明是服务端自己的问题，按 error 级别留痕；4xx 是客户端用法问题，warn 足够
        if (e.getCode() != null && e.getCode() >= 500) {
            log.error("业务异常(code={})：{}", e.getCode(), e.getMessage());
        } else {
            log.warn("业务异常(code={})：{}", e.getCode(), e.getMessage());
        }
        return Result.error(e.getCode(), e.getMessage());
    }

    /**
     * 取异常里最有信息量的那句话：
     * 校验类异常（BindException / ConstraintViolationException）的 message 往往只是
     * 「Validation failed for argument ...」，真正的字段原因在 getFieldErrors 里。
     */
    private String describeDetail(Exception e) {

        if (e instanceof BindException bindException && bindException.hasFieldErrors()) {
            return bindException.getFieldErrors().stream()
                    .map(f -> f.getField() + " " + f.getDefaultMessage())
                    .collect(Collectors.joining("; "));
        }
        if (e instanceof ConstraintViolationException violationException) {
            return violationException.getConstraintViolations().stream()
                    .map(v -> v.getPropertyPath() + " " + v.getMessage())
                    .collect(Collectors.joining("; "));
        }
        return e.getMessage();
    }
}
