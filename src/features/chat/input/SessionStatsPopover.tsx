// ============================================
// SessionStatsPopover - 点击 footer 上的速率区域弹出的会话统计面板
//
// 结构对齐 DeepSeek harness 的「会话统计」浮层：标题 + 若干「标签 / 数值」行。
// 数据来自 useSessionTurnStats，在 InputFooter 内计算后传入，避免重复订阅。
// 浮层用 Radix Popover 承载：一侧对齐触发元素，自动避让视口边缘。
// ============================================

import { useTranslation } from 'react-i18next'
import { Popover, PopoverTrigger, PopoverContent } from '../../../components/ui'
import { StatsIcon, GaugeIcon, DatabaseIcon } from '../../../components/Icons'
import { formatDuration, formatTokenRate } from '../../../utils/formatUtils'
import type { SessionTurnStats } from '../../../hooks/useSessionTurnStats'
import type { SessionStatsDisplayFields } from '../../../store/themeStore'

interface SessionStatsPopoverProps {
  stats: SessionTurnStats
  tokensPerSec: number
  /** 当前环境下（桌面端或移动端）要在底部展示的指标项 */
  displayFields?: SessionStatsDisplayFields
}

export function SessionStatsPopover({ stats, tokensPerSec, displayFields }: SessionStatsPopoverProps) {
  const { t } = useTranslation(['chat', 'common'])

  // 最后一轮瞬时速率（空闲时为 0 tok/s）；面板内为会话平均速率
  const rateLabel = formatTokenRate(tokensPerSec)
  const averageRate = stats.tokensPerSec !== null ? formatTokenRate(stats.tokensPerSec) : '—'

  // 全量详情行（浮层展示）
  const detailRows: { label: string; value: string }[] = [
    { label: t('sessionStats.modelTime'), value: stats.modelMs > 0 ? formatDuration(stats.modelMs) : '—' },
    { label: t('sessionStats.toolTime'), value: stats.toolMs > 0 ? formatDuration(stats.toolMs) : '—' },
    {
      label: t('sessionStats.ttft'),
      value: stats.ttftMs !== null ? formatDuration(stats.ttftMs) : '—',
    },
    { label: t('sessionStats.tps'), value: averageRate },
    {
      label: t('sessionStats.cacheHit'),
      value: stats.cacheHitPercent !== null ? `${Math.round(stats.cacheHitPercent)}%` : '—',
    },
    { label: t('sessionStats.outputTokens'), value: formatTokenCount(stats.outputTokens) },
  ]

  // 底部紧凑展示行：根据 displayFields 动态组合
  const fields = displayFields ?? {
    modelTime: false,
    toolTime: false,
    ttft: false,
    tps: true,
    cacheHit: false,
    outputTokens: false,
  }

  const bottomItems: { key: string; label: string; value: string }[] = []
  if (fields.tps) {
    bottomItems.push({
      key: 'tps',
      label: t('sessionStats.labels.tps'),
      value: rateLabel,
    })
  }
  if (fields.modelTime) {
    bottomItems.push({
      key: 'modelTime',
      label: t('sessionStats.labels.modelTime'),
      value: stats.modelMs > 0 ? formatDuration(stats.modelMs) : '—',
    })
  }
  if (fields.toolTime) {
    bottomItems.push({
      key: 'toolTime',
      label: t('sessionStats.labels.toolTime'),
      value: stats.toolMs > 0 ? formatDuration(stats.toolMs) : '—',
    })
  }
  if (fields.ttft) {
    bottomItems.push({
      key: 'ttft',
      label: t('sessionStats.labels.ttft'),
      value: stats.ttftMs !== null ? formatDuration(stats.ttftMs) : '—',
    })
  }
  if (fields.cacheHit) {
    bottomItems.push({
      key: 'cacheHit',
      label: t('sessionStats.labels.cacheHit'),
      value: stats.cacheHitPercent !== null ? `${Math.round(stats.cacheHitPercent)}%` : '—',
    })
  }
  if (fields.outputTokens) {
    bottomItems.push({
      key: 'outputTokens',
      label: t('sessionStats.labels.outputTokens'),
      value: formatTokenCount(stats.outputTokens),
    })
  }

  // 若用户把所有指标全关，兜底仅显示图标，点击仍然可以弹出详情
  const hasBottomItems = bottomItems.length > 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 max-w-full flex items-center gap-1.5 tabular-nums border border-transparent px-1.5 py-0.5 rounded-md hover:bg-bg-200 hover:border-border-200 transition-colors data-[state=open]:text-text-100 overflow-hidden"
          title={t('inputFooter.tokenRate')}
        >
          <StatsIcon size={11} className="shrink-0 text-text-400" />
          {hasBottomItems ? (
            <span className="flex items-center gap-1.5 min-w-0 truncate">
              {bottomItems.map((item, index) => (
                <span key={item.key} className="flex items-center gap-1 shrink-0">
                  {index > 0 && <span className="text-text-400/50">·</span>}
                  <span className="text-text-400 text-[length:var(--fs-xxs)]">{item.label}</span>
                  <span className="text-text-200 font-medium">{item.value}</span>
                </span>
              ))}
            </span>
          ) : (
            <span className="text-[length:var(--fs-xxs)] text-text-400">{t('sessionStats.title')}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-72 p-0">
        <div className="flex items-center gap-2 border-b border-border-200/50 px-4 py-2.5 text-[length:var(--fs-sm)] font-medium text-text-200">
          <StatsIcon size={13} className="shrink-0 text-text-400" />
          <span>{t('sessionStats.title')}</span>
        </div>

        <dl className="flex flex-col gap-2.5 px-4 py-3.5">
          {detailRows.map(row => (
            <div key={row.label} className="flex items-center justify-between gap-4">
              <dt className="text-[length:var(--fs-sm)] text-text-400">{row.label}</dt>
              <dd className="text-[length:var(--fs-sm)] tabular-nums text-text-200">{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex items-center justify-between gap-3 border-t border-border-200/50 px-4 py-2.5 text-[length:var(--fs-xxs)] text-text-500">
          <span className="flex items-center gap-1.5">
            <GaugeIcon size={11} className="shrink-0" />
            <span className="tabular-nums">{t('sessionStats.counts', { turns: stats.turns, steps: stats.steps })}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <DatabaseIcon size={11} className="shrink-0" />
            <span className="tabular-nums">{formatTokenCount(stats.inputTokens)}</span>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}
