// ============================================
// SyncStatusRow - 侧栏底部的偏好同步状态行
//
// 常驻显示多端同步的实时状态，位置在主机快速切换条上方：
//   - 同步中：动态小方格加载图标（与全站 Spinner 的 pixel 变体同款）
//   - 已同步：绿色圆形对号
//   - 失败：红色圆形叹号，悬停显示原因
//   - 未启用/未登录：不显示（避免占据无意义的一行）
//
// 状态来源是 preferencesSyncEngine 的内存状态，通过 subscribeSyncState 订阅，
// 因此每次同步开始/结束都会立即重渲染，不需要轮询。
// ============================================

import { useSyncExternalStore } from 'react'
import { AlertCircleIcon } from '../../../components/Icons'
import { NativeTooltip } from '../../../components/ui/Tooltip'
import { PixelGrid, Spinner } from '../../../components/ui/Spinner'
import { getSyncState, subscribeSyncState, type SyncState } from '../../../api/preferencesSyncEngine'
import { cn } from '../../../utils/cn'
import { syncStatusView, useSyncIndicatorAvailable, type SyncIndicatorKind } from './syncStatus'

/** 订阅同步引擎状态（useSyncExternalStore 保证并发渲染下一致）。 */
function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSyncState, getSyncState, getSyncState)
}

/**
 * 图标本体：同步中用闪烁小方格，已同步用「全亮小方格」，失败用红色叹号。
 *
 * 成功态刻意复用同步中的九宫格几何（而非对号），让两个状态读起来是同一图标的
 * 两个阶段：格子从逐个点亮变为全部点亮，表示同步走完。
 */
function SyncStatusIconGlyph({ kind }: { kind: SyncIndicatorKind }) {
  if (kind === 'syncing') return <Spinner size="sm" tone="accent" variant="pixel" />
  if (kind === 'error') {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-danger-100/15 text-danger-100">
        <AlertCircleIcon size={11} />
      </span>
    )
  }
  return (
    <span className="flex size-4 items-center justify-center text-accent-main-100" aria-hidden="true">
      <PixelGrid cell={4} animated={false} />
    </span>
  )
}

/**
 * 同步状态图标（仅图标，悬停显示详情）。
 *
 * 挂在主机快速切换行右侧：同步是「多端之间」的状态，与主机选择同属一行更自然，
 * 也避免单独占一行。未登录或未启用同步时不渲染。
 */
export function SyncStatusIcon() {
  const state = useSyncState()
  const available = useSyncIndicatorAvailable()
  if (!available) return null

  const view = syncStatusView(state)
  return (
    <NativeTooltip>
      <span
        className={cn(
          'flex size-5 items-center justify-center rounded-full',
          view.kind === 'syncing' ? 'text-accent-main-100' : undefined,
        )}
        title={view.title}
        aria-label={view.label}
        role="status"
      >
        <SyncStatusIconGlyph kind={view.kind} />
      </span>
    </NativeTooltip>
  )
}

export default SyncStatusIcon
