<script setup lang="ts">
/**
 * 内容治理 · 评论表格（**纯展示组件**）
 * ------------------------------------------------------------------
 * 与另两张表同一套路：只渲染结构，数据/动作走 props + emit。
 * 样式留在父级 `AdminContentView` 的 scoped 块里（`:deep()` 命中）。
 *
 * 与文章/笔记表的差别（照抄重构前的列定义，一个字没动）：
 *   正文用 `.cm-table__comment`（两行截断）；只有「删除」一个动作。
 */
import { formatDateTime } from '@/utils/format'
import type { AdminCommentVO } from '@/types/admin'

interface Props {
  rows: AdminCommentVO[]
  busyId: number | null
}

defineProps<Props>()

defineEmits<{
  /** 删除 */
  remove: [row: AdminCommentVO]
}>()
</script>

<template>
  <table class="cm-table">
    <thead>
      <tr>
        <th scope="col">评论内容</th>
        <th scope="col">作者</th>
        <th scope="col">所属文章</th>
        <th scope="col">层级</th>
        <th scope="col">时间</th>
        <th scope="col" class="cm-table__right">操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.id">
        <td class="cm-table__main">
          <span class="cm-table__comment">{{ row.content }}</span>
        </td>
        <td>
          <div class="cm-author">
            <el-avatar :size="26" :src="row.author?.avatar || undefined" class="cm-author__avatar">
              {{ row.author?.userName?.charAt(0) ?? '?' }}
            </el-avatar>
            <span class="cm-author__name">{{ row.author?.userName }}</span>
          </div>
        </td>
        <td class="cm-table__mono">#{{ row.articleId }}</td>
        <td>
          <span v-if="row.parentId === 0" class="cm-badge">一级评论</span>
          <span v-else class="cm-badge">回复</span>
        </td>
        <td class="cm-table__time">{{ formatDateTime(row.createTime) }}</td>
        <td class="cm-table__right">
          <el-button
            size="small"
            type="danger"
            plain
            :loading="busyId === row.id"
            @click="$emit('remove', row)"
          >
            删除
          </el-button>
        </td>
      </tr>
    </tbody>
  </table>
</template>
