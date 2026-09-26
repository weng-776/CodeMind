package com.codemind.utils;

import org.springframework.web.multipart.MultipartFile;

public interface FileUploadService {
    /**
     * 实现文件上传的核心业务方法！
     * @param folder 不同上传位置的文件夹！ 例如： 轮播图 banners
     * @param file 上传的文件封装对象！
     * @return 可以访问的文件地址
     */
    String uploadFile(String folder, MultipartFile file) throws Exception;
    void deleteFile(String fileUrl) throws Exception;
}
