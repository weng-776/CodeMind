package com.codemind.ai.vo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import lombok.Data;

@Data
public class AiConversationVO {
    // 会话 ID 为雪花算法生成的 19 位 Long，超出 JS Number 安全整数范围（16 位），
    // 直接以数字出参会丢精度（末 3 位变 0），故序列化为字符串；前端已按 string 处理。
    @JsonSerialize(using = ToStringSerializer.class)
    Long id;
    String title;
}
