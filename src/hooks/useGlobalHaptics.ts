// ============================================
// useGlobalHaptics — 移动端全局触觉反馈
// ============================================
//
// 用一处 document 级监听覆盖全站可交互元素,避免在每个 onClick 里手写震动。
// 触发时机选 click(而非 pointerdown):click 只在真正的点按后触发,
// 手指按下后拖动滚动不会误震;且能自然对应「一次操作完成」。
//
// 目标的判定与分级统一交给 resolveHapticTarget(见 utils/interaction):
//   data-haptic="light|medium|strong" 显式指定
//   data-haptic="none"                不震动(已有自定义触觉的元素用)
//   其它可点元素(标签、ARIA 角色、自带 onClick 的自定义行)默认 light
//
// 仅在触摸优先设备(preferTouchUi)挂载;带 hover 的桌面/混合设备不震。
// 总开关由 hapticStore 控制,hapticTap 内部会再判一次。

import { useEffect } from 'react'
import { hapticTap } from '../utils/haptics'
import { resolveHapticTarget } from '../utils/interaction'

export function useGlobalHaptics(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    const onClick = (event: MouseEvent) => {
      const resolution = resolveHapticTarget(event.target)
      if (!resolution) return
      hapticTap(resolution.strength)
    }

    // capture:在业务 onClick 的 stopPropagation 之前捕获,确保不漏。
    document.addEventListener('click', onClick, { capture: true })
    return () => document.removeEventListener('click', onClick, { capture: true })
  }, [enabled])
}
