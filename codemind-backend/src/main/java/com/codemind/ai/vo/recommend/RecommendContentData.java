package com.codemind.ai.vo.recommend;

import com.codemind.ai.entity.recommend.RecommendContent;
import com.codemind.ai.entity.recommend.RelatedTopics;
import com.codemind.ai.vo.SearchArticleData;
import com.codemind.ai.vo.SearchNoteData;
import lombok.Data;

import java.util.List;
@Data
public class RecommendContentData {
   List<RecommendArticleData> articleDataList;
    private RelatedTopics topics;
    List<RecommendNoteData> noteDataList;



}
