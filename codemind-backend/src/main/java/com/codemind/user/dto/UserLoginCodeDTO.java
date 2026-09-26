package com.codemind.user.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class UserLoginCodeDTO {
    @NotBlank(message = "手机号不能为空")
    String phone;
    @NotBlank(message = "验证码不能为空")
    String code;
}
