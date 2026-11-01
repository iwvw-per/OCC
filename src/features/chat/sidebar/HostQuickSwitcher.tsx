// ============================================
// HostQuickSwitcher - 侧栏对话区底部的主机快速切换条
//
// 只显示已启用主机的「简称」（server.name），点击即切换活动主机。
// 比「主机」tab 更轻：常驻在对话列表下方，无需切 tab。
//
// 切换不重载所有会话：
// - messageStore 按 serverId 分片，切服（server-switch）不失效任何消息缓存
// - 会话列表有 30s TTL 缓存兜底（切回最近访问过的主机秒出）
// ============================================

import { useCallback, useSyncExternalStore } from 'react'
import { useServerStore } from '../../../hooks/useServerStore'
import { cn } from '../../../utils/cn'
import { interactive } from '../../../utils/interaction'
import { SyncStatusIcon } from './SyncStatusRow'
import { useSyncIndicatorAvailable } from './syncStatus'
import { statusDotClass, useServerConnectionState } from './hostStatus'
import { getHostMetricsCollapsed, setHostMetricsCollapsed, subscribeHostMetricsCollapsed, toggleHostMetricsCollapsed } from './hostMetricsUi'

export function HostQuickSwitcher() {
  const { servers, activeServer, setActiveServer } = useServerStore()
  const activeId = activeServer?.id ?? null
  const visibleServers = servers.filter(server => server.enabled !== false)
  const collapsed = useSyncExternalStore(
    subscribeHostMetricsCollapsed,
    getHostMetricsCollapsed,
    getHostMetricsCollapsed,
  )

  const handleSelect = useCallback(
    (id: string) => {
      if (id !== activeId) {
        // 切到别的主机：资源监控跟随新主机，并确保它是展开的
        setActiveServer(id)
        setHostMetricsCollapsed(false)
        return
      }
      /**
       * 重复点击当前主机：收起 / 展开资源监控。
       *
       * 复用这排已有的主机按钮而不是再放一个「主机资源」标题行 —— 侧栏底部
       * 本来就有一排主机切换按钮，再加一行标题既重复又占高度。
       */
      toggleHostMetricsCollapsed()
    },
    [activeId, setActiveServer],
  )

  // 当前主机按钮同时承担资源监控的折叠开关，因此只要有一台主机就显示这一行
  // （此前是「多于一台才显示」，只有单机时按钮不出现，就没法折叠了）。
  const showHosts = visibleServers.length > 0
  const syncAvailable = useSyncIndicatorAvailable()
  if (!showHosts && !syncAvailable) return null

  return (
    <div className="shrink-0 px-2 py-1.5 border-t border-border-200/40">
      <div className="flex flex-wrap items-center gap-1">
        {showHosts &&
          visibleServers.map(server => (
            <HostQuickHostRow
              key={server.id}
              serverId={server.id}
              name={server.name}
              isActive={server.id === activeId}
              metricsExpanded={!collapsed}
              onSelect={handleSelect}
            />
          ))}
        {/* 同步状态：贴在该行右侧，只保留图标（悬停显示详情） */}
        <span className="ml-auto flex items-center">
          <SyncStatusIcon />
        </span>
      </div>
    </div>
  )
}

function HostQuickHostRow({
  serverId,
  name,
  isActive,
  metricsExpanded,
  onSelect,
}: {
  serverId: string
  name: string
  isActive: boolean
  /** 当前主机才有意义：资源监控是否展开。用于 title 与 aria-expanded */
  metricsExpanded: boolean
  onSelect: (id: string) => void
}) {
  const state = useServerConnectionState(serverId)
  const { getHealth } = useServerStore()
  const health = getHealth(serverId)
  return (
    <button
      type="button"
      onClick={() => onSelect(serverId)}
      // 当前主机的按钮兼作「资源监控」折叠开关，用 aria-expanded 把这一语义暴露出来
      {...(isActive ? { 'aria-expanded': metricsExpanded, 'aria-controls': 'host-metrics-panel' } : {})}
      title={isActive ? `${name} · ${metricsExpanded ? '点击收起资源监控' : '点击展开资源监控'}` : name}
      className={cn(
        'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[length:var(--fs-xxs)] transition-colors',
        isActive
          ? 'bg-accent-main-100/15 text-text-100'
          : 'text-text-400 hover:bg-bg-200',
        interactive.focusRingCompact,
      )}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(health, state)}`} />
      <span className="max-w-[12ch] truncate">{name}</span>
    </button>
  )
}
