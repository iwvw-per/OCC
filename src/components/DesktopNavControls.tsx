import { memo, useCallback } from 'react'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  SettingsIcon,
  AppWindowIcon,
  SidebarIcon,
} from './Icons'
import { IconButton } from './ui/IconButton'
import { useTranslation } from 'react-i18next'
import { isTauri } from '../utils/tauri'
import { cn } from '../utils/cn'
import { interactive } from '../utils/interaction'

/**
 * 桌面端导航控件组：后退/前进 + 打开项目 + 设置 + 新建窗口 + 侧栏开关。
 *
 * 按钮统一使用项目的标准 IconButton（md、ghost 圆角），与对话顶栏面板按钮
 * （窗口控制按钮左侧那一排）完全一致：同尺寸、同图标大小、同 hover 交互、同间距。
 *
 * 在 Windows 全高侧栏布局中放在侧边栏顶部工具栏；在其他桌面模式下放在标题栏左侧。
 */
interface DesktopNavControlsProps {
  /** 侧栏开关：传入时显示为带展开态高亮的开关按钮 */
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
  /** 设置按钮的 accent（更新可用）样式 */
  accent?: boolean
  /** 收起态：只渲染侧栏开关，其余导航按钮隐藏（空间不足时） */
  showExtra?: boolean
}

export const DesktopNavControls = memo(function DesktopNavControls({
  sidebarOpen,
  onToggleSidebar,
  accent = false,
  showExtra = true,
}: DesktopNavControlsProps) {
  const { t } = useTranslation('components')

  const handleBack = useCallback(() => {
    window.history.back()
  }, [])

  const handleForward = useCallback(() => {
    window.history.forward()
  }, [])

  const handleOpenProject = useCallback(() => {
    window.dispatchEvent(new CustomEvent('titlebar:open-project'))
  }, [])

  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('titlebar:open-settings'))
  }, [])

  /**
   * 同位置按钮的两端语义：
   *   - 桌面端（Tauri）→ 新建一个独立窗口（原生窗口，跨项目并行工作）
   *   - 网页端 → 新建浏览器标签页，`noopener` 避免新页面反向操纵本窗口
   *
   * 网页端此前点它什么都不发生（函数内直接 return），看起来像坏按钮。
   * 保留同一个带 `#/` 的地址：新标签页落地就是「新对话」首页。
   */
  const opensNewTab = !isTauri()
  const handleNewWindow = useCallback(() => {
    if (!isTauri()) {
      window.open(`${window.location.origin}${window.location.pathname}#/`, '_blank', 'noopener')
      return
    }
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('open_new_window', { directory: null }).catch(() => {
        // 静默
      })
    })
  }, [])

  // 与 Header 面板按钮一致：IconButton md，图标 16，text-text-300 hover:text-text-100。
  const btnClass = cn('text-text-300 hover:text-text-100', interactive.subtle)

  return (
    <>
      {onToggleSidebar && (
        <IconButton
          aria-label={t(sidebarOpen ? 'desktopTitlebar.collapseSidebar' : 'desktopTitlebar.expandSidebar')}
          title={t(sidebarOpen ? 'desktopTitlebar.collapseSidebar' : 'desktopTitlebar.expandSidebar')}
          onClick={onToggleSidebar}
          aria-pressed={sidebarOpen}
          className={cn(btnClass, sidebarOpen ? interactive.toggleActive : 'border border-transparent')}
        >
          <SidebarIcon size={16} />
        </IconButton>
      )}

      {showExtra && (
        <>
          <IconButton
            aria-label={t('desktopTitlebar.goBack')}
            title={t('desktopTitlebar.goBack')}
            onClick={handleBack}
            className={btnClass}
          >
            <ChevronLeftIcon size={16} />
          </IconButton>
          <IconButton
            aria-label={t('desktopTitlebar.goForward')}
            title={t('desktopTitlebar.goForward')}
            onClick={handleForward}
            className={btnClass}
          >
            <ChevronRightIcon size={16} />
          </IconButton>

          <IconButton
            aria-label={t('desktopTitlebar.openProject')}
            title={t('desktopTitlebar.openProject')}
            onClick={handleOpenProject}
            className={btnClass}
          >
            <FolderOpenIcon size={16} />
          </IconButton>

          <IconButton
            aria-label={t('desktopTitlebar.openSettings')}
            title={t('desktopTitlebar.openSettings')}
            onClick={handleOpenSettings}
            className={cn(btnClass, accent ? 'text-accent-main-100' : undefined)}
          >
            <SettingsIcon size={16} />
          </IconButton>

          <IconButton
            aria-label={t(opensNewTab ? 'desktopTitlebar.newTab' : 'desktopTitlebar.newWindow')}
            title={t(opensNewTab ? 'desktopTitlebar.newTab' : 'desktopTitlebar.newWindow')}
            onClick={handleNewWindow}
            className={btnClass}
          >
            <AppWindowIcon size={16} />
          </IconButton>
        </>
      )}
    </>
  )
})