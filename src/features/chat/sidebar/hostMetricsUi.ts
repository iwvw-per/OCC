// ============================================
// hostMetricsUi - 主机资源监控条的共享 UI 状态
//
// 为什么单独一个模块：折叠开关由**两个组件**共同读写 ——
//   - HostQuickSwitcher：点当前主机时切换折叠；
//   - HostMetricsBar：读这个开关决定显隐。
// 用一个极简的外部 store（而非 React context）是因为两者在组件树上是兄弟节点，
// 且侧栏可能在多处实例化，context 需要额外层级。
// ============================================

/** 折叠状态持久化键 */
const COLLAPSED_KEY = 'opencode-host-metrics-collapsed'

/** 占位数据开关（见 isMetricsDemoEnabled） */
const DEMO_STORAGE_KEY = 'opencode-host-metrics-demo'

type Listener = () => void

const listeners = new Set<Listener>()

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

let collapsed = readCollapsed()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeHostMetricsCollapsed(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getHostMetricsCollapsed(): boolean {
  return collapsed
}

export function setHostMetricsCollapsed(next: boolean): void {
  if (collapsed === next) return
  collapsed = next
  try {
    localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
  } catch {
    // 隐私模式写不了：不影响本次会话内的行为
  }
  emit()
}

export function toggleHostMetricsCollapsed(): void {
  setHostMetricsCollapsed(!collapsed)
}

/**
 * 占位模式开关：URL 带 `?hostMetricsDemo=1`，或 localStorage 置位。
 *
 * 默认关闭。它只在**没有真实数据**时顶替显示，不会覆盖接口返回的真实值。
 */
export function isMetricsDemoEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false
    if (new URLSearchParams(window.location.search).get('hostMetricsDemo') === '1') return true
    return localStorage.getItem(DEMO_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
