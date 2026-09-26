package com.codemind.user.dto;

import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class UpdateUserDataDTO {
    @Size(min = 1, max = 12 ,message = "昵称不能超过12个字符")
     private  String userName;
     private   String avatar;
     @Size(min = 6, max = 200 ,message = "简介不能超过200字符")
     private   String intro;
}
