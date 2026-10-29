import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { ShareDialog } from '../ShareDialog'
import { ContextDetailsDialog } from './ContextDetailsDialog'
import { ArchivedSessionsDialog } from './ArchivedSessionsDialog'
import {
  CogIcon,
  SunIcon,
  MoonIcon,
  SystemIcon,
  MinimizeIcon,
  ShareIcon,
  ArchiveIcon,
} from '../../../components/Icons'
import { CircularProgress } from '../../../components/CircularProgress'
import { SegmentedControl } from '../../settings/components/SettingsUI'
import { formatTokens, formatCost, useTheme, useSessionStats } from '../../../hooks'
import { useHasMessages } from '../../../store'
import { useServerStore, type ServerHealth } from '../../../hooks/useServerStore'
import { interactive } from '../../../utils/interaction'

// 状态指示器 - 上下文占用圆环
function StatusIndicator({
  percent,
  size = 20,
}: {
  percent: number
  size?: number
}) {
  const clampedPercent = Math.min(Math.max(percent, 0), 100)

  // 进度颜色
  const progressColor =
    clampedPercent === 0
      ? 'text-text-500'
      : clampedPercent >= 90
        ? 'text-danger-100'
        : clampedPercent >= 70
          ? 'text-warning-100'
          : 'text-accent-main-100'

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <CircularProgress
        progress={clampedPercent / 100}
        size={size}
        strokeWidth={3}
        trackClassName="text-text-100/10"
        progressClassName={progressColor}
      />
    </div>
  )
}

export interface SidebarFooterProps {
  showLabels: boolean
  connectionState: string
  contextLimit?: number
  onOpenSettings?: () => void
}

