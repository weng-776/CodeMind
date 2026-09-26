/**
 * 展示层格式化工具
 * ------------------------------------------------------------------
 * 只做「给人看」的转换，不做任何业务判断。
 * 后端返回的时间格式为 `yyyy-MM-dd HH:mm:ss`（如 2025-01-01 12:00:00），
 * Safari 无法直接解析带空格的字符串，必须先替换成 `T` 再交给 Date。
 */

/** 把后端时间字符串解析为 Date；解析失败返回 null */
export function parseServerTime(input: string | number | Date | null | undefined): Date | null {
  if (input === null || input === undefined) return null
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input
  if (typeof input === 'number') {
    const d = new Date(input)
    return Number.isNaN(d.getTime()) ? null : d
  }

  const raw = input.trim()
  if (!raw) return null

  // `2025-01-01 12:00:00` → `2025-01-01T12:00:00`
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)
    ? raw.replace(' ', 'T')
    : raw

  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? null : d
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 2 天前，
 * 超过 30 天回退为绝对日期。
 */
export function formatRelativeTime(input: string | number | Date | null | undefined): string {
  const date = parseServerTime(input)
  if (!date) return ''

  const diff = Date.now() - date.getTime()

  // 服务端时间可能略微超前（时钟不同步），统一显示为「刚刚」，避免出现「-1 分钟前」
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
  if (diff < YEAR) return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 绝对时间：2025-01-01 12:00 */
export function formatDateTime(
  input: string | number | Date | null | undefined,
  withSeconds = false,
): string {
  const date = parseServerTime(input)
  if (!date) return ''
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base
}

/** 仅日期：2025-01-01 */
export function formatDate(input: string | number | Date | null | undefined): string {
  const date = parseServerTime(input)
  if (!date) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 大数缩写：9856 → 9856，12500 → 1.3万，1200000 → 120万
 * 技术社区里数字通常不大，所以 1 万以下保持原样更精确。
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '0'
  const n = Math.floor(value)
  if (n < 10000) return String(n)
  if (n < 100000000) {
    const w = n / 10000
    return `${w >= 100 ? Math.floor(w) : Math.round(w * 10) / 10}万`
  }
  const y = n / 100000000
  return `${y >= 100 ? Math.floor(y) : Math.round(y * 10) / 10}亿`
}

/** 阅读时长估算：按中文 350 字/分钟粗略计算，最小 1 分钟 */
export function estimateReadingMinutes(content: string | null | undefined): number {
  if (!content) return 1
  const length = content.replace(/\s+/g, '').length
  return Math.max(1, Math.round(length / 350))
}
