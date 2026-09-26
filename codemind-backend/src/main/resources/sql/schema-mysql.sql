CREATE TABLE IF NOT EXISTS SPRING_AI_CHAT_MEMORY (
                                                     `id` BIGINT(19) NOT NULL AUTO_INCREMENT,
    `conversation_id` VARCHAR(36) NOT NULL COLLATE 'utf8mb4_general_ci',
    `content` TEXT NOT NULL COLLATE 'utf8mb4_general_ci',
    `type` VARCHAR(10) NOT NULL COLLATE 'utf8mb4_general_ci',
    `timestamp` TIMESTAMP NOT NULL,
    PRIMARY KEY (`id`) USING BTREE,
    INDEX `SPRING_AI_CHAT_MEMORY_CONVERSATION_ID_TIMESTAMP_IDX` (`conversation_id`, `timestamp`) USING BTREE,
    CONSTRAINT TYPE_CHECK CHECK (type IN ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL'))
    );