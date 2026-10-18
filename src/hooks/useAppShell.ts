// ============================================
// useAppShell — 布局外壳的派生状态与交互
//
// 从 App.tsx 抽出：桌面/移动端布局判定、侧栏与右栏的开合、桌面标题栏参数，
// 以及底部面板/右栏的宽度计算。App 只保留路由、pane 编排与弹窗。
// ============================================

import { useCallback, useEffect, useRef } from 'react'
import { layoutStore, useLayoutStore } from '../store'
import type { ChatViewportValue } from '../features/chat/chatViewport'
import { getDesktopPlatform, usesCustomDesktopTitlebar } from '../utils/tauri'

export interface UseAppShellOptions {
  chatViewport: ChatViewportValue
  sidebarExpanded: boolean
  setSidebarExpanded: (expanded: boolean) => void
  splitEnabled: boolean
  isSplit: boolean
  fullscreenPaneId: string | null
  focusedPaneId: string | null
  onOpenSidebar: () => void
  onToggleRightPanelRaw: () => void
  onSplitPane: (() => void) | undefined
  onToggleFocusedPaneFullscreen: () => void
}

export interface AppShell {
  rightPanelOpen: boolean
  rightPanelWidth: number
  isMobilePanelLayout: boolean
  desktopFullHeightSidebar: boolean
  webMainAreaTopBar: boolean
  rightPanelDrawerWidth: number
  focusedIsSingleMode: boolean
  desktopTitlebarHeaderProps:
    | {
        onOpenSidebar: () => void
        onToggleRightPanel: () => void
        onSplitPane?: () => void
        isPaneFullscreen: boolean
        onTogglePaneFullscreen?: () => void
      }
    | undefined
  toggleSidebar: () => void
  toggleRightPanel: () => void
  openSidebar: () => void
  closeSidebar: () => void
}

export function useAppShell(options: UseAppShellOptions): AppShell {
  const { rightPanelOpen, rightPanelWidth } = useLayoutStore()
  const isMobilePanelLayout = options.chatViewport.interaction.sidebarBehavior === 'overlay'
  const { setSidebarExpanded } = options

  // 移动端 overlay 侧栏的开合是临时浏览状态，不该参与偏好同步：进入该布局时
  // 标记为 transient，同步拉取不再改写它；回到桌面端则恢复持久化语义。
  // 同时把 overlay 侧栏收起，移动端始终以对话页为起点，避免桌面端偏好把侧栏
  // 在手机上默认盖住内容。
  const wasMobilePanelLayoutRef = useRef(false)
  useEffect(() => {
    layoutStore.setSidebarExpandedTransientMode(isMobilePanelLayout)
    if (isMobilePanelLayout && !wasMobilePanelLayoutRef.current) {
      layoutStore.setSidebarExpandedTransient(false)
    } else if (!isMobilePanelLayout && wasMobilePanelLayoutRef.current) {
      layoutStore.reloadFromStorage()
    }
    wasMobilePanelLayoutRef.current = isMobilePanelLayout
  }, [isMobilePanelLayout])

  const openSidebar = useCallback(() => {
    if (isMobilePanelLayout && rightPanelOpen) {
      layoutStore.closeRightPanel()
    }
    if (isMobilePanelLayout) {
      // 移动端 overlay 侧栏是浏览动作，不写同步键（否则会关掉桌面端的侧栏）
      layoutStore.setSidebarExpandedTransient(true)
      return
    }
    setSidebarExpanded(true)
  }, [isMobilePanelLayout, rightPanelOpen, setSidebarExpanded])

  const closeSidebar = useCallback(() => {
    if (isMobilePanelLayout) {
      layoutStore.setSidebarExpandedTransient(false)
      return
    }
    setSidebarExpanded(false)
  }, [isMobilePanelLayout, setSidebarExpanded])

  const toggleSidebar = useCallback(() => {
    if (options.sidebarExpanded) closeSidebar()
    else openSidebar()
  }, [closeSidebar, openSidebar, options.sidebarExpanded])

  const toggleRightPanel = useCallback(() => {
    if (!isMobilePanelLayout) {
      options.onToggleRightPanelRaw()
      return
    }
    if (rightPanelOpen) {
      layoutStore.closeRightPanel()
      return
    }
    // 移动端：右栏是覆盖式 overlay；切到右栏时收起侧栏（临时交互，不落盘同步）
    if (options.sidebarExpanded) layoutStore.setSidebarExpandedTransient(false)
    layoutStore.openRightPanel()
  }, [isMobilePanelLayout, options, rightPanelOpen])

  // 桌面端把应用顶栏并入标题栏：仅当聚焦 pane 是 single（非 split，或 split 中被全屏）
  // 时传入 Header handlers，让 DesktopTitlebar 内嵌渲染 Header 内容。
  const focusedIsSingleMode = !options.isSplit || options.fullscreenPaneId === options.focusedPaneId
  const desktopTitlebarHeaderProps =
    focusedIsSingleMode
      ? {
          onOpenSidebar: openSidebar,
          onToggleRightPanel: toggleRightPanel,
          onSplitPane: options.splitEnabled && !options.fullscreenPaneId ? options.onSplitPane : undefined,
          isPaneFullscreen: options.fullscreenPaneId !== null,
          onTogglePaneFullscreen: options.isSplit ? options.onToggleFocusedPaneFullscreen : undefined,
        }
      : undefined

  // Windows 桌面：侧栏全高贯穿，标题栏只覆盖主区上方；macOS 保留全宽标题栏
  // （红绿灯位于窗口左上，需要全宽标题栏承载）。
  const desktopFullHeightSidebar = getDesktopPlatform() === 'windows' && !isMobilePanelLayout

  // 网页/Linux 桌面端没有固定的全宽顶栏：右侧面板以浮层从右侧滑入顶栏下方。
  // 为避免盖住工作状态面板（会话信息卡片）与对话内容，把主区内容让出面板宽度，
  // 通过 --right-drawer-width 下发给对话区与底部面板；Windows/macOS 桌面走 docked，
  // 移动端右栏是覆盖式 overlay（不挤压主区），二者都恒为 0。
  const rightPanelDrawerWidth =
    !isMobilePanelLayout && !desktopFullHeightSidebar && !usesCustomDesktopTitlebar() && rightPanelOpen
      ? options.chatViewport.layout.rightPanel.dockedWidth || rightPanelWidth
      : 0

  // 网页/Linux 桌面端（无自定义桌面标题栏）：主区顶部那条装饰顶栏是 absolute z-10 的
  // 不透明 bg-bg-100 条。分屏时 pane 外层带 contain 形成独立层叠上下文，PaneHeader 的
  // z-20 被锁在里面，装饰条会盖住整条 pane 工具栏（表现为分屏后顶部工具栏消失）。
  // 把 surface 抬到 z-20 即可；右面板抽屉 z-30 依旧在其之上。
  const webMainAreaTopBar = !desktopFullHeightSidebar && !usesCustomDesktopTitlebar()

  return {
    rightPanelOpen,
    rightPanelWidth,
    isMobilePanelLayout,
    desktopFullHeightSidebar,
    webMainAreaTopBar,
    rightPanelDrawerWidth,
    focusedIsSingleMode,
    desktopTitlebarHeaderProps,
    toggleSidebar,
    toggleRightPanel,
    openSidebar,
    closeSidebar,
  }
}
