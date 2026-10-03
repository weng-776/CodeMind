<script setup lang="ts">
/**
 * 内容治理 · 文章表格（**纯展示组件**）
 * ------------------------------------------------------------------
 * 只渲染结构；数据由父级 `AdminContentView` 传入，动作以事件抛回父级。
 * 拆出来是为了给 `AdminContentView.vue` 瘦身（T21）。
 *
 * ⚠️ 表格样式**留在父级**的 scoped 块里，靠 `:deep()` 命中本组件的内部元素。
 *    原因：`.cm-table*` / `.cm-author*` / `.cm-badge*` 三张表几乎完全共用，
 *    在三个子组件里各复制一遍，等于把「页面头样式刻意重复」那个毛病换个地方复发
 *    —— 而 T21 要解的正是这个。样式集中一处，子组件只负责结构。
 *
 *    本组件的**根元素是 `<table>`**，外层 `.cm-table-scroll` 仍由父级提供，
 *    所以最终 DOM 与重构前完全一致（`<div class="cm-table-scroll"><table>…`）。
 */
import { formatCount, formatDateTime } from '@/utils/format'
import type { AdminArticleVO } from '@/types/admin'

interface Props {
  rows: AdminArticleVO[]
  /** 正在提交的行 id（该行按钮转 loading，防重复点击） */
  busyId: number | null
}

defineProps<Props>()

defineEmits<{
  /** 下架 / 恢复 */
  toggleStatus: [row: AdminArticleVO]
  /** 删除 */
  remove: [row: AdminArticleVO]
}>()
</script>

<template>
  <table class="cm-table">
    <thead>
      <tr>
        <th scope="col">文章</th>
        <th scope="col">作者</th>
        <th scope="col">数据</th>
        <th scope="col">状态</th>
        <th scope="col">发布时间</th>
        <th scope="col" class="cm-table__right">操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.id">
        <td class="cm-table__main">
          <span class="cm-table__title">{{ row.title }}</span>
          <!-- 列表 VO 刻意不含正文，只展示 summary -->
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
          {{ formatCount(row.viewCount) }} 浏览 · {{ formatCount(row.likeCount) }} 赞 ·
          {{ formatCount(row.favoriteCount) }} 藏
        </td>
        <td>
          <!-- 草稿是**醒目标签**：管理端含草稿，不打标签管理员会误以为已公开 -->
          <span v-if="row.status === 0" class="cm-badge cm-badge--warning">草稿 / 已下架</span>
          <span v-else class="cm-badge cm-badge--success">公开</span>
        </td>
        <td class="cm-table__time">{{ formatDateTime(row.createTime) }}</td>
        <td class="cm-table__right">
          <el-button
            size="small"
            plain
            :loading="busyId === row.id"
            @click="$emit('toggleStatus', row)"
          >
            {{ row.status === 1 ? '下架' : '恢复' }}
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
