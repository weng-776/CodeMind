package com.codemind.utils;

import com.codemind.config.MinioConfiguration;
import com.codemind.config.properties.MinioProperties;
import io.minio.*;
import io.minio.errors.*;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.net.URI;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.UUID;

/**
 *
 * description:
 */
@Service
@Slf4j
public class FileUploadServiceImpl implements FileUploadService {
   @Autowired
    MinioProperties minioProperties;
    @Autowired
    MinioClient minioClient;
    @Override
    public String uploadFile(String folder, MultipartFile file) throws Exception{
        //判断桶是否存在
        boolean bucketExists = minioClient.bucketExists(BucketExistsArgs.builder().bucket(minioProperties.getBucketName()).build());
        if (!bucketExists){
            //不存在创建桶，同时设置访问权限
            minioClient.makeBucket(MakeBucketArgs.builder().bucket(minioProperties.getBucketName()).build());
            String config = """
                        {
                              "Statement" : [ {
                                "Action" : "s3:GetObject",
                                "Effect" : "Allow",
                                "Principal" : "*",
                                "Resource" : "arn:aws:s3:::%s/*"
                              } ],
                              "Version" : "2012-10-17"
                        }
                    """.formatted(minioProperties.getBucketName());
            //给桶设置权限
            minioClient.setBucketPolicy(SetBucketPolicyArgs.builder()
                    .bucket(minioProperties.getBucketName()).config(config).build());
        }

        //3. 处理上传的对象名（影响，minio桶中的文件结构！）
        //现在： 桶名 / folder / ai.png  缺点： 所有文件都平铺（banner，video）不好区分！ 核心缺点，可能覆盖！
        //小知识点： x/x/x.png -> exam0625 /x/x/ x.png
        //解决覆盖问题： 确保对象和文件的名字唯一即可！！ uuid - - -
        //1.需要添加文件夹 2.添加uuid确保不重复
        String objectName = folder + "/" + new SimpleDateFormat("yyyyMMdd").format(new Date()) + "/"
                +UUID.randomUUID().toString().replaceAll("-","")+ "_" + file.getOriginalFilename();


        //4. 上传文件 putObject方法
        //putObject . 上传文件数据 .steam(文件输入流)
        //uploadObject .上传文件数据 .filename(文件的磁盘地址 c:\\)
        minioClient.putObject(PutObjectArgs.builder().bucket(minioProperties.getBucketName())
                .contentType(file.getContentType())
                .object(objectName)
                .stream(file.getInputStream(),file.getSize(),-1).build());

        //5. 拼接回显地址 【端点 + 桶 + 对象名】
        String url =String.join("/",minioProperties.getEndpoint(),minioProperties.getBucketName(),objectName);

        return url;

    }
    @Override
    public void deleteFile(String fileUrl) throws Exception {
        String bucketName = minioProperties.getBucketName();

        // 使用 URI 解析路径
        URI uri = new URI(fileUrl);
        String path = uri.getPath(); // 例如 /my-bucket/note-cover/20250101/abc.jpg
        if (path == null || path.isEmpty()) {
            throw new RuntimeException("无效的文件URL: " + fileUrl);
        }

        // 去掉开头的 '/'
        String pathWithoutLeadingSlash = path.startsWith("/") ? path.substring(1) : path;

        // 检查桶名是否匹配
        if (!pathWithoutLeadingSlash.startsWith(bucketName + "/")) {
            throw new RuntimeException("URL中的桶名与配置不符: " + fileUrl);
        }

        String objectName = pathWithoutLeadingSlash.substring(bucketName.length() + 1);

        minioClient.removeObject(RemoveObjectArgs.builder()
                .bucket(bucketName)
                .object(objectName)
                .build());
    }
}

