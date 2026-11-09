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
import { autoCompactCeiling, compactRatio } from '../../utils/contextWindow'
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
  /**
   * 上色依据是「相对自动压缩触发线」而不是「相对窗口」。
   *
   * 服务端在 `window - max(10%, 16000)` 处就压缩（见 utils/contextWindow.ts），
   * 所以 80% 窗口往往已经越过触发线。此前用窗口百分比上色会误导：用户看到
   * 60% 以为还早，实际上服务端随时可能压缩；反过来也可能因为分母偏大而
   * 一直显示「安全」的绿色，看着像「不涨」。
   */
  const ratio = compactRatio(stats.contextUsed ?? 0, stats.contextLimit)
  const progressColor =
    percent === 0
      ? 'text-text-500'
      : ratio !== null && ratio >= 1
        ? 'text-danger-100'
        : ratio !== null && ratio >= 0.85
          ? 'text-warning-100'
          : 'text-accent-main-100'
  const ceiling = autoCompactCeiling(stats.contextLimit)

  const title = known
    ? `${t('sidebar.contextUsage')}: ${formatTokens(stats.contextUsed ?? 0)} / ${formatTokens(stats.contextLimit)} · ${Math.round(percent)}% · ${t('sidebar.contextAutoCompactAt', { value: formatTokens(ceiling) })} · ${formatCost(stats.totalCost)}`
    : `${t('sidebar.contextUsage')}: ${stats.contextUsed === null ? '—' : formatTokens(stats.contextUsed)} · ${t('sidebar.contextLimitUnknown')} · ${formatCost(stats.totalCost)}`

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
        /**
         * 未知窗口：只画轨道 + 一个居中的短横，明确表示「不知道」。
         *
         * 此前这里进度恒为 0、也不加任何标记，视觉上与「占用 0%」完全一样 ——
         * 用户看到的就是「圆圈在，但怎么都不涨」。原因是模型列表还没到手、
         * 或该模型没声明 limit，`contextPercent` 为 null（不是 0）。加一条
         * 虚线状的短横后，两种状态可以一眼区分。
         */
        <>
          <CircularProgress
            progress={0}
            size={18}
            strokeWidth={2.5}
            trackClassName="text-text-100/10"
            progressClassName="text-transparent"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute h-[2px] w-[6px] rounded-full bg-text-500/70"
          />
        </>
      )}
    </button>
  )
}
