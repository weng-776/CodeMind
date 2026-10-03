package com.codemind.admin.vo;

import lombok.Data;

@Data
public class AdminQueueVO {
    private String queueName;
    private Integer messageCount;
    private Integer consumerCount;
}
