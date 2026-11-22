import i18n from '../i18n'
import { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../constants'

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return ''

  const now = Date.now()
  const diff = now - timestamp

  const minutes = Math.floor(diff / MS_PER_MINUTE)
  const hours = Math.floor(diff / MS_PER_HOUR)
  const days = Math.floor(diff / MS_PER_DAY)

  if (minutes < 1) return i18n.t('common:relativeTime.justNow')
  if (minutes < 60) return i18n.t('common:relativeTime.minutesAgo', { count: minutes })
  if (hours < 24) return i18n.t('common:relativeTime.hoursAgo', { count: hours })
  if (days < 7) return i18n.t('common:relativeTime.daysAgo', { count: days })

  return formatMonthDay(timestamp)
}

/** 月/日（不含年份），如 10/3 */
const monthDayFormatters = new Map<string, Intl.DateTimeFormat>()
export function formatMonthDay(timestamp: number): string {
  const locale = i18n.language || 'en'
  let formatter = monthDayFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' })
    monthDayFormatters.set(locale, formatter)
  }
  return formatter.format(timestamp)
}

/**
 * 按「自然日」边界的相对时间：今天 / 昨天 / 前天 / 3天前 …（与 formatRelativeTime 的
 * 小时粒度不同，用于项目行的最后使用时间展示）
 */
export function formatRelativeDay(timestamp: number): string {
  if (!timestamp) return ''

  const now = new Date()
  const date = new Date(timestamp)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfToday - startOfTarget) / MS_PER_DAY)

  if (dayDiff <= 0) return i18n.t('common:relativeTime.today')
  if (dayDiff === 1) return i18n.t('common:relativeTime.yesterday')
  if (dayDiff === 2) return i18n.t('common:relativeTime.dayBeforeYesterday')
  if (dayDiff < 7) return i18n.t('common:relativeTime.daysAgo', { count: dayDiff })

  return formatMonthDay(timestamp)
}
