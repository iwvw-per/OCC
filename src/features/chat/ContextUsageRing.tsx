// ============================================
// ContextUsageRing — 顶栏上下文占用圆环
// ============================================
//
// 顶栏右侧的小圆环，显示当前会话的上下文占用百分比，点击弹出上下文详情。
// 桌面端：工作状态面板可见时隐藏（面板内已有上下文信息，避免重复），面板收起
// 时显示在顶栏。移动端面板永不占位，圆环始终显示。
//
// 数据源与侧栏底部 / 工作状态面板一致：useSessionStats（订 messageStore）。

import { useTranslation } from 'react-i18next'
import { CircularProgress } from '../../components/CircularProgress'
import { formatCost, formatTokens, useSessionStats } from '../../hooks'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'

interface ContextUsageRingProps {
  contextLimit: number
  onOpenDetails: () => void
  className?: string
}

export function ContextUsageRing({ contextLimit, onOpenDetails, className }: ContextUsageRingProps) {
  const { t } = useTranslation(['chat', 'common'])
  const stats = useSessionStats(contextLimit)
  /**
   * 窗口未知（模型列表还没到手 / 该模型没声明 limit）时不画环、不算百分比。
   *
   * 旧实现兜底 200000：实测某模型真实窗口 1000000，分母错 5 倍，圆环虚高。
   * 画一个错的环比不画更有害 —— 用户会据此判断「快满了」。
   */
  const known = stats.contextPercent !== null
  const percent = known ? Math.min(Math.max(stats.contextPercent ?? 0, 0), 100) : 0

  const progressColor =
    percent === 0
      ? 'text-text-500'
      : percent >= 90
        ? 'text-danger-100'
        : percent >= 70
          ? 'text-warning-100'
          : 'text-accent-main-100'

  const title = known
    ? `${t('sidebar.contextUsage')}: ${formatTokens(stats.contextUsed)} / ${formatTokens(stats.contextLimit)} · ${Math.round(percent)}% · ${formatCost(stats.totalCost)}`
    : `${t('sidebar.contextUsage')}: ${formatTokens(stats.contextUsed)} · ${t('sidebar.contextLimitUnknown')} · ${formatCost(stats.totalCost)}`

  return (
    <button
      type="button"
      onClick={onOpenDetails}
      title={title}
      aria-label={t('sidebar.contextUsage')}
      className={cn(
        'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-text-300 hover:text-text-100',
        interactive.subtle,
        className,
      )}
    >
      {known ? (
        <CircularProgress
          progress={percent / 100}
          size={18}
          strokeWidth={2.5}
          trackClassName="text-text-100/10"
          progressClassName={progressColor}
        />
      ) : (
        // 未知窗口：只画轨道，不画进度，避免任何「占用多少」的暗示
        <CircularProgress
          progress={0}
          size={18}
          strokeWidth={2.5}
          trackClassName="text-text-100/10"
          progressClassName="text-transparent"
        />
      )}
    </button>
  )
}
