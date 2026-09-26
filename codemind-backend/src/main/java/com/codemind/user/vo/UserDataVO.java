package com.codemind.user.vo;

import io.swagger.v3.oas.models.security.SecurityScheme;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class UserDataVO {

    private String phone;

    private String userName;

    private String avatar;
    private String intro;

    private Integer fansCount;
    private Integer followCount;
    private Integer noteCount;
    private Integer articleCount;

}
