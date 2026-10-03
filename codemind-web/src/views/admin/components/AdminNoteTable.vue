<script setup lang="ts">
/**
 * 内容治理 · 笔记表格（**纯展示组件**）
 * ------------------------------------------------------------------
 * 与 `AdminArticleTable.vue` 同一套路：只渲染结构，数据/动作走 props + emit。
 * 样式留在父级 `AdminContentView` 的 scoped 块里（`:deep()` 命中），
 * 三张表共用一套 `.cm-table*` / `.cm-author*` / `.cm-badge*`，不重复复制。
 *
 * 与文章表的差别（照抄重构前的列定义，一个字没动）：
 *   数据列是「字数 · 浏览」；状态列是**两个**标签（状态 + 可见性）。
 */
import { formatCount, formatDateTime } from '@/utils/format'
import type { AdminNoteVO } from '@/types/admin'

interface Props {
  rows: AdminNoteVO[]
  busyId: number | null
}

defineProps<Props>()

defineEmits<{
  /** 转草稿 / 恢复 */
  toggleStatus: [row: AdminNoteVO]
  /** 删除 */
  remove: [row: AdminNoteVO]
}>()
</script>

<template>
  <table class="cm-table">
    <thead>
      <tr>
        <th scope="col">笔记</th>
        <th scope="col">作者</th>
        <th scope="col">数据</th>
        <th scope="col">状态</th>
        <th scope="col">创建时间</th>
        <th scope="col" class="cm-table__right">操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.id">
        <td class="cm-table__main">
          <span class="cm-table__title">{{ row.title }}</span>
          <span class="cm-table__sub cm-line-clamp-1">{{ row.summary || '（无摘要）' }}</span>
        </td>
        <td>
          <div class="cm-author">
            <el-avatar :size="26" :src="row.author?.avatar || undefined" class="cm-author__avatar">
              {{ row.author?.userName?.charAt(0) ?? '?' }}
            </el-avatar>
            <span class="cm-author__name">{{ row.author?.userName }}</span>
          </div>
        </td>
        <td class="cm-table__mono">
          {{ formatCount(row.wordCount) }} 字 · {{ formatCount(row.viewCount) }} 浏览
        </td>
        <td>
          <div class="cm-badge-group">
            <span v-if="row.status === 0" class="cm-badge cm-badge--warning">草稿</span>
            <span v-else class="cm-badge cm-badge--success">正常</span>
            <!-- 私密同样必须醒目：管理端含私密笔记，是设计意图不是越权 -->
            <span v-if="row.visibility === 0" class="cm-badge cm-badge--danger">私密</span>
            <span v-else class="cm-badge">公开</span>
          </div>
        </td>
        <td class="cm-table__time">{{ formatDateTime(row.createTime) }}</td>
        <td class="cm-table__right">
          <el-button
            size="small"
            plain
            :loading="busyId === row.id"
            @click="$emit('toggleStatus', row)"
          >
            {{ row.status === 1 ? '转草稿' : '恢复' }}
          </el-button>
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
