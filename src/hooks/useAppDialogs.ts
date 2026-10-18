// ============================================
// useAppDialogs — 应用级弹窗的开合状态
//
// 把 App.tsx 里散落的 useState 收敛成一处：设置、项目、定时任务、命令面板、
// 关闭服务确认。这样 App 组件只关心「弹窗开关」，不再各写一对 setter。
// ============================================

import { useCallback, useMemo, useState } from 'react'
import type { SettingsTab } from '../features/settings/SettingsDialog'
import { useCloseServiceDialog } from './useCloseServiceDialog'

export interface AppDialogsApi {
  settings: {
    open: boolean
    initialTab: SettingsTab
    openTab: (tab: SettingsTab) => void
    openDefault: () => void
    openAbout: () => void
    close: () => void
  }
  project: { open: boolean; show: () => void; close: () => void }
  scheduledTasks: { open: boolean; show: () => void; close: () => void }
  commandPalette: { open: boolean; show: () => void; close: () => void }
  closeService: ReturnType<typeof useCloseServiceDialog>
}

export function useAppDialogs(): AppDialogsApi {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('servers')
  const [projectOpen, setProjectOpen] = useState(false)
  const [scheduledTasksOpen, setScheduledTasksOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const closeService = useCloseServiceDialog()

  const openSettingsTab = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const openDefaultSettings = useCallback(() => openSettingsTab('servers'), [openSettingsTab])
  const openAboutSettings = useCallback(() => openSettingsTab('about'), [openSettingsTab])

  const showProject = useCallback(() => setProjectOpen(true), [])
  const closeProject = useCallback(() => setProjectOpen(false), [])
  const showScheduledTasks = useCallback(() => setScheduledTasksOpen(true), [])
  const closeScheduledTasks = useCallback(() => setScheduledTasksOpen(false), [])
  const showCommandPalette = useCallback(() => setCommandPaletteOpen(true), [])
  const closeCommandPalette = useCallback(() => setCommandPaletteOpen(false), [])

  return useMemo(
    () => ({
      settings: {
        open: settingsOpen,
        initialTab: settingsTab,
        openTab: openSettingsTab,
        openDefault: openDefaultSettings,
        openAbout: openAboutSettings,
        close: closeSettings,
      },
      project: { open: projectOpen, show: showProject, close: closeProject },
      scheduledTasks: { open: scheduledTasksOpen, show: showScheduledTasks, close: closeScheduledTasks },
      commandPalette: { open: commandPaletteOpen, show: showCommandPalette, close: closeCommandPalette },
      closeService,
    }),
    [
      settingsOpen,
      settingsTab,
      projectOpen,
      scheduledTasksOpen,
      commandPaletteOpen,
      closeService,
      openSettingsTab,
      openDefaultSettings,
      openAboutSettings,
      closeSettings,
      showProject,
      closeProject,
      showScheduledTasks,
      closeScheduledTasks,
      showCommandPalette,
      closeCommandPalette,
    ],
  )
}
