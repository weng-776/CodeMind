package com.codemind.utils;

public class NoteWordCount {
    public static int getWordCount(String text) {
        if (text == null || text.trim().isEmpty()) {
            return 0;
        }

        // 1. 统计汉字及中文标点以外的常见汉字字符
        int chineseCount = 0;
        // \u4e00-\u9fa5 涵盖大部分常用汉字
        java.util.regex.Matcher chineseMatcher =
                java.util.regex.Pattern.compile("[\u4e00-\u9fa5]").matcher(text);
        while (chineseMatcher.find()) {
            chineseCount++;
        }

        // 2. 统计英文单词数
        int englishWordCount = 0;
        java.util.regex.Matcher englishMatcher =
                java.util.regex.Pattern.compile("\\b[a-zA-Z]+\\b").matcher(text);
        while (englishMatcher.find()) {
            englishWordCount++;
        }

        // 3. 统计数字（连续的数字算作一个词，如 "2026" 算 1 个词）
        int numberCount = 0;
        java.util.regex.Matcher numberMatcher =
                java.util.regex.Pattern.compile("\\b\\d+\\b").matcher(text);
        while (numberMatcher.find()) {
            numberCount++;
        }

        return chineseCount + englishWordCount + numberCount;
    }

}