export function SidebarFooter({
  showLabels,
  connectionState,
  contextLimit = 0,
  onOpenSettings,
}: SidebarFooterProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { mode: themeMode, setThemeWithAnimation: onThemeChange, chatContentWidth, resetChatContentWidth } = useTheme()
  // 统计与 hasMessages 留在 footer：流式时不让整个 SidePanel 跟着 messages 重渲
  const hasMessages = useHasMessages()
  const stats = useSessionStats(contextLimit)
  const { activeServer, getHealth } = useServerStore()
  // 健康探测优先于 SSE 连接态：SSE 长连接在进程死后可能长时间挂着，
  // health 是真 HTTP 探测（5s 超时判离线），用它决定状态点颜色更准。
  const activeHealth: ServerHealth | null = activeServer ? getHealth(activeServer.id) : null
  const [isOpen, setIsOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 260, fromBottom: false })
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [contextDialogOpen, setContextDialogOpen] = useState(false)
  const [archivedDialogOpen, setArchivedDialogOpen] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const prevShowLabelsRef = useRef(showLabels)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 菜单中连接状态显示用：health 优先（真实可达性），SSE 仅补充 connecting 过渡态
  const statusColorClass = (() => {
    switch (activeHealth?.status) {
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
        return connectionState === 'connecting' ? 'bg-warning-100 animate-pulse' : 'bg-text-500/60'
    }
  })()

  /** 上下文窗口是否已知：未知时不画占用条、不显示百分比（见 contextPercent 为 null 的约定） */
  const contextKnown = stats.contextPercent !== null
  const statsColor =
    !contextKnown
      ? 'bg-text-500/40'
      : stats.contextPercent! >= 90
        ? 'bg-danger-100'
        : stats.contextPercent! >= 70
          ? 'bg-warning-100'
          : 'bg-accent-main-100'

  // 打开菜单
  const openMenu = useCallback(() => {
    if (!buttonRef.current || !containerRef.current) return

    const buttonRect = buttonRef.current.getBoundingClientRect()
    const containerRect = containerRef.current.getBoundingClientRect()
    const menuWidth = showLabels ? containerRect.width : 260

    if (showLabels) {
      // 展开模式：菜单底部在容器上方，留点间隙
      setMenuPos({
        top: containerRect.top - 8,
        left: containerRect.left,
        width: menuWidth,
        fromBottom: true,
      })
    } else {
      // 收起模式：菜单在按钮右侧，底部对齐按钮底部
      setMenuPos({
        top: buttonRect.bottom, // 用作 bottom 计算的参考点
        left: buttonRect.right + 16, // 间距增加到 16px
        width: 260,
        fromBottom: true, // 也用 bottom 定位
      })
    }

    setIsOpen(true)
    requestAnimationFrame(() => setIsVisible(true))
  }, [showLabels])

  // 关闭菜单
  const closeMenu = useCallback(() => {
    setIsVisible(false)
    // 使用 ref 追踪 timeout 以便清理
    const closeTimeoutId = setTimeout(() => setIsOpen(false), 150)
    // 保存到 ref 以便清理
    closeTimeoutIdRef.current = closeTimeoutId
  }, [])

  // 切换菜单
  const toggleMenu = useCallback(() => {
    if (isOpen) closeMenu()
    else openMenu()
  }, [isOpen, openMenu, closeMenu])

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      closeMenu()
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, closeMenu])

  // ESC 关闭
  useEffect(() => {
    if (!isOpen) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [isOpen, closeMenu])

  // 侧边栏状态变化时关闭
  useEffect(() => {
    const showLabelsChanged = prevShowLabelsRef.current !== showLabels
    prevShowLabelsRef.current = showLabels

    let frameId: number | null = null

    if (showLabelsChanged && isOpen) {
      frameId = requestAnimationFrame(() => closeMenu())
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [showLabels, isOpen, closeMenu])

  // 清理 closeTimeout 防止内存泄漏
  useEffect(() => {
    return () => {
      if (closeTimeoutIdRef.current) {
        clearTimeout(closeTimeoutIdRef.current)
        closeTimeoutIdRef.current = null
      }
    }
  }, [])

  // 浮动菜单
  const floatingMenu = isOpen
    ? createPortal(
        <div
          ref={menuRef}
          className={`
        fixed z-[9999] rounded-lg border border-border-200/60 glass-alt shadow-lg overflow-hidden
        transition-all duration-150 ease-out
        ${isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}
      `}
          style={{
            bottom: window.innerHeight - menuPos.top,
            left: menuPos.left,
            width: menuPos.width,
            transformOrigin: showLabels ? 'bottom left' : 'bottom left',
          }}
        >
          {/* Context Stats */}
          <div className="relative p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('sidebar.contextUsage')}</span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[length:var(--fs-sm)] leading-none text-text-400 tabular-nums">
                  {contextKnown ? `${Math.round(stats.contextPercent!)}%` : '--'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu()
                    setContextDialogOpen(true)
                  }}
                  className="shrink-0 text-[length:var(--fs-sm)] leading-none text-text-400 hover:bg-bg-200 hover:border-border-200 border border-transparent rounded px-1 transition-colors"
                >
                  {t('sidebar.viewDetails')}
                </button>
              </div>
            </div>
            <div className="w-full h-1.5 bg-bg-300 rounded-full overflow-hidden relative mb-2">
              <div
                className={`absolute inset-0 ${statsColor} transition-transform duration-500 ease-out origin-left`}
                style={{ transform: `scaleX(${contextKnown ? Math.min(100, stats.contextPercent!) / 100 : 0})` }}
              />
            </div>
            <div className="flex justify-between text-[length:var(--fs-xxs)] text-text-400 tabular-nums">
              <span>
                {formatTokens(stats.contextUsed)} /{' '}
                {contextKnown ? formatTokens(stats.contextLimit) : t('sidebar.contextLimitUnknown')}
              </span>
              <span>{formatCost(stats.totalCost)}</span>
            </div>
            <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
          </div>

          {/* Theme Selector */}
          <div className="relative p-2">
            <div className="text-[length:var(--fs-xxs)] font-bold text-text-400 uppercase tracking-wider px-1 mb-1.5">
              {t('sidebar.appearance')}
            </div>
            {/* 主题切换：复用设置里的 SegmentedControl（底层是共享 Tabs slider），
                不再手写容器与指示层。此前手写版在底色/边框/圆角/指示层 ring 上
                都与侧栏其他 tab 不一致。 */}
            <SegmentedControl
              value={themeMode}
              size="lg"
              fullWidth
              options={[
                { value: 'system' as const, label: t('sidebar.themeAuto'), icon: <SystemIcon size={14} /> },
                { value: 'light' as const, label: t('sidebar.themeLight'), icon: <SunIcon size={14} /> },
                { value: 'dark' as const, label: t('sidebar.themeDark'), icon: <MoonIcon size={14} /> },
              ]}
              onChange={(mode, e) => onThemeChange(mode, e)}
            />
            <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
          </div>

          {/* Menu Items */}
          <div className="flex flex-col gap-0.5 p-1">
            <button
              onClick={() => {
                resetChatContentWidth()
                closeMenu()
              }}
              disabled={chatContentWidth === null}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200 transition-colors text-left disabled:opacity-40 disabled:pointer-events-none"
            >
              <MinimizeIcon size={14} />
              <span>{t('sidebar.resetWidth')}</span>
            </button>

            <button
              onClick={() => {
                closeMenu()
                setShareDialogOpen(true)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200 transition-colors text-left"
            >
              <ShareIcon size={14} />
              <span>{t('sidebar.shareChat')}</span>
            </button>

            <button
              onClick={() => {
                closeMenu()
                setArchivedDialogOpen(true)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200 transition-colors text-left"
            >
              <ArchiveIcon size={14} />
              <span>{t('sidebar.archivedChats')}</span>
            </button>

            <button
              onClick={() => {
                closeMenu()
                onOpenSettings?.()
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200 transition-colors text-left"
            >
              <CogIcon size={14} />
              <span>{t('sidebar.settings')}</span>
            </button>
          </div>

          {/* Connection Status */}
          <div className="relative flex items-center gap-2 px-3 py-2 text-[length:var(--fs-xxs)] text-text-300 cursor-default">
            <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-border-200/30" />
            <div className={`w-1.5 h-1.5 rounded-full ${statusColorClass}`} />
            <span className="capitalize">{activeHealth ? activeHealth.status : connectionState}</span>
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <div className="shrink-0 pb-[var(--safe-area-inset-bottom)] border-t border-border-200/40">
      <div ref={containerRef} className="flex flex-col gap-0.5 mx-2 py-2">
        {/* 状态/设置触发按钮 */}
        <button
          ref={buttonRef}
          onClick={toggleMenu}
          className={`
            h-8 flex items-center rounded-lg transition-all duration-300 group overflow-hidden
            ${isOpen ? interactive.toggleActiveNeutral : 'text-text-300 hover:bg-bg-200 border border-transparent'}
          `}
          style={{
            width: showLabels ? '100%' : 32,
            // 本按钮带 1px 边框（hover/open 态需要），上方导航按钮无边框。
            // 收起时圆环中心要对齐到按钮中线 16px：border(1) + padding(5) + 圆环半宽(10) = 16，
            // 所以 paddingLeft 取 5；取 6 会让圆环右偏 1px。
            paddingLeft: showLabels ? 6 : 5,
            paddingRight: showLabels ? 8 : 4,
          }}
          title={`Context: ${formatTokens(hasMessages ? stats.contextUsed : 0)} tokens • ${contextKnown ? `${Math.round(stats.contextPercent!)}%` : t('sidebar.contextLimitUnknown')} • ${formatCost(stats.totalCost)}`}
        >
          {/* 状态指示器 */}
          <StatusIndicator percent={stats.contextPercent ?? 0} size={20} />

          {/* 展开时显示详细信息 */}
          <span
            className="ml-2 flex-1 flex items-center justify-between min-w-0 transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            <span className="text-[length:var(--fs-sm)] tabular-nums text-text-300 truncate">
              {hasMessages ? formatTokens(stats.contextUsed) : '0'} /{' '}
              {contextKnown ? formatTokens(stats.contextLimit) : t('sidebar.contextLimitUnknown')}
            </span>
            <span
              className={`text-[length:var(--fs-sm)] font-medium ml-2 ${
                !contextKnown
                  ? 'text-text-400'
                  : stats.contextPercent! >= 90
                    ? 'text-danger-100'
                    : stats.contextPercent! >= 70
                      ? 'text-warning-100'
                      : 'text-text-400'
              }`}
            >
              {contextKnown ? `${Math.round(stats.contextPercent!)}%` : '--'}
            </span>
          </span>
        </button>
      </div>

      {floatingMenu}
      <ShareDialog isOpen={shareDialogOpen} onClose={() => setShareDialogOpen(false)} />
      <ArchivedSessionsDialog isOpen={archivedDialogOpen} onClose={() => setArchivedDialogOpen(false)} />
      <ContextDetailsDialog
        isOpen={contextDialogOpen}
        onClose={() => setContextDialogOpen(false)}
        contextLimit={stats.contextLimit}
      />
    </div>
  )
}
