import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { DESKTOP_MACOS_TRAFFIC_LIGHTS_WIDTH, DESKTOP_TITLEBAR_HEIGHT, DESKTOP_TITLEBAR_Z_INDEX } from '../constants'
import { MinusIcon, SquareIcon, CopyIcon, CloseIcon } from './Icons'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../hooks/useTheme'
import { getDesktopPlatform, usesCustomDesktopTitlebar } from '../utils/tauri'
import { useUpdateStore, hasUpdateAvailable } from '../store/updateStore'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Header } from '../features/chat/Header'
import { DesktopNavControls } from './DesktopNavControls'
import { NativeTooltip } from './ui/Tooltip'

/* 右上角窗口控制按钮专属样式：贴右边缘，无圆角，近似正方形（与其余统一样式区分） */
export const DESKTOP_TITLEBAR_BUTTON =
  'inline-flex h-full w-11 items-center justify-center text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100'

const WindowsControls = memo(function WindowsControls() {
  const { t } = useTranslation('components')
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlistenResize: (() => void) | undefined

    const win = getCurrentWindow()
    win
      .isMaximized()
      .then(m => {
        if (!cancelled) setMaximized(m)
      })
      .catch(() => {})

    win
      .onResized(() => {
        void win
          .isMaximized()
          .then(m => {
            if (!cancelled) setMaximized(m)
          })
          .catch(() => {})
      })
      .then(fn => {
        if (cancelled) fn()
        else unlistenResize = fn
      })
      .catch(() => {})

    return () => {
      cancelled = true
      unlistenResize?.()
    }
  }, [])

  const handleMinimize = useCallback(() => {
    getCurrentWindow().minimize()
  }, [])

  const handleToggleMaximize = useCallback(() => {
    getCurrentWindow().toggleMaximize()
  }, [])

  const handleClose = useCallback(() => {
    getCurrentWindow().close()
  }, [])

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <NativeTooltip>
        <button
          type="button"
          onClick={handleMinimize}
          className={DESKTOP_TITLEBAR_BUTTON}
          title={t('desktopTitlebar.minimize')}
          aria-label={t('desktopTitlebar.minimize')}
        >
          <MinusIcon size={14} />
        </button>
      </NativeTooltip>
      <NativeTooltip>
        <button
          type="button"
          onClick={handleToggleMaximize}
          className={DESKTOP_TITLEBAR_BUTTON}
          title={maximized ? t('desktopTitlebar.restore') : t('desktopTitlebar.maximize')}
          aria-label={maximized ? t('desktopTitlebar.restore') : t('desktopTitlebar.maximize')}
        >
          {maximized ? <CopyIcon size={12} /> : <SquareIcon size={12} />}
        </button>
      </NativeTooltip>
      <NativeTooltip>
        <button
          type="button"
          onClick={handleClose}
          className={`${DESKTOP_TITLEBAR_BUTTON} hover:bg-danger-100 hover:text-white`}
          title={t('desktopTitlebar.close')}
          aria-label={t('desktopTitlebar.close')}
        >
          <CloseIcon size={14} />
        </button>
      </NativeTooltip>
    </div>
  )
})

export function DesktopTitlebar({
  headerProps,
  showNav = true,
}: {
  headerProps?: React.ComponentProps<typeof Header>
  /** 导航控件是否显示在标题栏。Windows 全高侧栏模式下导航移到侧边栏顶部工具栏，此处隐藏 */
  showNav?: boolean
}) {
  const { mode, resolvedTheme } = useTheme()
  const updateState = useUpdateStore()
  const hasUpdate = hasUpdateAvailable(updateState)
  const platform = useMemo(() => getDesktopPlatform(), [])
  const isDesktopChrome = useMemo(() => usesCustomDesktopTitlebar(), [])

  /* ---- 原生主题同步 ---- */
  useEffect(() => {
    if (!isDesktopChrome) return
    // 让 overlay 侧边栏知道标题栏高度
    document.documentElement.style.setProperty('--desktop-titlebar-height', `${DESKTOP_TITLEBAR_HEIGHT}px`)
    // 顶栏内容已并入标题栏：消息区/工作状态卡片不再需要为 Header 预留行高
    if (headerProps) {
      document.documentElement.style.setProperty('--chat-header-height', '0px')
    }
    return () => {
      document.documentElement.style.removeProperty('--desktop-titlebar-height')
      if (headerProps) {
        document.documentElement.style.removeProperty('--chat-header-height')
      }
    }
  }, [isDesktopChrome, headerProps])

  useEffect(() => {
    if (!isDesktopChrome) return

    let cancelled = false
    const theme = mode === 'system' ? null : resolvedTheme

    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      if (cancelled) return
      try {
        await getCurrentWindow().setTheme(theme)
      } catch {
        // best effort
      }
    })

    return () => {
      cancelled = true
    }
  }, [isDesktopChrome, mode, resolvedTheme])

  /* ---- 导航（已移至 DesktopNavControls） ---- */
  if (!isDesktopChrome) return null

  return (
    <header
      className="desktop-titlebar relative grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center bg-bg-100 border-b border-border-200/50"
      style={{ height: DESKTOP_TITLEBAR_HEIGHT, zIndex: DESKTOP_TITLEBAR_Z_INDEX }}
    >
      {/* ---- 左侧：平台占位 + 导航（非 Windows 全高侧栏模式） ---- */}
      {/* ⚠️ 必须 items-center:IconButton 是固定 size-8,若用 items-stretch,
          在 44px 标题栏里会被顶到上方(实测上 0 / 下 12),与居中的标题与窗口控制
          按钮错位。窄屏(<768)Windows 会把导航控件放回标题栏左侧,正是这个分支,
          故与侧栏顶部工具栏(items-center gap-1)保持同一对齐。 */}
      <div className="flex h-full shrink-0 items-center gap-1">
        {platform === 'macos' ? (
          <div className="h-full shrink-0" style={{ width: DESKTOP_MACOS_TRAFFIC_LIGHTS_WIDTH }} />
        ) : (
          <div className="h-full shrink-0 w-1" />
        )}

        {showNav && <DesktopNavControls accent={hasUpdate} />}
      </div>

      {/* ---- 中间：拖拽区 / 嵌入的应用顶栏 ---- */}
      {headerProps ? (
        <div className="h-full min-w-0">
          <Header embedded {...headerProps} />
        </div>
      ) : (
        <div data-tauri-drag-region className="h-full min-w-0" />
      )}

      {/* ---- 右侧：Windows 控制按钮 / macOS 留白 ---- */}
      {platform === 'windows' ? <WindowsControls /> : <div data-tauri-drag-region className="h-full w-3 shrink-0" />}
    </header>
  )
}
