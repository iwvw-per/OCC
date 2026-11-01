// ============================================
// hostMetricsModel - 侧栏主机监控的纯函数部分
//
// 与组件分开，便于单测（组件文件导出非组件会破坏 Fast Refresh，
// 且 react-hooks/purity 禁止在渲染期读时钟）。
// ============================================

/** 数据超过这个时长未更新就视为「采集停摆」，避免把旧数字当成实时值。 */
export const STALE_AFTER_MS = 90_000

/**
 * 解析服务端 `recorded_at`。
 *
 * serveragent 用 `datetime('now')` 写入，产出 `YYYY-MM-DD HH:MM:SS`（UTC 但无时区标记）：
 *   - Safari 不接受空格分隔 → `Date.parse` 返回 NaN → 整条监控被误判成「已停止更新」；
 *   - 无时区标记会被解析成本地时间 → 中国大陆差 8 小时 → 新鲜数据显示成过期。
 * 因此显式补成 ISO 并标 UTC。
 */
export function parseRecordedAt(value: string | undefined): number | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`
  const ms = Date.parse(withZone)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 判断这批指标是否已经停更。
 *
 * `now` 由调用方传入（在轮询回调里取一次），不在渲染期读时钟 ——
 * 渲染期读 `Date.now()` 会随重渲染产生不稳定结果，也违反 purity 规则。
 */
export function isMetricsStale(recordedAt: string | undefined, now: number): boolean {
  const recordedMs = parseRecordedAt(recordedAt)
  if (recordedMs === null) return false
  return now - recordedMs > STALE_AFTER_MS
}

/** 把字节数格式化成 1.2G / 512M 这类紧凑形式（侧栏空间有限） */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)}G`
  const mb = bytes / 1024 ** 2
  return `${Math.round(mb)}M`
}

/**
 * 格式化**以 MB 为单位**的内存数值（网关 memUsed / memTotal 的单位）。
 *
 * 与 formatBytes 分开是刻意的：两个函数的入参单位不同，混用会静默差 1024 倍。
 * 实测 23972 → "23.4G"，若误当字节会得到 "0M"。
 */
export function formatMegabytes(mb: number): string {
  const gb = mb / 1024
  if (gb >= 1) return `${gb.toFixed(1)}G`
  return `${Math.round(mb)}M`
}

/** 用量条颜色：与侧栏上下文占用条保持同一套阈值语义 */
export function barColor(percent: number): string {
  if (percent >= 90) return 'bg-danger-100'
  if (percent >= 70) return 'bg-warning-100'
  return 'bg-accent-main-100'
}
