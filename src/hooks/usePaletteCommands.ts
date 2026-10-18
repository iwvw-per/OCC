// ============================================
// usePaletteCommands — 命令面板（CommandPalette）的条目定义
//
// 从 App.tsx 抽出：条目只依赖「动作函数 + 焦点 pane 状态 + i18n」，
// 与组件树无关，便于单测与复用。
// ============================================

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { keybindingStore, type KeybindingAction } from '../store/keybindingStore'
import { paneLayoutStore, usePaneLayout } from '../store'
import type { CommandItem } from '../components/CommandPalette'

export interface PaletteCommandActions {
  openSettings: () => void
  openProject: () => void
  openSettingsTab: (tab: 'keybindings') => void
  openScheduledTasks: () => void
  toggleSidebar: () => void
  toggleRightPanel: () => void
  newTerminal: () => void
  toggleTerminal: () => void
}

/** 当前聚焦 pane 上可执行的会话动作（由 ChatPane 的 pane controller 提供）。 */
export interface PaletteSessionActions {
  newSession?: () => void
  archiveSession?: () => void
  previousSession?: () => void
  nextSession?: () => void
  openModelSelector?: () => void
  toggleAgent?: () => void
  copyLastResponse?: () => void
  cancelMessage?: () => void
  isStreaming?: boolean
}

export interface PalettePaneCapabilities {
  splitEnabled: boolean
  toggleFocusedPaneFullscreen: () => void
}

function focusChatInput() {
  document.querySelector<HTMLTextAreaElement>('[data-input-box] textarea')?.focus()
}

