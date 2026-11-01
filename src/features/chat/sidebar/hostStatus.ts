// ============================================
// hostStatus - 主机连接状态的共享读取与着色
//
// HostQuickSwitcher 与 HostMetricsBar 都要在主机名前画一个状态点，逻辑完全一致，
// 抽到一处避免两份「健康探测优先、SSE 兜底」的判定逐渐分叉。
// ============================================

import { useCallback, useSyncExternalStore } from 'react'
import type { ServerHealth } from '../../../hooks/useServerStore'
import { subscribeToServerConnectionState, getServerConnectionInfo, type ConnectionState } from '../../../api/events'

export function useServerConnectionState(serverId: string): ConnectionState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToServerConnectionState(serverId, () => onStoreChange()),
    [serverId],
  )
  const getSnapshot = useCallback(() => getServerConnectionInfo(serverId).state, [serverId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 状态点颜色以健康探测为准（真实可达性），SSE 仅补充 connecting 过渡态 ——
 * 进程死后 SSE 长连接可能还挂着，health 是 5s 超时的真实探测，能立刻判离线。
 */
export function statusDotClass(health: ServerHealth | null, state: ConnectionState): string {
  switch (health?.status) {
    case 'online':
      return 'bg-success-100'
    case 'checking':
      return 'bg-warning-100 animate-pulse'
    case 'unauthorized':
      return 'bg-warning-100'
    case 'offline':
    case 'error':
      return 'bg-danger-100'
    default:
      // 从未探测过：fallback 到 SSE 连接态（connecting 用黄点提示正在握手）
      return state === 'connecting' ? 'bg-warning-100 animate-pulse' : 'bg-text-500/50'
  }
}
