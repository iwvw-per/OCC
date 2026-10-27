// ============================================
// preventPageZoom — 禁止页面级双指缩放
// ============================================
//
// viewport meta 里的 `maximum-scale=1, user-scalable=no` 在 Android Chrome
// 与桌面浏览器上有效，但 **iOS Safari 从 iOS 10 起会忽略它**（为了可访问性）。
// 因此在 iPhone/iPad 上双指仍能放大整个页面，放大后聊天界面会错位、
// 输入框被推出视口，只能靠重新加载恢复。
//
// 这里用事件拦截补上 iOS 的缺口：
//   - `gesturestart` / `gesturechange`：iOS 专有的捏合手势事件
//   - `touchmove` 且 `touches.length > 1`：兜底（部分 WebView 不发 gesture 事件）
//
// ⚠️ 必须放行**组件级**的捏合手势：图片查看器（AttachmentDetailModal）、
// 代码块预览（MarkdownRenderer）都实现了自己的 pinch 缩放，那些元素内部
// 的 gesture 事件不能吃掉，否则图片就放不大了。
//
// 判据：事件目标在带 `data-allow-pinch` 的子树内 → 放行。
// 组件只需在自己的手势容器上加这个属性，无需改这里。

/** 允许内部捏合手势的标记属性 */
export const ALLOW_PINCH_ATTR = 'data-allow-pinch'

function isInsidePinchable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest(`[${ALLOW_PINCH_ATTR}]`)
}

/**
 * 安装页面级缩放拦截。
 *
 * 幂等：重复调用只装一次（HMR / 多次初始化都安全）。
 * 返回卸载函数，便于测试清理。
 */
let installed = false
let teardown: (() => void) | null = null

export function preventPageZoom(): () => void {
  if (installed) return teardown ?? (() => {})
  if (typeof document === 'undefined') return () => {}
  installed = true

  const blockGesture = (event: Event) => {
    if (isInsidePinchable(event.target)) return
    // iOS 的 gesture 事件必须 preventDefault 才能阻止页面缩放
    event.preventDefault()
  }

  const blockMultiTouchMove = (event: TouchEvent) => {
    if (event.touches.length <= 1) return
    if (isInsidePinchable(event.target)) return
    // 双指移动一律拦掉：没有页面级缩放需求，而放过它就会触发缩放
    event.preventDefault()
  }

  // gesture* 只在 iOS 上触发，passive 必须为 false 才能 preventDefault
  document.addEventListener('gesturestart', blockGesture, { passive: false })
  document.addEventListener('gesturechange', blockGesture, { passive: false })
  document.addEventListener('gestureend', blockGesture, { passive: false })
  document.addEventListener('touchmove', blockMultiTouchMove, { passive: false })

  teardown = () => {
    document.removeEventListener('gesturestart', blockGesture)
    document.removeEventListener('gesturechange', blockGesture)
    document.removeEventListener('gestureend', blockGesture)
    document.removeEventListener('touchmove', blockMultiTouchMove)
    installed = false
    teardown = null
  }

  return teardown
}

/** 测试用：重置安装状态 */
export function resetPreventPageZoomForTest(): void {
  teardown?.()
  installed = false
  teardown = null
}
