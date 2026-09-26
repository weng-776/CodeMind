package com.codemind.user.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class UserPasswordLoginDTO {
    @NotBlank(message = "手机号不能为空")
    private String phone;
    @NotBlank(message = "密码不能为空")
    private String password;
}