export function usePaletteCommands(
  actions: PaletteCommandActions,
  session: PaletteSessionActions | null | undefined,
  pane: PalettePaneCapabilities,
): CommandItem[] {
  const { t } = useTranslation(['commands'])
  const paneLayout = usePaneLayout()

  return useMemo(() => {
    const getShortcut = (action: KeybindingAction) => keybindingStore.getKey(action)
    const focusedPaneId = () => paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
    const withPane = (fn: (paneId: string) => void) => () => {
      const paneId = focusedPaneId()
      if (paneId) fn(paneId)
    }

    return [
      // ── 通用 ──
      {
        id: 'openSettings',
        label: t('commands:openSettings'),
        description: t('commands:openSettingsDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('openSettings'),
        action: actions.openSettings,
      },
      {
        id: 'openProject',
        label: t('commands:openProject'),
        description: t('commands:openProjectDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('openProject'),
        action: actions.openProject,
      },
      {
        id: 'openSettingsShortcuts',
        label: t('commands:openShortcutsSettings'),
        description: t('commands:openShortcutsSettingsDesc'),
        category: t('commands:categories.general'),
        action: () => actions.openSettingsTab('keybindings'),
      },
      {
        id: 'openScheduledTasks',
        label: t('commands:openScheduledTasks', { defaultValue: '定时任务' }),
        description: t('commands:openScheduledTasksDesc', { defaultValue: '管理定时任务' }),
        category: t('commands:categories.general'),
        action: actions.openScheduledTasks,
      },
      {
        id: 'toggleSidebar',
        label: t('commands:toggleSidebar'),
        description: t('commands:toggleSidebarDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('toggleSidebar'),
        action: actions.toggleSidebar,
      },
      {
        id: 'toggleRightPanel',
        label: t('commands:toggleRightPanel'),
        description: t('commands:toggleRightPanelDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('toggleRightPanel'),
        action: actions.toggleRightPanel,
      },
      {
        id: 'focusInput',
        label: t('commands:focusInput'),
        description: t('commands:focusInputDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('focusInput'),
        action: focusChatInput,
      },

      // ── 会话 ──
      {
        id: 'newSession',
        label: t('commands:newSession'),
        description: t('commands:newSessionDesc'),
        category: t('commands:categories.session'),
        shortcut: getShortcut('newSession'),
        action: () => session?.newSession?.(),
      },
      {
        id: 'archiveSession',
        label: t('commands:archiveSession'),
        description: t('commands:archiveSessionDesc'),
        category: t('commands:categories.session'),
        shortcut: getShortcut('archiveSession'),
        action: () => session?.archiveSession?.(),
      },
      {
        id: 'previousSession',
        label: t('commands:previousSession'),
        description: t('commands:previousSessionDesc'),
        category: t('commands:categories.session'),
        shortcut: getShortcut('previousSession'),
        action: () => session?.previousSession?.(),
      },
      {
        id: 'nextSession',
        label: t('commands:nextSession'),
        description: t('commands:nextSessionDesc'),
        category: t('commands:categories.session'),
        shortcut: getShortcut('nextSession'),
        action: () => session?.nextSession?.(),
      },

      // ── 终端 ──
      {
        id: 'toggleTerminal',
        label: t('commands:toggleTerminal'),
        description: t('commands:toggleTerminalDesc'),
        category: t('commands:categories.terminal'),
        shortcut: getShortcut('toggleTerminal'),
        action: actions.toggleTerminal,
      },
      {
        id: 'newTerminal',
        label: t('commands:newTerminal'),
        description: t('commands:newTerminalDesc'),
        category: t('commands:categories.terminal'),
        shortcut: getShortcut('newTerminal'),
        action: actions.newTerminal,
      },

      // ── 模型 ──
      {
        id: 'selectModel',
        label: t('commands:selectModel'),
        description: t('commands:selectModelDesc'),
        category: t('commands:categories.model'),
        shortcut: getShortcut('selectModel'),
        action: () => session?.openModelSelector?.(),
      },
      {
        id: 'toggleAgent',
        label: t('commands:toggleAgent'),
        description: t('commands:toggleAgentDesc'),
        category: t('commands:categories.model'),
        shortcut: getShortcut('toggleAgent'),
        action: () => session?.toggleAgent?.(),
      },

      // ── 消息 ──
      {
        id: 'copyLastResponse',
        label: t('commands:copyLastResponse'),
        description: t('commands:copyLastResponseDesc'),
        category: t('commands:categories.message'),
        shortcut: getShortcut('copyLastResponse'),
        action: () => session?.copyLastResponse?.(),
      },
      {
        id: 'cancelMessage',
        label: t('commands:cancelMessage'),
        description: t('commands:cancelMessageDesc'),
        category: t('commands:categories.message'),
        shortcut: getShortcut('cancelMessage'),
        action: () => session?.cancelMessage?.(),
        when: () => !!session?.isStreaming,
      },

      // ── 分屏 ──
      {
        id: 'focusNextPane',
        label: t('commands:focusNextPane'),
        description: t('commands:focusNextPaneDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('focusNextPane'),
        action: () => paneLayoutStore.focusNextPane(),
      },
      {
        id: 'focusPrevPane',
        label: t('commands:focusPrevPane'),
        description: t('commands:focusPrevPaneDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('focusPrevPane'),
        action: () => paneLayoutStore.focusPrevPane(),
      },
      {
        id: 'splitRight',
        label: t('commands:splitRight'),
        description: t('commands:splitRightDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('splitRight'),
        action: withPane(paneId => {
          if (pane.splitEnabled) paneLayoutStore.splitPane(paneId, 'horizontal')
        }),
      },
      {
        id: 'splitDown',
        label: t('commands:splitDown'),
        description: t('commands:splitDownDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('splitDown'),
        action: withPane(paneId => {
          if (pane.splitEnabled) paneLayoutStore.splitPane(paneId, 'vertical')
        }),
      },
      {
        id: 'closePane',
        label: t('commands:closePane'),
        description: t('commands:closePaneDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('closePane'),
        action: withPane(paneId => {
          if (paneLayout.isSplit) paneLayoutStore.closePane(paneId)
        }),
        when: () => paneLayout.isSplit,
      },
      {
        id: 'togglePaneFullscreen',
        label: t('commands:togglePaneFullscreen'),
        description: t('commands:togglePaneFullscreenDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('togglePaneFullscreen'),
        action: () => {
          if (paneLayout.isSplit) pane.toggleFocusedPaneFullscreen()
        },
        when: () => paneLayout.isSplit,
      },
    ]
  }, [t, actions, session, pane, paneLayout.focusedPaneId, paneLayout.isSplit])
}
