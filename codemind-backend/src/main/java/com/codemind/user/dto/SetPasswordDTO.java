package com.codemind.user.dto;

import com.codemind.utils.RegexPatterns;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import lombok.Data;

@Data
public class SetPasswordDTO {
    @NotBlank(message = "新密码不能为空")
    @Pattern(regexp = RegexPatterns.PASSWORD_REGEX, message = "新密码为 4-32 位字母、数字或下划线")
    private String password;
    @NotBlank
    private String phone;
}
