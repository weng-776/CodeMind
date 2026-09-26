package com.codemind.user.dto;

import com.codemind.utils.RegexPatterns;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class UpdatePasswordDTO {
    @NotBlank(message = "原密码不能为空")
    @Pattern(regexp = RegexPatterns.PASSWORD_REGEX, message = "原密码为 4-32 位字母、数字或下划线")
    private String oldPassword;
    @NotBlank(message = "新密码不能为空")
    @Pattern(regexp = RegexPatterns.PASSWORD_REGEX, message = "新密码为 4-32 位字母、数字或下划线")
    private String newPassword;
}
