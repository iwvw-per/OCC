import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getHostMetricsCollapsed,
  setHostMetricsCollapsed,
  subscribeHostMetricsCollapsed,
  toggleHostMetricsCollapsed,
} from './hostMetricsUi'

/**
 * 主机资源监控的折叠开关是**跨组件共享**的：
 * HostQuickSwitcher 里点当前主机去切换它，HostMetricsBar 读它决定显隐。
 * 这里锁定这层语义，避免以后改成各自一份 state 导致「点了没反应」。
 */
describe('hostMetricsUi 折叠开关', () => {
  beforeEach(() => {
    localStorage.clear()
    setHostMetricsCollapsed(false)
  })

  it('切换开关会翻转状态并可往返', () => {
    expect(getHostMetricsCollapsed()).toBe(false)
    toggleHostMetricsCollapsed()
    expect(getHostMetricsCollapsed()).toBe(true)
    toggleHostMetricsCollapsed()
    expect(getHostMetricsCollapsed()).toBe(false)
  })

  it('状态变化会通知所有订阅者（两个组件要同时更新）', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeHostMetricsCollapsed(a)
    const offB = subscribeHostMetricsCollapsed(b)

    setHostMetricsCollapsed(true)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    offA()
    setHostMetricsCollapsed(false)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    offB()
  })

  it('设成相同值不重复通知（避免无谓重渲染）', () => {
    const listener = vi.fn()
    const off = subscribeHostMetricsCollapsed(listener)
    setHostMetricsCollapsed(false) // 已经是 false
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('折叠状态持久化到 localStorage，重开侧栏仍保持', () => {
    setHostMetricsCollapsed(true)
    expect(localStorage.getItem('opencode-host-metrics-collapsed')).toBe('1')
    setHostMetricsCollapsed(false)
    expect(localStorage.getItem('opencode-host-metrics-collapsed')).toBe('0')
  })
})
