// ============================================
// useEffectiveContextLimit — 圆环/统计用的上下文窗口
// ============================================
//
// 两个口径缺一不可：
//
//   1. `limit.input || limit.context`：与服务端压缩判据一致
//      （见 utils/contextWindow.ts）。
//   2. 与「实测上界」取较小者：声明值可能是错的。实测有站点把所有模型
//      统一声明成 context=1000000，真实窗口远小于此，于是圆环百分比长期
//      偏低、看起来「一直不涨」（见 utils/contextWindowObservation.ts）。
//
// 观测数据在 localStorage，且会随溢出事件更新，所以这里用
// useSyncExternalStore 订阅，保证收敛后圆环立刻重算。

import { useSyncExternalStore } from 'react'
import type { ModelInfo } from '../api'
import { effectiveContextWindow } from '../utils/contextWindow'
import {
  contextWindowKey,
  observedWindowVersion,
  resolveContextWindow,
  subscribeObservedWindow,
} from '../utils/contextWindowObservation'

export function useEffectiveContextLimit(model: ModelInfo | undefined, serverId?: string): number {
  // 观测变化时触发重渲染（version 只是变更标记）
  useSyncExternalStore(subscribeObservedWindow, observedWindowVersion, observedWindowVersion)

  if (!model) return 0
  const declared = effectiveContextWindow(model)
  const key = contextWindowKey(serverId, model.providerId, model.id)
  return resolveContextWindow(declared, key)
}
