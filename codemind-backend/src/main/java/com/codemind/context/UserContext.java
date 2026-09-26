package com.codemind.context;

public class UserContext {
    private static final ThreadLocal<Long> tl = new ThreadLocal<>();
    public static Long getUserId() {
        return tl.get();
    }
    public static void setUserId(Long userId) {
        tl.set(userId);
    }
    public  static void removeUserId() {
        tl.remove();
    }
}
