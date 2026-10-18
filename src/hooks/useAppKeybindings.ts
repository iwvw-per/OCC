// ============================================
// useAppKeybindings — 全局快捷键 → 动作映射
//
// 从 App.tsx 抽出。所有动作都来自外部（设置弹窗、pane controller、store），
// 这里只负责把快捷键动作接到具体实现上。
// ============================================

import { useMemo } from 'react'
import type { KeybindingHandlers } from './useKeybindings'
import { layoutStore, paneLayoutStore } from '../store'

/** 聚焦某个 pane 的输入框（分屏切换焦点后把光标带过去）。 */
function focusPaneInput(paneId: string) {
  requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>(`[data-pane-id="${paneId}"] textarea`)?.focus()
  })
}

function focusChatInput() {
  document.querySelector<HTMLTextAreaElement>('[data-input-box] textarea')?.focus()
}

export interface AppKeybindingActions {
  openSettings: () => void
  openProject: () => void
  openCommandPalette: () => void
  toggleSidebar: () => void
  toggleRightPanel: () => void
  newTerminal: () => void
  toggleFocusedPaneFullscreen: () => void
}

export interface AppKeybindingPaneState {
  focusedPaneId: string | null
  isSplit: boolean
  splitEnabled: boolean
}

export interface AppKeybindingSessionActions {
  newSession?: () => void
  archiveSession?: () => void
  previousSession?: () => void
  nextSession?: () => void
  openModelSelector?: () => void
  toggleAgent?: () => void
  cancelMessage?: () => void
  copyLastResponse?: () => void
  toggleFullAuto?: () => void
}

export function useAppKeybindings(
  actions: AppKeybindingActions,
  pane: AppKeybindingPaneState,
  session: AppKeybindingSessionActions | null | undefined,
): KeybindingHandlers {
  return useMemo<KeybindingHandlers>(() => {
    const withPane = (fn: (paneId: string) => void) => () => {
      const paneId = pane.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
      if (paneId) fn(paneId)
    }

    return {
      openSettings: actions.openSettings,
      openProject: actions.openProject,
      commandPalette: actions.openCommandPalette,
      toggleSidebar: actions.toggleSidebar,
      toggleRightPanel: actions.toggleRightPanel,
      focusInput: focusChatInput,
      newSession: () => session?.newSession?.(),
      archiveSession: () => session?.archiveSession?.(),
      previousSession: () => session?.previousSession?.(),
      nextSession: () => session?.nextSession?.(),
      toggleTerminal: () => layoutStore.toggleBottomPanel(),
      newTerminal: actions.newTerminal,
      selectModel: () => session?.openModelSelector?.(),
      toggleAgent: () => session?.toggleAgent?.(),
      cancelMessage: () => session?.cancelMessage?.(),
      copyLastResponse: () => session?.copyLastResponse?.(),
      toggleFullAuto: () => session?.toggleFullAuto?.(),
      focusNextPane: () => {
        paneLayoutStore.focusNextPane()
        const paneId = paneLayoutStore.getFocusedPaneId()
        if (paneId) focusPaneInput(paneId)
      },
      focusPrevPane: () => {
        paneLayoutStore.focusPrevPane()
        const paneId = paneLayoutStore.getFocusedPaneId()
        if (paneId) focusPaneInput(paneId)
      },
      splitRight: withPane(paneId => {
        if (pane.splitEnabled) paneLayoutStore.splitPane(paneId, 'horizontal')
      }),
      splitDown: withPane(paneId => {
        if (pane.splitEnabled) paneLayoutStore.splitPane(paneId, 'vertical')
      }),
      closePane: withPane(paneId => {
        if (pane.isSplit) paneLayoutStore.closePane(paneId)
      }),
      togglePaneFullscreen: () => {
        if (pane.isSplit) actions.toggleFocusedPaneFullscreen()
      },
    }
  }, [actions, pane, session])
}
